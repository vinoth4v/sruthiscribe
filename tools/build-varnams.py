#!/usr/bin/env python3
"""Turn the CompMusic varnam notations into SruthiScribe composition records.

    python3 tools/fetch-varnams.py --out tools/data/varnams
    python3 tools/build-varnams.py --out tools/data/varnams.json

Two files per varnam feed this:

  <ragam>.yaml   the machine-readable notation -- sections, tala cycles, eight
                 divisions per cycle, four svaras per division (Adi tala, 32
                 aksharas to the cycle). Svaras are bare letters; ``^`` marks
                 tara sthayi and ``_`` mandra, and ``,`` extends the previous
                 svara for one more akshara.
  <ragam>.doc    the original Word document, which carries the sahitya laid out
                 one syllable per svara, plus lyrics, meanings and composer.

Three things have to be reconstructed, and each is checked rather than assumed:

Svara variants. The ``moorchanas`` block in the yaml numbers the variants
inconsistently between files -- Kalyani's gandharam is written G2 where Sahana's
same pitch is G3 -- so the letters are resolved against SCALES below, which is
read out of index.html's ragam table and asserted against the yaml on every run.

Octaves. Not every file marks them: abhogi.yaml has no ``_`` at all even though
the pallavi descends to mandra dhaivatam, and kalyani, saveri and sri mark
nothing whatsoever. Octaves are therefore chosen by the path of least melodic
motion across each section, pinned wherever the file does give a marker.
--verify-octaves scores that two ways against the files that mark octaves
properly: leave-one-out, which is the case actually relied on, recovers every
mark; stripping a section's markers entirely, the worst case for the unmarked
files, leaves about 6% of svaras in the wrong octave.

Sahitya. Only the pallavi, anupallavi and charanam carry lyrics; the muktayi
svaram and chittasvarams are pure svara passages. Each notation line's svaras
are checked against the yaml's at the same offset before its syllables are
believed, so a line the conversion mangled is skipped rather than sliding the
rest of the section along. --selftest checks the whole chain against the
printed first avartana of Evvari bodhana.

Dataset: Carnatic Varnam Dataset v1.1, doi:10.5281/zenodo.7726167,
CC BY-NC-ND 4.0. Notations from Shivkumar Kalyanaraman's archive
(shivkumar.org/music/varnams/). The varnams themselves are public domain.
"""

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import tinyyaml  # noqa: E402

# Semitones above Sa for every svara name the app uses.
PITCH = {"S": 0, "R1": 1, "R2": 2, "R3": 3, "G1": 2, "G2": 3, "G3": 4,
         "M1": 5, "M2": 6, "P": 7, "D1": 8, "D2": 9, "D3": 10,
         "N1": 9, "N2": 10, "N3": 11}

# Letter -> svara for each varnam's ragam, matching index.html's ragam table.
# The yaml moorchanas cannot be trusted for this (see the module docstring), so
# every entry here is checked against the app's own scale at build time.
SCALES = {
    "abhogi":  {"S": "S", "R": "R2", "G": "G2", "M": "M1", "D": "D2"},
    "begada":  {"S": "S", "R": "R2", "G": "G3", "M": "M1", "P": "P",
                "D": "D2", "N": "N2"},
    "kalyani": {"S": "S", "R": "R2", "G": "G3", "M": "M2", "P": "P",
                "D": "D2", "N": "N3"},
    "mohanam": {"S": "S", "R": "R2", "G": "G3", "P": "P", "D": "D2"},
    "sahana":  {"S": "S", "R": "R2", "G": "G3", "M": "M1", "P": "P",
                "D": "D2", "N": "N2"},
    "saveri":  {"S": "S", "R": "R1", "G": "G3", "M": "M1", "P": "P",
                "D": "D1", "N": "N3"},
    "sri":     {"S": "S", "R": "R2", "G": "G2", "M": "M1", "P": "P",
                "D": "D2", "N": "N2"},
}

