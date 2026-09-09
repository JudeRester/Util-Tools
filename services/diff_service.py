"""
텍스트 차이점 비교 (Diff Checker) 백엔드 서비스 모듈 (services/diff_service.py)
- Python difflib.SequenceMatcher 기반 고성능 텍스트 비교 엔진
- 행(Line) 단위 비교 및 단어(Word) / 문자(Character) 단위 인라인 세부 하이라이팅
- 공백 무시(ignore_whitespace), 대소문자 무시(ignore_case), 빈 줄 무시(ignore_blank_lines) 옵션 지원
- Split View(나란히 보기) 및 Unified View(단일 통합 보기) 양방향 정렬 데이터 모델 반환
- 파일 인코딩(UTF-8, CP949 등) 자동 감지 로컬 파일 읽기 지원
"""

import os
import re
import difflib
from typing import Dict, Any, List, Optional, Tuple
import eel

from core.paths import APP_DIR


def _detect_encoding_and_read(file_path: str) -> Tuple[str, str]:
    """파일의 인코딩을 자동 감지하여 텍스트 및 감지된 인코딩명 반환"""
    encodings_to_try = ['utf-8-sig', 'utf-8', 'cp949', 'euc-kr', 'latin-1']
    with open(file_path, 'rb') as f:
        raw_bytes = f.read()

    for enc in encodings_to_try:
        try:
            return raw_bytes.decode(enc), enc
        except UnicodeDecodeError:
            continue

    return raw_bytes.decode('utf-8', errors='replace'), 'utf-8 (fallback)'


def _merge_consecutive_parts(parts: List[Dict[str, str]]) -> List[Dict[str, str]]:
    """동일한 타입의 연속된 인라인 토큰을 단일 문자열로 병합하여 DOM 노드 수 최소화"""
    if not parts:
        return []
    merged = [dict(parts[0])]
    for p in parts[1:]:
        if p["type"] == merged[-1]["type"]:
            merged[-1]["text"] += p["text"]
        else:
            merged.append(dict(p))
    return merged


def _compute_inline_tokens(
    orig_str: str,
    mod_str: str,
    granularity: str,
    ignore_case: bool
) -> Tuple[List[Dict[str, str]], List[Dict[str, str]]]:
    """변경된 행 내부의 단어/문자 세부 차이점 토큰 계산"""
    if granularity == "line":
        op = [{"text": orig_str, "type": "del"}] if orig_str else []
        mp = [{"text": mod_str, "type": "ins"}] if mod_str else []
        return op, mp

    if granularity == "char":
        orig_tokens = list(orig_str)
        mod_tokens = list(mod_str)
    else:  # "word" (기본값)
        orig_tokens = re.findall(r'\w+|\s+|[^\w\s]', orig_str)
        mod_tokens = re.findall(r'\w+|\s+|[^\w\s]', mod_str)

    def tok_norm(t: str) -> str:
        return t.lower() if ignore_case else t

    comp_orig = [tok_norm(t) for t in orig_tokens]
    comp_mod = [tok_norm(t) for t in mod_tokens]

    sm = difflib.SequenceMatcher(None, comp_orig, comp_mod)
    orig_parts = []
    mod_parts = []

    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        ot = "".join(orig_tokens[i1:i2])
        mt = "".join(mod_tokens[j1:j2])

        if tag == 'equal':
            if ot:
                orig_parts.append({"text": ot, "type": "equal"})
            if mt:
                mod_parts.append({"text": mt, "type": "equal"})
        elif tag == 'delete':
            if ot:
                orig_parts.append({"text": ot, "type": "del"})
        elif tag == 'insert':
            if mt:
                mod_parts.append({"text": mt, "type": "ins"})
        elif tag == 'replace':
            if ot:
                orig_parts.append({"text": ot, "type": "del"})
            if mt:
                mod_parts.append({"text": mt, "type": "ins"})

    return _merge_consecutive_parts(orig_parts), _merge_consecutive_parts(mod_parts)


