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
tala = _load("tala", os.path.join(_here, "lib", "tala.py"))


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


SECS = ("pallavi", "anupallavi", "caranam", "carana", "madhyamakala",
        "samasticaranam", "cittasvara", "muktayisvara")

# Piece headers read "<number><kind> - <tala> - <composer>" with em dashes, so
# read the fields rather than pattern-match the line. Any header at all has to
# reset the current piece: a svarajati whose kind went unrecognised used to
# leave the previous kirtana in force, and its rows were then scored against a
# tala they were never in.
KINDS = ("kirtana", "gita", "svarajati", "tanavarnam", "varnam", "tana",
         "sancari", "prabandham", "daru", "padam", "tillana", "jatisvara",
         "slokam", "viruttam", "ragamalika", "varna")


def fold(t):
    # TeX sets i-macron as DOTLESS I + combining macron; without this fix
    # 'kirtana' folds to 'krtana' and matches the 'tana' alternative.
    import re, unicodedata
    t = t.replace("\u0131", "i").replace("\u0237", "j")
    t = unicodedata.normalize("NFD", t)
    t = "".join(c for c in t if not unicodedata.combining(c))
    return re.sub(r"[^a-z]", "", t.lower())


def header(raw):
    if "\u2014" not in raw:
        return None
    parts = raw.split("\u2014")
    if len(parts) < 2:
        return None
    head, tal = fold(parts[0]), fold(parts[1])
    kind = None
    for k in KINDS:
        if k in head:
            kind = k
            break
    if kind is None:
        return ("other", tal) if "tala" in tal and head else None
    # A tana names its composer where others name a tala. Still a header.
    return kind, (tal if "tala" in tal else "")


def grid_lyric(line):
    """A sahitya row of the notation grid, as opposed to prose or a footer.

    It carries dandas from the symbol font and several letters. Every one of
    these should have a svara row directly above it; one that does not means
    the notation line was dropped, which is how a section came to verify while
    missing half its pallavi.
    """
    bars = [g for g in line if g.ch in grid.BAR and grid.is_symbol_font(g.font)]
    letters = [g for g in line
               if g.ch.isalpha() and "Palladio" in (g.font or "")]
    return len(bars) >= 1 and len(letters) >= 6


def syllables(line):
    """Split a sahitya row into (x, text) syllables.

    Syllables are set as separate runs with a visible gap; letters inside one
    are nearly touching. Anything that is not Palladio text -- the dandas, the
    gamaka signs -- is not part of a syllable.
    """
    gl = sorted([g for g in line
                 if "Palladio" in (g.font or "") and g.ch.strip()
                 and g.ch not in "|"],
                key=lambda g: g.x)
    out, cur = [], []
    for g in gl:
        if cur and g.x - (cur[-1].x + cur[-1].w) > 1.6:
            out.append((cur[0].x, "".join(c.ch for c in cur)))
            cur = []
        cur.append(g)
    if cur:
        out.append((cur[0].x, "".join(c.ch for c in cur)))
    return out


def pair_sahitya(cells, lyric_line):
    """Attach each syllable to the note it starts on, by x position."""
    if not lyric_line:
        return
    notes = [c for c in cells if c["t"] == "sv" and c.get("x") is not None]
    if not notes:
        return
    for x, text in syllables(lyric_line):
        best, at = 1e9, None
        for c in notes:
            d = abs(c["x"] - x)
            if d < best:
                best, at = d, c
        if at is not None and best < 26 and not at.get("syl"):
            at["syl"] = text


def _corpus(pdf_path):
    """Yield (page, kind, tala-name, anga, segments) for every notation row."""
    out = []
    cur = None
    for p in grid.load_pages(pdf_path):
        pi = p["page"]                   # position in the page tree, not a list index
        if pi < 40:                      # front matter and contents
            continue
        rows = grid.page_lines(p)
        for i, (y, line) in enumerate(rows):
            raw = "".join(g.ch for g in line)
            h = header(raw)
            if h:
                cur = (h[0], h[1], tala.anga(h[1]) if h[1] else None)
                continue
            if cur is None or not grid.is_svara_line(line):
                continue
            segs = grid.segments(grid.parse_svara_line(line, p["hrules"]))
            if segs:
                out.append((pi, cur[0], cur[1], cur[2], segs))
    return out


