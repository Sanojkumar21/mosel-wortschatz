"""The word list: your own (data/private/) if present, otherwise the bundled sample.

A dataset is a list of chapters, each with numbered words:
    [{"number": 1, "title": "...", "words": [{"id": 1, "term": "der Fluss, Flüsse",
      "translation": "river", "example": "...", "core": true, "section": "..."}]}]
plus an optional {"<word id>": "English translation of the example"} map.
"""
from __future__ import annotations

import json
from pathlib import Path


class DatasetError(ValueError):
    pass


def validate(chapters) -> int:
    """Raise DatasetError if the structure is not usable; return the number of words."""
    if not isinstance(chapters, list) or not chapters:
        raise DatasetError("the word list must be a non-empty list of chapters")
    seen: set = set()
    for c in chapters:
        if not isinstance(c, dict) or "title" not in c or not isinstance(c.get("words"), list):
            raise DatasetError("every chapter needs a title and a list of words")
        for w in c["words"]:
            if not isinstance(w, dict) or not {"id", "term", "translation"} <= w.keys():
                raise DatasetError(f"word in chapter {c.get('number')!r} needs id, term and translation")
            if w["id"] in seen:
                raise DatasetError(f"duplicate word id {w['id']!r}")
            seen.add(w["id"])
    return len(seen)


def load_dataset(data_dir: Path) -> dict:
    """Prefer data/private (your own list, never committed); fall back to data/sample."""
    for source in ("private", "sample"):
        folder = data_dir / source
        vocab = folder / "vocab.json"
        if vocab.is_file():
            chapters = json.loads(vocab.read_text(encoding="utf-8"))
            words = validate(chapters)
            examples_file = folder / "examples_en.json"
            examples = json.loads(examples_file.read_text(encoding="utf-8")) if examples_file.is_file() else {}
            return {"source": source, "chapters": chapters, "examples_en": examples,
                    "chapter_count": len(chapters), "word_count": words}
    raise DatasetError(f"no word list found in {data_dir}/private or {data_dir}/sample")