@eel.expose
def compute_text_diff(orig_text: str, mod_text: str, options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    두 텍스트 간의 차이점을 계산하고 통계 및 행/인라인 토큰 구조 반환
    """
    try:
        options = options or {}
        ignore_whitespace = bool(options.get("ignore_whitespace", False))
        ignore_case = bool(options.get("ignore_case", False))
        ignore_blank_lines = bool(options.get("ignore_blank_lines", False))
        granularity = str(options.get("granularity", "word")).lower()
        if granularity not in ("word", "char", "line"):
            granularity = "word"

        def normalize_line(s: str) -> str:
            val = s
            if ignore_case:
                val = val.lower()
            if ignore_whitespace:
                val = re.sub(r'\s+', ' ', val.strip())
            return val

        raw_orig_lines = orig_text.splitlines()
        raw_mod_lines = mod_text.splitlines()

        # 인덱스 및 원본 행 보존 (빈 줄 무시 필터링 적용 시에도 실제 라인 번호 유지)
        orig_indexed: List[Tuple[int, str, str]] = []
        for idx, l in enumerate(raw_orig_lines):
            if ignore_blank_lines and not l.strip():
                continue
            orig_indexed.append((idx + 1, l, normalize_line(l)))

        mod_indexed: List[Tuple[int, str, str]] = []
        for idx, l in enumerate(raw_mod_lines):
            if ignore_blank_lines and not l.strip():
                continue
            mod_indexed.append((idx + 1, l, normalize_line(l)))

        norm_orig = [item[2] for item in orig_indexed]
        norm_mod = [item[2] for item in mod_indexed]

        matcher = difflib.SequenceMatcher(None, norm_orig, norm_mod)
        diff_items: List[Dict[str, Any]] = []

        additions = 0
        deletions = 0
        modifications = 0
        unchanged = 0

        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == 'equal':
                for idx in range(i2 - i1):
                    o_num, o_text, _ = orig_indexed[i1 + idx]
                    m_num, m_text, _ = mod_indexed[j1 + idx]
                    diff_items.append({
                        "type": "equal",
                        "orig_line_num": o_num,
                        "orig_text": o_text,
                        "orig_parts": [{"text": o_text, "type": "equal"}],
                        "mod_line_num": m_num,
                        "mod_text": m_text,
                        "mod_parts": [{"text": m_text, "type": "equal"}]
                    })
                    unchanged += 1

            elif tag == 'replace':
                count = max(i2 - i1, j2 - j1)
                for idx in range(count):
                    has_o = (i1 + idx) < i2
                    has_m = (j1 + idx) < j2
                    o_num, o_text, _ = orig_indexed[i1 + idx] if has_o else (None, "", "")
                    m_num, m_text, _ = mod_indexed[j1 + idx] if has_m else (None, "", "")

                    if has_o and has_m:
                        modifications += 1
                        op, mp = _compute_inline_tokens(o_text, m_text, granularity, ignore_case)
                        diff_items.append({
                            "type": "replace",
                            "orig_line_num": o_num,
                            "orig_text": o_text,
                            "orig_parts": op,
                            "mod_line_num": m_num,
                            "mod_text": m_text,
                            "mod_parts": mp
                        })
                    elif has_o:
                        deletions += 1
                        diff_items.append({
                            "type": "delete",
                            "orig_line_num": o_num,
                            "orig_text": o_text,
                            "orig_parts": [{"text": o_text, "type": "del"}],
                            "mod_line_num": None,
                            "mod_text": "",
                            "mod_parts": []
                        })
                    elif has_m:
                        additions += 1
                        diff_items.append({
                            "type": "insert",
                            "orig_line_num": None,
                            "orig_text": "",
                            "orig_parts": [],
                            "mod_line_num": m_num,
                            "mod_text": m_text,
                            "mod_parts": [{"text": m_text, "type": "ins"}]
                        })

            elif tag == 'delete':
                for idx in range(i1, i2):
                    o_num, o_text, _ = orig_indexed[idx]
                    deletions += 1
                    diff_items.append({
                        "type": "delete",
                        "orig_line_num": o_num,
                        "orig_text": o_text,
                        "orig_parts": [{"text": o_text, "type": "del"}],
                        "mod_line_num": None,
                        "mod_text": "",
                        "mod_parts": []
                    })

            elif tag == 'insert':
                for idx in range(j1, j2):
                    m_num, m_text, _ = mod_indexed[idx]
                    additions += 1
                    diff_items.append({
                        "type": "insert",
                        "orig_line_num": None,
                        "orig_text": "",
                        "orig_parts": [],
                        "mod_line_num": m_num,
                        "mod_text": m_text,
                        "mod_parts": [{"text": m_text, "type": "ins"}]
                    })

        # 표준 Unified Patch 생성
        filtered_orig_lines = [item[1] for item in orig_indexed]
        filtered_mod_lines = [item[1] for item in mod_indexed]
        unified_patch_lines = list(difflib.unified_diff(
            filtered_orig_lines,
            filtered_mod_lines,
            fromfile="Original",
            tofile="Modified",
            lineterm=""
        ))
        unified_patch = "\n".join(unified_patch_lines)

        return {
            "status": "success",
            "stats": {
                "additions": additions,
                "deletions": deletions,
                "modifications": modifications,
                "unchanged": unchanged,
                "orig_total": len(raw_orig_lines),
                "mod_total": len(raw_mod_lines),
                "is_identical": (additions == 0 and deletions == 0 and modifications == 0)
            },
            "items": diff_items,
            "unified_patch": unified_patch
        }

    except Exception as e:
        return {
            "status": "error",
            "message": f"Diff 계산 중 오류가 발생했습니다: {str(e)}"
        }


@eel.expose
def select_and_read_diff_file(target_side: str = "orig") -> Dict[str, Any]:
    """파일 대화상자를 열어 텍스트/코드 파일을 읽어 반환"""
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        file_path = filedialog.askopenfilename(
            title=f"비교할 파일 선택 ({'원본(Left)' if target_side == 'orig' else '수정본(Right)'})",
            filetypes=[
                ("모든 텍스트 및 코드 파일", "*.txt;*.md;*.json;*.js;*.py;*.html;*.css;*.csv;*.xml;*.yml;*.yaml;*.sql;*.log;*.ini"),
                ("모든 파일", "*.*")
            ]
        )
        root.destroy()

        if not file_path:
            return {"status": "cancelled"}

        file_path = os.path.normpath(file_path)
        content, enc = _detect_encoding_and_read(file_path)
        filename = os.path.basename(file_path)

        return {
            "status": "success",
            "side": target_side,
            "file_path": file_path,
            "filename": filename,
            "encoding": enc,
            "content": content
        }

    except Exception as e:
        return {
            "status": "error",
            "message": f"파일 열기 실패: {str(e)}"
        }


@eel.expose
def get_diff_sample_texts() -> Dict[str, Any]:
    """테스트 및 데모용 샘플 코드/텍스트 반환"""
    orig_sample = '''def calculate_total_price(items, discount_rate=0.0):
    """주문 항목의 총 가격을 계산합니다."""
    subtotal = 0.0
    for item in items:
        # 단가와 수량을 곱하여 합산
        price = item.get("price", 0)
        quantity = item.get("qty", 1)
        subtotal += price * quantity

    # 할인율 적용
    final_price = subtotal * (1.0 - discount_rate)
    return round(final_price, 2)


def print_receipt(order_id, total):
    print("===== RECEIPT =====")
    print("Order ID: " + str(order_id))
    print("Total: $" + str(total))
'''

    mod_sample = '''def calculate_total_price(items, discount_rate=0.0, tax_rate=0.1):
    """주문 항목의 총 가격과 세금을 계산합니다."""
    subtotal = 0.0
    for item in items:
        # 단가와 수량을 곱하여 합산 (음수 수량 방지)
        price = float(item.get("price", 0.0))
        quantity = max(0, int(item.get("qty", 1)))
        subtotal += price * quantity

    # 할인율 및 세금율 적용
    discounted = subtotal * (1.0 - discount_rate)
    final_price = discounted * (1.0 + tax_rate)
    return round(final_price, 2)


def print_receipt(order_id, total, currency="KRW"):
    print("===== ORDER RECEIPT =====")
    print(f"Order ID: {order_id}")
    print(f"Total Amount: {total} {currency}")
    print("Thank you for your purchase!")
'''

    return {
        "status": "success",
        "orig_text": orig_sample,
        "mod_text": mod_sample
    }
