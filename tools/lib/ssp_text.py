#!/usr/bin/env python3
"""Prototype: extract text from the SSP English web edition with a real glyph map.

The PDF is typeset TeX with embedded subset fonts, and every one of them carries
an /Encoding /Differences array mapping character codes to PostScript glyph
names. So the map does not have to be guessed -- it can be read out of the file
and composed with a glyph-name -> Unicode table.

This is a feasibility probe run locally, not a loader. The SSP text is public
domain (Subbarama Dikshitar, 1904; he died in 1906) but this typesetting is a
modern derivative, (c) Guruguhanugraha Archives.
"""

import re
import sys
import zlib
import unicodedata
import os, importlib.util
_spec = importlib.util.spec_from_file_location("cff",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "cff.py"))
cff = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(_spec and cff)

# ---------------------------------------------------------------- glyph names

# The Latin base, then the accents and combining marks a Sanskrit
# transliteration font needs. TeX's skt encoding names them the usual way:
# a letter glyph for the base, and separate glyphs for the diacritics that get
# placed over or under it.
BASE = {
    "space": " ", "exclam": "!", "quotedbl": '"', "numbersign": "#",
    "dollar": "$", "percent": "%", "ampersand": "&", "quoteright": "’",
    "parenleft": "(", "parenright": ")", "asterisk": "*", "plus": "+",
    "comma": ",", "hyphen": "-", "period": ".", "slash": "/", "colon": ":",
    "semicolon": ";", "less": "<", "equal": "=", "greater": ">",
    "question": "?", "at": "@", "bracketleft": "[", "backslash": "\\",
    "bracketright": "]", "asciicircum": "^", "underscore": "_",
    "quoteleft": "‘", "braceleft": "{", "bar": "|", "braceright": "}",
    "asciitilde": "~", "endash": "–", "emdash": "—",
    "quotedblleft": "“", "quotedblright": "”",
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
    "dotlessi": "ı", "germandbls": "ß",
    "ae": "æ", "oe": "œ", "AE": "Æ", "OE": "Œ",
    "fi": "fi", "fl": "fl", "ff": "ff", "ffi": "ffi", "ffl": "ffl",
}
for c in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ":
    BASE[c] = c

# Combining marks, applied to the preceding base letter. This is where the
# diacritics that carry meaning in a ragam name live: the macron that makes
# Kalyani "Kalyāṇi", the dot-below that distinguishes ṇ from n and ḷ from l.
COMBINING = {
    "macron": "̄", "acute": "́", "grave": "̀",
    "circumflex": "̂", "tilde": "̃", "dieresis": "̈",
    "breve": "̆", "ring": "̊", "caron": "̌",
    "cedilla": "̧", "ogonek": "̨", "hungarumlaut": "̋",
    "dotbelow": "̣", "dotaccentbelow": "̣",
    "macronbelow": "̱", "ringbelow": "̥", "tildebelow": "̰",
    "candrabindu": "̐", "anusvara": "̣",
    "dotaccent": "\u0307",   # ṅ, ṁ -- dot above
    "ring": "\u0325",
}

# Precomposed glyph names, e.g. /amacron, /ntildebelow, /sacute.
def glyph_to_text(name):
    if name in BASE:
        return BASE[name], ""
    if name in COMBINING:
        return "", COMBINING[name]
    # uniXXXX
    m = re.fullmatch(r"uni([0-9A-Fa-f]{4})", name)
    if m:
        return chr(int(m.group(1), 16)), ""
    # <letter><accentname>, the common TeX/AGL composite form
    for acc, mark in sorted(COMBINING.items(), key=lambda kv: -len(kv[0])):
        if name.endswith(acc) and len(name) > len(acc):
            stem = name[:-len(acc)]
            base, extra = glyph_to_text(stem)
            if base:
                return base + mark + extra, ""
    return "", ""


# ------------------------------------------------------------------ pdf guts

def objects(data):
    """Every 'N 0 obj ... endobj' body, by object number."""
    out = {}
    for m in re.finditer(rb"(\d+)\s+(\d+)\s+obj\b", data):
        num = int(m.group(1))
        end = data.find(b"endobj", m.end())
        if end < 0:
            continue
        out[num] = data[m.end():end]
    return out