def audit(pdf_path):
    """How many kirtanas parse 100% clean against their printed tala?"""
    import re, unicodedata
    from collections import defaultdict
    SECS = ('pallavi', 'anupallavi', 'caranam', 'carana', 'madhyamakala',
            'samasticaranam', 'cittasvara', 'muktayisvara')
    # Piece headers are "<number><kind> n - <tala> - <composer>" with em
    # dashes, so read the fields rather than pattern-matching the whole line.
    # Any header at all has to reset the current piece: a svarajati whose kind
    # went unrecognised used to leave the previous kirtana in force, and its
    # rows were then scored against that kirtana's tala -- eleven consecutive
    # rows of a misra-jati-eka svarajati read as adi and "missed by 2" while
    # being perfectly correct.
    KINDS = ("kirtana", "gita", "svarajati", "tanavarnam", "varnam", "tana",
             "sancari", "prabandham", "daru", "padam", "tillana", "jatisvara",
             "slokam", "viruttam", "ragamalika", "varna")

    def header(raw):
        if "\u2014" not in raw:
            return None
        parts = raw.split("\u2014")
        if len(parts) < 2:
            return None
        head, tal = fold(parts[0]), fold(parts[1])
        kind = None
        for k in KINDS:
            if k in head:
                kind = k
                break
        if kind is None:
            # Not a piece header unless the second field names a tala; that
            # lets an unfamiliar kind still reset the current piece.
            return ("other", tal) if "tala" in tal and head else None
        # A tana names its composer where others name a tala. It is still a
        # header, and it still has to end the piece before it -- otherwise its
        # rows are read as part of the preceding kirtana and fail against a
        # tala they were never in.
        return kind, (tal if "tala" in tal else "")

    def fold(t):
        # TeX sets i-macron as DOTLESS I + combining macron; without this fix
        # 'kirtana' folds to 'krtana' and matches the 'tana' alternative.
        t = t.replace("\u0131", "i").replace("\u0237", "j")
        t = unicodedata.normalize("NFD", t)
        t = "".join(c for c in t if not unicodedata.combining(c))
        return re.sub(r"[^a-z]", "", t.lower())

    anga_for = tala.anga

    pages = grid.load_pages(pdf_path)
    kritis = []
    cur = sec = None
    for p in pages:
        if p["page"] < 40:                # front matter and contents
            continue
        rows = grid.page_lines(p)
        for i, (y, line) in enumerate(rows):
            raw = fold("".join(g.ch for g in line))
            h = header("".join(g.ch for g in line))
            if h:
                cur = {"kind": h[0], "anga": anga_for(h[1]),
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
                cur["secs"].setdefault(sec or "_", []).append(
                    grid.parse_svara_line(line, p["hrules"]))
            elif sec is not None and grid_lyric(line):
                above = (i > 0 and grid.is_svara_line(rows[i - 1][1])
                         and 0 < rows[i - 1][0] - y < 20)
                if not above:
                    cur["orphans"] = cur.get("orphans", 0) + 1

    def duration_ok(segs, anga):
        """Does the section last a whole number of avartanas?

        This is the gate, because it is what loading notation actually needs:
        the svara sequence and its durations. Where the bar lines fall can be
        re-derived from the tala afterwards.
        """
        total = sum(segs)
        if total <= 0:
            return False
        for k in (1, 2, 4):
            cycle = sum(anga) * k
            for off in ([0.0] + ([cycle - segs[0]] if segs and segs[0] < cycle else [])):
                q = (total + off) / cycle
                if abs(q - round(q)) < 1e-6 and round(q) >= 1:
                    return True
        return False

    def dandas_ok(segs, anga):
        """Do the printed dandas agree with the anga structure as well?

        Strictly informational, and reported separately, because SSP is not
        consistent about it: a misra laghu of 7 is printed 3|4, subdividing an
        anga, while dhruva prints 6|4|4, merging its laghu and drutam into one
        group of 6 and omitting a boundary. Neither containment direction can
        hold for both, so this counts the sections where the dandas land on
        anga boundaries exactly, and nothing depends on it.
        """
        total = sum(segs)
        if total <= 0:
            return False
        marks, run = set(), 0.0
        for x in segs[:-1]:
            run += x
            marks.add(round(run, 6))
        for k in (1, 2, 4):
            cycle = sum(anga) * k
            for off in ([0.0] + ([cycle - segs[0]] if segs and segs[0] < cycle else [])):
                q = (total + off) / cycle
                if abs(q - round(q)) > 1e-6 or round(q) < 1:
                    continue
                want, run = set(), -off
                for _ in range(int(round(q))):
                    for a in anga:
                        run += a * k
                        if 1e-6 < run < total - 1e-6:
                            want.add(round(run, 6))
                if want and want <= marks:
                    return True
        return False

    clean = duration_ok

    st = Counter()
    for kr in kritis:
        if kr["kind"] != "kirtana" or not kr["anga"]:
            continue
        st["kirtanas"] += 1
        secs = [(n, grid.segments(grid.join_lines(c)))
                for n, c in kr["secs"].items() if sum(len(x) for x in c) >= 6]
        secs = [(n, s) for n, s in secs if len(s) >= 2]
        if not secs:
            continue
        if kr.get("orphans"):
            st["with_orphans"] += 1
        ok = sum(1 for n, s in secs if clean(s, kr["anga"]))
        st["strict"] += sum(1 for n, s in secs if dandas_ok(s, kr["anga"]))
        st["sections"] += len(secs)
        st["clean"] += ok
        st["whole"] += (ok == len(secs))
    print("kirtanas with a known tala : %d" % st["kirtanas"])
    print("sections verifying         : %d/%d (%.0f%%)"
          % (st["clean"], st["sections"], 100.0 * st["clean"] / max(1, st["sections"])))
    print("  of those, dandas also land on anga boundaries: %d" % st["strict"])
    print("kirtanas with a lyric row and no notation above it: %d"
          % st["with_orphans"])
    print("  (usually an extra caranam printed as words only, but it is also")
    print("   how a dropped notation line would show up)")
    print("kirtanas clean end to end  : %d (%.0f%%)  <- the loadable set"
          % (st["whole"], 100.0 * st["whole"] / max(1, st["kirtanas"])))
    return 0


def scan(pdf_path):
    """Where the remaining failures are, so the next fix can be aimed.

    Two views. By tala family, because a family that fails as a block points
    at the model rather than at the glyphs -- eka tala is notated with one
    anga, so its dandas cannot be anga boundaries and the containment test
    does not apply to it. And by page, because several rows of one piece
    missing by the SAME amount is the signature of a single cause; that is
    what turned up a svarajati being scored against the kirtana before it.
    """
    import re
    import unicodedata
    from collections import Counter, defaultdict

    st = _corpus(pdf_path)
    rows, ok, byfam = Counter(), Counter(), Counter()
    per, miss = defaultdict(Counter), Counter()
    for pi, kind, tal, anga, segs in st:
        if kind != "kirtana" or not anga:
            continue
        fam = tala.family(tal) or "?"
        byfam[fam] += 1
        total, unit = sum(segs), sum(anga)
        rows[fam] += 1
        best = None
        for k in (1, 2, 4):
            q = round(total / (unit * k))
            if q >= 1:
                d = total - unit * k * q
                if best is None or abs(d) < abs(best):
                    best = d
        if best is None:
            continue
        miss[round(best * 2) / 2] += 1
        if abs(best) < 1e-6:
            ok[fam] += 1
        else:
            per[pi][round(best * 2) / 2] += 1

    n = sum(miss.values())
    print("rows whose total is a whole number of avartanas: %d/%d (%.0f%%)\n"
          % (sum(ok.values()), n, 100.0 * sum(ok.values()) / max(1, n)))
    print("  tala family        rows    correct")
    for f in sorted(rows, key=lambda x: -rows[x]):
        print("  %-16s %6d   %5d  %3.0f%%"
              % (f, rows[f], ok[f], 100.0 * ok[f] / rows[f]))
    print("\n  miss distribution")
    for d, c in sorted(miss.items(), key=lambda kv: -kv[1])[:8]:
        print("  %+6.1f  %5d  %4.1f%%" % (d, c, 100.0 * c / n))
    hot = []
    for pi, c in per.items():
        d, k = c.most_common(1)[0]
        if k >= 4:
            hot.append((k, pi, d))
    hot.sort(reverse=True)
    print("\n  pages where >=4 rows of one kirtana miss by the same amount")
    for k, pi, d in hot[:8]:
        print("   page %-4d %d rows miss %+g" % (pi, k, d))
    return 0


def emit(pdf_path, out_path=None):
    """Write the kirtanas that verify end to end, as JSON.

    Only pieces whose every section lasts a whole number of avartanas are
    written. Each carries where it came from -- the volume's own page number,
    not a list position -- so a row in the database can be checked against the
    book.
    """
    import json
    import re

    pages = grid.load_pages(pdf_path)
    out, cur, sec = [], None, None
    ragam_of_janya, mela_ragam, printed = {}, None, None
    janya_re = re.compile(r"^([\d.]+)janya")

    for p in pages:
        if p["page"] < 40:
            continue
        rows = grid.page_lines(p)
        # "4.bhanumati - 35 -" : mela number, its raga, the printed page.
        # Read the raw line, not the folded one: folding strips the digits.
        foot = p.get("footer", "")
        m = re.match(r"^(\d+)\.(.+?)\u2014(\d+)\u2014", foot)
        if m:
            mela_ragam = m.group(2).strip()
            printed = int(m.group(3))
        for i, (y, line) in enumerate(rows):
            raw = "".join(g.ch for g in line)
            f = fold(raw)
            jm = janya_re.match(raw)
            if "\u2014" in raw and jm:
                # "22.10 janya (bhasanga) 3 - husani"
                ragam_of_janya[jm.group(1).rstrip(".")] = raw.split("\u2014")[-1].strip()
                continue
            h = header(raw)
            if h:
                num = re.match(r"^([\d.]+)", raw)
                parts = raw.split("\u2014")
                cur = {
                    "kind": h[0], "tala": h[1], "anga": tala.anga(h[1]) if h[1] else None,
                    "composer": parts[-1].strip() if len(parts) > 2 else None,
                    "number": num.group(1).rstrip(".") if num else None,
                    "page": p["page"], "printed_page": printed,
                    "mela_ragam": mela_ragam, "sections": [],
                }
                out.append(cur)
                sec = None
                continue
            if cur is None:
                continue
            if f in SECS:
                sec = f
                cur["sections"].append({"name": f, "lines": []})
                continue
            if not grid.is_svara_line(line):
                continue
            cells = grid.parse_svara_line(line, p["hrules"])
            lyric = rows[i + 1][1] if i + 1 < len(rows) and grid_lyric(rows[i + 1][1]) else None
            pair_sahitya(cells, lyric)
            if not cur["sections"]:
                cur["sections"].append({"name": "_", "lines": []})
            cur["sections"][-1]["lines"].append(cells)

    def duration_ok(segs, anga):
        total = sum(segs)
        if total <= 0:
            return False
        for k in (1, 2, 4):
            cycle = sum(anga) * k
            for off in ([0.0] + ([cycle - segs[0]] if segs and segs[0] < cycle else [])):
                q = (total + off) / cycle
                if abs(q - round(q)) < 1e-6 and round(q) >= 1:
                    return True
        return False

    good = []
    for kr in out:
        if kr["kind"] != "kirtana" or not kr["anga"]:
            continue
        secs = []
        for s in kr["sections"]:
            cells = grid.join_lines(s["lines"])
            if len(cells) < 6:
                continue
            segs = grid.segments(cells)
            if len(segs) < 2:
                continue
            secs.append((s["name"], cells, segs))
        if not secs or not all(duration_ok(g, kr["anga"]) for _, _, g in secs):
            continue

        rec = {k: kr[k] for k in ("tala", "anga", "composer", "number",
                                  "page", "printed_page", "mela_ragam")}
        rec["ragam"] = ragam_of_janya.get(
            ".".join((kr["number"] or "").split(".")[:2]), kr["mela_ragam"])
        rec["sections"] = []
        for name, cells, segs in secs:
            # An extension -- the mid-dot, the comma, the semicolon -- holds
            # the note before it. Exporting only the svara cells silently
            # dropped that time, so a section came out short of the avartana
            # count the audit had just verified.
            notes = []
            for c in cells:
                if c["t"] == "sv":
                    notes.append({"s": c["svara"], "o": c["oct"], "d": c["dur"],
                                  **({"syl": c["syl"]} if c.get("syl") else {}),
                                  **({"grace": True} if c.get("grace") else {}),
                                  **({"gamaka": c["gam"]} if c.get("gam") else {})})
                elif c["t"] == "ext" and notes:
                    held = next((n for n in reversed(notes) if not n.get("grace")), None)
                    if held is not None:
                        held["d"] += c["dur"]
            rec["sections"].append({
                "name": name, "aksharas": round(sum(segs), 4),
                "avartanas": round(sum(segs) / sum(kr["anga"]), 4),
                "notes": notes,
            })
        # SSP prints no title; a kirtana is known by the opening of its
        # pallavi. It also prints sahitya syllable by syllable with no word
        # boundaries, so the syllables are kept as they were set and also
        # joined, since the joined form is what matches a catalogue.
        first = next((s for s in rec["sections"] if s["name"] == "pallavi"),
                     rec["sections"][0])
        syls = [n["syl"] for n in first["notes"] if n.get("syl")]
        rec["opening_syllables"] = syls[:10]
        rec["title"] = "".join(s for s in syls[:10] if s not in "-\u2014")
        rec["pallavi_sahitya"] = " ".join(syls)
        good.append(rec)

    text = json.dumps(good, ensure_ascii=False, indent=1)
    if out_path:
        open(out_path, "w", encoding="utf-8").write(text)
        print("wrote %s -- %d kirtanas" % (out_path, len(good)))
    else:
        print(text)
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", nargs="?", default="tools/data/ssp/ssp_cakram1-4.pdf")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--emit", metavar="OUT.json", nargs="?", const="-",
                    help="write the kirtanas that verify end to end, as JSON")
    ap.add_argument("--scan", action="store_true",
                    help="where the remaining failures are, by tala family and page")
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
    if args.scan:
        sys.exit(scan(args.pdf))
    if args.emit:
        sys.exit(emit(args.pdf, None if args.emit == "-" else args.emit))
    pages = grid.load_pages(args.pdf)
    n = sum(1 for p in pages
            for y, l in grid.page_lines(p) if grid.is_svara_line(l))
    print("pages: %d, svara lines: %d" % (len(pages), n))


if __name__ == "__main__":
    main()
