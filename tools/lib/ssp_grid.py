#!/usr/bin/env python3
"""SSP notation-grid extractor.

Builds a geometric model of each page -- every glyph at its true x/y (font
Widths + TJ kerning, not guessed advances), every rule the page draws -- and
reads the notation exactly as the book's own scheme (page iii) defines it:

  lowercase svara = 1 aksharakalam, CAPITAL = 2
  underline halves the value; stacked underlines quarter it, and so on
  dot above = tara sthayi, dot below = mandra, double dots one octave further
  ',' extends the previous svara by one unit, ';' by two
  the symbol font carries the gamakas: ) sphurita * pratyahata w nokku
  ^ ravai X kandippu _ vali / etra-jaru \\ irakka-jaru g orikai
  'j' is the tala danda; the arithmetic between dandas is the verifier

Public domain source: Subbarama Dikshitar, Sangita Sampradaya Pradarsini, 1904.
"""

import re
import sys
import zlib
import unicodedata
import importlib.util


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

import os
_here = os.path.dirname(os.path.abspath(__file__))
base = _load("ssp_text", os.path.join(_here, "ssp_text.py"))

SVARA_LETTERS = set("srgmpdnSRGMPDN")

# CMSY10 has no /Differences -- TeX relies on the font's built-in encoding, and
# our CFF reader yields nothing for these low codes. Only three matter in the
# notation: the mid-dot that holds a note for one more akshara, and the two
# dandas. (Codes 0x6A/0x6B fall through to 'j'/'k' by the ASCII fallback.)
CMSY_BUILTIN = {1: "\u00b7", 0x6A: "j", 0x6B: "k"}
GAMAKA = {")": "sphurita", "*": "pratyahata", "w": "nokku", "^": "ravai",
          "X": "kandippu", "_": "vali", "/": "etra-jaru", "\\": "irakka-jaru",
          "g": "orikai", "n": "irakka-jaru", "~": "kampita"}
BAR = {"j", "k"}


# ------------------------------------------------------------- page model ---

class Glyph(object):
    __slots__ = ("x", "y", "w", "ch", "font", "size", "mark")
    def __init__(self, x, y, w, ch, font, size, mark=False):
        self.x, self.y, self.w = x, y, w
        self.ch, self.font, self.size, self.mark = ch, font, size, mark
    def __repr__(self):
        return "%r@(%.0f,%.0f)" % (self.ch, self.x, self.y)


def font_widths(objs):
    """font object number -> (widths list indexed from FirstChar, firstchar)."""
    out = {}
    for num, body in objs.items():
        if b"/BaseFont" not in body:
            continue
        fc = re.search(rb"/FirstChar\s+(\d+)", body)
        wm = re.search(rb"/Widths\s*\[(.*?)\]", body, re.S)
        if not wm:
            wr = re.search(rb"/Widths\s+(\d+)\s+\d+\s+R", body)
            if wr:
                wm = re.search(rb"\[(.*?)\]", objs.get(int(wr.group(1)), b""), re.S)
        if fc and wm:
            ws = [float(x) for x in re.findall(rb"[\d.]+", wm.group(1))]
            out[num] = (ws, int(fc.group(1)))
    return out


TOK = re.compile(
    rb"/(\w+)\s+([\d.]+)\s+Tf"                                   # 1,2 font
    rb"|(-?[\d.]+)\s+(-?[\d.]+)\s+(Td|TD)"                       # 3,4,5
    rb"|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(Tm|cm)"  # 6-12
    rb"|\[((?:[^\[\]\\()]|\((?:[^()\\]|\\.)*\)|\\.)*)\]\s*TJ"    # 13 TJ array
    rb"|(\((?:[^()\\]|\\.)*\))\s*Tj"                             # 14 Tj
    rb"|\bq\b|\bQ\b|\bBT\b|\bET\b"
    rb"|(-?[\d.]+)\s+(-?[\d.]+)\s+m\s+(-?[\d.]+)\s+(-?[\d.]+)\s+l\s+S\b"  # 15-18 line
    rb"|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+re\s*f\b")    # 19-22 rect


def mat_mul(a, b):
    return [a[0]*b[0]+a[1]*b[2], a[0]*b[1]+a[1]*b[3],
            a[2]*b[0]+a[3]*b[2], a[2]*b[1]+a[3]*b[3],
            a[4]*b[0]+a[5]*b[2]+b[4], a[4]*b[1]+a[5]*b[3]+b[5]]


