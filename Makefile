PY ?= .venv/bin/python
PORT ?= 8000

.PHONY: setup serve test lint static import docker

setup:            ## create the virtualenv and install everything
	python3 -m venv .venv
	$(PY) -m pip install -q -r requirements-dev.txt
	[ -f .env ] || cp .env.example .env
	@echo "Add your GROQ_API_KEY to .env, then: make serve"

serve:            ## run the trainer at http://127.0.0.1:$(PORT)
	PORT=$(PORT) $(PY) -m mosel

test:             ## backend + browser-client tests
	$(PY) -m pytest -q
	node --test tests/js/

lint:
	$(PY) -m ruff check .

static:           ## build the static site (no backend) into _site/
	$(PY) scripts/build_static.py

import:           ## import your word list from the old single-file trainer: make import HTML=path/to/file.html
	$(PY) scripts/import_html.py $(HTML)

docker:           ## build and run the container (reads .env)
	docker build -t mosel-wortschatz .
	docker run --rm -p $(PORT):8000 --env-file .env mosel-wortschatz
