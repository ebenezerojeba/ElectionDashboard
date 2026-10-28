"""Fallback text extractor for damaged PDFs.

1. pypdf (tolerant of broken cross-reference tables).
2. If pypdf cannot open the file or reads no pages, the structure is repaired in memory
   with qpdf (via pikepdf) and pypdf is retried. The source file is never modified.

Reads one file path from argv and writes JSON
{"pageCount": n, "pages": [[line, ...], ...], "pageErrors": [i, ...], "repaired": bool} to stdout.
Prints nothing else; never logs content."""
import io
import json
import logging
import sys
import warnings

logging.disable(logging.CRITICAL)
warnings.filterwarnings("ignore")
from pypdf import PdfReader  # noqa: E402


def read(stream) -> dict:
    reader = PdfReader(stream, strict=False)
    pages, errors = [], []
    for i, page in enumerate(reader.pages):
        try:
            text = page.extract_text() or ""
            pages.append([ln.strip() for ln in text.splitlines() if ln.strip()])
        except Exception:
            pages.append([])
            errors.append(i)
    return {"pageCount": len(reader.pages), "pages": pages, "pageErrors": errors}


def repaired_stream(path: str):
    import pikepdf  # optional dependency

    buf = io.BytesIO()
    with pikepdf.open(path, suppress_warnings=True, attempt_recovery=True) as pdf:
        pdf.save(buf)
    buf.seek(0)
    return buf


def main(path: str) -> None:
    result = None
    try:
        result = read(path)
    except Exception:
        result = None
    if result is None or result["pageCount"] == 0 or len(result["pageErrors"]) == result["pageCount"]:
        try:
            result = read(repaired_stream(path))
            result["repaired"] = True
        except Exception:
            if result is None:
                raise
    result.setdefault("repaired", False)
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main(sys.argv[1])