def apply(m, x, y):
    return (m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5])


def page_model(content, fonts, maps, widths):
    """-> (glyphs, hrules, vrules) in page coordinates."""
    glyphs, hrules, vrules = [], [], []
    ctm = [1, 0, 0, 1, 0, 0]
    stack = []
    cur = None; curw = None; size = 10.0
    tm = None; lm = None    # text matrix / line matrix

    def show(raw):
        nonlocal tm
        if tm is None or cur is None:
            return
        enc = cur.get("enc", {})
        fname = cur.get("base", "?")
        for b in raw:
            g = enc.get(b)
            if g:
                text, mark = base.glyph_to_text(g)
            elif "CMSY" in fname and b in CMSY_BUILTIN:
                text, mark = CMSY_BUILTIN[b], ""
            else:
                text, mark = ((chr(b) if 32 <= b < 127 else ""), "")
            wlist, fc = curw if curw else (None, 0)
            adv = (wlist[b - fc] / 1000.0 * size) if (wlist and 0 <= b - fc < len(wlist)) else 0.5 * size
            x, y = apply(ctm, tm[4], tm[5])
            ch = text or mark
            if ch:
                glyphs.append(Glyph(x, y, adv, ch, fname, size, mark=bool(mark and not text)))
            tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + adv, tm[5]]

    for m in TOK.finditer(content):
        t = m.group(0)
        if m.group(1):
            name = m.group(1).decode()
            num = fonts.get(name, -1)
            cur = maps.get(num); curw = widths.get(num)
            size = float(m.group(2))
        elif m.group(5):                          # Td/TD
            if lm is None:
                lm = [1, 0, 0, 1, 0, 0]
            lm = [lm[0], lm[1], lm[2], lm[3],
                  lm[4] + float(m.group(3)), lm[5] + float(m.group(4))]
            tm = list(lm)
        elif m.group(12):                         # Tm or cm
            vals = [float(m.group(i)) for i in range(6, 12)]
            if m.group(12) == b"Tm":
                lm = vals; tm = list(vals)
            else:
                ctm = mat_mul(vals, ctm)
        elif m.group(13) is not None:             # TJ
            body = m.group(13)
            for piece in re.finditer(rb"\((?:[^()\\]|\\.)*\)|(-?[\d.]+)", body):
                if piece.group(1) is not None:
                    if tm is not None:
                        tm[4] -= float(piece.group(1)) / 1000.0 * size
                else:
                    show(base.unescape(piece.group(0)))
        elif m.group(14):                         # Tj
            show(base.unescape(m.group(14)))
        elif t == b"q":
            stack.append(list(ctm))
        elif t == b"Q":
            if stack: ctm = stack.pop()
        elif t == b"BT":
            tm = lm = [1, 0, 0, 1, 0, 0]
        elif m.group(15) is not None:             # line
            x0, y0 = apply(ctm, float(m.group(15)), float(m.group(16)))
            x1, y1 = apply(ctm, float(m.group(17)), float(m.group(18)))
            if abs(y1 - y0) < .5: hrules.append((min(x0, x1), max(x0, x1), (y0 + y1) / 2))
            elif abs(x1 - x0) < .5: vrules.append(((x0 + x1) / 2, min(y0, y1), max(y0, y1)))
        elif m.group(19) is not None:             # filled rect: thin = rule
            x, y = apply(ctm, float(m.group(19)), float(m.group(20)))
            w = float(m.group(21)) * ctm[0]; h = float(m.group(22)) * ctm[3]
            if abs(h) <= 1.2 and abs(w) > 2: hrules.append((x, x + w, y + h / 2))
            elif abs(w) <= 1.2 and abs(h) > 2: vrules.append((x + w / 2, y, y + h))
    return glyphs, hrules, vrules


# ------------------------------------------------------------ line assembly --

def is_symbol_font(name):
    """The CM* families carry the gamaka signs, not the text."""
    return "CM" in (name or "")


