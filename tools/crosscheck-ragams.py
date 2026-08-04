#!/usr/bin/env python3
"""Check the engine's ragam scales against an independently published table.

    python3 tools/crosscheck-ragams.py                  # fetch and report
    python3 tools/crosscheck-ragams.py --sql            # emit verification SQL

The 120 ragams wired into the decoder are its state space: the arohana and
avarohana decide which svarasthanas a reading is allowed to use and which
direction rules constrain it, so a wrong scale is not a cosmetic error -- it
costs accuracy on every recording in that ragam and does so silently.

They were assembled from Wikipedia. This scores them against a second,
unrelated source: the Multitask Carnatic Music Dataset (Singh & Biswas, NIT
Silchar, doi:10.5281/zenodo.7388670, CC BY 4.0), which publishes the svara
set, parent melakarta, arohana, avarohana and janya classification for 40
ragams annotated over Dunya recordings.

Agreement is judged on the svara SET -- which svarasthanas the ragam uses --
not on the written sequence. Two sources routinely write the same ragam's
arohana differently and both be right: vakra turns, the trailing S, and
whether an anya svara appears in the ascent are all editorial. The set is
what the decoder actually consumes.

Where they disagree the tool says so and stops. Neither source outranks the
other on musicology, and a disagreement is a question for a musician, not a
thing to auto-apply -- see --sql, which records the verification and the
conflicts as data rather than editing any scale.
"""

import argparse
import importlib.util
import json
import os
import re
import sys
import urllib.request

_here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_here, "lib"))
import xlsx  # noqa: E402

# Reuse the phonetic key the composition builder already uses, rather than
# growing a second spelling of the same idea.
_spec = importlib.util.spec_from_file_location(
    "build_compositions", os.path.join(_here, "build-compositions.py"))
_bc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_bc)
phon = _bc.phon

ZENODO = ("https://zenodo.org/api/records/7388670/files/"
          "Indian%20Carnatic%20Classical%20Music.xlsx/content")
SOURCE = "zenodo:7388670 multitask-carnatic"
LICENSE = ("CC BY 4.0 — Singh & Biswas, Multitask Carnatic Music Dataset, "
           "NIT Silchar, doi:10.5281/zenodo.7388670")

# Svarasthana of every way the two sources spell a svara. Both use the
# Sa/Ri/Ga/Ma/Pa/Da/Ni system with a variant number; the dataset omits the
# number on S and P, which have only one position each.
POS = {
    "S": 0, "R1": 1, "R2": 2, "R3": 3, "G1": 2, "G2": 3, "G3": 4,
    "M1": 5, "M2": 6, "P": 7, "D1": 8, "D2": 9, "D3": 10,
    "N1": 9, "N2": 10, "N3": 11,
}


def svaras(text):
    """The set of svarasthanas a written scale uses."""
    out = set()
    for tok in re.findall(r"[SRGMPDN][1-3]?", (text or "").upper()):
        if tok in POS:
            out.add(POS[tok])
    return out


# Names the two sources spell differently in ways the phonetic key cannot
# reach: a different word for the same ragam, or a Sen/Chen alternation that
# folding aspirates does not touch. Without these the report calls a ragam
# missing that has been in the engine all along.
ALIAS = {
    "Thodi": "Hanumatodi",
    "Nata": "Nattai",
    "Senchurutti": "Chenchurutti",
}


def engine_ragams():
    """Read the ragam table straight out of the shipping page.

    Same reasoning as tools/lib/engine.js: check the scales the app actually
    decodes with, not a copy of them that can drift.
    """
    html = open(os.path.join(_here, "..", "index.html"), encoding="utf-8").read()
    out = []
    for m in re.finditer(r"R\('([^']+)',\s*(\d+|null)\s*,\s*'([^']*)'\s*,\s*'([^']*)'", html):
        name, mela, aroh, avaroh = m.group(1), m.group(2), m.group(3), m.group(4)
        if name.startswith("Chromatic"):
            continue
        out.append({"name": name, "mela": None if mela == "null" else int(mela),
                    "arohana": aroh, "avarohana": avaroh})
    return out