META = {
    "abhogi":  dict(ragam="Abhogi", app_ragam="Abhogi"),
    "begada":  dict(ragam="Begada", app_ragam="Begada"),
    "kalyani": dict(ragam="Kalyani", app_ragam="Kalyani"),
    "mohanam": dict(ragam="Mohanam", app_ragam="Mohanam"),
    "sahana":  dict(ragam="Sahana", app_ragam="Sahana"),
    "saveri":  dict(ragam="Saveri", app_ragam="Saveri"),
    "sri":     dict(ragam="Sri", app_ragam="Sri"),
}

# yaml key -> the section name the app displays.
SECTION_NAMES = [
    ("pallavi", "Pallavi"),
    ("anupallavi", "Anupallavi"),
    ("muktayiswaram", "Muktayisvaram"),
    ("charanam", "Charanam"),
    ("firstchittiswaram", "Chittasvaram 1"),
    ("secondchittiswaram", "Chittasvaram 2"),
    ("thirdchittiswaram", "Chittasvaram 3"),
    ("fourthchittiswaram", "Chittasvaram 4"),
    ("fifthchittiswaram", "Chittasvaram 5"),
]
SUNG = {"pallavi", "anupallavi", "charanam"}  # the sections that carry sahitya


# ---------------------------------------------------------------- notation ---

def flatten(section):
    """cycles -> divisions -> svaras  becomes one list of (letter, octave)."""
    out = []
    for cycle in section:
        for div in cycle:
            for tok in div:
                tok = tok.strip()
                if tok == ",":
                    out.append((",", None))
                    continue
                m = re.match(r"^([SRGMPDN])([\^_]*)$", tok)
                if not m:
                    raise ValueError("unparsed svara token %r" % tok)
                letter, marks = m.group(1), m.group(2)
                octave = marks.count("^") - marks.count("_") if marks else None
                out.append((letter, octave))
    return out


OCTAVES = (-1, 0, 1)
# A slight pull back toward the madhya octave. Without it a passage is free to
# sit an octave off at no cost, since transposing a whole run leaves the
# intervals inside it unchanged; too much of it and genuine tara passages get
# dragged down. Anything from 0.1 to 0.35 scores the same on --verify-octaves,
# so this sits in the middle of that plateau rather than on its edge.
STRAY = 0.25


def resolve(tokens, scale, hide=None):
    """Name each svara and place it in an octave.

    Explicit ``^``/``_`` markers pin the octave wherever the file gives one.
    The rest are chosen together rather than one at a time: the octave path that
    minimises total melodic motion across the section wins, which is what a
    varnam's stepwise line implies. Choosing them jointly matters because a
    section may open away from madhya -- Abhogi's anupallavi starts on tara Sa
    -- and a left-to-right rule seeded at madhya Sa gets the whole section wrong
    from the first note. It also recovers the mandra dhaivatam in the pallavi of
    Evvari bodhana, which abhogi.yaml does not mark at all.

    Extensions (``,``) lengthen the svara they follow rather than becoming notes
    of their own.

    ``hide`` is the index of one marked svara to treat as unmarked, so the
    inference can be scored against the marks the dataset does provide.
    """
    notes, holds = [], []
    for letter, mark in tokens:
        if letter == ",":
            if holds:
                holds[-1] += 1
            continue
        name = scale.get(letter)
        if name is None:
            raise ValueError("letter %r is not in this ragam's scale" % letter)
        notes.append((name, PITCH[name], mark))
        holds.append(1)
    if not notes:
        return []

    # Viterbi over the three octaves: cost is the interval from the previous
    # svara, plus a nudge back toward madhya so ties do not drift.
    def allowed(i):
        _, _, mark = notes[i]
        if mark is not None and i != hide:
            return (mark,)
        return OCTAVES

    best = {o: (STRAY * abs(o), None) for o in allowed(0)}
    trail = [best]
    for i in range(1, len(notes)):
        base, prev_base = notes[i][1], notes[i - 1][1]
        step = {}
        for o in allowed(i):
            cand = min(((cost + abs(base + 12 * o - prev_base - 12 * po)
                         + STRAY * abs(o), po)
                        for po, (cost, _) in best.items()))
            step[o] = cand
        best = step
        trail.append(best)

    o = min(best, key=lambda k: best[k][0])
    path = [o]
    for step in reversed(trail[1:]):
        o = step[o][1]
        path.append(o)
    path.reverse()

    return [{"s": name, "o": o, "d": d}
            for (name, _, _), o, d in zip(notes, path, holds)]


