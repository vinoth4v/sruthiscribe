"""Read individual members out of a remote ZIP over HTTP range requests.

A ZIP stores its table of contents at the *end* of the file, so given a server
that honours Range requests you can fetch the directory, pick the handful of
members you want, and fetch only those byte spans. Saraga is a 14.4 GB archive
whose central directory is 1.1 MB and whose annotation files are a few kB each;
this turns "download 14.4 GB to read a 200-byte tonic file" into a fraction of
a second.

Zenodo serves 206 Partial Content even though it advertises no Accept-Ranges
header, so the capability is probed by trying it rather than by asking.

Handles ZIP64, which Saraga needs: past 4 GB the classic end-of-directory
record stores 0xffffffff placeholders and the real values live in a ZIP64
record behind a locator.
"""

import struct
import time
import urllib.error
import urllib.request
import zlib

EOCD_SIG = b"PK\x05\x06"
EOCD64_LOCATOR_SIG = b"PK\x06\x07"
CENTRAL_SIG = b"PK\x01\x02"
MAX_COMMENT = 65535


class RemoteZipError(Exception):
    pass


class RemoteZip:
    def __init__(self, url, timeout=120, on_throttle=None, pace=0.0):
        self.url = url
        self.timeout = timeout
        # Called with (seconds, attempt) when the server asks us to slow down,
        # so a CLI can say so instead of appearing to hang.
        self.on_throttle = on_throttle
        # A small fixed gap between requests keeps a long run under the rate
        # limit in the first place, which is cheaper than being throttled out
        # of it afterwards.
        self.pace = pace
        self._last = 0.0
        self.size = self._content_length()
        self.entries = self._read_central_directory()

    # ---------- transport ----------
    def _get(self, start, end, attempts=6):
        """Fetch bytes [start, end] inclusive, as HTTP ranges are defined.

        Selective extraction means many small requests where a plain download
        would have made one, and Zenodo rate-limits on request count. 429 and
        5xx are therefore expected rather than exceptional: back off, honour
        Retry-After when the server sends it, and carry on. Failing the whole
        run on the first 429 would make this approach unusable.
        """
        if self.pace:
            gap = self.pace - (time.monotonic() - self._last)
            if gap > 0:
                time.sleep(gap)
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={start}-{end}"})
        delay = 2.0
        for attempt in range(attempts):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    if r.status != 206:
                        raise RemoteZipError(
                            f"server ignored the Range request (HTTP {r.status}); "
                            "selective extraction needs a server that supports ranges"
                        )
                    data = r.read()
                    self._last = time.monotonic()
                    return data
            except urllib.error.HTTPError as e:
                if e.code not in (429, 500, 502, 503, 504) or attempt == attempts - 1:
                    raise
                wait = float(e.headers.get("Retry-After") or 0) or delay
                self._on_throttle(wait, attempt + 1)
                time.sleep(wait)
                delay = min(delay * 2, 60)
            except (urllib.error.URLError, TimeoutError):
                if attempt == attempts - 1:
                    raise
                time.sleep(delay)
                delay = min(delay * 2, 60)
        raise RemoteZipError("exhausted retries fetching a byte range")

    def _on_throttle(self, wait, attempt):
        if self.on_throttle:
            self.on_throttle(wait, attempt)

    def _content_length(self):
        req = urllib.request.Request(self.url, method="HEAD")
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            n = r.headers.get("Content-Length")
        if not n:
            raise RemoteZipError("server did not report a Content-Length")
        return int(n)

    # ---------- directory ----------
    def _read_central_directory(self):
        tail_len = min(self.size, MAX_COMMENT + 22)
        tail = self._get(self.size - tail_len, self.size - 1)

        i = tail.rfind(EOCD_SIG)
        if i < 0:
            raise RemoteZipError("no end-of-central-directory record found")
        count, cd_size, cd_off = struct.unpack("<H", tail[i + 10:i + 12])[0], \
            *struct.unpack("<II", tail[i + 12:i + 20])

        # Past 4 GB the classic record is all placeholders; the truth is in ZIP64.
        loc = tail.rfind(EOCD64_LOCATOR_SIG)
        if loc >= 0:
            eocd64_off = struct.unpack("<Q", tail[loc + 8:loc + 16])[0]
            rec = self._get(eocd64_off, eocd64_off + 55)
            count = struct.unpack("<Q", rec[32:40])[0]
            cd_size = struct.unpack("<Q", rec[40:48])[0]
            cd_off = struct.unpack("<Q", rec[48:56])[0]

        cd = self._get(cd_off, cd_off + cd_size - 1)
        entries, p = {}, 0
        while p + 46 <= len(cd) and cd[p:p + 4] == CENTRAL_SIG:
            (method, csize, usize, nlen, elen, clen, lho) = (
                struct.unpack("<H", cd[p + 10:p + 12])[0],
                struct.unpack("<I", cd[p + 20:p + 24])[0],
                struct.unpack("<I", cd[p + 24:p + 28])[0],
                struct.unpack("<H", cd[p + 28:p + 30])[0],
                struct.unpack("<H", cd[p + 30:p + 32])[0],
                struct.unpack("<H", cd[p + 32:p + 34])[0],
                struct.unpack("<I", cd[p + 42:p + 46])[0],
            )
            name = cd[p + 46:p + 46 + nlen].decode("utf-8", "replace")
            extra = cd[p + 46 + nlen:p + 46 + nlen + elen]
            if 0xFFFFFFFF in (csize, usize, lho):
                usize, csize, lho = _apply_zip64(extra, usize, csize, lho)
            if not name.endswith("/"):
                entries[name] = {
                    "name": name, "method": method, "csize": csize,
                    "usize": usize, "header_offset": lho,
                }
            p += 46 + nlen + elen + clen

        if len(entries) == 0:
            raise RemoteZipError("central directory parsed but held no files")
        return entries

    # ---------- members ----------
    def namelist(self, skip_junk=True):
        """Member names, with macOS archiving artefacts dropped by default.

        Saraga was zipped on a Mac, so every real file has a shadow under
        __MACOSX/ holding an AppleDouble resource fork with the same extension.
        Counting those doubles the apparent track count and hands you binary
        junk where you expected JSON, so they are filtered unless asked for.
        """
        names = list(self.entries)
        if not skip_junk:
            return names
        return [n for n in names
                if not n.startswith("__MACOSX/")
                and not n.split("/")[-1].startswith("._")]

    def read(self, name):
        """Return one member's decompressed bytes."""
        e = self.entries[name]
        # The local header repeats the name/extra lengths, and they can differ
        # from the central directory's, so the data offset is read from there.
        head = self._get(e["header_offset"], e["header_offset"] + 29)
        nlen, elen = struct.unpack("<HH", head[26:30])
        start = e["header_offset"] + 30 + nlen + elen
        if e["csize"] == 0:
            return b""
        raw = self._get(start, start + e["csize"] - 1)
        if e["method"] == 0:
            return raw
        if e["method"] == 8:
            return zlib.decompress(raw, -15)
        raise RemoteZipError(f"{name}: unsupported compression method {e['method']}")

    def extract(self, name, dest):
        import os
        os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
        data = self.read(name)
        with open(dest, "wb") as f:
            f.write(data)
        return len(data)


def _apply_zip64(extra, usize, csize, lho):
    q = 0
    while q + 4 <= len(extra):
        hid, hsz = struct.unpack("<HH", extra[q:q + 4])
        body = extra[q + 4:q + 4 + hsz]
        if hid == 0x0001:
            k = 0
            if usize == 0xFFFFFFFF:
                usize = struct.unpack("<Q", body[k:k + 8])[0]; k += 8
            if csize == 0xFFFFFFFF:
                csize = struct.unpack("<Q", body[k:k + 8])[0]; k += 8
            if lho == 0xFFFFFFFF:
                lho = struct.unpack("<Q", body[k:k + 8])[0]; k += 8
            break
        q += 4 + hsz
    return usize, csize, lho
