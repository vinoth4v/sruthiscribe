#!/usr/bin/env python3
"""Extract notation from the Sangita Sampradaya Pradarsini.

    python3 tools/fetch-ssp.py
    python3 tools/build-ssp.py --selftest tools/data/ssp/ssp_cakram1-4.pdf

Status: the extraction core is verified. The assembler reads real kirtanas
correctly some of the time -- not often enough to load anything yet.

    python3 tools/build-ssp.py --audit    # the number that decides this

Measured on Volume I: of 147 kirtanas, 2 parse fully clean against their own
printed tala, and 22 of 391 sections do. Per-segment agreement is 56%, which
is the misleading number -- a kriti is only loadable when every avartana in it
verifies, and by that gate the yield is 1%.

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

Worked example, the first Dikshitar kirtana in the book (Vol I, mela 15):

    pallavi   S . R G M | P D N S' | S' N D P M G R      segments 8 | 4 | 4
              sri nathadi | guruguho | jayati jayati

which is 2-kalai adi tala (laghu 8 + drutam 4 + drutam 4) and matches the
printed page. Its caranam lines verify the same way. So the model is right;
what is missing is robustness across the other 145.

What --audit says is wrong, in the order it costs accuracy: the tanas and
sancaris use the danda as a phrase mark rather than an anga boundary, so they
should not be scored against the tala at all; kalai changes inside a section
(madhyamakala runs at half) are not detected; and multi-page pieces lose their
section context at the page break.

Until a kriti parses clean end to end, nothing from SSP enters the database.
A wrongly parsed kriti presented as Dikshitar's notation would be worse than
an honestly absent one, and at a 1% verified yield that gate is doing real
work rather than being a formality.
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


def audit(pdf_path):
    """How many kirtanas parse 100% clean against their printed tala?"""
    import re, unicodedata
    from collections import defaultdict
    ANGA = {'adi': [4, 2, 2], 'triputa': [3, 2, 2], 'rupaka': [2, 4],
            'mathya': [4, 2, 4], 'jhampa': [7, 1, 2], 'ata': [5, 5, 2, 2],
            'dhruva': [4, 2, 4, 4], 'eka': [4], 'misracapu': [3, 4],
            'khandacapu': [2, 3]}
    SECS = ('pallavi', 'anupallavi', 'caranam', 'carana', 'madhyamakala',
            'samasticaranam', 'cittasvara', 'muktayisvara')
    hdr = re.compile(r"(?:^|\d)(kirtana|gita|tana|sancari|prabandham|daru|varna)"
                     r"\d*([a-z]{2,26}?)tala")

    def fold(t):
        # TeX sets i-macron as DOTLESS I + combining macron; without this fix
        # 'kirtana' folds to 'krtana' and matches the 'tana' alternative.
        t = t.replace("\u0131", "i").replace("\u0237", "j")
        t = unicodedata.normalize("NFD", t)
        t = "".join(c for c in t if not unicodedata.combining(c))
        return re.sub(r"[^a-z]", "", t.lower())

    def anga_for(nm):
        if nm in ANGA:
            return ANGA[nm]
        for k, v in ANGA.items():
            if k in nm or nm in k:
                return v

    pages = grid.load_pages(pdf_path)
    kritis = []
    cur = sec = None
    for pi, p in enumerate(pages):
        if pi < 35:                       # front matter and contents
            continue
        for y, line in grid.page_lines(p):
            raw = fold("".join(g.ch for g in line))
            m = hdr.search(raw)
            if m:
                cur = {"kind": m.group(1), "anga": anga_for(m.group(2)),
                       "secs": defaultdict(list)}
                kritis.append(cur)
                sec = None
                continue
            if cur is None:
                continue
            if raw in SECS:
                sec = raw
                continue
            if grid.is_svara_line(line):
                cur["secs"][sec or "_"] += grid.parse_svara_line(line, p["hrules"])

    def clean(segs, anga):
        for k in (1, 2, 4):
            pat = [a * k for a in anga]
            for off in range(len(pat)):
                if all(abs(s - pat[(i + off) % len(pat)]) < 1e-6
                       for i, s in enumerate(segs)):
                    return True
        return False

    st = Counter()
    for kr in kritis:
        if kr["kind"] != "kirtana" or not kr["anga"]:
            continue
        st["kirtanas"] += 1
        secs = [(n, grid.segments(c)) for n, c in kr["secs"].items() if len(c) >= 6]
        secs = [(n, s) for n, s in secs if len(s) >= 2]
        if not secs:
            continue
        ok = sum(1 for n, s in secs if clean(s, kr["anga"]))
        st["sections"] += len(secs)
        st["clean"] += ok
        st["whole"] += (ok == len(secs))
    print("kirtanas with a known tala : %d" % st["kirtanas"])
    print("sections verifying         : %d/%d (%.0f%%)"
          % (st["clean"], st["sections"], 100.0 * st["clean"] / max(1, st["sections"])))
    print("kirtanas clean end to end  : %d (%.0f%%)  <- the loadable set"
          % (st["whole"], 100.0 * st["whole"] / max(1, st["kirtanas"])))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", nargs="?", default="tools/data/ssp/ssp_cakram1-4.pdf")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--audit", action="store_true",
                    help="how many kirtanas verify end to end (the loadable set)")
    args = ap.parse_args()
    if not os.path.exists(args.pdf):
        sys.exit("No volume at %s.\nFetch it first:\n    python3 tools/fetch-ssp.py"
                 % args.pdf)
    if args.selftest:
        sys.exit(selftest(args.pdf))
    if args.audit:
        sys.exit(audit(args.pdf))
    pages = grid.load_pages(args.pdf)
    n = sum(1 for p in pages
            for y, l in grid.page_lines(p) if grid.is_svara_line(l))
    print("pages: %d, svara lines: %d" % (len(pages), n))


if __name__ == "__main__":
    main()
