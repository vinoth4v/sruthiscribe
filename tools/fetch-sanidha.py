#!/usr/bin/env python3
"""Mirror the parts of the Sanidha dataset that SruthiScribe can learn from.

    python3 tools/fetch-sanidha.py --out ~/datasets/sanidha
    python3 tools/fetch-sanidha.py --out ~/datasets/sanidha --all-stems
    python3 tools/fetch-sanidha.py --check          # just test the connection

    # through the clientless portal, with the browser session:
    python3 tools/fetch-sanidha.py --curl-file ~/sanidha.curl --check
    python3 tools/fetch-sanidha.py --curl-file ~/sanidha.curl --excerpt 60:60

Sanidha lives on a Georgia Tech host that only answers from inside the campus
network. There are two ways in. A real GlobalProtect tunnel makes the host
directly reachable and needs nothing extra. The *clientless* portal at
vpn.gatech.edu/http/<host>/ works in a plain browser but reverse-proxies every
URL and authenticates with HttpOnly cookies, so --curl-file feeds it the
session from a DevTools "Copy as cURL". --check reports which part is missing
instead of hanging.

Never fetch the per-concert tarballs: they are ~396 GB together because they
carry the 1080p video, and every file inside is also served loose.

By default this fetches the vocal stem and every annotation, and skips the
video and the non-vocal stems. That is not a shortcut: the app transcribes a
single voice, so vocals.wav plus vocal_pitch.txt plus tonic.txt is the whole of
what it can be scored against, and it turns a multi-hundred-gigabyte mirror
into a couple of gigabytes. --all-stems and --videos widen it if you later want
to work on source separation or ensemble input.

Downloads resume: rerunning after an interruption re-checks sizes and only
fetches what is missing or short.
"""

import argparse
import html
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://sanidha.music.gatech.edu/sanidha/"
HOST = "sanidha.music.gatech.edu"

# GT's GlobalProtect also offers a clientless portal, which reverse-proxies the
# host at https://vpn.gatech.edu/http/<host>/<path>. That path needs the browser
# session's cookies, so --curl-file lifts them straight out of a DevTools
# "Copy as cURL" instead of asking anyone to retype a token.
PORTAL = "https://vpn.gatech.edu/http/sanidha.music.gatech.edu/sanidha/"
HEADERS = {}

# The five per-concert tarballs are ~396 GB together (Concert01 alone is 51.8 GB)
# because they carry the 1080p video. Everything in them is also served as loose
# files, so there is never a reason to touch one.
ARCHIVE_EXT = {".gz", ".tgz", ".zip", ".tar", ".bz2", ".xz"}

# Downloaded unless --all-stems / --videos widen the selection.
WANTED_AUDIO = {"vocals.wav"}
ANNOTATION_EXT = {".txt", ".json", ".csv", ".md"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".avi"}
AUDIO_EXT = {".wav", ".flac", ".aif", ".aiff", ".mp3"}

# The processed multitracks are a mastered version of the clean ones; for
# pitch tracking the clean stems are the reference, so the duplicate is skipped.
SKIP_DIRS = {"audio-multitracks-processed"}

# Below this the vocal stem is bleed, not singing: measured levels in Sanidha
# are about -25 dBFS while the voice is present and -67..-81 dBFS when it is not.
SILENT_DBFS = -50.0


def log(msg):
    print(msg, flush=True)


# ------------------------------------------------------- authenticated GET --

def load_curl(path):
    """Lift headers out of a DevTools 'Copy as cURL' blob.

    The clientless portal authenticates with cookies that are HttpOnly, so
    document.cookie cannot see them and there is nothing to copy by hand. The
    cURL that DevTools already generates has them, so that is what we read.
    """
    try:
        text = open(os.path.expanduser(path), encoding="utf-8", errors="replace").read()
    except OSError as e:
        raise SystemExit("Cannot read %s (%s).\n"
                         "  Save the browser's 'Copy as cURL' into that file first."
                         % (path, e.strerror or e))
    headers = {}
    for m in re.finditer(r"""(?:-H|--header)\s+(['"])(.*?)\1""", text, re.S):
        name, _, value = m.group(2).partition(":")
        if value.strip():
            headers[name.strip()] = value.strip()
    for m in re.finditer(r"""(?:-b|--cookie)\s+(['"])(.*?)\1""", text, re.S):
        headers["Cookie"] = m.group(2).strip()
    url = None
    m = re.search(r"""curl\s+(?:--?\w[\w-]*\s+)*?(['"])(https?://.*?)\1""", text)
    if m:
        url = m.group(2)
    if "Cookie" not in headers:
        raise SystemExit(
            "No Cookie found in %s.\n"
            "  In Chrome: DevTools > Network, click the request for the Sanidha\n"
            "  directory page, then right-click > Copy > Copy as cURL, and save\n"
            "  that text into the file." % path)
    headers.pop("Accept-Encoding", None)   # we do not want to decode gzip ourselves
    return headers, url