def attach_marks(glyphs):
    """Fold combining accents into the letter they belong to.

    Only accents set in the *text* font are accents. The gamaka signs come out
    of the CM families and several of them decode to combining characters --
    vali is a macron, and folding it onto the svara beside it turns "P" into
    "P-bar" and, worse, changes what the duration reader sees. They stay
    standalone glyphs so parse_svara_line can read them as ornaments.
    """
    bases = [g for g in glyphs if not g.mark or is_symbol_font(g.font)]
    for g in bases:
        g.mark = False
    for mk in (g for g in glyphs if g.mark and not is_symbol_font(g.font)):
        near = None; best = 1e9
        for b in bases:
            if is_symbol_font(b.font): continue
            if abs(b.y - mk.y) > mk.size * 1.4: continue
            dx = abs((b.x + b.w / 2) - mk.x)
            if dx < best: best, near = dx, b
        if near is not None and best < near.size * 1.6:
            near.ch = unicodedata.normalize("NFC", near.ch + mk.ch)
    return bases


def group_lines(glyphs, gap=5.0):
    """Cluster glyphs into printed lines.

    One printed line is not one baseline: TeX nudges accented capitals and sets
    the gamaka symbols a couple of points above and below the svaras, so a row
    spans ~5pt while the sahitya sits ~12pt lower. Bucketing by a fixed grid
    split those rows (dandas in one bucket, notes in the next); clustering
    against the row's own top edge keeps them together without ever swallowing
    the sahitya line underneath.
    """
    if not glyphs:
        return []
    rows = []
    prev = None
    for g in sorted(glyphs, key=lambda g: (-g.y, g.x)):
        # Break where there is a real vertical gap, measured against the last
        # glyph rather than the row's top edge. A svara band is up to ~9pt tall
        # -- accents above, dropped sub-baselines below -- while its steps are
        # under 4pt and the gap down to the sahitya is 8-10pt. Measuring from
        # the top edge cut such a band in half and split one printed row into
        # two, which is what produced half-length avartanas.
        if prev is not None and abs(prev - g.y) <= gap:
            rows[-1][1].append(g)
        else:
            rows.append((g.y, [g]))
        prev = g.y
    return [(top, sorted(r, key=lambda g: g.x)) for top, r in rows]


def is_svara_line(line):
    def core(ch):
        # NFD so an octave-dotted svara counts by its base letter.
        d = unicodedata.normalize("NFD", ch)
        return d[0] if d else ""
    letters = [g for g in line if g.ch and core(g.ch) in SVARA_LETTERS
               and len(unicodedata.normalize("NFD", g.ch).rstrip("\u0307\u0323\u0308")) <= 1
               and 'Palladio' in g.font]
    other_words = [g for g in line if len(g.ch) == 1 and g.ch.isalpha()
                   and unicodedata.normalize("NFD", g.ch)[0] not in SVARA_LETTERS
                   and 'Palladio' in g.font and g.ch not in 'jk']
    return len(letters) >= 4 and len(letters) > 2 * max(1, len(other_words))


# --------------------------------------------------------------- the grid ---

def underline_depth(g, hrules):
    """How many rules sit under this glyph (stacked underlines halve again)."""
    n = 0
    for x0, x1, y in hrules:
        # Judge by the glyph's centre, not its edges. A rule is drawn under a
        # beamed group and stops at the group's ink, so the first and last
        # note of the group overhang it slightly and were being read at full
        # value -- which is why failing lines always totalled HIGH.
        cx = g.x + g.w * 0.5
        if y < g.y - 0.5 and y > g.y - g.size * 0.85 and x0 - 1.5 <= cx <= x1 + 1.5:
            n += 1
    return n


def is_grace(g, body_size):
    """A svara set smaller, or in italic, is an ornament and takes no time.

    SSP writes grace notes at a smaller size in the italic face. They are sung,
    but they belong to the akshara of the note they lean on rather than
    occupying one of their own -- counting them is what made avartanas come out
    one or two aksharas long.
    """
    return "Ita" in (g.font or "") or g.size < body_size - 0.4