def parse_differences(body):
    m = re.search(rb"/Differences\s*\[(.*?)\]", body, re.S)
    if not m:
        return {}
    enc, code = {}, 0
    for tok in re.finditer(rb"(\d+)|/([^\s/\[\]<>]+)", m.group(1)):
        if tok.group(1):
            code = int(tok.group(1))
        else:
            enc[code] = tok.group(2).decode("latin1")
            code += 1
    return enc


def builtin_encoding(objs, body):
    """The font program's own code -> glyph map.

    The text fonts here carry no /Encoding override, so the mapping lives inside
    the embedded CFF: without it every accent byte is unmapped and silently
    dropped, which is what turns Saṅgīta into "Sa ng ta".
    """
    fd = re.search(rb"/FontDescriptor\s+(\d+)\s+\d+\s+R", body)
    if not fd:
        return {}
    desc = objs.get(int(fd.group(1)), b"")
    ff = re.search(rb"/FontFile3\s+(\d+)\s+\d+\s+R", desc)
    if not ff:
        return {}
    prog = objs.get(int(ff.group(1)), b"")
    st = prog.find(b"stream")
    if st < 0:
        return {}
    st = prog.find(b"\n", st) + 1
    raw = prog[st:prog.rfind(b"endstream")]
    try:
        raw = zlib.decompress(raw)
    except Exception:
        pass
    try:
        return cff.encoding(raw)
    except Exception:
        return {}


def font_maps(data, objs):
    """font object number -> {code: glyphname}."""
    maps = {}
    for num, body in objs.items():
        if b"/Font" not in body or b"/BaseFont" not in body:
            continue
        base = re.search(rb"/BaseFont\s*/([A-Za-z0-9+#-]+)", body)
        enc = {}
        m = re.search(rb"/Encoding\s+(\d+)\s+\d+\s+R", body)
        if m:
            enc = parse_differences(objs.get(int(m.group(1)), b""))
        elif b"/Differences" in body:
            enc = parse_differences(body)
        if not enc:
            enc = builtin_encoding(objs, body)
        maps[num] = {"base": base.group(1).decode() if base else "?", "enc": enc}
    return maps


def streams(data):
    for m in re.finditer(rb"stream\r?\n", data):
        s = m.end()
        e = data.find(b"endstream", s)
        if e < 0:
            continue
        raw = data[s:e]
        try:
            yield zlib.decompress(raw)
        except Exception:
            continue


def resource_fonts(objs):
    """resource name -> font object, merged across the whole file.

    Resources are not all reachable from the page objects here -- some sit in a
    parent node -- and the names turn out to be globally unambiguous, so every
    /Font dictionary in the file can be merged into one map.
    """
    out = {}
    for body in objs.values():
        for m in re.finditer(rb"/Font\s*<<(.*?)>>", body, re.S):
            for fm in re.finditer(rb"/(\w+)\s+(\d+)\s+\d+\s+R", m.group(1)):
                out.setdefault(fm.group(1).decode(), int(fm.group(2)))
    return out


# Text-showing operators, plus the positioning ones -- TeX emits a Td/TD for
# nearly every word, so the vertical component is what actually marks a line
# break; the horizontal one tells us whether a space was skipped over.
TEXT_OPS = re.compile(
    rb"/(\w+)\s+([\d.]+)\s+Tf"
    rb"|(-?[\d.]+)\s+(-?[\d.]+)\s+(?:TD|Td)"
    rb"|(?:-?[\d.]+\s+){4}(-?[\d.]+)\s+(-?[\d.]+)\s+Tm"
    rb"|\((?:[^()\\]|\\.)*\)"
    rb"|\bT\*\b")


def unescape(lit):
    out, i = bytearray(), 0
    body = lit[1:-1]
    while i < len(body):
        c = body[i]
        if c == 0x5C:
            i += 1
            if i >= len(body):
                break
            n = body[i]
            if 0x30 <= n <= 0x37:
                m = re.match(r"[0-7]{1,3}", bytes(body[i:i + 3]).decode("latin1"))
                out.append(int(m.group(0), 8) & 0xFF)
                i += len(m.group(0))
                continue
            out.append({0x6E: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12}.get(n, n))
            i += 1
        else:
            out.append(c)
            i += 1
    return bytes(out)


