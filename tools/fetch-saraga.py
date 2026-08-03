#!/usr/bin/env python3
"""Fetch just the useful parts of Saraga Carnatic — public, no VPN, no login.

    python3 tools/fetch-saraga.py --out ~/datasets/saraga --list
    python3 tools/fetch-saraga.py --out ~/datasets/saraga --tracks 40
    python3 tools/fetch-saraga.py --out ~/datasets/saraga --annotations-only

Saraga ships as one 14.4 GB zip, which is more than most laptops want to spare.
It does not have to be downloaded. Zenodo honours HTTP range requests, and a
zip keeps its table of contents at the end, so individual members can be pulled
out of the remote archive directly. What this app can actually be scored
against is far smaller than the archive:

    tonic + metadata + phrases + sections   197 tracks     0.4 MB
    pitch contours                          197 tracks   1320 MB
    isolated vocal stems                    168 tracks   1982 MB

So 40 well-annotated tracks with their vocal stems land at well under a
gigabyte, and the full annotated corpus at about 3 GB — against 14.4 GB for the
archive that contains them.

Interrupted runs resume: anything already on disk at the right size is skipped.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from remotezip import RemoteZip, RemoteZipError  # noqa: E402

RECORD = "4301737"
ZIP_NAME = "saraga1.5_carnatic.zip"
ZIP_URL = f"https://zenodo.org/api/records/{RECORD}/files/{ZIP_NAME}/content"

TINY_ANNOTATIONS = (".ctonic.txt", ".json", ".mphrases-manual.txt",
                    ".sections-manual-p.txt", ".sections-manual.txt",
                    ".tempo-manual.txt", ".sama-manual.txt", ".bpm-manual.txt")
PITCH_ANNOTATIONS = (".pitch.txt", ".pitch-vocal.txt")
VOCAL_AUDIO = ".multitrack-vocal.mp3"
MIX_AUDIO = ".mp3.mp3"


def log(m):
    print(m, flush=True)


def human(n):
    return f"{n/1e9:.2f} GB" if n >= 1e9 else f"{n/1e6:.1f} MB"


def group_by_track(names):
    tracks = {}
    for n in names:
        tracks.setdefault("/".join(n.split("/")[:-1]), []).append(n)
    return tracks


def score_track(files):
    """Rank a piece by how much ground truth it carries.

    An isolated vocal stem with its own contour is worth far more here than a
    tonic and nothing else, because it is the only case where what the engine
    is fed and what the reference describes are the same signal.
    """
    joined = " ".join(files)
    s = 0
    if VOCAL_AUDIO in joined: s += 4
    if ".pitch-vocal.txt" in joined: s += 3
    if ".mphrases-manual.txt" in joined: s += 3
    if ".ctonic.txt" in joined: s += 2
    if ".pitch.txt" in joined: s += 2
    if ".sections-manual" in joined: s += 1
    return s


def usable(files):
    """A piece is scorable only with a tonic and some pitch reference."""
    joined = " ".join(files)
    return ".ctonic.txt" in joined and (".pitch.txt" in joined or ".pitch-vocal.txt" in joined)


def select(z, args):
    names = z.namelist()
    tracks = {k: v for k, v in group_by_track(names).items() if usable(v)}
    ranked = sorted(tracks.items(), key=lambda kv: (-score_track(kv[1]), kv[0]))
    if args.tracks:
        ranked = ranked[:args.tracks]

    wanted = []
    for _, files in ranked:
        for n in files:
            if n.endswith(TINY_ANNOTATIONS):
                wanted.append(n)
            elif n.endswith(PITCH_ANNOTATIONS):
                if not args.no_pitch:
                    wanted.append(n)
            elif args.annotations_only:
                continue
            elif n.endswith(VOCAL_AUDIO) and args.audio in ("vocal", "both"):
                wanted.append(n)
            elif n.endswith(MIX_AUDIO) and args.audio in ("mix", "both"):
                wanted.append(n)
    return ranked, wanted


def trim_contour(data, seconds):
    """Drop contour samples past `seconds`.

    A full Saraga pitch file is ~7 MB of text covering a whole 20-minute
    concert item, while the harness scores a one-minute excerpt. Keeping only
    the head of the file cuts the annotation footprint by an order of magnitude
    at the cost of pinning how late in a recording you can place that excerpt.
    """
    out = []
    for line in data.decode("utf-8", "replace").split("\n"):
        if not line.strip():
            continue
        try:
            t = float(line.split()[0])
        except (ValueError, IndexError):
            continue
        if t > seconds:
            break
        out.append(line)
    return ("\n".join(out) + "\n").encode("utf-8")


def main():
    ap = argparse.ArgumentParser(description="Selectively fetch Saraga Carnatic from Zenodo.")
    ap.add_argument("--out", default="~/datasets/saraga")
    ap.add_argument("--tracks", type=int, default=40,
                    help="how many of the best-annotated pieces to take (0 = all)")
    ap.add_argument("--audio", choices=["vocal", "mix", "both", "none"], default="vocal",
                    help="which audio to fetch (default: the isolated vocal stem)")
    ap.add_argument("--annotations-only", action="store_true", help="same as --audio none")
    ap.add_argument("--no-pitch", action="store_true",
                    help="skip the large F0 contours (leaves nothing to score against)")
    ap.add_argument("--trim-pitch", type=float, default=0, metavar="SEC",
                    help="keep only the first SEC seconds of each contour")
    ap.add_argument("--list", action="store_true", help="show what would be fetched and exit")
    ap.add_argument("--pace", type=float, default=0.35, metavar="SEC",
                    help="minimum gap between range requests; raise it if Zenodo throttles")
    ap.add_argument("--archive", default=None, metavar="URL",
                    help="also upload fetched audio to s3://bucket/prefix or supabase://bucket/prefix")
    args = ap.parse_args()
    if args.annotations_only:
        args.audio = "none"

    out = os.path.expanduser(args.out)

    log(f"opening the remote archive ({ZIP_NAME}) without downloading it")
    try:
        z = RemoteZip(
            ZIP_URL, pace=args.pace,
            on_throttle=lambda w, a: log(f"\n  Zenodo asked us to slow down — waiting {w:.0f}s (retry {a})"))
    except (RemoteZipError, OSError) as e:
        log(f"could not read the archive: {e}")
        sys.exit(1)
    log(f"  {human(z.size)} archive, {len(z.namelist())} members\n")

    ranked, wanted = select(z, args)
    total = sum(z.entries[n]["usize"] for n in wanted)
    log(f"selected {len(ranked)} piece(s), {len(wanted)} files, {human(total)}")
    if args.trim_pitch:
        log(f"  contours trimmed to the first {args.trim_pitch:.0f}s — actual size will be far lower")

    if args.list:
        for name, files in ranked:
            log(f"  [{score_track(files):2d}] {name.split('/')[-1]}")
        log("\n(--list only; nothing downloaded)")
        return

    uploader = None
    if args.archive:
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
        from objectstore import open_store
        uploader = open_store(args.archive)
        log(f"  archiving audio to {args.archive}")

    log("")
    done = fetched = 0
    for n in wanted:
        rel = n
        dest = os.path.join(out, rel)
        expected = z.entries[n]["usize"]
        is_pitch = n.endswith(PITCH_ANNOTATIONS)

        if os.path.exists(dest) and (is_pitch or os.path.getsize(dest) == expected):
            done += 1
            continue

        try:
            data = z.read(n)
        except Exception as e:
            log(f"\n  ! skipping {os.path.basename(n)}: {e}")
            continue
        if is_pitch and args.trim_pitch:
            data = trim_contour(data, args.trim_pitch)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(data)
        fetched += 1

        if uploader and (n.endswith(VOCAL_AUDIO) or n.endswith(MIX_AUDIO)):
            uploader.put(rel, data)

        if fetched % 10 == 0 or fetched == 1:
            print(f"\r  {done + fetched}/{len(wanted)} files", end="", flush=True)
    print(f"\r  {done + fetched}/{len(wanted)} files ({fetched} new, {done} already present)")

    on_disk = 0
    for root, _, files in os.walk(out):
        for f in files:
            on_disk += os.path.getsize(os.path.join(root, f))
    log(f"\n{out} now holds {human(on_disk)}")
    log(f"\nnext:  node tools/eval.js --data {args.out} --limit 20")


if __name__ == "__main__":
    main()
