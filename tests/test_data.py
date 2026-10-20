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
