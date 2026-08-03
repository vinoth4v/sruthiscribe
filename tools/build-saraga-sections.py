#!/usr/bin/env python3
"""Read Saraga's section annotations into composition structure.

    python3 tools/fetch-saraga.py --out ~/datasets/saraga --annotations-only
    python3 tools/build-saraga-sections.py --data ~/datasets/saraga --report
    python3 tools/build-saraga-sections.py --data ~/datasets/saraga --sql

Saraga ships a manual section layer per concert item: where the pallavi starts,
where the anupallavi takes over, where the caranam runs to, alongside the parts
of a performance that are not the composition at all -- alapana, kalpana svara,
neraval, tani avartana. Each line is

    6.791836734   1   74.555102041   Pallavi
    start(s)          duration(s)    label

What this produces is **structure, not notation**: which sections the piece has
and where they fall in that recording. It deliberately stops short of decoding
svaras from the audio. The engine's measured svara accuracy is 67% with a
correct tonic and its voicing false-alarm rate is about 50% (see the accuracy
section of tools/README.md), so a transcription of a live rendition would be
wrong in roughly a third of its notes -- fine as the starting point the app's
own recording flow offers, badly wrong as a library entry a student reads as
the notation of a kriti.

Saraga is CC BY-NC-SA 4.0, doi:10.5281/zenodo.4301737.
"""

import argparse
import json
import os
import re
import sys
import unicodedata

# The labels Saraga uses, normalised. Only the first group belongs to the
# composition; the rest is what a concert wraps around it.
COMPOSITION = {
    "pallavi": "Pallavi",
    "anupallavi": "Anupallavi",
    "caranam": "Charanam",
    "charanam": "Charanam",
    "samashticaranam": "Samashti Charanam",
    "cittasvara": "Chittasvaram",
    "chittasvara": "Chittasvaram",
    "muktayisvara": "Muktayisvaram",
    "madhyamakala": "Madhyamakala",
    "melkalam": "Madhyamakala",   # the same passage, named for its faster tempo
    "jatisvara": "Jatisvaram",
}
PERFORMANCE = {
    "vocalalap": "Vocal alapana",
    "violinalap": "Violin alapana",
    "alap": "Alapana",
    "kalpanasvara": "Kalpana svara",
    "nereval": "Neraval",
    "neraval": "Neraval",
    "taniavartana": "Tani avartana",
    "sloka": "Shloka",
    "viruttam": "Viruttam",
    "mangalam": "Mangalam",
    "ragamalikasvara": "Ragamalika svara",
    "tisram": "Tisra gati",       # a change of gati inside a section, not a section
    "svarakalpana": "Kalpana svara",
}


def fold(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z]", "", s.lower())


def classify(label):
    """Section name, kind, and the ragam if the label names one.

    A ragamalika changes ragam section by section, and Saraga writes that into
    the label: "Caraṇam sahānā", "Pallavi nāṭakurinji", "Anupallavi kāpi". The
    section name is the first word, the rest is the ragam it is set in -- worth
    keeping rather than filing the whole string under "unrecognised".
    """
    key = fold(label)
    if key in COMPOSITION:
        return COMPOSITION[key], "composition", None
    if key in PERFORMANCE:
        return PERFORMANCE[key], "performance", None

    words = [w for w in re.split(r"\s+", (label or "").strip()) if w]
    if len(words) > 1:
        head = fold(words[0])
        if head in COMPOSITION:
            return COMPOSITION[head], "composition", " ".join(words[1:])
        if head in PERFORMANCE:
            return PERFORMANCE[head], "performance", " ".join(words[1:])
    # Anything left is reported rather than silently dropped or miscounted.
    return label.strip(), "other", None


def read_sections(path):
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            parts = [p for p in re.split(r"\t+", line.strip()) if p]
            if len(parts) < 4:
                continue
            try:
                start, dur = float(parts[0]), float(parts[2])
            except ValueError:
                continue
            name, kind, ragam = classify(parts[3])
            sec = {"name": name, "kind": kind,
                   "start": round(start, 2), "end": round(start + dur, 2)}
            if ragam:
                sec["ragam"] = ragam
            out.append(sec)
    return sorted(out, key=lambda s: s["start"])


