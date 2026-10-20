import json

import pytest

from mosel.vocab import DatasetError, load_dataset, validate


def test_sample_list_is_valid(data_dir):
    d = load_dataset(data_dir)
    assert d["source"] == "sample" and d["word_count"] == 60
    assert set(d["examples_en"]) == {str(w["id"]) for c in d["chapters"] for w in c["words"]}


def test_private_list_wins_over_the_sample(data_dir):
    (data_dir / "private").mkdir()
    (data_dir / "private" / "vocab.json").write_text(json.dumps(
        [{"number": 1, "title": "Mine", "words": [{"id": 1, "term": "das Haus", "translation": "house"}]}]))
    d = load_dataset(data_dir)
    assert d["source"] == "private" and d["word_count"] == 1 and d["examples_en"] == {}


@pytest.mark.parametrize("bad", [
    [],
    [{"title": "x"}],
    [{"title": "x", "words": [{"id": 1, "term": "a"}]}],
    [{"title": "x", "words": [{"id": 1, "term": "a", "translation": "b"}, {"id": 1, "term": "c", "translation": "d"}]}],
])
def test_invalid_lists_are_rejected(bad):
    with pytest.raises(DatasetError):
        validate(bad)


def test_import_script_extracts_embedded_data(tmp_path):
    from scripts.import_html import main
    html = tmp_path / "t.html"
    vocab = '[{"number": 1, "title": "A", "words": [{"id": 1, "term": "der Fluss", "translation": "river"}]}]'
    examples = '{"1": "x"}'
    html.write_text(f"<script>\nconst VOCAB_DATA = {vocab};\n</script>\n"
                    f"<script>\nconst EXAMPLE_EN = {examples};\n</script>")
    main([str(html), "--out", str(tmp_path / "out")])
    assert json.loads((tmp_path / "out" / "vocab.json").read_text())[0]["words"][0]["term"] == "der Fluss"


def test_wordlist_dir_and_render_secret_files_win(data_dir, tmp_path, monkeypatch):
    import mosel.vocab as vocab_module
    mine = [{"number": 1, "title": "Mine", "words": [{"id": 7, "term": "die Burg", "translation": "castle"}]}]
    secrets = tmp_path / "etc-secrets"
    secrets.mkdir()
    (secrets / "vocab.json").write_text(json.dumps(mine))
    monkeypatch.setattr(vocab_module, "RENDER_SECRETS", secrets)
    assert load_dataset(data_dir)["word_count"] == 1                        # Render Secret Files
    other = tmp_path / "elsewhere"
    other.mkdir()
    (other / "vocab.json").write_text(json.dumps(mine * 1 + [{"number": 2, "title": "B", "words": [
        {"id": 8, "term": "der Turm", "translation": "tower"}]}]))
    assert load_dataset(data_dir, other)["word_count"] == 2                 # WORDLIST_DIR beats both


def test_without_secrets_the_sample_is_used(data_dir, tmp_path, monkeypatch):
    import mosel.vocab as vocab_module
    monkeypatch.setattr(vocab_module, "RENDER_SECRETS", tmp_path / "missing")
    assert load_dataset(data_dir)["source"] == "sample"


def test_static_build_points_at_the_backend_and_has_no_private_data(tmp_path):
    from scripts.build_static import build
    out = build(tmp_path / "site", backend="https://backend.example/")
    assert '<meta name="mosel-backend" content="https://backend.example/">' in (out / "index.html").read_text()
    assert json.loads((out / "data" / "vocab.json").read_text())[0]["title"] == "Unterwegs"   # the public sample
    off = build(tmp_path / "site2", backend="")
    assert '<meta name="mosel-backend" content="">' in (off / "index.html").read_text()
