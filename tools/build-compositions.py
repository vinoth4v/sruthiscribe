#!/usr/bin/env python3
"""Build composition metadata from Wikipedia's composer lists.

    python3 tools/build-compositions.py --report     # coverage and what fails to match
    python3 tools/build-compositions.py --out tools/data/compositions.json

Wikipedia has two large machine-readable composition lists -- Tyagaraja's and
Muthuswami Dikshitar's -- laid out as wikitables of composition / raga / tala,
grouped under section headings that name the set (Pancharatna, Navagraha, the
Guruguha vibhakti kritis, and so on). Everything else is prose or does not exist,
so this is the whole of what can be imported mechanically.

Nothing here invents notation. These rows are metadata: title, ragam, tala,
language, and which group the piece belongs to. That is the honest ceiling for
compositions whose notation is not openly licensed -- see the module docstring in
tools/build-varnams.py for why that is the case.

The work is in the matching. The lists spell ragams a dozen ways -- Todi for
Hanumatodi, Sankarabharanam for Shankarabharanam, "Vegavahini(Chakravagam)" with
the mela name in brackets -- so names are folded to bare letters and looked up
against the ragam library built by tools/build-ragams.py, including its alternate
names. Whatever still fails to match is reported rather than guessed at.

Wikipedia text is CC BY-SA 4.0.
"""

import argparse
import json
import os
import re
import sys
import unicodedata
import urllib.parse
import urllib.request

API = "https://en.wikipedia.org/w/api.php"
UA = "SruthiScribe/1.0 (carnatic library build)"

SOURCES = [
    {"page": "List of compositions by Tyagaraja",
     "composer": "Tyagaraja", "language": "Telugu",
     "fallback": {"title": 1, "ragam": 2, "tala": 3, "language": 4}},
    {"page": "List of compositions by Muthuswami Dikshitar",
     "composer": "Muthuswami Dikshitar", "language": "Sanskrit",
     "fallback": {"title": 0, "ragam": 1, "tala": 2}},
]

# The suladi sapta talas as the app names them, plus the chapu talas, keyed by
# the folded spellings these pages actually use.
TALAS = {
    "adi": "Adi", "aadi": "Adi",
    "rupaka": "Rupaka", "rupakam": "Rupaka", "roopakam": "Rupaka",
    "rupakachapu": "Rupaka", "misrachapu": "Misra chapu", "mchapu": "Misra chapu",
    "misrachaapu": "Misra chapu", "mishrachapu": "Misra chapu",
    "khandachapu": "Khanda chapu", "kchapu": "Khanda chapu",
    "khandachaapu": "Khanda chapu", "kandachapu": "Khanda chapu",
    "triputa": "Triputa", "tripta": "Triputa",
    "jhampa": "Jhampa", "jampa": "Jhampa", "misrajhampa": "Jhampa",
    "ata": "Ata", "atta": "Ata", "khandaata": "Khanda Ata",
    "dhruva": "Dhruva", "matya": "Matya", "matyam": "Matya",
    "eka": "Eka", "ekam": "Eka",
    "chathushraeka": "Chaturasra Eka", "chatushraeka": "Chaturasra Eka",
    "chaturasraeka": "Chaturasra Eka", "chaturasrareka": "Chaturasra Eka",
    "tisraeka": "Tisra Eka", "thisraeka": "Tisra Eka", "trisraeka": "Tisra Eka",
    "khandaeka": "Khanda Eka", "misraeka": "Misra Eka",
    "sankeernaeka": "Sankirna Eka", "sankirnaeka": "Sankirna Eka",
    "tisratriputa": "Tisra Triputa", "chaturasratriputa": "Adi",
    "desadi": "Desadi", "madhyadi": "Madhyadi",
}


