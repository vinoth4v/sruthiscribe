#!/usr/bin/env python3
"""Build the ragam library from Wikipedia's list of janya ragas.

    python3 tools/build-ragams.py --out tools/data/ragams.json
    python3 tools/build-ragams.py --sql > tools/data/ragams.sql

en.wikipedia.org/wiki/List_of_Janya_ragas is the one page that has the whole
system in a machine-readable shape: every janya grouped under the melakarta it
derives from, with arohana and avarohana written as {{svaraC|S|R1|G3|...}}
templates rather than prose. Everything else here is derived from those scales
rather than scraped, so it stays internally consistent:

  * the melakarta number gives the chakra (six ragas to a chakra, twelve of them)
  * the note count each way gives the classification -- sampurna 7, shadava 6,
    audava 5, and the mixed forms like audava-sampurna
  * a scale that does not ascend or descend monotonically is vakra
  * whichever of the seven svara positions never appear are the varja svaras
  * the semitone positions become the same [[0,"S"],[2,"R2"],...] shape the app's
    pitch engine already scores against

The app ships its own table of ragams inside index.html and that stays the
offline source of truth for the engine; --check compares the two and reports
where a scale disagrees rather than silently overwriting either.

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

PAGE = "List of Janya ragas"
API = "https://en.wikipedia.org/w/api.php"
UA = "SruthiScribe/1.0 (carnatic library build; https://github.com/)"

# Semitones above Sa. Ri/Ga and Dha/Ni overlap by design: R2 and G1 are the same
# pitch, named differently depending on which the ragam uses.
PITCH = {"S": 0, "R1": 1, "R2": 2, "R3": 3, "G1": 2, "G2": 3, "G3": 4,
         "M1": 5, "M2": 6, "P": 7, "D1": 8, "D2": 9, "D3": 10,
         "N1": 9, "N2": 10, "N3": 11}

CHAKRAS = ["Indu", "Netra", "Agni", "Veda", "Bana", "Rutu",
           "Rishi", "Vasu", "Brahma", "Disi", "Rudra", "Aditya"]

COUNT_NAME = {7: "sampurna", 6: "shadava", 5: "audava", 4: "svarantara",
              3: "svarantara"}


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


def clean_name(cell):
    """'''12 [[Rupavati|Rūpavati]]''' -> ('Rupavati', 12)."""
    num = None
    m = re.match(r"^\s*'*\s*(\d{1,2})\s+", cell)
    if m:
        num = int(m.group(1))
        cell = cell[m.end():]
    # [[Target|Display]] -> Target, [[Target]] -> Target. The link target is the
    # plainer spelling; the display text carries diacritics.
    m = re.search(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]", cell)
    name = m.group(1) if m else cell
    # Link targets and cells carry editorial debris: a section anchor
    # ("Devagandhari#In Carnatic music"), a {{not a typo}} wrapper, a gloss in
    # braces ("Hameer Kalyāni {carnatic interpretation of Kedar}"). None of it
    # is part of the ragam's name.
    name = re.sub(r"\{\{\s*not a typo\s*\|([^}]*)\}\}", r"\1", name, flags=re.I)
    name = re.sub(r"\{\{[^}]*\|([^|}]*)\}\}", r"\1", name)
    name = re.sub(r"\{\{[^}]*\}\}", "", name)
    name = re.sub(r"\{[^}]*\}", "", name)
    name = name.split("#")[0]
    name = re.sub(r"\((?:[^)]*\s)?r[aā]gam?\)", "", name, flags=re.I)
    name = name.replace("'", "").replace("''", "").strip()
    name = re.sub(r"\s+", " ", name)
    return name, num


def fold(s):
    """Name key for matching: diacritics, case, spacing and punctuation gone.

    The list page and the app spell the same ragam differently often enough --
    Dhanyāsi against Dhanyasi, Jyoti swarupini against Jyotiswarupini -- that
    matching on the bare letters resolves most of it on its own.
    """
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z]", "", s.lower())


# Where folding is not enough and more than one candidate has the right scale,
# the app's name is pinned to a Wikipedia entry by hand. Each of these was
# checked by confirming the two scales agree.
ALIASES = {
    "Nattai": "Nata",
    "Kalyani": "Kalyani",
    "Kedaragowla": "Kedaragaula",
    "Shankarabharanam": "Dheerasankarabharanam",
    "Sriranjani": "Shreeranjani",
    "Subhapantuvarali": "Shubhapantuvarali",
    "Shyamalangi": "Shamalangi",
    "Jhankaradhwani": "Jhankaradhvani",
    "Kamas": "Khamas",
    "Kamavardhani": "Kamavardhini",
    "Gowrimanohari": "Gourimanohari",
    "Gavambodhi": "Gavambhodi",
    "Dhatuvardhani": "Dhatuvardani",
    "Kuntalavarali": "Kunthalavarali",
    "Kumudakriya": "Kumudhakriya",
    "Madhyamavati": "Madhyamavathi",
    "Nalinakanti": "Nalinakanthi",
    "Nitimati": "Neetimati",
    "Purvikalyani": "Poorvi Kalyani",
    "Reetigowla": "Reethigowla",
    "Saurashtram": "Sowrashtram",
    "Shadvidhamargini": "Shadvidamargini",
    "Surati": "Surutti",
    "Vasanta": "Vasantha",
    "Vishwambhari": "Vishwambari",
}


def svaras_of(cell):
    m = re.search(r"\{\{\s*svaraC\s*\|(.*?)\}\}", cell, re.S)
    if not m:
        return None
    out = []
    for tok in m.group(1).split("|"):
        tok = tok.strip()
        if not tok or "=" in tok:
            continue
        tok = tok.replace("’", "'").replace("’", "'")
        base = tok.rstrip("'").rstrip(".")
        if base not in PITCH:
            return None
        out.append(tok)
    return out or None


def positions(tokens):
    """Token list -> semitone offsets, tracking octave marks."""
    out = []
    for tok in tokens:
        up = tok.count("'")
        down = tok.count(".")
        base = tok.rstrip("'").rstrip(".")
        out.append(PITCH[base] + 12 * (up - down))
    return out


def bound(tokens, ascending):
    """Mark the Sa that bounds a scale as the upper one.

    A scale runs from Sa to Sa and the upper one is written plainly:
    "S R2 G3 M1 P D2 N3 S" ascends to the octave, "S N3 D2 P M1 G3 R2 S"
    descends from it. Taken literally that reads as a line turning round at the
    end, which would call every melakarta vakra.
    """
    out = list(tokens)
    if ascending and out and out[-1] == "S":
        out[-1] = "S'"
    elif not ascending and out and out[0] == "S":
        out[0] = "S'"
    return out


def classify(aroh, avaroh):
    """Note counts, vakra-ness and the varja svaras, straight from the scales."""
    def bare(toks):
        return [t.rstrip("'").rstrip(".") for t in toks]

    def distinct(toks):
        # The scale is bounded by Sa at both ends; count Sa once.
        seen, out = set(), []
        for t in bare(toks):
            if t not in seen:
                seen.add(t)
                out.append(t)
        return out

    a, d = distinct(aroh), distinct(avaroh)
    ac, dc = len(a), len(d)
    up, down = positions(bound(aroh, True)), positions(bound(avaroh, False))
    vakra = (any(y < x for x, y in zip(up, up[1:])) or
             any(y > x for x, y in zip(down, down[1:])))
    families = {"S": "S", "R": "R", "G": "G", "M": "M", "P": "P",
                "D": "D", "N": "N"}
    present = {families[t[0]] for t in set(a) | set(d)}
    varja = [f for f in "RGMPDN" if f not in present]
    kind = "%s-%s" % (COUNT_NAME.get(ac, str(ac)), COUNT_NAME.get(dc, str(dc)))
    if ac == dc:
        kind = COUNT_NAME.get(ac, str(ac))
    if vakra:
        kind += " vakra"
    return ac, dc, kind, varja


def scale_svaras(aroh, avaroh):
    """The [[semitone, name]] pairs the pitch engine matches against."""
    seen = {}
    for tok in list(aroh) + list(avaroh):
        base = tok.rstrip("'").rstrip(".")
        seen.setdefault(PITCH[base], base)
    return [[p, seen[p]] for p in sorted(seen) if 0 <= p < 12]


def parse(text):
    """Walk the tables, carrying the melakarta each janya sits under."""
    ragams, mela, mela_name = [], None, None
    for line in text.split("\n"):
        if not line.startswith("|") or line.startswith("|-") or line.startswith("|}"):
            continue
        cells = [c.strip() for c in re.split(r"\|\|", line.lstrip("|"))]
        if len(cells) < 3:
            continue
        aroh, avaroh = svaras_of(cells[1]), svaras_of(cells[2])
        if not aroh or not avaroh:
            continue
        name, num = clean_name(cells[0])
        if not name or len(name) > 60:
            continue
        if num:
            mela, mela_name = num, name
        ac, dc, kind, varja = classify(aroh, avaroh)
        ragams.append({
            "name": name,
            "melakarta": num,
            "parent_mela_num": num or mela,
            "parent_mela": name if num else mela_name,
            "chakra_num": ((num or mela) - 1) // 6 + 1 if (num or mela) else None,
            "chakra": CHAKRAS[((num or mela) - 1) // 6] if (num or mela) else None,
            "arohana": " ".join(aroh),
            "avarohana": " ".join(avaroh),
            "aroha_count": ac,
            "avaroha_count": dc,
            "janya_type": kind,
            "is_vakra": "vakra" in kind,
            "varja_svaras": varja,
            "svaras": scale_svaras(aroh, avaroh),
            "wiki_url": "https://en.wikipedia.org/wiki/"
                        + urllib.parse.quote(name.replace(" ", "_")),
        })
    return ragams


def dedupe(ragams):
    """Keep one row per name, preferring the melakarta entry."""
    by_name = {}
    for r in ragams:
        key = r["name"].lower()
        old = by_name.get(key)
        if old is None or (r["melakarta"] and not old["melakarta"]):
            by_name[key] = r
    return sorted(by_name.values(),
                  key=lambda r: (r["parent_mela_num"] or 99,
                                 0 if r["melakarta"] else 1, r["name"]))


def app_ragams(index_html):
    src = open(index_html, encoding="utf-8").read()
    out = {}
    for m in re.finditer(r"R\('([^']+)',\s*(\d+),\s*'([^']*)',\s*'([^']*)',\s*(\[\[.*?\]\])\)", src):
        out[m.group(1)] = {
            "mela": int(m.group(2)), "arohana": m.group(3),
            "avarohana": m.group(4),
            "svaras": re.findall(r"'([SRGMPDN][123]?)'", m.group(5)),
        }
    return out


def merge(ragams, index_html):
    """Fold the app's own ragam table into the Wikipedia set.

    Where the two disagree the app wins, because its scales are what pitch
    detection is scored against and several are the more standard attribution:
    Wikipedia files Sahana and Valaji under different melakartas than practice
    does, and gives Begada a kakali nishadam where the app has kaisiki. The
    disagreement is not thrown away -- it goes in ``notes`` so a reader can see
    that the ragam is classified more than one way.

    Ragams the app knows and the list page does not (Behag, Sindhubhairavi --
    both taken into Carnatic music from Hindustani) are added from the app.
    ``in_engine`` marks the ragams pitch detection can actually name.
    """
    by_fold = {fold(r["name"]): r for r in ragams}
    app = app_ragams(index_html)
    notes = []
    for name, a in app.items():
        r = by_fold.get(fold(ALIASES.get(name, name))) or by_fold.get(fold(name))
        if r is None:
            ragams.append({
                "name": name, "melakarta": None,
                "parent_mela_num": a["mela"], "parent_mela": None,
                "chakra_num": (a["mela"] - 1) // 6 + 1,
                "chakra": CHAKRAS[(a["mela"] - 1) // 6],
                "arohana": a["arohana"], "avarohana": a["avarohana"],
                "aroha_count": len(set(a["arohana"].split())),
                "avaroha_count": len(set(a["avarohana"].split())),
                "janya_type": None, "is_vakra": False, "varja_svaras": [],
                "svaras": [[PITCH[s], s] for s in a["svaras"]],
                "alt_names": [], "in_engine": True, "wiki_url": None,
                "source": "sruthiscribe:engine-table", "notes": None,
            })
            continue

        diff = []
        if r["parent_mela_num"] != a["mela"]:
            diff.append("Wikipedia files it under melakarta %s" % r["parent_mela_num"])
        wset = {s[1] for s in r["svaras"]}
        if wset != set(a["svaras"]):
            diff.append("Wikipedia gives the scale as %s" % " ".join(sorted(wset)))

        r["alt_names"] = sorted({r["name"], name} - {name})
        r["name"] = name
        r["in_engine"] = True
        r["source"] = "wikipedia:List_of_Janya_ragas + sruthiscribe:engine-table"
        r["arohana"], r["avarohana"] = a["arohana"], a["avarohana"]
        r["svaras"] = [[PITCH[s], s] for s in a["svaras"]]
        if r["melakarta"] is None:
            r["parent_mela_num"] = a["mela"]
            r["chakra_num"] = (a["mela"] - 1) // 6 + 1
            r["chakra"] = CHAKRAS[(a["mela"] - 1) // 6]
        if diff:
            r["notes"] = ("Classified differently elsewhere: "
                          + "; ".join(diff) + ".")
            notes.append("%s -- %s" % (name, "; ".join(diff)))

    for r in ragams:
        r.setdefault("alt_names", [])
        r.setdefault("in_engine", False)
        r.setdefault("notes", None)
        r.setdefault("source", "wikipedia:List_of_Janya_ragas")
    return ragams, notes


def check(ragams, index_html):
    """Report coverage and every place the two tables disagree."""
    merged, notes = merge(list(ragams), index_html)
    app = app_ragams(index_html)
    matched = sum(1 for r in merged if r["in_engine"])
    print("ragams              : %d  (%d melakarta, %d janya)"
          % (len(merged), sum(1 for r in merged if r["melakarta"]),
             sum(1 for r in merged if not r["melakarta"])))
    print("matched to the app  : %d of %d" % (matched, len(app)))
    print("added from the app  : %s"
          % ", ".join(r["name"] for r in merged
                      if r["source"] == "sruthiscribe:engine-table") or "none")
    print("disagreements kept  : %d" % len(notes))
    for n in notes:
        print("   " + n)


def sql_str(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    return "'" + str(v).replace("'", "''") + "'"


def sql_array(vs):
    return "array[" + ", ".join(sql_str(v) for v in vs) + "]::text[]" if vs else "'{}'::text[]"


def to_sql(ragams, chunk=500):
    """Compact INSERTs, in chunks small enough to run one statement at a time.

    Rows travel as pipe-delimited lines inside one dollar-quoted blob rather
    than as SQL tuples: nine hundred ragams spelled out as literals is mostly
    quotes, ``::text[]`` casts and the word ``null``, and none of that carries
    information. Only what cannot be recomputed is shipped at all -- the
    semitone table, the chakra, the parent melakarta's name and the Wikipedia
    URL all follow from the name, the melakarta number and the two scales, so
    the trailing UPDATE fills them in.
    """
    def cell(v):
        if v is None or v is False:
            return ""
        if v is True:
            return "1"
        if isinstance(v, list):
            return ";".join(v)
        return str(v).replace("|", "/").replace("\n", " ")

    fields = ("name alt_names melakarta parent_mela_num arohana avarohana "
              "aroha_count avaroha_count janya_type varja_svaras is_vakra "
              "in_engine notes source").split()
    out = []
    for i in range(0, len(ragams), chunk):
        lines = []
        for r in ragams[i:i + chunk]:
            r = dict(r, source=("app" if str(r.get("source", "")).startswith("sruthiscribe")
                                else "wiki"))
            lines.append("|".join(cell(r.get(f)) for f in fields))
        picks = []
        for n, f in enumerate(fields, 1):
            p = "split_part(l, '|', %d)" % n
            if f in ("melakarta", "parent_mela_num", "aroha_count", "avaroha_count"):
                p = "nullif(%s, '')::int" % p
            elif f in ("is_vakra", "in_engine"):
                p = "%s = '1'" % p
            elif f in ("alt_names", "varja_svaras"):
                p = ("case when %s = '' then '{}'::text[] "
                     "else string_to_array(%s, ';') end" % (p, p))
            elif f in ("janya_type", "notes"):
                p = "nullif(%s, '')" % p
            picks.append("  %s" % p)
        updates = ",\n".join("  %s = excluded.%s" % (f, f) for f in fields[1:])
        out.append("insert into ragams (" + ", ".join(fields) + ")\nselect\n"
                   + ",\n".join(picks)
                   + "\nfrom unnest(string_to_array($R$\n" + "\n".join(lines)
                   + "\n$R$, E'\\n')) as l where l <> ''\n"
                   + "on conflict (name) do update set\n" + updates + ";")

    out.append("""-- Fill in everything that follows from what was just loaded.