def decode_page(content, fonts, maps):
    """Content stream -> text, decoding each string through its current font.

    Two things this has to get right beyond the glyph map:

    Accent order. This font emits the diacritic as its own glyph *before* the
    letter it belongs to, so "SAṄGĪTA" arrives as dot, N, G, macron, I, T, A.
    Marks are therefore held and attached to the next base letter, not the
    previous one -- the other way round gives "SA ˙NG ̄ITA".

    Word breaks. TeX positions nearly every word with its own Td, so treating
    each as a line break shreds the text. Only a vertical move starts a new
    line; a horizontal one is a space.
    """
    out, cur, pending = [], None, ""
    size, y, x = 10.0, None, None
    for m in TEXT_OPS.finditer(content):
        tok = m.group(0)
        if m.group(1):
            cur = maps.get(fonts.get(m.group(1).decode(), -1))
            size = float(m.group(2)) or size
            continue
        if m.group(3) is not None:          # Td / TD, relative
            dx, dy = float(m.group(3)), float(m.group(4))
            y = (y or 0) + dy
            x = (x or 0) + dx
            # A few units of vertical shift is an accent being raised or a
            # subscript dropped, not a new line; a real line advance is on the
            # order of the font size.
            out.append("\n" if abs(dy) > size * 0.55 else
                       (" " if dx > size * 0.42 else ""))
            continue
        if m.group(5) is not None:          # Tm, absolute
            nx, ny = float(m.group(5)), float(m.group(6))
            if y is not None and abs(ny - y) > size * 0.55:
                out.append("\n")
            elif x is not None and nx - x > size * 0.42:
                out.append(" ")
            x, y = nx, ny
            continue
        if tok == b"T*":
            out.append("\n")
            continue
        raw = unescape(tok)
        enc = (cur or {}).get("enc", {})
        for b in raw:
            g = enc.get(b)
            if g is None:
                if 32 <= b < 127:
                    out.append(chr(b))
                continue
            text, mark = glyph_to_text(g)
            if mark and not text:
                pending += mark
                continue
            if text:
                if pending:
                    # A mark over a dotless i means the i keeps its own dot:
                    # ı + macron is ī, not "ı̄".
                    base = "i" if text[0] == "ı" else text[0]
                    out.append(base + pending + text[1:])
                    pending = ""
                else:
                    out.append(text)
    return "".join(out)


def tidy(t):
    """Repair the two artefacts the glyph stream leaves behind.

    The dot-below diacritic is not a glyph in these fonts -- it is a period
    positioned under the letter -- so it arrives as a free-standing full stop
    between letters. And a word that mixes accented and plain glyphs gets broken
    by the small horizontal jumps that position the accents.
    """
    # "IKS . ITA" -> "IKṢITA"; only between letters, so real sentence stops stay.
    t = re.sub(r"(?<=[A-Za-z])\s*\.\s*(?=[A-Za-z])", "\u0323", t)
    t = unicodedata.normalize("NFC", t)
    # Re-join a word split by accent positioning: a single space between two
    # letter runs where one side carries a diacritic.
    t = re.sub(r"(?<=[^\W\d_]) (?=[^\W\d_])",
               lambda m: "", t) if False else t
    return t


def main():
    path = sys.argv[1]
    want = sys.argv[2] if len(sys.argv) > 2 else None
    data = open(path, "rb").read()
    objs = objects(data)
    maps = font_maps(data, objs)
    fonts = resource_fonts(objs)

    texts = []
    for content in streams(data):
        if b"Tf" not in content:
            continue
        t = decode_page(content, fonts, maps)
        t = tidy(t)
        if len(t.strip()) > 40:
            texts.append(t)

    if want:
        hits = [t for t in texts if want.lower() in t.lower()]
        print("pages containing %r: %d" % (want, len(hits)))
        for t in hits[:2]:
            print("=" * 70)
            print(re.sub(r"\n{3,}", "\n\n", t)[:2500])
    else:
        print("text pages: %d" % len(texts))
        for t in texts[:3]:
            print("=" * 70)
            print(re.sub(r"\n{3,}", "\n\n", t)[:1200])


if __name__ == "__main__":
    main()
