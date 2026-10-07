"""
빠른 메모 카테고리(상위 보관함) 및 정렬 정책 기능 검증 테스트 스크립트 (#8)
"""
import os
import sys

# 루트 경로 추가
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import db_service, notes_service


def test_note_categories_seeding_and_crud():
    print("[TEST 1] Note Categories 시딩 및 CRUD 검증 시작...")

    # 1. 시딩 확인 (최소 4개 기본 카테고리 존재)
    res = notes_service.get_note_categories()
    assert res["status"] == "success", f"get_note_categories 실패: {res}"
    categories = res["data"]
    assert len(categories) >= 4, f"기본 카테고리 개수 부족: {len(categories)}"
    
    cat_ids = [c["id"] for c in categories]
    assert "all" in cat_ids, "'all' 시스템 카테고리 누락"
    assert "scratch" in cat_ids, "'scratch' 시스템 카테고리 누락"
    assert "work" in cat_ids, "'work' 기본 카테고리 누락"
    assert "personal" in cat_ids, "'personal' 기본 카테고리 누락"
    print("  -> 기본 카테고리 4종(all, scratch, work, personal) 시딩 확인")

    # 2. 신규 카테고리 생성
    save_res = notes_service.save_note_category("new", "테스트 보관함", "📁")
    assert save_res["status"] == "success", f"save_note_category 생성 실패: {save_res}"
    new_cat_id = save_res["id"]
    print(f"  -> 신규 카테고리 생성 성공: {new_cat_id}")

    # 3. 카테고리 이름 및 아이콘 수정
    update_res = notes_service.save_note_category(new_cat_id, "수정된 보관함", "🏷️")
    assert update_res["status"] == "success", f"save_note_category 수정 실패: {update_res}"
    print("  -> 카테고리 수정 성공")

    # 4. 메모 생성 후 신규 카테고리 지정
    test_note = {
        "id": "test_note_cat_999",
        "title": "카테고리 테스트 메모",
        "content": "이 메모는 테스트 보관함에 속합니다.",
        "category": new_cat_id,
        "is_pinned": 1
    }
    save_notes_res = notes_service.save_notes([test_note])
    assert save_notes_res["status"] == "success", f"save_notes 실패: {save_notes_res}"

    # 카테고리 조회 시 notes_count 확인
    cat_res2 = notes_service.get_note_categories()
    target_cat = next((c for c in cat_res2["data"] if c["id"] == new_cat_id), None)
    assert target_cat is not None, "신규 카테고리 조회 실패"
    assert target_cat["notes_count"] == 1, f"메모 개수 불일치: {target_cat['notes_count']}"
    print("  -> 카테고리별 notes_count 집계 정상 동작")

    # 5. 카테고리 삭제 시 소속 메모 자동 이전(scratch로 이동) 검증
    del_res = notes_service.delete_note_category(new_cat_id)
    assert del_res["status"] == "success", f"delete_note_category 실패: {del_res}"
    print("  -> 카테고리 삭제 성공")

    # 이전된 메모 확인
    notes_list_res = notes_service.get_notes()
    migrated_note = next((n for n in notes_list_res["data"] if n["id"] == "test_note_cat_999"), None)
    assert migrated_note is not None, "메모가 유실됨"
    assert migrated_note["category"] == "scratch", f"메모가 scratch로 이전되지 않음: {migrated_note['category']}"
    print("  -> 소속 메모가 'scratch' 보관함으로 안전하게 자동 이전됨 확인")

    # 시스템 카테고리 삭제 방지 가드 검증
    sys_del_res = notes_service.delete_note_category("all")
    assert sys_del_res["status"] == "error", "시스템 카테고리 삭제가 허용됨"
    print("  -> 시스템 카테고리('all') 삭제 차단 가드 확인")

    print("[PASS] Test 1: Note Categories 시딩 및 CRUD 정상 완료")


def test_note_categories_reorder():
    print("[TEST 2] Note Categories 순서 변경 검증 시작...")
    cat_res = notes_service.get_note_categories()
    initial_ids = [c["id"] for c in cat_res["data"]]

    # 순서 뒤집기 (all은 제외하고)
    non_all_ids = [cid for cid in initial_ids if cid != "all"]
    reversed_ids = ["all"] + list(reversed(non_all_ids))

    reorder_res = notes_service.reorder_note_categories(reversed_ids)
    assert reorder_res["status"] == "success", f"reorder_note_categories 실패: {reorder_res}"

    cat_res_after = notes_service.get_note_categories()
    after_ids = [c["id"] for c in cat_res_after["data"]]
    assert after_ids == reversed_ids, f"순서 갱신 불일치: {after_ids} vs {reversed_ids}"
    print("  -> 카테고리 순서 일괄 갱신 성공")

    print("[PASS] Test 2: Note Categories 순서 변경 정상 완료")


if __name__ == "__main__":
    test_note_categories_seeding_and_crud()
    test_note_categories_reorder()
    print("\n[ALL PASS] Notes category functional tests completed successfully.")
