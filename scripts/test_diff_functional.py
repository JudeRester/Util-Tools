"""
Diff Checker 백엔드 기능 테스트 (scripts/test_diff_functional.py)
- services.diff_service의 주요 알고리즘 및 API 기능 전수 검증
- 100% 자동화 단위/기능 테스트
"""

import sys
from pathlib import Path

# 루트 디렉토리 sys.path 추가
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from services.diff_service import (
    compute_text_diff,
    get_diff_sample_texts,
    _compute_inline_tokens,
    _merge_consecutive_parts
)


def test_identical_texts():
    text = "Hello world\nThis is a test\nSame content"
    res = compute_text_diff(text, text)
    assert res["status"] == "success", "Status should be success"
    stats = res["stats"]
    assert stats["is_identical"] is True, "is_identical must be True"
    assert stats["additions"] == 0, "Additions must be 0"
    assert stats["deletions"] == 0, "Deletions must be 0"
    assert stats["modifications"] == 0, "Modifications must be 0"
    assert stats["unchanged"] == 3, "Unchanged must be 3"
    assert len(res["items"]) == 3, "Should have 3 items"
    assert all(item["type"] == "equal" for item in res["items"]), "All items must be equal"
    print("  [PASS] test_identical_texts")


def test_additions_and_deletions():
    orig = "Line 1\nLine 2\nLine 3"
    mod = "Line 1\nLine 3\nLine 4"
    res = compute_text_diff(orig, mod)
    assert res["status"] == "success"
    stats = res["stats"]
    assert stats["is_identical"] is False
    assert stats["deletions"] == 1, f"Expected 1 deletion, got {stats['deletions']}"
    assert stats["additions"] == 1, f"Expected 1 addition, got {stats['additions']}"
    assert stats["unchanged"] == 2, f"Expected 2 unchanged, got {stats['unchanged']}"
    print("  [PASS] test_additions_and_deletions")


def test_word_level_inline_diff():
    orig = "function processData(value) {\n    return value * 2;\n}"
    mod = "function processData(value, factor = 1) {\n    return value * factor;\n}"
    res = compute_text_diff(orig, mod, {"granularity": "word"})
    assert res["status"] == "success"
    stats = res["stats"]
    assert stats["modifications"] == 2, f"Expected 2 modifications, got {stats['modifications']}"
    
    # Check that inline tokens exist
    first_mod = res["items"][0]
    assert first_mod["type"] == "replace"
    assert any(p["type"] == "ins" for p in first_mod["mod_parts"])
    print("  [PASS] test_word_level_inline_diff")


def test_char_and_line_granularity():
    orig = "abc123def"
    mod = "abc456def"
    res_char = compute_text_diff(orig, mod, {"granularity": "char"})
    assert res_char["status"] == "success"
    item_char = res_char["items"][0]
    assert item_char["type"] == "replace"
    del_chars = [p["text"] for p in item_char["orig_parts"] if p["type"] == "del"]
    ins_chars = [p["text"] for p in item_char["mod_parts"] if p["type"] == "ins"]
    assert "123" in "".join(del_chars)
    assert "456" in "".join(ins_chars)

    res_line = compute_text_diff(orig, mod, {"granularity": "line"})
    assert res_line["status"] == "success"
    item_line = res_line["items"][0]
    assert item_line["orig_parts"] == [{"text": orig, "type": "del"}]
    assert item_line["mod_parts"] == [{"text": mod, "type": "ins"}]
    print("  [PASS] test_char_and_line_granularity")


def test_ignore_whitespace():
    orig = "   hello   world   \nfoo  bar"
    mod = "hello world\nfoo bar"
    # Without ignore_whitespace
    res_strict = compute_text_diff(orig, mod, {"ignore_whitespace": False})
    assert res_strict["stats"]["is_identical"] is False

    # With ignore_whitespace
    res_relaxed = compute_text_diff(orig, mod, {"ignore_whitespace": True})
    assert res_relaxed["stats"]["is_identical"] is True
    assert res_relaxed["stats"]["unchanged"] == 2
    print("  [PASS] test_ignore_whitespace")


def test_ignore_case():
    orig = "HELLO WORLD\nFoo Bar"
    mod = "hello world\nfoo bar"
    res_strict = compute_text_diff(orig, mod, {"ignore_case": False})
    assert res_strict["stats"]["is_identical"] is False

    res_case_ins = compute_text_diff(orig, mod, {"ignore_case": True})
    assert res_case_ins["stats"]["is_identical"] is True
    print("  [PASS] test_ignore_case")


def test_ignore_blank_lines():
    orig = "Line 1\n\nLine 2\n\n\nLine 3"
    mod = "Line 1\nLine 2\nLine 3"
    res = compute_text_diff(orig, mod, {"ignore_blank_lines": True})
    assert res["status"] == "success"
    assert res["stats"]["is_identical"] is True
    assert res["stats"]["unchanged"] == 3
    # Check that original line numbers were preserved
    orig_nums = [item["orig_line_num"] for item in res["items"]]
    assert orig_nums == [1, 3, 6], f"Expected original line numbers [1, 3, 6], got {orig_nums}"
    print("  [PASS] test_ignore_blank_lines")


def test_empty_inputs():
    res_both_empty = compute_text_diff("", "")
    assert res_both_empty["status"] == "success"
    assert res_both_empty["stats"]["is_identical"] is True
    assert len(res_both_empty["items"]) == 0

    res_orig_empty = compute_text_diff("", "New line 1\nNew line 2")
    assert res_orig_empty["status"] == "success"
    assert res_orig_empty["stats"]["additions"] == 2
    assert res_orig_empty["stats"]["deletions"] == 0

    res_mod_empty = compute_text_diff("Old line 1", "")
    assert res_mod_empty["status"] == "success"
    assert res_mod_empty["stats"]["deletions"] == 1
    assert res_mod_empty["stats"]["additions"] == 0
    print("  [PASS] test_empty_inputs")


def test_sample_texts_and_patch():
    samples = get_diff_sample_texts()
    assert samples["status"] == "success"
    assert len(samples["orig_text"]) > 50
    assert len(samples["mod_text"]) > 50

    res = compute_text_diff(samples["orig_text"], samples["mod_text"])
    assert res["status"] == "success"
    assert res["stats"]["is_identical"] is False
    assert res["stats"]["modifications"] > 0
    assert len(res["unified_patch"]) > 0
    assert "--- Original" in res["unified_patch"]
    assert "+++ Modified" in res["unified_patch"]
    print("  [PASS] test_sample_texts_and_patch")


def run_all_tests():
    print("\n--- Running Diff Checker Functional Tests ---")
    test_identical_texts()
    test_additions_and_deletions()
    test_word_level_inline_diff()
    test_char_and_line_granularity()
    test_ignore_whitespace()
    test_ignore_case()
    test_ignore_blank_lines()
    test_empty_inputs()
    test_sample_texts_and_patch()
    print("--- ALL 9 DIFF CHECKER FUNCTIONAL TESTS PASSED! ---\n")


if __name__ == "__main__":
    run_all_tests()
