#!/usr/bin/env python3
"""Fetch the Sangita Sampradaya Pradarsini (English web edition) volumes.

    python3 tools/fetch-ssp.py --out tools/data/ssp

Subbarama Dikshitar's 1904 Pradarsini is the one place complete Carnatic
notation exists in the open: 229 fully notated Muttusvami Dikshitar kirtanas,
plus the gitas, tanas and sancaris for all 72 melas and their janyas. The
author died in 1906, so the text is public domain everywhere.

What is fetched is the English web edition (ibiblio.org/guruguha) -- typeset
TeX with a real text layer, which is what makes machine extraction possible at
all. That typesetting is (c) Guruguhanugraha Archives; what the extractor
takes from it is the public-domain notation content, not the typesetting.
"""

import argparse
import os
import urllib.request

BASE = "http://ibiblio.org/guruguha/"
VOLS = {
    "ssp_cakram1-4.pdf": "Volume I — melas 1-24",
    "ssp_cakram5-6.pdf": "Volume II — melas 25-36",
    "ssp_7to12.pdf": "Volume III — melas 37-72",
    "ssp_append.pdf": "Anubandham (appendix)",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="tools/data/ssp")
    ap.add_argument("--all", action="store_true",
                    help="also the appendix (default: the three volumes)")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    for name, label in VOLS.items():
        if name == "ssp_append.pdf" and not args.all:
            continue
        dest = os.path.join(args.out, name)
        if os.path.exists(dest) and os.path.getsize(dest) > 1e6:
            print("have  %s (%s)" % (dest, label))
            continue
        print("fetch %s (%s)…" % (name, label), flush=True)
        urllib.request.urlretrieve(BASE + name, dest)
        print("  -> %.1f MB" % (os.path.getsize(dest) / 1e6))


if __name__ == "__main__":
    main()