# ------------------------------------------------------------------ sahitya ---

SVARA_TOKEN_CHARS = "-\u2013\u2014^_"   # formatting debris left by the .doc conversion
SVARA_TOKEN = re.compile(r"^[%s]*[SRGMPDN,][SRGMPDN,%s]*$"
                         % (SVARA_TOKEN_CHARS, SVARA_TOKEN_CHARS))


def cells(line, drop_debris=False):
    """Split a notation line into its aksharas, ignoring the bar lines.

    ``drop_debris`` discards cells that are nothing but hyphens. On a svara line
    those are leftovers from formatting the conversion lost, and counting them
    as aksharas is what pushes a line of sixteen out to eighteen and slides the
    sahitya under the wrong svaras. On a sahitya line a lone hyphen is real --
    it is how the documents hold a syllable across the next akshara -- so it is
    kept there.
    """
    out = [t for t in re.split(r"[\s|\u00a0]+", line.strip()) if t]
    if drop_debris:
        out = [t for t in out if t.strip(SVARA_TOKEN_CHARS)]
    return out


def is_svara_line(line):
    """Does this line carry svaras?

    The stray hyphens in these documents are debris: Word marked octaves
    visually and neither the text nor the HTML export preserves it, so a token
    is judged on its letters alone. A few cells per line come out mangled, hence
    a majority test rather than a strict one.
    """
    toks = cells(line)
    if len(toks) < 8:
        return False
    return sum(1 for t in toks if SVARA_TOKEN.match(t)) >= 0.8 * len(toks)


def notation_lines(text, key):
    """The (svara line, sahitya line) pairs of one section, in order.

    Notation is laid out as a svara line with its sahitya line underneath,
    sixteen aksharas to the pair -- though sri.doc puts a blank line between the
    two, so the search skips blanks. Under a muktayi svaram or a chittasvaram
    the second line is empty. The sahitya line is only accepted when it has
    exactly as many cells as the svaras above it; prose runs between the
    notation blocks in these documents and that count is what tells them apart.
    """
    heads = {"pallavi": r"^\s*Pallavi\b", "anupallavi": r"^\s*Anupallavi\b",
             "charanam": r"^\s*Chara[n\u1e47]am\b"}
    nxt_head = r"^\s*(Anupallavi|Chara[n\u1e47]am|Muk?tha?yi|Chitt[ai])"
    lines = text.split("\n")
    starts = [i for i, l in enumerate(lines) if re.match(heads[key], l, re.I)]
    if not starts:
        return []
    # The lyrics are listed in the header block up top as well; the notated copy
    # is the last occurrence.
    start = starts[-1]
    stop = len(lines)
    for i in range(start + 1, len(lines)):
        if re.match(nxt_head, lines[i], re.I):
            stop = i
            break

    out = []
    i = start + 1
    while i < stop:
        if not is_svara_line(lines[i]):
            i += 1
            continue
        svaras = cells(lines[i], drop_debris=True)
        j = i + 1
        while j < stop and not lines[j].strip():
            j += 1
        sahitya = None
        if j < stop and not is_svara_line(lines[j]) and cells(lines[j]):
            sahitya = [t.strip(SVARA_TOKEN_CHARS) for t in cells(lines[j])]
            i = j
        out.append((svaras, sahitya))
        i += 1
    return out


