"""Build the static site (no backend) into _site/ for GitHub Pages or any static host.

It contains the trainer and the public sample word list. AI features then use the learner's
own Groq key, entered in the page. Your private word list is never included.

    python scripts/build_static.py
"""
from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def build(out: Path = ROOT / "_site") -> Path:
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / "web", out)
    (out / "data").mkdir()
    for name in ("vocab.json", "examples_en.json"):
        shutil.copy(ROOT / "data" / "sample" / name, out / "data" / name)
    (out / ".nojekyll").write_text("")
    return out


if __name__ == "__main__":
    print(f"static site written to {build()}")
