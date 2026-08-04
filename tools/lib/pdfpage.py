#!/usr/bin/env python3
"""Cut a single page out of a PDF into a standalone one-page PDF.

Written so an SSP page can be rasterised and looked at. macOS ships sips and
qlmanage, and both render only the first page of a document, so the only way
to see page 200 is to make it page 1 of something.

Object bodies are copied verbatim -- embedded font programs and content
streams included -- and their numbers preserved, so nothing has to be
re-encoded. Only the page's /Parent is rewritten, to point at the new
single-entry page tree.

    python3 tools/lib/pdfpage.py in.pdf 60 out.pdf
"""

import os
import re
import sys
import importlib.util

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("ssp_text", os.path.join(_here, "ssp_text.py"))
_text = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_text)

REF = re.compile(rb"(\d+)\s+\d+\s+R\b")


def page_list(objs):
    """Page object numbers in reading order."""
    root = None
    for num, body in objs.items():
        if b"/Type" in body and b"/Pages" in body and b"/Kids" in body and b"/Parent" not in body:
            root = num
            break
    if root is None:
        return []

    def walk(num, seen):
        if num in seen:
            return []
        seen.add(num)
        body = objs.get(num, b"")
        kids = re.search(rb"/Kids\s*\[(.*?)\]", body, re.S)
        if kids:
            out = []
            for m in REF.finditer(kids.group(1)):
                out += walk(int(m.group(1)), seen)
            return out
        return [num]

    return walk(root, set())


def collect(objs, start, skip_parent_of=None):
    """Every object reachable from `start`, following indirect references."""
    seen, stack = set(), [start]
    while stack:
        n = stack.pop()
        if n in seen or n not in objs:
            continue
        seen.add(n)
        body = objs[n]
        # Do not chase /Parent upward -- that would drag in the whole page tree.
        if n == skip_parent_of:
            body = re.sub(rb"/Parent\s+\d+\s+\d+\s+R", b"", body)
        # A stream's bytes can contain anything; only scan the dictionary.
        cut = body.find(b"stream")
        head = body if cut < 0 else body[:cut]
        for m in REF.finditer(head):
            stack.append(int(m.group(1)))
    return seen


def extract(data, index, out_path, box=None):
    objs = _text.objects(data)
    pages = page_list(objs)
    if not pages:
        raise SystemExit("no page tree found")
    if not 0 <= index < len(pages):
        raise SystemExit("page %d out of range (0..%d)" % (index, len(pages) - 1))
    pnum = pages[index]

    keep = collect(objs, pnum, skip_parent_of=pnum)
    nxt = max(objs) + 1
    cat_num, pages_num = nxt, nxt + 1

    body = objs[pnum]
    if re.search(rb"/Parent\s+\d+\s+\d+\s+R", body):
        body = re.sub(rb"/Parent\s+\d+\s+\d+\s+R", b"/Parent %d 0 R" % pages_num, body)
    else:
        body = body.replace(b"<<", b"<< /Parent %d 0 R" % pages_num, 1)
    if box:
        # Cropping is how you zoom: the rasteriser fits the MediaBox to the
        # output size, so a narrow box renders that band at high resolution.
        body = re.sub(rb"/MediaBox\s*\[[^\]]*\]", b"", body)
        body = re.sub(rb"/CropBox\s*\[[^\]]*\]", b"", body)
        body = body.replace(b"<<", b"<< /MediaBox [%d %d %d %d]" % tuple(box), 1)
    # MediaBox may have been inherited from the parent we just detached.
    if b"/MediaBox" not in body:
        inherited = None
        for anc in objs.values():
            m = re.search(rb"/MediaBox\s*\[[^\]]*\]", anc)
            if m:
                inherited = m.group(0)
                break
        if inherited:
            body = body.replace(b"<<", b"<< " + inherited, 1)

    out = bytearray(b"%PDF-1.4\n")
    offsets = {}

    def put(num, payload):
        offsets[num] = len(out)
        out.extend(b"%d 0 obj" % num)
        out.extend(payload)
        out.extend(b"endobj\n")

    for n in sorted(keep):
        put(n, body if n == pnum else objs[n])
    put(cat_num, b"<< /Type /Catalog /Pages %d 0 R >>\n" % pages_num)
    put(pages_num, b"<< /Type /Pages /Kids [%d 0 R] /Count 1 >>\n" % pnum)

    top = max(offsets) + 1
    xref_at = len(out)
    out.extend(b"xref\n0 %d\n" % top)
    out.extend(b"0000000000 65535 f \n")
    for i in range(1, top):
        if i in offsets:
            out.extend(b"%010d 00000 n \n" % offsets[i])
        else:
            out.extend(b"0000000000 65535 f \n")
    out.extend(b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n"
               % (top, cat_num, xref_at))
    open(out_path, "wb").write(bytes(out))
    return len(keep)


if __name__ == "__main__":
    src, idx, dst = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    box = [int(v) for v in sys.argv[4:8]] if len(sys.argv) >= 8 else None
    n = extract(open(src, "rb").read(), idx, dst, box)
    print("wrote %s (%d objects, %.0f kB)" % (dst, n, os.path.getsize(dst) / 1024))
