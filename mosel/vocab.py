"""The word list: your own if present, otherwise the bundled sample.

Where "your own" can live, first match wins:
  1. WORDLIST_DIR, if set (any folder with vocab.json)
  2. /etc/secrets, where Render puts Secret Files (so a hosted copy needs no repository change)
  3. data/private/ (git-ignored, for running locally)

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


RENDER_SECRETS = Path("/etc/secrets")


def candidate_folders(data_dir: Path, wordlist_dir: Path | None = None) -> list[tuple[str, Path]]:
    folders = []
    if wordlist_dir:
        folders.append(("private", wordlist_dir))
    folders.append(("private", RENDER_SECRETS))
    folders.append(("private", data_dir / "private"))
    folders.append(("sample", data_dir / "sample"))
    return folders


def load_dataset(data_dir: Path, wordlist_dir: Path | None = None) -> dict:
    """Your own list if one is found (never committed); otherwise the public sample."""
    for source, folder in candidate_folders(data_dir, wordlist_dir):
        vocab = folder / "vocab.json"
        if vocab.is_file():
            chapters = json.loads(vocab.read_text(encoding="utf-8"))
            words = validate(chapters)
            examples_file = folder / "examples_en.json"
            examples = json.loads(examples_file.read_text(encoding="utf-8")) if examples_file.is_file() else {}
            return {"source": source, "chapters": chapters, "examples_en": examples,
                    "chapter_count": len(chapters), "word_count": words}
    looked = ", ".join(str(f) for _, f in candidate_folders(data_dir, wordlist_dir))
    raise DatasetError(f"no word list found (looked in {looked})")
