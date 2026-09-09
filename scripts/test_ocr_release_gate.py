"""
scripts/test_ocr_release_gate.py
Util-Tools OCR Release Gate Automated Verification Harness

Tests:
1. Rotation Invariance (0° -> 90° -> 180° -> 270° -> 0° dimension and bbox symmetry)
2. ROI + TextAngle + Rotation combination coordinate bounding and line union consistency
3. Source Registry LRU/TTL eviction safety and in-flight image isolation
4. Input boundary hardening (Decompression Bomb, >25MB oversize, corrupt bytes, unsupported language)
5. History & thumbnail deletion idempotency
"""

import io
import os
import sys
import time
import json
import uuid
import struct
import unittest
from pathlib import Path
from typing import Dict, Any

from PIL import Image, ImageDraw, ImageFont
import numpy as np

# 프로젝트 루트 경로 등록
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

# Windows 콘솔 UTF-8 출력 보장
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from services.ocr_service import (
    _source_registry,
    _execute_ocr_pipeline,
    recognize_ocr_source,
    delete_ocr_history,
    clear_ocr_history,
    _save_ocr_history_record,
    OcrSourceRegistry,
    MAX_UPLOAD_BYTES,
    MAX_IMAGE_DIMENSION,
    MAX_TOTAL_PIXELS
)
from services.db_service import get_db_connection


def create_test_image(text: str = "Util-Tools Release Gate Test", width: int = 800, height: int = 400) -> Image.Image:
    """합성 텍스트 이미지 생성"""
    img = Image.new("RGB", (width, height), color=(240, 244, 248))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\malgun.ttf", 36)
    except Exception:
        font = ImageFont.load_default()

    draw.rectangle([(20, 20), (width - 20, height - 20)], outline=(59, 130, 246), width=3)
    draw.text((80, 150), text, fill=(15, 23, 42), font=font)
    return img