def _req(url, extra=None, method=None):
    h = dict(HEADERS)
    if extra:
        h.update(extra)
    return urllib.request.Request(url, headers=h, method=method)


def _looks_like_login(body):
    head = body[:4000].lower()
    return (b"globalprotect" in head or b"<form" in head and b"password" in head
            or b"portal-userauthcookie" in head)


def preflight(timeout=8, base=None):
    """Explain a failure to reach Sanidha in terms of what to fix."""
    if base and "vpn.gatech.edu" in base:
        # Clientless portal: the dataset host is never contacted directly, so
        # the only meaningful test is whether our copied session still works.
        try:
            with urllib.request.urlopen(_req(base), timeout=timeout) as r:
                body = r.read(4096)
            if _looks_like_login(body):
                return False, ("the portal returned its login page — the session in "
                               "--curl-file has expired.\n  Reload the directory in the "
                               "browser and copy a fresh cURL.")
            return True, f"portal session accepted ({r.status})"
        except urllib.error.HTTPError as e:
            return False, (f"portal answered HTTP {e.code}. If 401/403, the session "
                           "cookie is stale — copy a fresh cURL.")
        except OSError as e:
            return False, f"could not reach {base}: {e}"
    try:
        ip = socket.gethostbyname(HOST)
    except OSError as e:
        return False, f"DNS lookup for {HOST} failed ({e}). Check your general network."
    try:
        with socket.create_connection((ip, 80), timeout=timeout):
            pass
    except OSError:
        return False, (
            f"{HOST} resolves to {ip} but will not accept a connection.\n"
            "  That is what it looks like from outside Georgia Tech's network.\n"
            "  Fix: connect the GT VPN (Palo Alto GlobalProtect, portal vpn.gatech.edu,\n"
            "  Duo 2FA required), then rerun. Note that a commercial VPN such as\n"
            "  Surfshark does the opposite of what is needed here — disconnect it,\n"
            "  since it routes you further away from campus."
        )
    try:
        req = urllib.request.Request(BASE, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, f"reachable ({r.status}) via {ip}"
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return False, (
                f"{BASE} answered {e.code}. The VPN is up but this account is not "
                "authorised for Sanidha yet — email natcs@gatech.edu to request access."
            )
        return False, f"{BASE} answered HTTP {e.code}."
    except OSError as e:
        return False, f"Could not fetch {BASE}: {e}"


def listing(url, timeout=30):
    """Parse one autoindex page into ([(name, url)] dirs, [(name, url)] files).

    The portal rewrites every href to an absolute /http/<host>/... path, so
    matching on relative links alone finds nothing there. Resolving each href
    and keeping only what lands *under* the current directory handles both
    layouts and drops the parent link, the column-sort links and the portal's
    own logout chrome without needing to enumerate them.
    """
    with urllib.request.urlopen(_req(url), timeout=timeout) as r:
        raw_body = r.read()
    if _looks_like_login(raw_body):
        raise RuntimeError("got the VPN login page, not a directory listing — "
                           "the portal session has expired; re-copy the cURL")
    body = raw_body.decode("utf-8", "replace")
    dirs, files = [], []
    for raw in re.findall(r'href="([^"]+)"', body, re.I):
        href = html.unescape(raw)
        if href.startswith(("#", "mailto:", "javascript:")):
            continue
        resolved = urllib.parse.urljoin(url, href)
        if "?" in resolved or not resolved.startswith(url) or resolved == url:
            continue
        name = resolved[len(url):]
        if not name or "/" in name.rstrip("/"):
            continue
        (dirs if name.endswith("/") else files).append((name, resolved))
    return dirs, files


def want(name, args):
    ext = os.path.splitext(name)[1].lower()
    if ext in ARCHIVE_EXT:
        return False        # the per-concert tarballs; see ARCHIVE_EXT
    if ext in ANNOTATION_EXT:
        return True
    if ext in VIDEO_EXT:
        return args.videos
    if ext in AUDIO_EXT:
        return args.all_stems or name.lower() in WANTED_AUDIO
    return False


# ---------------------------------------------------------------- excerpts
# Sanidha's stems are uncompressed WAV, which means a timestamp maps straight
# to a byte offset. Fetching only the excerpt the harness will actually score
# turns a 300 MB stem into about 5 MB per scored minute -- the difference
# between a mirror that fits on a laptop and one that does not.
#
# The excerpt is written as a standalone WAV starting at t=0, with a sidecar
# recording where it came from so the absolute annotation timestamps still line
# up. Without that sidecar every contour would silently be offset.
def parse_wav_header(url, timeout=30):
    head = ranged_get(url, 0, 65535, timeout)
    if head[0:4] != b"RIFF" or head[8:12] != b"WAVE":
        raise ValueError("not a RIFF/WAVE file")
    pos = 12
    fmt = None
    while pos + 8 <= len(head):
        cid = head[pos:pos + 4]
        size = int.from_bytes(head[pos + 4:pos + 8], "little")
        body = pos + 8
        if cid == b"fmt ":
            fmt = {
                "channels": int.from_bytes(head[body + 2:body + 4], "little"),
                "rate": int.from_bytes(head[body + 4:body + 8], "little"),
                "bits": int.from_bytes(head[body + 14:body + 16], "little"),
            }
            fmt["raw"] = head[pos:body + size + (size & 1)]
        elif cid == b"data":
            if not fmt:
                raise ValueError("data chunk came before fmt")
            fmt["data_offset"] = body
            fmt["data_size"] = size
            return fmt
        pos = body + size + (size & 1)
    raise ValueError("no data chunk in the first 64 kB")


def ranged_get(url, start, end, timeout=60):
    """Fetch exactly [start, end]. Refuses to accept a whole-file answer.

    A reverse proxy is free to drop the Range header and reply 200 with the
    entire body. Silently accepting that would pull a 300 MB stem through
    memory for every 60-second excerpt, so an un-honoured range is an error
    here rather than a very slow success.
    """
    want = end - start + 1
    req = _req(url, {"Range": f"bytes={start}-{end}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        status = r.status
        if status != 206:
            r.read(1)
            raise RuntimeError(
                "server answered %d, not 206 — this hop is not honouring Range "
                "requests, so byte-range excerpting is unavailable. Fetch whole "
                "stems (drop --excerpt) only if you have the disk for it." % status)
        body = r.read(want + 1)
    if _looks_like_login(body):
        raise RuntimeError("portal session expired mid-transfer")
    return body[:want]


def build_wav(fmt, pcm):
    body = b"WAVE" + fmt["raw"] + b"data" + len(pcm).to_bytes(4, "little") + pcm
    return b"RIFF" + len(body).to_bytes(4, "little") + body


def download_excerpt(url, dest, start_sec, len_sec, timeout=60):
    """Fetch only [start, start+len) of a remote WAV."""
    fmt = parse_wav_header(url, timeout)
    stride = fmt["channels"] * (fmt["bits"] // 8)
    total_frames = fmt["data_size"] // stride
    first = min(total_frames, int(start_sec * fmt["rate"]))
    count = min(total_frames - first, int(len_sec * fmt["rate"]))
    if count <= 0:
        return "past end"

    a = fmt["data_offset"] + first * stride
    pcm = ranged_get(url, a, a + count * stride - 1, timeout)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as f:
        f.write(build_wav(fmt, pcm))
    with open(os.path.splitext(dest)[0] + ".excerpt.json", "w") as f:
        f.write('{"start": %.6f, "length": %.6f}\n' % (first / fmt["rate"], count / fmt["rate"]))
    return "new"


# Sections whose audio is the lead voice. "Violin Alap" and "Tani Avartanam"
# are long stretches where the vocal stem is near-silent, so a fixed window can
# land entirely inside one and score the engine against silence.
VOCAL_HINTS = ("pallavi", "anupallavi", "charanam", "caranam", "chittasvaram",
               "cittasvaram", "sahitya", "niraval", "svara", "tillana",
               "mangalam", "viruttam", "sloka", "vocal")
NON_VOCAL_HINTS = ("violin", "tani", "mridangam", "ghatam", "instrumental")


def excerpt_rms_dbfs(path):
    """Rough level of a written excerpt, in dBFS. -inf for an empty file."""
    import array
    import math
    import wave
    try:
        with wave.open(path) as w:
            n = min(w.getnframes(), w.getframerate() * 20)
            if n <= 0 or w.getsampwidth() != 2:
                return 0.0
            a = array.array("h")
            a.frombytes(w.readframes(n))
    except Exception:
        return 0.0
    if not len(a):
        return -999.0
    acc = 0.0
    for v in a:
        acc += float(v) * v
    rms = math.sqrt(acc / len(a))
    return -999.0 if rms <= 0 else 20 * math.log10(rms / 32768.0)


def vocal_windows(song_dir, length, pad=6.0):
    """Candidate excerpt starts inside sung sections, longest section first.

    A section label is necessary but not sufficient: a concert "Pallavi" can
    run for six minutes and contain long violin responses where the vocal stem
    is silent. The caller checks the level of what it actually got and falls
    through to the next candidate, so this returns a list, not one answer.
    """
    path = os.path.join(song_dir, "sections.txt")
    if not os.path.exists(path):
        return []
    spans = []
    for line in open(path, encoding="utf-8", errors="replace"):
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 3:
            continue
        try:
            a, b = float(parts[0]), float(parts[1])
        except ValueError:
            continue
        label = parts[2].strip().lower()
        if not label or any(k in label for k in NON_VOCAL_HINTS):
            continue
        if not any(k in label for k in VOCAL_HINTS):
            continue
        if b - a >= length + pad:
            spans.append((a, b))
    spans.sort(key=lambda ab: ab[1] - ab[0], reverse=True)
    starts = []
    for a, b in spans:
        # Try a few places inside a long section, not just its opening.
        room = b - a - length
        for frac in (0.15, 0.45, 0.7):
            t = a + pad + room * frac
            if t + length <= b and all(abs(t - u) > length / 2 for u in starts):
                starts.append(t)
    return starts


def remote_size(url, timeout=30):
    try:
        req = _req(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            n = r.headers.get("Content-Length")
            return int(n) if n else None
    except Exception:
        return None


def download(url, dest, timeout=60):
    """Fetch url to dest, resuming a partial file when the server allows it."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    total = remote_size(url, timeout)
    have = os.path.getsize(dest) if os.path.exists(dest) else 0
    if total is not None and have == total:
        return "have"
    if have and total is None:
        return "have"  # cannot verify length; leave the existing file alone

    headers = {}
    mode = "wb"
    if have and total is not None and have < total:
        headers["Range"] = f"bytes={have}-"
        mode = "ab"

    req = _req(url, headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            resuming = r.status == 206
            if not resuming:
                mode, have = "wb", 0
            start, done = time.time(), have
            with open(dest, mode) as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    if total:
                        rate = (done - have) / max(time.time() - start, 0.001) / 1e6
                        pct = 100 * done / total
                        print(f"\r    {pct:5.1f}%  {done/1e6:8.1f} MB  {rate:5.1f} MB/s",
                              end="", flush=True)
            if total:
                print("\r" + " " * 46 + "\r", end="")
    except urllib.error.HTTPError as e:
        return f"http {e.code}"
    except OSError as e:
        return f"error {e}"
    return "resumed" if mode == "ab" else "new"


def crawl(url, out_dir, args, stats, depth=0, base=None):
    base = base or BASE
    rel = urllib.parse.unquote(url[len(base):]) if url.startswith(base) else ""
    try:
        dirs, files = listing(url)
    except Exception as e:
        log(f"  ! cannot list {rel or '/'}: {e}")
        return

    for name, furl in files:
        plain_name = urllib.parse.unquote(name)
        if not want(plain_name, args):
            stats["skipped"] += 1
            continue
        dest = os.path.join(out_dir, urllib.parse.unquote(rel + name))
        log(f"  {urllib.parse.unquote(rel + name)}")
        # Uncompressed WAV lets us fetch just the scored window; everything
        # else has to come down whole.
        if args.excerpt and plain_name.lower().endswith(".wav"):
            if os.path.exists(dest) and os.path.exists(os.path.splitext(dest)[0] + ".excerpt.json"):
                status = "have"
            else:
                start, length = args.excerpt
                if start is not None:
                    cands = [start]
                else:                       # --excerpt auto:LEN
                    cands = vocal_windows(os.path.dirname(os.path.dirname(dest)),
                                          length) or [60.0]
                status = "error no candidate window"
                for i, st in enumerate(cands[:4]):
                    try:
                        status = download_excerpt(furl, dest, st, length)
                    except Exception as e:
                        status = f"error {e}"
                        break
                    lvl = excerpt_rms_dbfs(dest)
                    if lvl > SILENT_DBFS or i == len(cands[:4]) - 1:
                        if lvl <= SILENT_DBFS:
                            log(f"    ! every candidate window was silent "
                                f"({lvl:.0f} dBFS) — kept the last")
                        else:
                            log(f"    voice at {st:.0f}s ({lvl:.0f} dBFS)")
                        break
                    log(f"    {st:.0f}s is silent ({lvl:.0f} dBFS), trying next section")
        else:
            status = download(furl, dest)
        stats[status if status in ("new", "resumed", "have") else "failed"] = \
            stats.get(status if status in ("new", "resumed", "have") else "failed", 0) + 1
        if status not in ("new", "resumed", "have"):
            log(f"    ! {status}")

    for name, durl in dirs:
        plain = urllib.parse.unquote(name).rstrip("/").lower()
        if plain in SKIP_DIRS and not args.all_stems:
            stats["skipped"] += 1
            continue
        if plain == "videos" and not args.videos:
            stats["skipped"] += 1
            continue
        crawl(durl, out_dir, args, stats, depth + 1, base)


def main():
    ap = argparse.ArgumentParser(description="Mirror the Sanidha dataset (GT VPN required).")
    ap.add_argument("--out", default="~/datasets/sanidha", help="destination directory")
    ap.add_argument("--base", default=BASE, help="override the dataset URL")
    ap.add_argument("--all-stems", action="store_true",
                    help="also fetch violin/mridangam/ghatam/tanpura and the processed mixes")
    ap.add_argument("--videos", action="store_true", help="also fetch the 1080p video (very large)")
    ap.add_argument("--excerpt", metavar="START:LEN", default=None,
                    help="fetch only LEN seconds from START of each stem (e.g. 60:60, "
                         "or auto:60 to start inside a sung section per sections.txt). "
                         "Uncompressed WAV means this is an exact byte range, so a 300 MB "
                         "stem costs about 5 MB per scored minute.")
    ap.add_argument("--check", action="store_true", help="test connectivity and exit")
    ap.add_argument("--portal", action="store_true",
                    help="go through the GlobalProtect clientless portal "
                         "(vpn.gatech.edu/http/...) instead of the campus host; "
                         "needs --curl-file")
    ap.add_argument("--curl-file", metavar="PATH",
                    help="a DevTools 'Copy as cURL' saved to a file; its cookies "
                         "authenticate the portal session")
    args = ap.parse_args()
    if args.excerpt:
        a, _, b = args.excerpt.partition(":")
        try:
            length = float(b or 60)
            # "auto" reads sections.txt and starts inside a sung section --
            # a fixed start lands in a violin alap or tani often enough to
            # score the engine against silence.
            args.excerpt = (None if a.strip().lower() == "auto" else float(a), length)
        except ValueError:
            ap.error("--excerpt wants START:LEN or auto:LEN, e.g. 60:60 or auto:60")

    global HEADERS
    base = args.base
    if args.curl_file:
        HEADERS, curl_url = load_curl(args.curl_file)
        if args.base == BASE:           # not overridden explicitly
            base = PORTAL
            if curl_url and "vpn.gatech.edu" in curl_url:
                # Anchor at /sanidha/ no matter which subdirectory was copied.
                cut = curl_url.find("/sanidha/")
                if cut != -1:
                    base = curl_url[:cut + len("/sanidha/")]
        log(f"portal session: {len(HEADERS)} headers from {args.curl_file}")
    elif args.portal:
        ap.error("--portal needs --curl-file (the portal requires your session cookies)")
    base = base if base.endswith("/") else base + "/"

    ok, msg = preflight(base=base)
    log(("connection: " if ok else "cannot reach Sanidha —\n  ") + msg)
    if args.check or not ok:
        sys.exit(0 if ok else 2)

    out = os.path.expanduser(args.out)
    log(f"\nmirroring {base}\n       to {out}")
    log("selection: annotations + " +
        ("all stems" if args.all_stems else "vocals.wav") +
        (" + video" if args.videos else "") +
        (f", audio excerpted to {args.excerpt[1]:.0f}s from "
         + ("a sung section" if args.excerpt[0] is None
            else f"{args.excerpt[0]:.0f}s")
         if args.excerpt else "") + "\n")

    stats = {"new": 0, "resumed": 0, "have": 0, "failed": 0, "skipped": 0}
    crawl(base, out, args, stats, base=base)
    log("\ndone — " + ", ".join(f"{k}: {v}" for k, v in stats.items()))
    if stats["new"] or stats["resumed"] or stats["have"]:
        log(f"\nnext:  node tools/eval.js --data {args.out}")


if __name__ == "__main__":
    main()
