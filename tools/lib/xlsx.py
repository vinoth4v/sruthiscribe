"""Read the cells of a simple .xlsx, without a spreadsheet library.

An xlsx is a zip of XML. For a single-sheet file of plain values -- which is
what a published annotation table is -- the whole format reduces to: resolve
shared strings, walk the rows, read each cell's value. Formulas, styles,
merged ranges and multiple sheets are out of scope and would need openpyxl.

Kept dependency-free on purpose, like the rest of tools/: the harness and the
builders must run on a clean checkout with nothing but python3.
"""

import re
import zipfile
from xml.etree import ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _shared_strings(z):
    """The string table xlsx uses so repeated text is stored once."""
    if "xl/sharedStrings.xml" not in z.namelist():
        return []
    root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    # A shared string can be split across several <t> runs when part of it is
    # styled differently; the cell's value is all of them concatenated.
    return ["".join(t.text or "" for t in si.iter(NS + "t"))
            for si in root.iter(NS + "si")]


def rows(path, sheet="xl/worksheets/sheet1.xml"):
    """Yield each row as a dict of column letter -> cell text."""
    z = zipfile.ZipFile(path)
    strings = _shared_strings(z)
    root = ET.fromstring(z.read(sheet))
    out = []
    for row in root.iter(NS + "row"):
        cells = {}
        for c in row.iter(NS + "c"):
            v = c.find(NS + "v")
            if v is None or v.text is None:
                continue
            col = re.match(r"[A-Z]+", c.get("r") or "").group(0)
            cells[col] = strings[int(v.text)] if c.get("t") == "s" else v.text
        out.append(cells)
    return out


def table(path, sheet="xl/worksheets/sheet1.xml"):
    """Rows as dicts keyed by the header row's names."""
    raw = rows(path, sheet)
    if not raw:
        return []
    head = raw[0]
    return [{head[col]: cells[col] for col in cells if col in head}
            for cells in raw[1:]]
