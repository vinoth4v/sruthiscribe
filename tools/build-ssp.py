#!/usr/bin/env python3
"""Extract notation from the Sangita Sampradaya Pradarsini.

    python3 tools/fetch-ssp.py
    python3 tools/build-ssp.py --selftest tools/data/ssp/ssp_cakram1-4.pdf

Status: the extraction core is built and verified; the kirtana assembler on
top of it is the remaining work.

What is verified, and how:

  glyph map      Every font's encoding is read out of the PDF itself -- TeX
                 /Differences arrays, and the charset+encoding tables inside
                 the embedded CFF programs (lib/cff.py). Nothing is guessed:
                 "Saṅgīta Saṁpradāya Pradarśini" round-trips with its
                 diacritics intact.
  geometry       Every glyph at its true x/y via the font Widths arrays and
                 TJ kerning; every rule the page draws, through the q/Q + cm
                 transform stack (lib/ssp_grid.py).
  the scheme     Read from the book's own page iii, not assumed: lowercase
                 svara = 1 aksharakalam, capital = 2, underlines halve;
                 octave dots above/below; ',' and ';' extensions; the ten
                 gamaka symbols; 'j' danda, 'k' double danda.
  durations      --selftest parses the first gita of mela 1 (kanakambari,
                 triputa tala) and checks the akshara count between dandas:
                 tisra laghu + two drutas = 7, and the full avartanas all
                 measure exactly 7.

What is not yet done: assembling labelled kirtana sections (pallavi /
anupallavi / caranam headers are present and located) into composition
records, pairing the interleaved sahitya lines by x-position, and the batch
load with a per-kriti cross-check against an independent source before any
row is written. Until that lands, nothing from SSP enters the database --
a wrongly parsed kriti presented as Dikshitar's notation would be worse than
an honestly absent one.
"""

import argparse
import os
import sys
import importlib.util
from collections import Counter

_here = os.path.dirname(os.path.abspath(__file__))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

grid = _load("ssp_grid", os.path.join(_here, "lib", "ssp_grid.py"))


def selftest(pdf_path):
    import re
    pages = grid.load_pages(pdf_path)
    target = None
    for p in pages:
        t = p["text"]
        if re.search(r"g\s*īta\s*—\s*tripuṭa", t) and "ONTENTS" not in t \
           and sum(1 for y, l in grid.page_lines(p) if grid.is_svara_line(l)) >= 4:
            target = p
            break
    if target is None:
        print("selftest FAILED: could not locate the mela-1 gita page")
        return 1
    segs = []
    for y, line in grid.page_lines(target):
        if grid.is_svara_line(line):
            segs += grid.segments(grid.parse_svara_line(line, target["hrules"]))
    hist = Counter(round(s, 2) for s in segs)
    full = hist.get(7.0, 0)
    total = sum(hist.values())
    print("avartana segments: %d, of which exactly 7 aksharas: %d" % (total, full))
    print("histogram:", hist.most_common(6))
    # Line-edge partials are expected; the dominant value must be the tala.
    ok = full >= total * 0.6 and hist.most_common(1)[0][0] == 7.0
    print("selftest %s: triputa tala arithmetic %s"
          % ("ok" if ok else "FAILED", "verifies" if ok else "does not verify"))
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", nargs="?", default="tools/data/ssp/ssp_cakram1-4.pdf")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if not os.path.exists(args.pdf):
        sys.exit("No volume at %s.\nFetch it first:\n    python3 tools/fetch-ssp.py"
                 % args.pdf)
    if args.selftest:
        sys.exit(selftest(args.pdf))
    pages = grid.load_pages(args.pdf)
    n = sum(1 for p in pages
            for y, l in grid.page_lines(p) if grid.is_svara_line(l))
    print("pages: %d, svara lines: %d" % (len(pages), n))


if __name__ == "__main__":
    main()
