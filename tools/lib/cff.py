"""Just enough CFF to recover a font's built-in code -> glyph-name map.

The SSP PDF's text fonts are Type1C (/FontFile3) with no /Encoding override, so
the mapping from byte to glyph lives inside the font program: a charset (glyph
index -> name) and an encoding (byte -> glyph index). Both are small tables near
the front of the CFF, which is why this is ~100 lines rather than a font library.
"""

import struct

STANDARD_STRINGS = """.notdef space exclam quotedbl numbersign dollar percent
ampersand quoteright parenleft parenright asterisk plus comma hyphen period
slash zero one two three four five six seven eight nine colon semicolon less
equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z
bracketleft backslash bracketright asciicircum underscore quoteleft a b c d e f
g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde
exclamdown cent sterling fraction yen florin section currency quotesingle
quotedblleft guillemotleft guilsinglleft guilsinglright fi fl endash dagger
daggerdbl periodcentered paragraph bullet quotesinglbase quotedblbase
quotedblright guillemotright ellipsis perthousand questiondown grave acute
circumflex tilde macron breve dotaccent dieresis ring cedilla hungarumlaut
ogonek caron emdash AE ordfeminine Lslash Oslash OE ordmasculine ae dotlessi
lslash oslash oe germandbls onesuperior logicalnot mu trademark Eth onehalf
plusminus Thorn onequarter divide brokenbar degree thorn threequarters
twosuperior registered minus eth multiply threesuperior copyright Aacute
Acircumflex Adieresis Agrave Aring Atilde Ccedilla Eacute Ecircumflex Edieresis
Egrave Iacute Icircumflex Idieresis Igrave Ntilde Oacute Ocircumflex Odieresis
Ograve Otilde Scaron Uacute Ucircumflex Udieresis Ugrave Yacute Ydieresis Zcaron
aacute acircumflex adieresis agrave aring atilde ccedilla eacute ecircumflex
edieresis egrave iacute icircumflex idieresis igrave ntilde oacute ocircumflex
odieresis ograve otilde scaron uacute ucircumflex udieresis ugrave yacute
ydieresis zcaron exclamsmall Hungarumlautsmall dollaroldstyle dollarsuperior
ampersandsmall Acutesmall parenleftsuperior parenrightsuperior
twodotenleader onedotenleader zerooldstyle oneoldstyle twooldstyle
threeoldstyle fouroldstyle fiveoldstyle sixoldstyle sevenoldstyle eightoldstyle
nineoldstyle""".split()


def _index(data, pos):
    """A CFF INDEX: count, offSize, offsets, then the concatenated items."""
    count = struct.unpack(">H", data[pos:pos + 2])[0]
    pos += 2
    if count == 0:
        return [], pos
    off_size = data[pos]
    pos += 1
    offs = []
    for i in range(count + 1):
        v = 0
        for b in data[pos:pos + off_size]:
            v = (v << 8) | b
        offs.append(v)
        pos += off_size
    base = pos - 1
    items = [data[base + offs[i]:base + offs[i + 1]] for i in range(count)]
    return items, base + offs[-1]


def _dict(data):
    """A CFF DICT: operands then an operator. Only integers are needed here."""
    out, operands, i = {}, [], 0
    while i < len(data):
        b = data[i]
        if b <= 21:
            op = b
            i += 1
            if b == 12:
                op = 1200 + data[i]
                i += 1
            out[op] = operands
            operands = []
        elif b == 28:
            operands.append(struct.unpack(">h", data[i + 1:i + 3])[0]); i += 3
        elif b == 29:
            operands.append(struct.unpack(">i", data[i + 1:i + 5])[0]); i += 5
        elif b == 30:  # real
            i += 1
            while i < len(data) and (data[i] & 0x0F) != 0x0F and (data[i] >> 4) != 0x0F:
                i += 1
            i += 1
            operands.append(0.0)
        elif 32 <= b <= 246:
            operands.append(b - 139); i += 1
        elif 247 <= b <= 250:
            operands.append((b - 247) * 256 + data[i + 1] + 108); i += 2
        elif 251 <= b <= 254:
            operands.append(-(b - 251) * 256 - data[i + 1] - 108); i += 2
        else:
            i += 1
    return out


def encoding(cff):
    """byte code -> glyph name, from the font's own charset and encoding."""
    hdr_size = cff[2]
    pos = hdr_size
    _names, pos = _index(cff, pos)
    topdicts, pos = _index(cff, pos)
    strings, pos = _index(cff, pos)
    top = _dict(topdicts[0])

    def sid_name(sid):
        if sid < len(STANDARD_STRINGS):
            return STANDARD_STRINGS[sid]
        j = sid - len(STANDARD_STRINGS)
        return strings[j].decode("latin1") if j < len(strings) else ".s%d" % sid

    n_glyphs = None
    charstrings_off = top.get(17, [None])[0]
    if charstrings_off:
        n_glyphs = struct.unpack(">H", cff[charstrings_off:charstrings_off + 2])[0]

    # charset: glyph index -> SID
    names = [".notdef"]
    cs_off = top.get(15, [0])[0]
    if cs_off > 2 and n_glyphs:
        fmt = cff[cs_off]
        p = cs_off + 1
        if fmt == 0:
            for _ in range(n_glyphs - 1):
                names.append(sid_name(struct.unpack(">H", cff[p:p + 2])[0]))
                p += 2
        elif fmt in (1, 2):
            while len(names) < n_glyphs:
                first = struct.unpack(">H", cff[p:p + 2])[0]; p += 2
                if fmt == 1:
                    n_left = cff[p]; p += 1
                else:
                    n_left = struct.unpack(">H", cff[p:p + 2])[0]; p += 2
                for k in range(n_left + 1):
                    if len(names) >= n_glyphs:
                        break
                    names.append(sid_name(first + k))

    # encoding: code -> glyph index
    enc_off = top.get(16, [0])[0]
    out = {}
    if enc_off > 1:
        fmt = cff[enc_off]
        p = enc_off + 1
        if (fmt & 0x7F) == 0:
            n_codes = cff[p]; p += 1
            for gid in range(1, n_codes + 1):
                out[cff[p]] = names[gid] if gid < len(names) else ".notdef"
                p += 1
        elif (fmt & 0x7F) == 1:
            n_ranges = cff[p]; p += 1
            gid = 1
            for _ in range(n_ranges):
                first, n_left = cff[p], cff[p + 1]; p += 2
                for k in range(n_left + 1):
                    if gid < len(names):
                        out[first + k] = names[gid]
                    gid += 1
        if fmt & 0x80:  # supplements
            n_sups = cff[p]; p += 1
            for _ in range(n_sups):
                code = cff[p]
                sid = struct.unpack(">H", cff[p + 1:p + 3])[0]
                out[code] = sid_name(sid)
                p += 3
    return out