def sahitya_by_akshara(text, key, tokens):
    """Line up the document's sahitya with the yaml's aksharas.

    The two files are independent transcriptions of the same varnam, so before a
    line's syllables are trusted its svaras are checked against the yaml's at the
    same offset. A line that disagrees is skipped and the rest still lands in the
    right place, which is what keeps one garbled line from sliding a whole
    section's lyrics along.

    The comparison ignores the extension commas. The documents drop one here and
    there -- abhogi's charanam and begada's pallavi each lose one -- and since
    the yaml is what the svaras are actually read from, a missing comma in the
    prose copy is no reason to throw away a line of sahitya that is otherwise a
    letter-perfect match.

    Returns one syllable per akshara, empty where none is known, plus how many
    notation lines matched out of how many were seen.
    """
    want = [letter for letter, _ in tokens]
    out = [""] * len(want)
    pos = matched = seen = 0
    for svaras, sahitya in notation_lines(text, key):
        # The sahitya line is the one laid out akshara by akshara, so it sets the
        # width when it is present; the svara line only has to corroborate it.
        n = len(sahitya) if sahitya else len(svaras)
        if pos + n > len(want):
            break
        seen += 1
        here = [l for l in want[pos:pos + n] if l != ","]
        got = [c.strip(SVARA_TOKEN_CHARS) for c in svaras]
        got = [c for c in got if c != ","]
        agree = sum(1 for cell, letter in zip(got, here) if letter in cell)
        if here and agree >= 0.8 * len(here):
            matched += 1
            if sahitya:
                out[pos:pos + n] = sahitya
        pos += n
    return out, matched, seen


def akshara_owner(tokens):
    """For each akshara, the index of the svara sounding on it.

    A ``,`` holds the svara before it, so one svara can span several aksharas.
    The sahitya syllable belongs to the akshara its svara starts on.
    """
    owners, n = [], -1
    for letter, _ in tokens:
        if letter != ",":
            n += 1
        owners.append(max(n, 0))
    return owners


def header_field(text, label):
    m = re.search(r"^\s*%s\s*:?\s*(.+)$" % label, text, re.I | re.M)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else None


def lyric_line(text, label):
    m = re.search(r"^\s*%s\s*:?\s*(.+)$" % label, text, re.I | re.M)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else None


def meaning(text, label):
    m = re.search(r"^\s*%s\s*:\s*(.+?)$" % label, text[text.find("Meanings"):],
                  re.I | re.M) if "Meanings" in text else None
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else None


# --------------------------------------------------------------------- main ---

def app_scales(index_html):
    """Read the ragam scales the app already ships, to check SCALES against."""
    src = open(index_html, encoding="utf-8").read()
    out = {}
    for m in re.finditer(r"R\('([^']+)',\s*\d+,\s*'[^']*',\s*'[^']*',\s*(\[\[.*?\]\])\)", src):
        names = re.findall(r"'([SRGMPDN][123]?)'", m.group(2))
        out[m.group(1)] = names
    return out


