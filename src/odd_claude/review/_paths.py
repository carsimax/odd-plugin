"""Node `path.join` semantics (normalizing join) and recursive mkdir for the review modules."""
import os
import posixpath
import re


def js_join(*parts: str) -> str:
    parts = tuple(p for p in parts if p != "")
    if not parts:
        return "."
    n = re.sub(r"^/{2,}", "/", posixpath.normpath("/".join(parts)))  # normpath keeps a leading "//"
    return n + "/" if parts[-1].endswith("/") and n != "/" else n


def mkdirp(path: str, mode: int) -> None:
    """`mkdirSync(path, {recursive: true, mode})`: every created directory gets `mode`; an existing non-directory raises."""
    if os.path.isdir(path):
        return
    parent = os.path.dirname(path)
    if parent and parent != path:
        mkdirp(parent, mode)
    try:
        os.mkdir(path, mode)
    except FileExistsError:
        if not os.path.isdir(path):
            raise