update ragams r set
  chakra_num   = (r.parent_mela_num - 1) / 6 + 1,
  chakra       = (array['Indu','Netra','Agni','Veda','Bana','Rutu',
                        'Rishi','Vasu','Brahma','Disi','Rudra','Aditya'])
                 [(r.parent_mela_num - 1) / 6 + 1],
  parent_mela  = m.name,
  svaras       = ragam_svaras(r.arohana, r.avarohana),
  wiki_url     = case when r.source = 'wiki'
                 then 'https://en.wikipedia.org/wiki/'
                      || replace(coalesce(r.alt_names[1], r.name), ' ', '_') end,
  license      = case when r.source = 'wiki' then 'CC BY-SA 4.0 (Wikipedia)' end,
  source       = case when r.source = 'wiki'
                 then 'wikipedia:List_of_Janya_ragas'
                 else 'sruthiscribe:engine-table' end
from (select melakarta, name from ragams where melakarta is not null) m
where m.melakarta = r.parent_mela_num and r.source in ('wiki', 'app');""")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="tools/data/ragams.json")
    ap.add_argument("--cache", default="tools/data/wiki")
    ap.add_argument("--index", default="index.html")
    ap.add_argument("--sql", action="store_true")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    ragams = dedupe(parse(fetch(PAGE, args.cache)))
    if args.check:
        check(ragams, args.index)
        return
    ragams, _ = merge(ragams, args.index)
    if args.sql:
        sys.stdout.write("\n\n".join(to_sql(ragams)) + "\n")
        return
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(ragams, f, ensure_ascii=False, indent=1)
    print("wrote %s (%d ragams)" % (args.out, len(ragams)))


if __name__ == "__main__":
    main()
