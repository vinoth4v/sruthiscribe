#!/usr/bin/env python3
"""Anga structure of a Carnatic tala, from its name.

The suladi sapta talas are not seven fixed patterns: each is a sequence of
angas, and the laghu's length is set by the jati. Tripuṭa with a tisra laghu
runs 3+2+2 = 7, with a khaṇḍa laghu 5+2+2 = 9. Treating the family name as the
whole answer -- and matching it by substring, so "khaṇḍajāti tripuṭa" lands on
"aṭa" -- is why SSP's printed avartanas did not add up.

    >>> anga("adi")
    [4, 2, 2]
    >>> anga("khandajatitriputa")
    [5, 2, 2]
    >>> anga("misrajatieka")
    [7]
"""

import re

# laghu, drutam (2), anudrutam (1) -- L is filled in from the jati.
STRUCTURE = {
    "dhruva":  ["L", 2, "L", "L"],
    "mathya":  ["L", 2, "L"],
    "rupaka":  [2, "L"],
    "jhampa":  ["L", 1, 2],
    "triputa": ["L", 2, 2],
    "ata":     ["L", "L", 2, 2],
    "eka":     ["L"],
}

# The jati each tala takes when none is named.
DEFAULT_JATI = {
    "dhruva": 4, "mathya": 4, "rupaka": 4, "jhampa": 7,
    "triputa": 3, "ata": 5, "eka": 4,
}

JATI = {
    "tisra": 3, "trisra": 3,
    "catusra": 4, "caturasra": 4, "chatusra": 4, "chaturasra": 4,
    "khanda": 5, "kanda": 5,
    "misra": 7, "mishra": 7,
    "sankirna": 9, "samkirna": 9,
}

# The capu talas are counted, not built from angas. SSP does not print their
# internal split at all -- a khanda capu kirtana prints 10|10|10|10, one danda
# per avartana at two kalai -- so they are carried as a single unit.
CAPU = {"misracapu": [7], "khandacapu": [5], "tisracapu": [3],
        "sankirnacapu": [9]}


def anga(name):
    """Anga lengths in aksharas, or None if the name is not a tala."""
    if not name:
        return None
    n = re.sub(r"[^a-z]", "", name.lower())
    # Drop the trailing word "tala" itself. Leaving it on is not cosmetic:
    # "ekatala" contains "ata", so the family search picked ata over eka and
    # turned a laghu of 3 into 3+3+2+2.
    n = re.sub(r"(talam|tala|tal)$", "", n)

    for k, v in CAPU.items():
        if k in n:
            return list(v)
    if n.endswith("capu") or "capu" in n:
        for j, v in JATI.items():                 # e.g. "khandacapu" handled above
            if n.startswith(j):
                return [v // 2, v - v // 2]
        return None

    # adi IS caturasra-jati triputa; it is not a separate tala.
    if "adi" in n and "jati" not in n:
        return [4, 2, 2]

    fam = None
    for f in STRUCTURE:
        if f in n:
            # "triputa" contains no other family name, but check the longest
            # match so "eka" inside "ekatala" does not beat a real prefix.
            if fam is None or len(f) > len(fam):
                fam = f
    if fam is None:
        return None

    jati = None
    for j, v in JATI.items():
        if j in n:
            if jati is None or len(j) > jati[0]:
                jati = (len(j), v)
    laghu = jati[1] if jati else DEFAULT_JATI[fam]
    return [laghu if a == "L" else a for a in STRUCTURE[fam]]


def family(name):
    """Which of the seven (or capu) a tala name belongs to."""
    if not name:
        return None
    import re as _re
    n = _re.sub(r"[^a-z]", "", name.lower())
    n = _re.sub(r"(talam|tala|tal)$", "", n)
    if "capu" in n:
        return "capu"
    if "adi" in n and "jati" not in n:
        return "adi"
    best = None
    for f in STRUCTURE:
        if f in n and (best is None or len(f) > len(best)):
            best = f
    return best


def total(name):
    a = anga(name)
    return sum(a) if a else None


if __name__ == "__main__":
    cases = [
        ("adi", [4, 2, 2]), ("triputa", [3, 2, 2]),
        ("tisrajatitriputa", [3, 2, 2]), ("khandajatitriputa", [5, 2, 2]),
        ("misrajatieka", [7]), ("tisrajatieka", [3]), ("catusrajatieka", [4]),
        ("eka", [4]), ("rupaka", [2, 4]), ("mathya", [4, 2, 4]),
        ("catusrajatimathya", [4, 2, 4]), ("jhampa", [7, 1, 2]),
        ("misrajatijhampa", [7, 1, 2]), ("ata", [5, 5, 2, 2]),
        ("khandajatiata", [5, 5, 2, 2]), ("dhruva", [4, 2, 4, 4]),
        ("misracapu", [7]), ("khandacapu", [5]),
        # The trailing "tala" must not change the answer.
        ("tisrajatiekatala", [3]), ("aditala", [4, 2, 2]),
        ("khandajatitriputatala", [5, 2, 2]), ("atatalam", [5, 5, 2, 2]),
        ("misrajatiekatala", [7]), ("rupakatala", [2, 4]),
    ]
    bad = 0
    for name, want in cases:
        got = anga(name)
        ok = got == want
        bad += not ok
        print("  %-22s -> %-16s %s" % (name, got, "" if ok else "WANT " + str(want)))
    print("selftest %s" % ("ok" if not bad else "FAILED (%d)" % bad))
    raise SystemExit(1 if bad else 0)