def walk(data_dir):
    """Every track that has both metadata and a section layer."""
    for root, _dirs, files in os.walk(data_dir):
        meta = next((f for f in files if f.endswith(".json")), None)
        sect = next((f for f in files if f.endswith(".sections-manual-p.txt")), None) \
            or next((f for f in files if f.endswith(".sections-manual.txt")), None)
        if not meta or not sect:
            continue
        try:
            m = json.load(open(os.path.join(root, meta), encoding="utf-8"))
        except Exception:
            continue
        sections = read_sections(os.path.join(root, sect))
        if not sections:
            continue
        lead = next((a["artist"]["name"] for a in m.get("artists", [])
                     if a.get("lead")), None)
        yield {
            "title": m.get("title") or os.path.basename(root),
            "mbid": m.get("mbid"),
            "concert": os.path.basename(os.path.dirname(root)),
            "artist": lead,
            "raaga": (m.get("raaga") or [{}])[0].get("name"),
            "taala": (m.get("taala") or [{}])[0].get("name"),
            "length_s": round((m.get("length") or 0) / 1000.0, 1),
            "sections": sections,
        }


def sql_str(v):
    if v is None:
        return "null"
    return "'" + str(v).replace("'", "''") + "'"


def to_sql(tracks):
    """One statement, rows as delimited lines -- see pack_structure() in the DB.

    Matched on phon() of the title, which is how the rest of the library joins
    across sources: Saraga's spelling of a piece rarely matches Wikipedia's.
    """
    def cell(v):
        return "" if v is None else str(v).replace("|", "/").replace(";", ",").replace(":", " ")

    lines = []
    for t in tracks:
        if not any(s["kind"] == "composition" for s in t["sections"]):
            continue
        secs = ";".join(":".join([
            cell(s["name"]), s["kind"], "%.2f" % s["start"], "%.2f" % s["end"],
            cell(s.get("ragam"))]).rstrip(":") for s in t["sections"])
        lines.append("|".join([cell(t["title"]), cell(t["artist"]),
                               cell(t["mbid"]), str(t["length_s"]), secs]))
    if not lines:
        return "-- nothing to load\n"
    return ("update versions v\n"
            "set notation = jsonb_set(v.notation, '{structure}', pack_structure(l))\n"
            "from unnest(string_to_array($S$\n" + "\n".join(lines)
            + "\n$S$, E'\\n')) as l, kritis k\n"
            "where k.id = v.kriti_id and k.source = 'saraga:mtg-upf'\n"
            "  and l <> '' and phon(k.title) = phon(split_part(l, '|', 1));\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="tools/data/saraga")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--sql", action="store_true")
    args = ap.parse_args()

    tracks = list(walk(args.data))
    if not tracks:
        sys.exit("No annotated tracks under %s.\nFetch them first:\n"
                 "    python3 tools/fetch-saraga.py --out %s --annotations-only"
                 % (args.data, args.data))

    if args.sql:
        sys.stdout.write(to_sql(tracks))
        return

    from collections import Counter
    labels = Counter((s["name"], s["kind"])
                     for t in tracks for s in t["sections"])
    withcomp = [t for t in tracks
                if any(s["kind"] == "composition" for s in t["sections"])]
    print("tracks with a section layer : %d" % len(tracks))
    print("  of those, with composition sections: %d" % len(withcomp))
    print("sections seen:")
    for (name, kind), n in labels.most_common():
        print("   %-22s %-12s %d" % (name, kind, n))
    unknown = [n for (n, k), _ in labels.items() if k == "other"]
    if unknown:
        print("unclassified labels: %s" % ", ".join(sorted(set(unknown))))
    print("\nsample:")
    for t in withcomp[:3]:
        print("  %s — %s (%s)" % (t["title"], t["raaga"], t["artist"]))
        for s in t["sections"]:
            print("     %-18s %-12s %7.1f – %7.1f s"
                  % (s["name"], s["kind"], s["start"], s["end"]))


if __name__ == "__main__":
    main()