def fold(s):
    """Bare letters, for matching names spelled a dozen different ways."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z]", "", s.lower())


# Romanisation of Carnatic names is not standardised, and these pages mix every
# convention there is: Sankarabharanam and Shankarabharanam, Athana and Atana,
# Rītigauḷa and Reethigowla, Māyāmāḻavagauḻa and Mayamalavagowla. Folding to bare
# letters is not enough -- the differences are systematic, so they are undone
# systematically. Order matters: digraphs before the vowels they contain.
PHONETIC = [
    ("ph", "p"), ("bh", "b"), ("gh", "g"), ("kh", "k"), ("jh", "j"),
    ("dh", "d"), ("th", "t"), ("ch", "c"), ("sh", "s"),
    ("aa", "a"), ("ee", "i"), ("ii", "i"), ("oo", "u"), ("uu", "u"),
    ("ai", "e"), ("ay", "e"), ("au", "o"), ("ow", "o"), ("ou", "o"),
    ("w", "v"), ("z", "j"), ("q", "k"), ("x", "ks"),
    ("y", "i"), ("j", "c"),
]


def phon(s):
    """A spelling-insensitive key for a Carnatic name.

    Collapses the aspirated/unaspirated and sibilant distinctions that
    transliteration disagrees about, the long and short vowels, and the
    au/ow/ou family, then squeezes runs of a repeated letter.

    Two more come from the Sanskrit: the anusvāra is written ṃ but takes the
    place of whichever nasal follows it, so Śaṃkarābharaṇaṃ and Shankarabharanam
    are the same word; and vocalic ṛ is usually romanised "ri", so Amṛta and
    Amritha are too. Both nasals fold together, which loses a distinction -- a
    phonetic key that then matches two different ragams is discarded rather than
    guessed at, in ragam_index().
    """
    s = (s or "").replace("ṛ", "ri").replace("ṝ", "ri")
    s = fold(s)
    for a, b in PHONETIC:
        s = s.replace(a, b)
    s = s.replace("m", "n")
    return re.sub(r"(.)\1+", r"\1", s)


def fetch(page, cache):
    path = os.path.join(cache, re.sub(r"\W+", "_", page) + ".wiki")
    if os.path.exists(path):
        return open(path, encoding="utf-8").read()
    q = urllib.parse.urlencode({"action": "parse", "page": page,
                                "prop": "wikitext", "format": "json",
                                "formatversion": "2"})
    req = urllib.request.Request(API + "?" + q, headers={"User-Agent": UA})
    text = json.load(urllib.request.urlopen(req))["parse"]["wikitext"]
    os.makedirs(cache, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return text


def plain(cell):
    """Strip wiki markup down to readable text.

    [[Target|Display]] keeps the display text, which is the spelling a reader
    sees; templates, refs, bold and italic markers and the Telugu or Tamil script
    that follows a <br/> all come off.
    """
    cell = re.sub(r"<ref[^>]*>.*?</ref>", "", cell, flags=re.S | re.I)
    cell = re.sub(r"<ref[^>]*/>", "", cell, flags=re.I)
    cell = re.sub(r"<br\s*/?>.*$", "", cell, flags=re.S | re.I)
    cell = re.sub(r"\{\{[^{}]*\}\}", "", cell)
    cell = re.sub(r"\[\[[^\]|]*\|([^\]]*)\]\]", r"\1", cell)
    cell = re.sub(r"\[\[([^\]]*)\]\]", r"\1", cell)
    cell = re.sub(r"<[^>]+>", "", cell)
    cell = cell.replace("'''", "").replace("''", "")
    # The Indic script after a title is the same title again, so those words come
    # off -- but a word at a time, not a character at a time. These pages sprinkle
    # single Indic letters inside otherwise romanised names (Nīḷāṃbari carries a
    # Malayalam ḷ, Kalyāṇi a Tamil ṇ), and stripping those by codepoint turns the
    # name into "Niāṃbari" and loses the match. Left alone, fold() drops them and
    # the surrounding letters still spell the ragam.
    cell = " ".join(w for w in cell.split() if not indic_word(w))
    return re.sub(r"\s+", " ", cell).strip(" \t|")


def INDIC(ch):
    o = ord(ch)
    return (0x0900 <= o <= 0x0DFF      # Devanagari .. Malayalam
            or 0x0E00 <= o <= 0x0FFF   # Thai, Tibetan
            or 0x11300 <= o <= 0x1137F)  # Grantha


def indic_word(word):
    letters = [c for c in word if c.isalpha()]
    if not letters:
        return False
    return sum(1 for c in letters if INDIC(c)) >= 0.6 * len(letters)


# Header text -> the field it holds. The two pages label their columns
# differently and some tables carry extra ones, so every table is read through
# its own header rather than by position.
HEADERS = {
    "composition": "title", "kriti": "title", "krithi": "title", "kruti": "title",
    "song": "title", "name": "title", "compositions": "title", "krithis": "title",
    "raga": "ragam", "ragam": "ragam", "raagam": "ragam", "raaga": "ragam",
    "rāga": "ragam", "ragas": "ragam",
    "tala": "tala", "talam": "tala", "taala": "tala", "taalam": "tala",
    "tāḷa": "tala", "thala": "tala", "thalam": "tala",
    "language": "language", "deity": "deity", "god": "deity",
    "kshetra": "place", "kshetram": "place", "temple": "place",
    "place": "place", "sthala": "place",
}


def column_map(header_cells):
    """Which table column holds which field, read off the header row.

    Dikshitar's page runs tables of three columns and tables of five, sometimes
    with the deity or the temple in between, so reading columns by position gets
    ragams into the tala field and titles into the ragam field.
    """
    out = {}
    for i, cell in enumerate(header_cells):
        key = fold(cell)
        for head, field in HEADERS.items():
            if key == fold(head):
                out.setdefault(field, i)
                break
    return out if "title" in out and "ragam" in out else None


def parse(text, fallback):
    """Walk the wikitables, carrying the section heading each row sits under."""
    rows, heading, cols, in_table = [], None, None, False
    for line in text.split("\n"):
        h = re.match(r"^\s*(={2,6})\s*(.+?)\s*\1\s*$", line)
        if h:
            heading = plain(h.group(2)) or None
            continue
        if line.startswith("{|"):
            in_table, cols = True, None
            continue
        if line.startswith("|}"):
            in_table = False
            continue
        if not in_table:
            continue
        if line.startswith("!"):
            cells = [plain(c) for c in re.split(r"\!\!|\|\|", line.lstrip("!"))]
            cols = column_map(cells) or cols
            continue
        if line.startswith("|-") or not line.startswith("|"):
            continue
        cells = [plain(c) for c in re.split(r"\|\||\!\!", line.lstrip("|"))]
        use = cols or fallback
        if not use or max(use.values()) >= len(cells):
            continue
        row = {f: cells[i] for f, i in use.items()}
        if not row.get("title") or not row.get("ragam"):
            continue
        # A header repeated mid-table, and rows where the "title" is really a
        # numbering column that slipped.
        if fold(row["title"]) in ("composition", "kriti", "krithi", "song"):
            continue
        row["group"] = heading
        rows.append(row)
    return rows


def ragam_index(ragams):
    """Two lookups: exact letters first, then the spelling-insensitive key.

    The phonetic key can collide (it is deliberately lossy), so an exact fold
    always wins and a phonetic key that matches more than one ragam is dropped
    rather than resolved arbitrarily.
    """
    exact, phonetic, clashes = {}, {}, set()
    for r in ragams:
        for name in [r["name"]] + list(r.get("alt_names") or []):
            exact.setdefault(fold(name), r["name"])
            k = phon(name)
            if k in phonetic and phonetic[k] != r["name"]:
                clashes.add(k)
            phonetic.setdefault(k, r["name"])
    for k in clashes:
        phonetic.pop(k, None)
    return {"exact": exact, "phon": phonetic}


def match_ragam(raw, idx):
    """Resolve a ragam as written on the page to a name in the library.

    The lists qualify names in brackets -- "Vegavahini(Chakravagam)",
    "Kashiramakriya(Kamavardhini/Panthuvarali)", "Jenjuti (Chenjuruti)" -- and
    each alternative is worth trying, since which one the library knows varies.
    """
    if not raw:
        return None, None
    candidates = []
    outer = re.sub(r"\([^)]*\)", "", raw)
    candidates.append(outer)
    for inner in re.findall(r"\(([^)]*)\)", raw):
        candidates.extend(inner.split("/"))
    candidates.extend(outer.split("/"))
    candidates = [c.strip() for c in candidates if c.strip()]
    # Sanskrit and Tamil disagree about the nominative ending, so the same ragam
    # is Mohana or Mohanam, Hindola or Hindolam, Saurashtra or Saurashtram.
    for c in list(candidates):
        candidates.append(c + "m")
        if c.endswith("m"):
            candidates.append(c[:-1])
    for lookup, key in (("exact", fold), ("phon", phon)):
        for c in candidates:
            hit = idx[lookup].get(key(c))
            if hit:
                return hit, None
    return None, raw


JATHIS = {"tisra": "Tisra", "trisra": "Tisra", "thisra": "Tisra",
          "chaturasra": "Chaturasra", "chathushra": "Chaturasra",
          "chatusra": "Chaturasra", "khanda": "Khanda", "kanda": "Khanda",
          "misra": "Misra", "mishra": "Misra",
          "sankirna": "Sankirna", "sankeerna": "Sankirna"}
TALA_PHON = None


def match_tala(raw):
    """Resolve a tala, splitting off a jathi prefix when there is one.

    The pages write "Khanda Triputa" and "Chaturasra Rupakam" as well as the
    bare names, and phonetics vary as much as they do for ragams -- Miśra cāpu,
    miSra cApu, Misra Chapu are all the same tala.
    """
    global TALA_PHON
    if TALA_PHON is None:
        TALA_PHON = {}
        for k, v in TALAS.items():
            TALA_PHON.setdefault(phon(k), v)
    if not raw:
        return None, None
    cleaned = re.sub(r"\(.*?\)", " ", raw)
    cleaned = re.sub(r"\b(jati|jathi|talam?|nadai)\b", " ", cleaned, flags=re.I)
    for key in (fold(cleaned), phon(cleaned)):
        table = TALAS if key == fold(cleaned) else TALA_PHON
        if key in table:
            return table[key], None
    # "Khanda Triputa" -- a jathi in front of one of the seven.
    words = [w for w in re.split(r"\s+", cleaned.strip()) if w]
    if len(words) >= 2:
        jathi = JATHIS.get(phon(words[0]))
        rest = phon("".join(words[1:]))
        if jathi and rest in TALA_PHON:
            base = TALA_PHON[rest]
            # Chaturasra Triputa is the tala everyone calls Adi.
            if jathi == "Chaturasra" and base == "Triputa":
                return "Adi", None
            # A jathi only varies the laghu, so it means nothing for the chapu
            # talas or for one already carrying a jathi.
            takes_jathi = ("Triputa", "Eka", "Dhruva", "Matya", "Jhampa", "Ata")
            return (jathi + " " + base if base in takes_jathi else base), None
    return None, raw


def language(raw, default):
    f = fold(raw or "")
    for lang in ("Telugu", "Sanskrit", "Tamil", "Kannada", "Malayalam"):
        if fold(lang) in f:
            return lang
    return default


def build(args):
    ragams = json.load(open(args.ragams, encoding="utf-8"))
    idx = ragam_index(ragams)
    out, bad_ragam, bad_tala = [], {}, {}
    for src in SOURCES:
        rows = parse(fetch(src["page"], args.cache), src["fallback"])
        for row in rows:
            ragam, miss_r = match_ragam(row.get("ragam"), idx)
            tala, miss_t = match_tala(row.get("tala"))
            if miss_r:
                bad_ragam[miss_r] = bad_ragam.get(miss_r, 0) + 1
            if miss_t:
                bad_tala[miss_t] = bad_tala.get(miss_t, 0) + 1
            title = re.sub(r"^\d+[.\s]*", "", row["title"]).strip()
            if not title:
                continue
            out.append({
                "title": title,
                "composer": src["composer"],
                # An unresolved ragam keeps the spelling the page published --
                # dropping it would lose real information, and a null would
                # claim the composition has no ragam at all.
                "ragam": ragam or (row.get("ragam") or "").strip(),
                "ragam_matched": bool(ragam),
                "tala": tala,
                "tala_raw": row.get("tala"),
                "language": language(row.get("language"), src["language"]),
                "deity": row.get("deity") or None,
                "place": row.get("place") or None,
                "group": row.get("group"),
                "source": "wikipedia:" + src["page"].replace(" ", "_"),
            })
    return out, bad_ragam, bad_tala


def to_sql(rows):
    """One statement per source page, rows as pipe-delimited lines.

    Composer, source page and default language are the same for a whole page, so
    they go in as arguments instead of being repeated four hundred times -- that
    alone is a third of the payload. Same shape as the ragam loader otherwise.
    """
    def cell(v):
        return "" if v is None else str(v).replace("|", "/").replace("\n", " ").strip()

    out = []
    for src in SOURCES:
        mine = [r for r in rows if r["source"].endswith(src["page"].replace(" ", "_"))]
        if not mine:
            continue
        lines = []
        for r in mine:
            lines.append("|".join([
                cell(r["title"]), cell(r["ragam"]),
                "1" if r["ragam_matched"] else "",
                cell(r["tala"]),
                "" if r["language"] == src["language"] else cell(r["language"]),
                cell(r.get("deity")), cell(r.get("place")), cell(r.get("group")),
            ]))
        out.append("select * from load_wikipedia_compositions($C$\n"
                   + "\n".join(lines) + "\n$C$, %s, %s, %s);"
                   % ("'" + src["composer"].replace("'", "''") + "'",
                      "'wikipedia:" + src["page"].replace(" ", "_") + "'",
                      "'" + src["language"] + "'"))
    return "\n\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default="tools/data/wiki")
    ap.add_argument("--ragams", default="tools/data/ragams.json")
    ap.add_argument("--out", default="tools/data/compositions.json")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--sql", action="store_true")
    args = ap.parse_args()

    rows, bad_ragam, bad_tala = build(args)
    if args.report:
        print("compositions parsed : %d" % len(rows))
        for c in sorted({r["composer"] for r in rows}):
            n = sum(1 for r in rows if r["composer"] == c)
            print("   %-24s %d" % (c, n))
        # Counted on ragam_matched, not on the field being non-empty: an
        # unresolved ragam still keeps the spelling the page published.
        print("ragam matched       : %d of %d"
              % (sum(1 for r in rows if r["ragam_matched"]), len(rows)))
        print("tala matched        : %d of %d"
              % (sum(1 for r in rows if r["tala"]), len(rows)))
        print("unmatched ragams    : %d distinct" % len(bad_ragam))
        for k, v in sorted(bad_ragam.items(), key=lambda x: -x[1])[:40]:
            print("   %3d  %s" % (v, k))
        print("unmatched talas     : %d distinct" % len(bad_tala))
        for k, v in sorted(bad_tala.items(), key=lambda x: -x[1])[:25]:
            print("   %3d  %s" % (v, k))
        return
    if args.sql:
        sys.stdout.write(to_sql(rows) + "\n")
        return
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    print("wrote %s (%d compositions)" % (args.out, len(rows)))


if __name__ == "__main__":
    main()