def parse_svara_line(line, hrules):
    """One printed svara line -> [{svara, oct, dur, gamakas, bar}...]."""
    out = []
    sizes = [g.size for g in line
             if "Palladio" in g.font
             and unicodedata.normalize("NFD", g.ch)[:1] in SVARA_LETTERS]
    body_size = max(sizes) if sizes else 10.0
    for g in line:
        ch = g.ch
        bare = unicodedata.normalize("NFD", ch)
        letter = bare[0]
        if letter in SVARA_LETTERS and 'Palladio' in g.font:
            octv = 0
            if "̇" in bare: octv = 1
            if "̣" in bare: octv = -1
            if "̈" in bare: octv = 2
            dots_below = bare.count("̣")
            if dots_below >= 2: octv = -2
            grace = is_grace(g, body_size)
            if grace:
                dur = 0.0
            else:
                dur = 2.0 if letter.isupper() else 1.0
                dur /= (2 ** underline_depth(g, hrules))
            out.append({"t": "sv", "svara": letter.upper(), "oct": octv,
                        "dur": dur, "x": g.x, "gam": [], "grace": grace})
        elif ch in (",", ";", "\u00b7"):
            unit = 1.0 / (2 ** underline_depth(g, hrules))
            out.append({"t": "ext", "dur": (2 * unit if ch == ";" else unit), "x": g.x})
        elif ch in BAR:
            out.append({"t": "bar", "double": ch == "k", "x": g.x})
        elif ch in GAMAKA and 'Palladio' not in g.font:
            if out and out[-1]["t"] == "sv":
                out[-1]["gam"].append(GAMAKA[ch])
            else:
                out.append({"t": "gam-lead", "gam": GAMAKA[ch], "x": g.x})
    return out


def join_lines(lines):
    """Concatenate parsed svara lines into one cell stream.

    A printed line that fills an avartana exactly does not repeat the danda at
    its right edge -- the line break is the boundary. Joining the streams
    naively therefore fuses the last anga of one row onto the first of the
    next, which is where the phantom 12s came from in a tala whose angas are
    8|4|4. Supplying the implicit danda costs nothing when the line already
    ends with one, since an empty segment is dropped downstream.
    """
    out = []
    for cells in lines:
        if not cells:
            continue
        if out and out[-1]["t"] != "bar" and cells[0]["t"] != "bar":
            out.append({"t": "bar", "double": False, "x": None, "implied": True})
        out += cells
    return out


def segments(cells):
    """Split a parsed line at the dandas; returns list of duration sums."""
    segs, cur = [], 0.0
    for c in cells:
        if c["t"] == "bar":
            segs.append(cur); cur = 0.0
        elif c["t"] in ("sv", "ext"):
            cur += c["dur"]
    if cur: segs.append(cur)
    return [s for s in segs if s > 0]


# ------------------------------------------------------------------- pages --

def page_streams(data, objs):
    """Decompressed content stream of each page, in page-tree order."""
    import zlib
    spec = importlib.util.spec_from_file_location(
        "pdfpage", os.path.join(_here, "pdfpage.py"))
    pp = importlib.util.module_from_spec(spec); spec.loader.exec_module(pp)
    out = []
    for pnum in pp.page_list(objs):
        m = re.search(rb"/Contents\s+(\d+)\s+\d+\s+R", objs.get(pnum, b""))
        if not m:
            out.append(b"")
            continue
        prog = objs.get(int(m.group(1)), b"")
        i = prog.find(b"stream")
        if i < 0:
            out.append(b"")
            continue
        i = prog.find(b"\n", i) + 1
        raw = prog[i:prog.rfind(b"endstream")]
        try:
            out.append(zlib.decompress(raw))
        except Exception:
            out.append(raw)
    return out


def load_pages(pdf_path):
    """Pages in reading order.

    Iterating the content streams as they happen to sit in the file gives an
    order that is close to, but not, the page order -- which makes any page
    number reported from here unusable for checking against the printed book.
    """
    d = open(pdf_path, "rb").read()
    objs = base.objects(d)
    maps = base.font_maps(d, objs)
    fonts = base.resource_fonts(objs)
    widths = font_widths(objs)
    pages = []
    for c in page_streams(d, objs):
        if b"Tf" not in c:
            continue
        glyphs, hr, vr = page_model(c, fonts, maps, widths)
        glyphs = attach_marks(glyphs)
        pages.append({"glyphs": glyphs, "hrules": hr, "vrules": vr,
                      "text": base.tidy(base.decode_page(c, fonts, maps))})
    return pages


def page_lines(page):
    return group_lines(page["glyphs"])


if __name__ == "__main__":
    pages = load_pages(sys.argv[1])
    print("pages:", len(pages))