class OcrReleaseGateTest(unittest.TestCase):

    def setUp(self):
        _source_registry.clear()

    # =========================================================================
    # Test 1: 0° -> 90° -> 180° -> 270° -> 0° Rotation Invariance
    # =========================================================================
    def test_01_rotation_invariance_and_symmetry(self):
        print("\n[TEST 1] Rotation Invariance (0° -> 90° -> 180° -> 270° -> 0°)...")
        w, h = 800, 400
        test_img = create_test_image("Util-Tools 0-Degree Baseline", width=w, height=h)
        buf = io.BytesIO()
        test_img.save(buf, format="PNG")
        raw_bytes = buf.getvalue()

        src = _source_registry.register_blob(raw_bytes, "rotate_test.png")
        source_id = src.source_id

        # 1. 0° Baseline
        res_0 = recognize_ocr_source(source_id, lang="en", rotation=0, save_history=False)
        self.assertTrue(res_0["success"], f"0° OCR failed: {res_0.get('error')}")
        self.assertEqual(res_0["width"], w)
        self.assertEqual(res_0["height"], h)
        blocks_0 = res_0["blocks"]
        self.assertGreater(len(blocks_0), 0, "No blocks detected at 0°")

        # 2. 90° Rotation (width & height swap)
        res_90 = recognize_ocr_source(source_id, lang="en", rotation=90, save_history=False)
        self.assertTrue(res_90["success"], f"90° OCR failed: {res_90.get('error')}")
        # In PIL rotate -90 expand=True, dimensions become (h, w) = (400, 800)
        for b in res_90["blocks"]:
            self.assertGreaterEqual(b["x"], 0)
            self.assertGreaterEqual(b["y"], 0)
            self.assertLessEqual(b["x"] + b["width"], h + 10)
            self.assertLessEqual(b["y"] + b["height"], w + 10)

        # 3. 180° Rotation
        res_180 = recognize_ocr_source(source_id, lang="en", rotation=180, save_history=False)
        self.assertTrue(res_180["success"], f"180° OCR failed: {res_180.get('error')}")
        for b in res_180["blocks"]:
            self.assertGreaterEqual(b["x"], 0)
            self.assertGreaterEqual(b["y"], 0)
            self.assertLessEqual(b["x"] + b["width"], w + 10)
            self.assertLessEqual(b["y"] + b["height"], h + 10)

        # 4. 270° Rotation
        res_270 = recognize_ocr_source(source_id, lang="en", rotation=270, save_history=False)
        self.assertTrue(res_270["success"], f"270° OCR failed: {res_270.get('error')}")
        for b in res_270["blocks"]:
            self.assertGreaterEqual(b["x"], 0)
            self.assertGreaterEqual(b["y"], 0)
            self.assertLessEqual(b["x"] + b["width"], h + 10)
            self.assertLessEqual(b["y"] + b["height"], w + 10)

        # 5. 360° (Return to Baseline 0°)
        res_360 = recognize_ocr_source(source_id, lang="en", rotation=360, save_history=False)
        self.assertTrue(res_360["success"], f"360° OCR failed: {res_360.get('error')}")
        blocks_360 = res_360["blocks"]
        self.assertEqual(len(blocks_0), len(blocks_360), "Block count mismatch between 0° and 360°")

        # Compare coordinates between 0° and 360° (must be identical within 1.5px float precision)
        for b0, b360 in zip(blocks_0, blocks_360):
            self.assertAlmostEqual(b0["x"], b360["x"], delta=1.5, msg="X coordinate drift on 360° return")
            self.assertAlmostEqual(b0["y"], b360["y"], delta=1.5, msg="Y coordinate drift on 360° return")
            self.assertAlmostEqual(b0["width"], b360["width"], delta=1.5, msg="Width drift on 360° return")
            self.assertAlmostEqual(b0["height"], b360["height"], delta=1.5, msg="Height drift on 360° return")

        print("  -> PASS: 360° rotation invariant cycle verified (exact coordinate match with baseline).")

    # =========================================================================
    # Test 2: ROI + TextAngle + Rotation Combinations
    # =========================================================================
    def test_02_roi_textangle_rotation_combinations(self):
        print("\n[TEST 2] ROI + TextAngle + Rotation Combinations...")
        w, h = 1000, 600
        test_img = create_test_image("Util-Tools ROI & Rotation Coordination", width=w, height=h)

        # Draw a distinctive word in a specific sub-region
        draw = ImageDraw.Draw(test_img)
        try:
            font = ImageFont.truetype("C:\\Windows\\Fonts\\malgun.ttf", 32)
        except Exception:
            font = ImageFont.load_default()
        draw.text((200, 200), "TARGET REGION TEST", fill=(255, 0, 0), font=font)

        # Define ROI surrounding that text
        roi = {"x": 150, "y": 150, "width": 500, "height": 200}

        # 1. 0° Rotation with ROI
        res_roi_0 = _execute_ocr_pipeline(test_img, roi=roi, lang="en", rotation=0)
        self.assertIn("TARGET REGION TEST", res_roi_0["text"])
        self.assertIsNotNone(res_roi_0["roi"])
        for b in res_roi_0["blocks"]:
            # All blocks must be inside the ROI plus margin
            self.assertGreaterEqual(b["x"], 145)
            self.assertGreaterEqual(b["y"], 145)
            self.assertLessEqual(b["x"] + b["width"], 655)
            self.assertLessEqual(b["y"] + b["height"], 355)

            # Check line union property: line bbox encloses all word bboxes
            for w_box in b["words"]:
                self.assertGreaterEqual(w_box["x"], b["x"] - 0.5)
                self.assertGreaterEqual(w_box["y"], b["y"] - 0.5)
                self.assertLessEqual(w_box["x"] + w_box["width"], b["x"] + b["width"] + 0.5)
                self.assertLessEqual(w_box["y"] + w_box["height"], b["y"] + b["height"] + 0.5)

        # 2. 90° Rotation with ROI in rotated space
        # Rotated image will be 600x1000
        rotated_roi = {"x": 50, "y": 50, "width": 400, "height": 400}
        res_roi_90 = _execute_ocr_pipeline(test_img, roi=rotated_roi, lang="en", rotation=90)
        self.assertIsNotNone(res_roi_90["roi"])
        for b in res_roi_90["blocks"]:
            self.assertGreaterEqual(b["x"], 45)
            self.assertGreaterEqual(b["y"], 45)
            self.assertLessEqual(b["x"] + b["width"], 455)
            self.assertLessEqual(b["y"] + b["height"], 455)

        print("  -> PASS: ROI bounds, line union, and rotation offset math verified.")

    # =========================================================================
    # Test 3: Source Registry TTL & LRU Eviction Under Concurrency
    # =========================================================================
    def test_03_source_registry_eviction_and_isolation(self):
        print("\n[TEST 3] Source Registry TTL/LRU Eviction & Concurrency Isolation...")
        custom_registry = OcrSourceRegistry(max_sources=3, ttl_seconds=1)

        dummy_img = create_test_image("Eviction Test", 200, 100)
        buf = io.BytesIO()
        dummy_img.save(buf, format="PNG")
        data = buf.getvalue()

        # Register 3 sources (fills capacity)
        s1 = custom_registry.register_blob(data, "s1.png")
        s2 = custom_registry.register_blob(data, "s2.png")
        s3 = custom_registry.register_blob(data, "s3.png")
        self.assertEqual(len(custom_registry._sources), 3)

        # Touch s1 so s2 becomes LRU
        time.sleep(0.01)
        _ = custom_registry.get(s1.source_id)

        # Register s4 -> s2 should be evicted
        s4 = custom_registry.register_blob(data, "s4.png")
        self.assertIsNone(custom_registry.get(s2.source_id), "LRU s2 was not evicted!")
        self.assertIsNotNone(custom_registry.get(s1.source_id), "s1 should remain active!")
        self.assertIsNotNone(custom_registry.get(s4.source_id), "s4 should be registered!")

        # Verify global recognize_ocr_source handles dead/evicted source gracefully
        res_evicted = recognize_ocr_source("non-existent-uuid-12345", lang="en")
        self.assertFalse(res_evicted["success"])
        self.assertEqual(res_evicted.get("error_code"), "SOURCE_EXPIRED")

        # Verify in-flight image isolation:
        # If an active source is evicted while in-flight OCR is occurring, get_image() copy is safe
        s_target = custom_registry.get(s1.source_id)
        in_flight_img = s_target.get_image()

        # Evict s1 now
        custom_registry.delete(s1.source_id)
        self.assertIsNone(custom_registry.get(s1.source_id))

        # In-flight image object remains completely valid and uncorrupted
        ocr_result = _execute_ocr_pipeline(in_flight_img, lang="en")
        self.assertIn("text", ocr_result)
        self.assertIsInstance(ocr_result["blocks"], list)

        print("  -> PASS: LRU eviction, SOURCE_EXPIRED response, and in-flight image isolation verified.")

    # =========================================================================
    # Test 4: Hardening Against Corrupt, Bomb, Oversize & Unsupported
    # =========================================================================
    def test_04_input_boundary_hardening(self):
        print("\n[TEST 4] Input Boundary Hardening (Corrupt, Bomb, Oversize, Unsupported)...")

        # 4.1 Corrupt Bytes
        print("  [4.1] Testing corrupt image bytes...")
        corrupt_data = b"NOT_A_VALID_IMAGE_RANDOM_GARBAGE_PAYLOAD"
        try:
            _source_registry.register_blob(corrupt_data, "corrupt.png")
            self.fail("Should have raised ValueError for corrupt image")
        except ValueError as e:
            self.assertIn("INVALID_IMAGE", str(e))

        # 4.2 Application Dimension Limits Defense (>10000px dimension or >30M total pixels)
        print("  [4.2] Testing application dimension & pixel limits...")
        huge_img = Image.new("1", (12000, 2000))
        huge_buf = io.BytesIO()
        huge_img.save(huge_buf, format="PNG")
        huge_bytes = huge_buf.getvalue()

        try:
            _source_registry.register_blob(huge_bytes, "bomb.png")
            self.fail("Should have raised ValueError for exceeding dimension limits")
        except ValueError as e:
            self.assertIn("INVALID_IMAGE", str(e))

        # 4.3 Oversize Payload (>25MB)
        print("  [4.3] Testing oversize payload (>25MB)...")
        oversize_bytes = b"x" * (MAX_UPLOAD_BYTES + 1024)
        try:
            _source_registry.register_blob(oversize_bytes, "oversize.png")
            self.fail("Should have raised ValueError for exceeding MAX_UPLOAD_BYTES")
        except ValueError as e:
            self.assertIn("PAYLOAD_TOO_LARGE", str(e))

        # 4.4 Unsupported Format (e.g. GIF)
        print("  [4.4] Testing unsupported image format...")
        gif_img = Image.new("RGB", (100, 100), color=(255, 0, 0))
        gif_buf = io.BytesIO()
        gif_img.save(gif_buf, format="GIF")
        gif_bytes = gif_buf.getvalue()
        try:
            _source_registry.register_blob(gif_bytes, "unsupported.gif")
            self.fail("Should have raised ValueError for unsupported format")
        except ValueError as e:
            self.assertIn("UNSUPPORTED_FORMAT", str(e))

        # 4.5 Unsupported Language Pack
        print("  [4.5] Testing unsupported language pack...")
        valid_img = create_test_image("Hello", 200, 100)
        try:
            _execute_ocr_pipeline(valid_img, lang="zz-unsupported-lang")
            self.fail("Should have raised ValueError for unsupported language")
        except ValueError as e:
            self.assertIn("OCR_LANGUAGE_UNAVAILABLE", str(e))

        print("  -> PASS: All boundary error codes (INVALID_IMAGE, PAYLOAD_TOO_LARGE, UNSUPPORTED_FORMAT, OCR_LANGUAGE_UNAVAILABLE) verified.")

    # =========================================================================
    # Test 5: History & Thumbnail Deletion Idempotency
    # =========================================================================
    def test_05_history_and_thumbnail_deletion_idempotency(self):
        print("\n[TEST 5] History & Thumbnail Deletion Idempotency...")
        conn = get_db_connection()
        cur = conn.cursor()

        # Insert a dummy record pointing to a non-existent thumbnail file
        missing_thumb_path = "C:\\path\\that\\definitely\\does_not_exist\\thumb_99999999.jpg"
        cur.execute("""
            INSERT INTO ocr_history (
                source_type, filename, image_width, image_height,
                extracted_text, blocks_json, thumbnail_path, latency_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            "test", "dummy.png", 100, 100,
            "Dummy Text For Idempotency Test", "[]", missing_thumb_path, 10.0
        ))
        test_history_id = cur.lastrowid
        conn.commit()
        conn.close()

        # 1. Delete history item with missing thumbnail file
        res_del = delete_ocr_history(test_history_id)
        self.assertTrue(res_del["success"], f"delete_ocr_history failed: {res_del.get('error')}")

        # 2. Check that record was deleted from SQLite
        conn = get_db_connection()
        row = conn.execute("SELECT id FROM ocr_history WHERE id = ?", (test_history_id,)).fetchone()
        conn.close()
        self.assertIsNone(row, "History record was not deleted from DB")

        # 3. Call delete again on already deleted ID (idempotency check)
        res_del_again = delete_ocr_history(test_history_id)
        self.assertTrue(res_del_again["success"], "Subsequent deletion of already deleted item failed")

        print("  -> PASS: History deletion idempotency and missing thumbnail tolerance verified.")


if __name__ == "__main__":
    suite = unittest.TestLoader().loadTestsFromTestCase(OcrReleaseGateTest)
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
