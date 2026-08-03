#!/usr/bin/env python3
"""Mirror the parts of the Sanidha dataset that SruthiScribe can learn from.

    python3 tools/fetch-sanidha.py --out ~/datasets/sanidha
    python3 tools/fetch-sanidha.py --out ~/datasets/sanidha --all-stems
    python3 tools/fetch-sanidha.py --check          # just test the connection

Sanidha lives on a Georgia Tech host that only answers from inside the campus
network, so the GT GlobalProtect VPN must be connected before this will work.
--check reports exactly which part of that is missing instead of hanging.

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

# Downloaded unless --all-stems / --videos widen the selection.
WANTED_AUDIO = {"vocals.wav"}
ANNOTATION_EXT = {".txt", ".json", ".csv", ".md"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".avi"}
AUDIO_EXT = {".wav", ".flac", ".aif", ".aiff", ".mp3"}

# The processed multitracks are a mastered version of the clean ones; for
# pitch tracking the clean stems are the reference, so the duplicate is skipped.
SKIP_DIRS = {"audio-multitracks-processed"}


def log(msg):
    print(msg, flush=True)


def preflight(timeout=8):
    """Explain a failure to reach Sanidha in terms of what to fix."""
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
    """Parse one autoindex page into (subdirectories, files)."""
    with urllib.request.urlopen(url, timeout=timeout) as r:
        body = r.read().decode("utf-8", "replace")
    dirs, files = [], []
    for raw in re.findall(r'href="([^"]+)"', body, re.I):
        href = html.unescape(raw)
        # Apache's column-sort links and the parent link are not content.
        if href.startswith(("?", "#", "/", "mailto:")) or href in ("../", ".."):
            continue
        if "://" in href:
            continue
        (dirs if href.endswith("/") else files).append(href)
    return dirs, files


def want(name, args):
    ext = os.path.splitext(name)[1].lower()
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
    req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


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


def remote_size(url, timeout=30):
    try:
        req = urllib.request.Request(url, method="HEAD")
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

    req = urllib.request.Request(url, headers=headers)
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


def crawl(url, out_dir, args, stats, depth=0):
    rel = urllib.parse.unquote(url[len(BASE):])
    try:
        dirs, files = listing(url)
    except Exception as e:
        log(f"  ! cannot list {rel or '/'}: {e}")
        return

    for name in files:
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
                try:
                    status = download_excerpt(urllib.parse.urljoin(url, name), dest,
                                              args.excerpt[0], args.excerpt[1])
                except Exception as e:
                    status = f"error {e}"
        else:
            status = download(urllib.parse.urljoin(url, name), dest)
        stats[status if status in ("new", "resumed", "have") else "failed"] = \
            stats.get(status if status in ("new", "resumed", "have") else "failed", 0) + 1
        if status not in ("new", "resumed", "have"):
            log(f"    ! {status}")

    for name in dirs:
        plain = urllib.parse.unquote(name).rstrip("/").lower()
        if plain in SKIP_DIRS and not args.all_stems:
            stats["skipped"] += 1
            continue
        if plain == "videos" and not args.videos:
            stats["skipped"] += 1
            continue
        crawl(urllib.parse.urljoin(url, name), out_dir, args, stats, depth + 1)


def main():
    ap = argparse.ArgumentParser(description="Mirror the Sanidha dataset (GT VPN required).")
    ap.add_argument("--out", default="~/datasets/sanidha", help="destination directory")
    ap.add_argument("--base", default=BASE, help="override the dataset URL")
    ap.add_argument("--all-stems", action="store_true",
                    help="also fetch violin/mridangam/ghatam/tanpura and the processed mixes")
    ap.add_argument("--videos", action="store_true", help="also fetch the 1080p video (very large)")
    ap.add_argument("--excerpt", metavar="START:LEN", default=None,
                    help="fetch only LEN seconds from START of each stem (e.g. 60:60). "
                         "Uncompressed WAV means this is an exact byte range, so a 300 MB "
                         "stem costs about 5 MB per scored minute.")
    ap.add_argument("--check", action="store_true", help="test connectivity and exit")
    args = ap.parse_args()
    if args.excerpt:
        try:
            a, _, b = args.excerpt.partition(":")
            args.excerpt = (float(a), float(b or 60))
        except ValueError:
            ap.error("--excerpt wants START:LEN in seconds, e.g. 60:60")

    ok, msg = preflight()
    log(("connection: " if ok else "cannot reach Sanidha —\n  ") + msg)
    if args.check or not ok:
        sys.exit(0 if ok else 2)

    out = os.path.expanduser(args.out)
    base = args.base if args.base.endswith("/") else args.base + "/"
    log(f"\nmirroring {base}\n       to {out}")
    log("selection: annotations + " +
        ("all stems" if args.all_stems else "vocals.wav") +
        (" + video" if args.videos else "") +
        (f", audio excerpted to {args.excerpt[1]:.0f}s from {args.excerpt[0]:.0f}s"
         if args.excerpt else "") + "\n")

    stats = {"new": 0, "resumed": 0, "have": 0, "failed": 0, "skipped": 0}
    crawl(base, out, args, stats)
    log("\ndone — " + ", ".join(f"{k}: {v}" for k, v in stats.items()))
    if stats["new"] or stats["resumed"] or stats["have"]:
        log(f"\nnext:  node tools/eval.js --data {args.out}")


if __name__ == "__main__":
    main()
