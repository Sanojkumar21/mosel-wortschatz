"""Build the static site (no backend) into _site/ for GitHub Pages or any static host.

It contains the trainer and the public sample word list. If the hosted backend (DEFAULT_BACKEND, or
MOSEL_BACKEND="" to turn it off) is reachable, the page uses it for the full word list and for AI,
so visitors need no key; otherwise AI uses the learner's own Groq key. Your private word list is
never included in the build.

    python scripts/build_static.py
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


# The hosted backend this static copy may use for the full word list and AI (empty: own-key mode only).
DEFAULT_BACKEND = "https://mosel-wortschatz.onrender.com/"


def build(out: Path = ROOT / "_site", backend: str | None = None) -> Path:
    backend = DEFAULT_BACKEND if backend is None else backend
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / "web", out)
    index = out / "index.html"
    index.write_text(index.read_text(encoding="utf-8").replace(
        '<meta name="mosel-backend" content="">', f'<meta name="mosel-backend" content="{backend}">'), encoding="utf-8")
    (out / "data").mkdir()
    for name in ("vocab.json", "examples_en.json"):
        shutil.copy(ROOT / "data" / "sample" / name, out / "data" / name)
    (out / ".nojekyll").write_text("")
    return out


if __name__ == "__main__":
    print(f"static site written to {build(backend=os.environ.get('MOSEL_BACKEND'))}")
