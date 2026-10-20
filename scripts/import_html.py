"""Import a word list from the original single-file trainer into data/private/.

The first version of Mosel Wortschatz was one HTML file with the vocabulary embedded as
`const VOCAB_DATA = [...]` and `const EXAMPLE_EN = {...}`. This pulls those two objects out
into JSON so the app can load them, without publishing them: data/private/ is git-ignored.

    python scripts/import_html.py path/to/trainer.html
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def extract(html: str, name: str):
    m = re.search(rf"const {name} = (.*?);\s*$", html, re.M)
    if not m:
        raise SystemExit(f"{name} not found in the HTML")
    return json.loads(m.group(1))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("html", type=Path)
    ap.add_argument("--out", type=Path, default=ROOT / "data" / "private")
    args = ap.parse_args(argv)
    html = args.html.read_text(encoding="utf-8")
    vocab = extract(html, "VOCAB_DATA")
    examples = extract(html, "EXAMPLE_EN")
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "vocab.json").write_text(json.dumps(vocab, ensure_ascii=False, indent=1), encoding="utf-8")
    (args.out / "examples_en.json").write_text(json.dumps(examples, ensure_ascii=False, indent=1), encoding="utf-8")
    words = sum(len(c["words"]) for c in vocab)
    print(f"imported {len(vocab)} chapters, {words} words, {len(examples)} translations into {args.out}")


if __name__ == "__main__":
    sys.exit(main())
