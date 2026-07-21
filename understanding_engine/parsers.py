"""Ingestion boundary: get raw content into normalized text.

No interpretation happens here — CSV rows become readable text lines, PDF
pages become extracted text, plain text passes through unchanged. Meaning
(entities, relationships) is only assigned in llm_extraction.py.
"""

import csv
from dataclasses import dataclass
from pathlib import Path

from pypdf import PdfReader


@dataclass
class ParsedSource:
    source_name: str
    text: str


# Entity extraction's job is to recognize WHICH columns are signals/entities
# and how they relate to assets — a semantic, structural judgment that a
# representative sample of rows answers exactly as well as the full file.
# It is never the step that reads actual data values for computation (that
# is the Computation Engine, reading source_reference straight from disk
# later). Sending every row of a real operational-size file here only
# inflates the prompt — observed in practice to push a single extraction
# call to ~35,000 tokens on a 1,440-row file, enough on its own to exceed a
# provider's per-minute token budget regardless of how many requests it
# allows. The sample is labeled honestly so the LLM (and anyone reading the
# intermediate text) knows it is not the whole file.
_CSV_SAMPLE_ROWS = 15


def parse_csv(path: Path) -> ParsedSource:
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        columns = reader.fieldnames or []
        rows = list(reader)
    lines = [f"Source file: {path.name} (tabular)", f"Columns: {', '.join(columns)}", f"Total rows: {len(rows)}", ""]
    sample = rows[:_CSV_SAMPLE_ROWS]
    if len(rows) > _CSV_SAMPLE_ROWS:
        lines.append(f"Showing the first {_CSV_SAMPLE_ROWS} of {len(rows)} rows as a representative sample:")
    for i, row in enumerate(sample, start=1):
        fields = " | ".join(f"{col}={row.get(col, '')}" for col in columns)
        lines.append(f"Row {i}: {fields}")
    return ParsedSource(source_name=path.name, text="\n".join(lines))


def parse_pdf(path: Path) -> ParsedSource:
    reader = PdfReader(str(path))
    pages = [page.extract_text() or "" for page in reader.pages]
    text = f"Source file: {path.name} (PDF)\n\n" + "\n\n".join(pages)
    return ParsedSource(source_name=path.name, text=text)


def parse_text(path: Path) -> ParsedSource:
    raw = path.read_text(encoding="utf-8")
    text = f"Source file: {path.name} (plain text)\n\n{raw}"
    return ParsedSource(source_name=path.name, text=text)


_PARSERS_BY_SUFFIX = {
    ".csv": parse_csv,
    ".pdf": parse_pdf,
    ".txt": parse_text,
}


def parse_source(path: Path) -> ParsedSource:
    parser = _PARSERS_BY_SUFFIX.get(path.suffix.lower())
    if parser is None:
        raise ValueError(f"no parser registered for file type: {path.suffix} ({path.name})")
    return parser(path)
