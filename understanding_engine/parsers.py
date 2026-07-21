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
# sample of rows answers exactly as well as the full file. It is never the step
# that reads actual data values for computation (that is the Computation Engine,
# reading source_reference straight from disk later). So no matter how large a
# real dataset is, only this small sample is ever sent to the model; the millions
# of rows never touch the LLM. 50 rows (up from 15) because a capable model with a
# large token budget can use a richer sample for better extraction, and it's still
# a tiny prompt. The sample is labeled honestly so the model (and anyone reading
# the intermediate text) knows it is not the whole file.
_CSV_SAMPLE_ROWS = 50


def parse_csv(path: Path) -> ParsedSource:
    # Streamed, not list(reader): a big operational file (millions of rows) must not
    # be pulled into memory just to sample the first few. We keep only the sample
    # rows and a running count, so memory stays bounded no matter the file size.
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        columns = reader.fieldnames or []
        sample: list[dict] = []
        total = 0
        for row in reader:
            total += 1
            if len(sample) < _CSV_SAMPLE_ROWS:
                sample.append(row)
    lines = [f"Source file: {path.name} (tabular)", f"Columns: {', '.join(columns)}", f"Total rows: {total}", ""]
    if total > _CSV_SAMPLE_ROWS:
        lines.append(f"Showing the first {_CSV_SAMPLE_ROWS} of {total} rows as a sample:")
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
