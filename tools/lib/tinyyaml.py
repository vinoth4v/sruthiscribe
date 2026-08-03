"""A YAML subset parser, just enough for the CompMusic varnam notations.

PyYAML is not installable on a PEP 668 managed Python without a virtualenv, and
the rest of tools/ is deliberately dependency-free, so this handles the shapes
those files actually use:

    key: scalar                 quoted or bare
    key:                        followed by an indented mapping or sequence
    - item                      block sequences
    - - - S                     compact nested sequences on one line

Comments, anchors, flow collections, multi-line scalars and everything else in
the spec are out of scope -- the notations use none of them.
"""


def _scalar(text):
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"":
        return text[1:-1]
    return text


def _expand(indent, body):
    """Split compact nesting into one physical line per level.

    "- - - S" becomes "-" / "  -" / "    - S", so that every entry's logical
    column is simply its leading whitespace and the parser needs no separate
    notion of position.
    """
    out = []
    while body.startswith("- "):
        rest = body[2:]
        if rest == "-" or rest.startswith("- "):
            out.append((indent, "-"))
            indent += 2
            body = rest
            continue
        break
    out.append((indent, body))
    return out


class _Parser(object):
    def __init__(self, text):
        self.lines = []
        for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
            if not raw.strip():
                continue
            raw = raw.rstrip()
            indent = len(raw) - len(raw.lstrip(" "))
            self.lines.extend(_expand(indent, raw[indent:]))
        self.i = 0

    def at_end(self):
        return self.i >= len(self.lines)

    def peek(self):
        return self.lines[self.i]

    def parse(self, col):
        """Parse the block whose entries start at column `col`."""
        _, body = self.peek()
        if body == "-" or body.startswith("- "):
            return self.parse_seq(col)
        return self.parse_map(col)

    def parse_seq(self, col):
        out = []
        while not self.at_end():
            indent, body = self.peek()
            if indent != col or (body != "-" and not body.startswith("- ")):
                break
            rest = body[2:] if body.startswith("- ") else ""
            self.i += 1
            if not rest.strip():
                out.append(self.parse_nested(col))
            else:
                out.append(_scalar(rest))
        return out

    def parse_map(self, col):
        out = {}
        while not self.at_end():
            indent, body = self.peek()
            if indent != col or ":" not in body:
                break
            key, _, rest = body.partition(":")
            self.i += 1
            if rest.strip():
                out[key.strip()] = _scalar(rest)
            else:
                out[key.strip()] = self.parse_nested(col, under_key=True)
        return out

    def parse_nested(self, col, under_key=False):
        """Parse the block that follows a key or a bare '-'."""
        if self.at_end():
            return None
        indent, body = self.peek()
        if indent > col:
            return self.parse(indent)
        # A block sequence is allowed to sit at its own key's indentation.
        if under_key and indent == col and (body == "-" or body.startswith("- ")):
            return self.parse_seq(col)
        return None


def load(text):
    p = _Parser(text)
    if p.at_end():
        return None
    return p.parse(p.peek()[0])


def load_file(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return load(f.read())
