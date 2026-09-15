import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.generator_service import get_generators, save_generators

def run_tests():
    print("[1] Fetching current generators from DB...")
    res = get_generators()
    assert res["status"] == "success", f"Failed to get generators: {res}"
    orig_generators = res["data"]
    print(f"    Loaded {len(orig_generators)} generators.")

    for g in orig_generators:
        assert "variables" in g, f"Generator {g.get('name')} missing 'variables' key"
        assert isinstance(g["variables"], list), f"Generator {g.get('name')} variables must be a list"

    print("[2] Testing save_generators with custom variables...")
    test_gen_id = "test_var_gen_" + str(len(orig_generators) + 1)
    test_gen = {
        "id": test_gen_id,
        "name": "단위 테스트 생성기",
        "icon": "🧪",
        "category": "테스트",
        "description": "파라미터 바인딩 검증용 테스트 생성기",
        "variables": [
            {
                "id": "var_prefix",
                "name": "prefix",
                "label": "접두사",
                "type": "text",
                "defaultValue": "TEST-",
                "description": "식별자 접두어"
            },
            {
                "id": "var_count",
                "name": "count",
                "label": "자릿수",
                "type": "number",
                "defaultValue": 8,
                "description": "난수 자릿수"
            },
            {
                "id": "var_body",
                "name": "template",
                "label": "여러 줄 템플릿",
                "type": "textarea",
                "defaultValue": "Line 1\nLine 2\nLine 3",
                "description": "여러 줄 텍스트 (줄바꿈 보존)"
            }
        ],
        "code": "const p = (params && params.prefix) || 'TEST-'; return p + Date.now();"
    }

    test_list = [g.copy() for g in orig_generators] + [test_gen]
    save_res = save_generators(test_list)
    assert save_res["status"] == "success", f"Failed to save generators: {save_res}"
    print("    Save successful.")

    print("[3] Verifying SQLite persistence and variables deserialization...")
    res2 = get_generators()
    assert res2["status"] == "success"
    retrieved_gens = {g["id"]: g for g in res2["data"]}
    assert test_gen_id in retrieved_gens, "Saved test generator not found in DB"

    saved_test_gen = retrieved_gens[test_gen_id]
    assert len(saved_test_gen["variables"]) == 3, f"Expected 3 variables, got: {saved_test_gen['variables']}"
    assert saved_test_gen["variables"][0]["name"] == "prefix"
    assert saved_test_gen["variables"][1]["name"] == "count"
    assert saved_test_gen["variables"][2]["name"] == "template"
    assert saved_test_gen["variables"][2]["type"] == "textarea"
    assert "\n" in saved_test_gen["variables"][2]["defaultValue"], "Newline in textarea defaultValue must be preserved"
    assert saved_test_gen["variables"][2]["defaultValue"] == "Line 1\nLine 2\nLine 3"
    print("    Variables (including multiline textarea with newlines) verified in DB.")

    print("[4] Cleaning up test generator (Restoring original state)...")
    clean_res = save_generators(orig_generators)
    assert clean_res["status"] == "success", f"Failed to clean up: {clean_res}"
    
    res3 = get_generators()
    assert len(res3["data"]) == len(orig_generators)
    assert test_gen_id not in [g["id"] for g in res3["data"]]
    print("    Cleanup complete and original state restored.")

    print("ALL GENERATOR SERVICE FUNCTIONAL TESTS PASSED!")

if __name__ == "__main__":
    run_tests()