def fetch(path):
    if os.path.exists(path):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    req = urllib.request.Request(ZENODO, headers={"User-Agent": "sruthiscribe/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r, open(path + ".part", "wb") as f:
        f.write(r.read())
    os.replace(path + ".part", path)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(_here, "data", "multitask.xlsx"))
    ap.add_argument("--sql", action="store_true", help="emit verification SQL")
    ap.add_argument("--json", help="write the full comparison")
    args = ap.parse_args()

    rows = xlsx.table(fetch(args.data))
    ours = engine_ragams()
    index = {}
    for r in ours:
        index.setdefault(phon(r["name"]), r)

    agree, conflict, unmatched = [], [], []
    for row in rows:
        name = (row.get("raag") or "").strip()
        if not name:
            continue
        # Alias keys are written as names and folded here, so the table reads
        # as musicology rather than as phonetic-key trivia.
        alias = next((v for k, v in ALIAS.items() if phon(k) == phon(name)), None)
        mine = index.get(phon(name)) or (index.get(phon(alias)) if alias else None)
        rec = {
            "name": name,
            "theirSvaras": row.get("swaras", ""),
            "theirArohana": row.get("aaroh", ""),
            "theirAvarohana": row.get("avroh", ""),
            "theirMela": row.get("melakarta", ""),
            "theirClass": row.get("janak/janya", ""),
        }
        if not mine:
            unmatched.append(rec)
            continue
        rec["engineName"] = mine["name"]
        rec["engineArohana"] = mine["arohana"]
        rec["engineAvarohana"] = mine["avarohana"]
        # Their "swaras" column is the ragam's svara set; ours is implied by the
        # union of the two scales, which is the same thing stated differently.
        theirs = svaras(row.get("swaras", "")) | svaras(row.get("aaroh", "")) | svaras(row.get("avroh", ""))
        mineset = svaras(mine["arohana"]) | svaras(mine["avarohana"])
        rec["onlyTheirs"] = sorted(theirs - mineset)
        rec["onlyOurs"] = sorted(mineset - theirs)
        (agree if theirs == mineset else conflict).append(rec)

    if args.json:
        json.dump({"agree": agree, "conflict": conflict, "unmatched": unmatched},
                  open(args.json, "w", encoding="utf-8"), indent=1, ensure_ascii=False)

    if args.sql:
        add = []
        add.append("-- Independent verification of engine ragam scales.")
        add.append("-- Generated by tools/crosscheck-ragams.py; source: " + SOURCE)
        for r in agree:
            add.append(
                "update ragams set notes = trim(both ' ' from coalesce(notes,'') || "
                "' Scale independently confirmed against the Multitask Carnatic "
                "Music Dataset (NIT Silchar, CC BY 4.0).') "
                "where phon(name) = phon('%s');" % r["engineName"].replace("'", "''"))
        for r in conflict:
            add.append(
                "update ragams set notes = trim(both ' ' from coalesce(notes,'') || "
                "' Scale disputed: the Multitask Carnatic Music Dataset gives %s / %s.') "
                "where phon(name) = phon('%s');"
                % (r["theirArohana"].replace("'", "''"),
                   r["theirAvarohana"].replace("'", "''"),
                   r["engineName"].replace("'", "''")))
        sys.stdout.write("\n".join(add) + "\n")
        return

    print("Multitask Carnatic Music Dataset (zenodo 7388670, CC BY 4.0)")
    print("  %d ragams published, %d of them are in the engine\n"
          % (len(rows), len(agree) + len(conflict)))
    print("agreeing on the svara set: %d" % len(agree))
    for r in agree:
        print("  %-22s %s" % (r["engineName"], r["theirArohana"]))
    print("\ndisagreeing: %d" % len(conflict))
    for r in conflict:
        print("  %-22s theirs %-32s ours %s" % (r["engineName"], r["theirArohana"], r["engineArohana"]))
        print("  %-22s theirs %-32s ours %s" % ("", r["theirAvarohana"], r["engineAvarohana"]))
        if r["onlyTheirs"]:
            print("  %-22s only in theirs: %s" % ("", r["onlyTheirs"]))
        if r["onlyOurs"]:
            print("  %-22s only in ours:   %s" % ("", r["onlyOurs"]))
    print("\npublished but not in the engine: %d" % len(unmatched))
    for r in unmatched:
        print("  %-22s %s / %s" % (r["name"], r["theirArohana"], r["theirAvarohana"]))


if __name__ == "__main__":
    main()
