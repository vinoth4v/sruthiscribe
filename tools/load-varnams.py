#!/usr/bin/env python3
"""Emit the SQL that loads tools/data/varnams.json into the library.

    python3 tools/build-varnams.py --out tools/data/varnams.json
    python3 tools/load-varnams.py > tools/data/varnams.sql

One statement per varnam, so a failure lands on one row rather than the batch.
Re-running is safe: each varnam is keyed on (title, ragam, source) and its
seed version is replaced, and the pallavi-only seed sketches these full
notations supersede are dropped by title.

Two shapes of notation go in. ``notation.sections`` is the real one -- section
by section, each with its tala cycle count and one entry per svara carrying how
many aksharas it holds and the sahitya syllable sung on it. ``flat`` stays a
plain sequence of svara tokens with no extensions, because that is what the
match_kritis RPC compares a recording against.
"""

import json
import sys


def sql_str(v):
    if v is None:
        return "null"
    return "'" + str(v).replace("'", "''") + "'"


def sql_json(v):
    return sql_str(json.dumps(v, ensure_ascii=False)) + "::jsonb"


def token(sv):
    """S, R2, D2. and S' -- the app's own svara spelling, mandra dotted."""
    o = sv["o"]
    return sv["s"] + ("'" * o if o > 0 else "." * -o)


# The pallavi-only seed sketches that these full notations replace. Matched on
# the title prefix, since the same varnam was seeded under several spellings.
SUPERSEDES = {
    "Evvari Bodhana": ["Evvari Bodhana (Varnam)"],
    "Intha Chalamu": ["Chalamu Seyada (Varnam)"],
    "Vanajakshiro": ["Vanajakshi (Varnam)", "Vanajakshi - Varnam",
                     "Vanajaksha Ninne Kori"],
    "Ninnukori": ["Ninnukori (Varnam)"],
    "Karunimpa Idi": ["Karunimpa Idi"],
    "Sarasuda Ninne": ["Sarasija Nabha Sodhari (Varnam)"],
    "Saami Ninne": ["Sami Ninne (Varnam)", "Sami Ninne Kori (Varnam)"],
}


def pack(sv):
    """svara/octave/aksharas[/syllable] -- see pack_svaras() in the database."""
    syl = sv.get("syl", "")
    for bad in " |/":
        if bad in syl:
            raise ValueError("syllable %r cannot be packed" % syl)
    return "%s/%d/%d%s" % (sv["s"], sv["o"], sv["d"], "/" + syl if syl else "")


def statements(varnams):
    for v in varnams:
        flat = " ".join(token(sv) for s in v["sections"] for sv in s["svaras"])
        secs = ["%s|%d|%d|%s|%s|%s" % (
            s["name"], s["cycles"], s["aksharas"],
            "t" if s["sahitya"] else "f", s["octaves"],
            " ".join(pack(sv) for sv in s["svaras"]))
            for s in v["sections"]]
        provenance = {
            "notation": v["source"],
            "mbid": v["mbid"],
            "arohana": v["arohana"],
            "avarohana": v["avarohana"],
            "octaves": ("marked in the dataset where given, otherwise the "
                        "octave path of least melodic motion"),
        }
        drop = SUPERSEDES.get(v["title"], [])
        titles = " or ".join("title like %s" % sql_str(d + "%") for d in drop)
        yield "\n".join([
            "-- %s (%s)" % (v["title"], v["ragam"]),
            "delete from versions where kriti_id in (select id from kritis",
            "  where (source = 'seed:traditional' and (%s))" % (titles or "false"),
            "     or (title = %s and ragam = %s and source = %s));"
            % (sql_str(v["title"]), sql_str(v["ragam"]), sql_str(v["source"])),
            "delete from kritis",
            "  where (source = 'seed:traditional' and (%s))" % (titles or "false"),
            "     or (title = %s and ragam = %s and source = %s);"
            % (sql_str(v["title"]), sql_str(v["ragam"]), sql_str(v["source"])),
            "with k as (",
            "  insert into kritis (title, composer, ragam, tala, form, language,",
            "                      lyrics, source, license, source_url, notes)",
            "  values (%s, %s, %s, %s, 'varnam', %s, %s, %s, %s, %s, %s)"
            % (sql_str(v["title"]), sql_str(v["composer"]), sql_str(v["ragam"]),
               sql_str(v["tala"]), sql_str(v["language"]), sql_json(v["lyrics"]),
               sql_str(v["source"]), sql_str(v["license"]),
               sql_str("https://doi.org/10.5281/zenodo.7726167"),
               sql_str("Complete notation: pallavi, anupallavi, muktayisvaram, "
                       "charanam and the chittasvarams.")),
            "  returning id)",
            "insert into versions (kriti_id, contributor, note, notation, flat,",
            "                      status, sections, has_sahitya, octaves)",
            "select k.id, %s, %s," % (
                sql_str("CompMusic / Shivkumar Kalyanaraman archive"),
                sql_str("Adi tala, 32 aksharas to the avartana, four to the beat.")),
            "  pack_notation('Adi', 32, array[",
            ",\n".join("    " + sql_str(s) for s in secs),
            "  ], %s)," % sql_json(provenance),
            "  %s, 'seed', %d, %s, %s from k;"
            % (sql_str(flat), len(v["sections"]),
               "true" if any(s["sahitya"] for s in v["sections"]) else "false",
               sql_str("dataset+inferred"
                       if any(s["octaves"] != "inferred" for s in v["sections"])
                       else "inferred")),
        ])


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "tools/data/varnams.json"
    with open(path, encoding="utf-8") as f:
        varnams = json.load(f)
    print("\n\n".join(statements(varnams)))


if __name__ == "__main__":
    main()