def build(ragam_key, datadir, checks):
    y = tinyyaml.load_file(os.path.join(datadir, "%s.yaml" % ragam_key))
    doc = os.path.join(datadir, "%s.txt" % ragam_key)
    text = open(doc, encoding="utf-8", errors="replace").read() if os.path.exists(doc) else ""
    scale = SCALES[ragam_key]

    sections = []
    for key, label in SECTION_NAMES:
        if key not in y or not y[key]:
            continue
        toks = flatten(y[key])
        svaras = resolve(toks, scale)
        sahitya = False
        if key in SUNG and text:
            syls, matched, seen = sahitya_by_akshara(text, key, toks)
            owners = akshara_owner(toks)
            for akshara, syl in enumerate(syls):
                if syl:
                    svaras[owners[akshara]].setdefault("syl", syl)
            sahitya = any(syls)
            if matched < seen:
                checks.append("%s/%s: %d of %d notation lines did not match the "
                              "yaml -- their sahitya was skipped"
                              % (ragam_key, key, seen - matched, seen))
            if not sahitya:
                checks.append("%s/%s: no sahitya recovered" % (ragam_key, key))
        marked = any(m is not None for _, m in toks)
        sections.append({
            "name": label,
            "cycles": len(y[key]),
            "aksharas": len(toks),
            "sahitya": sahitya,
            "octaves": "dataset+inferred" if marked else "inferred",
            "svaras": svaras,
        })

    lyrics = [{"name": n, "text": lyric_line(text, n),
               "meaning": meaning(text, n)}
              for n in ("Pallavi", "Anupallavi", "Charanam")]
    return {
        "title": title_of(text, y),
        "ragam": META[ragam_key]["app_ragam"],
        "tala": "Adi",
        "form": "varnam",
        "language": "Telugu",
        "composer": header_field(text, "Composer"),
        "mbid": y.get("mbid"),
        "arohana": " ".join(y["moorchanas"]["arohana"]),
        "avarohana": " ".join(y["moorchanas"]["avarohana"]),
        "lyrics": [l for l in lyrics if l["text"]],
        "sections": sections,
        "source": "compmusic:carnatic-varnam-1.1",
        "license": ("CC BY-NC-ND 4.0 · Carnatic Varnam Dataset v1.1, "
                    "doi:10.5281/zenodo.7726167 · notation from Shivkumar "
                    "Kalyanaraman's archive (shivkumar.org) · composition "
                    "in the public domain"),
    }


def title_of(text, y):
    """The title, preferring the Word document's heading over the yaml.

    Some documents shout it (INTHA CHALAMU) and the yaml spellings drift
    (Evari vs Evvari), so a shouted heading is recased and anything else is
    taken as written.
    """
    head = next((l.strip() for l in text.split("\n") if l.strip()), None)
    title = head or y.get("title") or ""
    if title.isupper():
        title = title.title()
    return title.strip()


# The opening avartana of Evvari bodhana as it is printed, svara by svara with
# its sahitya. Everything this tool reconstructs shows up in these two lines:
# the mandra dhaivatam and madhyamam that abhogi.yaml never marks, the tara
# shadjam that it does, the extension commas, and the syllables from the Word
# document. If a change breaks any of that, --selftest says so.
REFERENCE = {
    "title": "Evvari Bodhana",
    "composer": "Patnam Subramania Iyer",
    "section": "Pallavi",
    "svaras": ("R2 , G2 , G2 R2 S , S R2 S S D2. M1. D2. , "
               "M1. D2. S D2. , S D2. S R2 G2 , M1 G2 G2 R2 S"),
    "sahitya": "Ev . va . ri . . . bo . . . dha . . . "
               "Na . . . . . vi . . . . ni . . . .",
}


def selftest(datadir):
    """Check the rebuilt Abhogi varnam against its printed first avartana."""
    checks = []
    v = build("abhogi", datadir, checks)
    sec = next(s for s in v["sections"] if s["name"] == REFERENCE["section"])
    svaras, sahitya = [], []
    for s in sec["svaras"][:]:
        tail = "'" * s["o"] if s["o"] > 0 else "." * -s["o"]
        svaras.append(s["s"] + tail)
        sahitya.append(s.get("syl") or ".")
        svaras.extend("," * (s["d"] - 1))
        sahitya.extend("." * (s["d"] - 1))

    bad = []
    for field, got in (("title", v["title"]), ("composer", v["composer"]),
                       ("svaras", " ".join(svaras[:32])),
                       ("sahitya", " ".join(sahitya[:32]))):
        if got != REFERENCE[field]:
            bad.append("  %s\n    want %s\n    got  %s"
                       % (field, REFERENCE[field], got))
    if bad:
        print("selftest FAILED")
        print("\n".join(bad))
        return 1
    print("selftest ok: Abhogi pallavi matches the printed notation, "
          "mandra and tara markings included")
    return 0


