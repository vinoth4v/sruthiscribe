#!/usr/bin/env python3
"""Pull the CompMusic Carnatic varnam notations out of the Zenodo archive.

    python3 tools/fetch-varnams.py --out tools/data/varnams

The archive is 247 MB, almost all of it audio. The notations and the Word
documents that carry the sahitya alignment come to well under a megabyte, so
they are read straight out of the remote zip by HTTP range instead of
downloading the whole thing -- the same trick tools/fetch-saraga.py uses.

Dataset: Carnatic Varnam Dataset v1.1, doi:10.5281/zenodo.7726167,
CC BY-NC-ND 4.0. Notations originally from Shivkumar Kalyanaraman's archive
at shivkumar.org/music/varnams/. The varnams themselves are public domain.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from remotezip import RemoteZip  # noqa: E402

ZIP_URL = ("https://zenodo.org/api/records/7726167/files/"
           "carnatic_varnam_1.1.zip/content")
ROOT = "carnatic_varnam_1.1/Notations_Annotations/"
RAGAMS = ["abhogi", "begada", "kalyani", "mohanam", "sahana", "saveri", "sri"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="tools/data/varnams")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    z = RemoteZip(ZIP_URL)
    wanted = [ROOT + "README.rst"]
    for r in RAGAMS:
        wanted += [ROOT + "notations/%s.yaml" % r, ROOT + "notations/%s.doc" % r]

    for name in wanted:
        dest = os.path.join(args.out, os.path.basename(name))
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            print("have  %s" % dest)
            continue
        data = z.read(name)
        with open(dest, "wb") as f:
            f.write(data)
        print("wrote %s  (%d bytes)" % (dest, len(data)))


if __name__ == "__main__":
    main()