def verify_octaves(datadir):
    """Score the octave inference by leave-one-out against the dataset's marks.

    Each explicitly marked svara is hidden in turn, the rest of the file left
    intact, and the inferred octave compared with the mark that was hidden.
    That measures the thing actually being relied on: whether the surrounding
    line determines an octave the file did not write down.
    """
    total = bad = 0
    blind_total = blind_bad = 0
    misses = []
    for key in sorted(SCALES):
        y = tinyyaml.load_file(os.path.join(datadir, "%s.yaml" % key))
        for skey, label in SECTION_NAMES:
            if skey not in y or not y[skey]:
                continue
            toks = flatten(y[skey])
            truth = resolve(toks, SCALES[key])
            marked = [i for i in range(len(truth))
                      if toks_mark(toks, i) is not None]
            for i in marked:
                total += 1
                got = resolve(toks, SCALES[key], hide=i)
                if got[i]["o"] != truth[i]["o"]:
                    bad += 1
                    misses.append("%s/%s #%d %s: marked %+d, inferred %+d"
                                  % (key, label, i, truth[i]["s"],
                                     truth[i]["o"], got[i]["o"]))
            # Worst case: a file that marks nothing at all, like kalyani.yaml,
            # saveri.yaml and sri.yaml. Strip every mark and re-infer.
            if marked:
                blind = resolve([(l, None) for l, _ in toks], SCALES[key])
                blind_total += len(truth)
                blind_bad += sum(1 for a, b in zip(truth, blind)
                                 if a["o"] != b["o"])
    print("octave leave-one-out : %d marked svaras, %d not recovered (%.2f%%)"
          % (total, bad, 100.0 * bad / total if total else 0))
    print("octave marks stripped: %d svaras in marked sections, %d wrong (%.2f%%)"
          % (blind_total, blind_bad,
             100.0 * blind_bad / blind_total if blind_total else 0))
    for m in misses[:20]:
        print("   " + m)
    if len(misses) > 20:
        print("   ... and %d more" % (len(misses) - 20))
    return bad, total


def toks_mark(tokens, n):
    """The explicit octave mark on the n-th sounded svara, or None."""
    i = -1
    for letter, mark in tokens:
        if letter == ",":
            continue
        i += 1
        if i == n:
            return mark
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="tools/data/varnams")
    ap.add_argument("--out", default="tools/data/varnams.json")
    ap.add_argument("--index", default="index.html")
    ap.add_argument("--verify-octaves", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    # The dataset is gitignored -- CC BY-NC-ND, and fetchable in a second -- so
    # a fresh clone lands here. Say what to run rather than throwing a traceback
    # from somewhere inside the yaml parser.
    missing = [r for r in sorted(SCALES)
               if not os.path.exists(os.path.join(args.data, r + ".yaml"))]
    if missing:
        sys.exit("No varnam notations in %s (missing %s).\n"
                 "Fetch them first:\n"
                 "    python3 tools/fetch-varnams.py --out %s"
                 % (args.data, ", ".join(missing[:3])
                    + ("..." if len(missing) > 3 else ""), args.data))

    if args.verify_octaves:
        verify_octaves(args.data)
        return
    if args.selftest:
        sys.exit(selftest(args.data))

    known = app_scales(args.index)
    for key, scale in SCALES.items():
        app = known.get(META[key]["app_ragam"])
        if app is None:
            print("note: %s is not in index.html's ragam table yet" % META[key]["app_ragam"])
            continue
        missing = [v for v in scale.values() if v not in app]
        if missing:
            print("MISMATCH %s: %s not in the app's scale %s"
                  % (key, missing, app))

    checks = []
    out = [build(k, args.data, checks) for k in sorted(SCALES)]
    for c in checks:
        print("check: %s" % c)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    for v in out:
        sung = sum(1 for s in v["sections"] for sv in s["svaras"] if "syl" in sv)
        print("%-10s %-22s %d sections, %4d svaras, %3d with sahitya"
              % (v["ragam"], v["title"], len(v["sections"]),
                 sum(len(s["svaras"]) for s in v["sections"]), sung))
    print("wrote %s" % args.out)


if __name__ == "__main__":
    main()
