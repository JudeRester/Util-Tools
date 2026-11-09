"""
tests/test_stock_groups.py
Unit tests for custom stock watchlist groups and migration logic.
"""
import os
import sys
import json
import shutil
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR))

from core.paths import STOCK_CONFIG_PATH
import services.stock_service as stock_service

class TestStockGroups(unittest.TestCase):
    def setUp(self):
        self.backup_path = f"{STOCK_CONFIG_PATH}.backup"
        if os.path.exists(STOCK_CONFIG_PATH):
            shutil.copyfile(STOCK_CONFIG_PATH, self.backup_path)

    def tearDown(self):
        if os.path.exists(self.backup_path):
            shutil.copyfile(self.backup_path, STOCK_CONFIG_PATH)
            os.remove(self.backup_path)

    def test_migration_and_crud(self):
        # 1. Setup legacy config without groups
        legacy_conf = {
            "client_id": "test_id",
            "client_secret": "test_secret",
            "watchlist": [
                {"code": "SOXS", "name": "SOXS", "market": "US"},
                {"code": "005930", "name": "삼성전자", "market": "KR"}
            ],
            "fx_cache": {}
        }
        with open(STOCK_CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(legacy_conf, f, indent=2)

        # 2. Test migration in load_stock_config
        conf = stock_service.load_stock_config()
        self.assertIn("groups", conf)
        self.assertEqual(len(conf["groups"]), 1)
        self.assertEqual(conf["groups"][0]["id"], "g_default")
        self.assertEqual(conf["groups"][0]["name"], "기본")
        self.assertEqual(conf["groups"][0]["codes"], ["SOXS", "005930"])
        self.assertEqual(conf["active_group_id"], "g_default")

        # 3. Test add_stock_group
        res_add = stock_service.add_stock_group("반도체")
        self.assertTrue(res_add["success"])
        new_gid = res_add["active_group_id"]
        self.assertTrue(new_gid.startswith("g_"))
        self.assertEqual(len(res_add["groups"]), 2)

        # 4. Test rename_stock_group
        res_ren = stock_service.rename_stock_group(new_gid, "AI 반도체")
        self.assertTrue(res_ren["success"])
        conf = stock_service.load_stock_config()
        grp = next(g for g in conf["groups"] if g["id"] == new_gid)
        self.assertEqual(grp["name"], "AI 반도체")

        # 5. Test add_stock_symbol to specific group
        res_sym = stock_service.add_stock_symbol("NVDA", "NVIDIA", "US", group_id=new_gid)
        self.assertTrue(res_sym["success"])
        conf = stock_service.load_stock_config()
        grp = next(g for g in conf["groups"] if g["id"] == new_gid)
        self.assertIn("NVDA", grp["codes"])

        # 6. Test set_active_stock_group
        res_act = stock_service.set_active_stock_group("g_default")
        self.assertTrue(res_act["success"])
        conf = stock_service.load_stock_config()
        self.assertEqual(conf["active_group_id"], "g_default")

        # 7. Test remove_stock_symbol
        res_rem_sym = stock_service.remove_stock_symbol("NVDA", group_id=new_gid)
        self.assertTrue(res_rem_sym["success"])
        conf = stock_service.load_stock_config()
        grp = next(g for g in conf["groups"] if g["id"] == new_gid)
        self.assertNotIn("NVDA", grp["codes"])

        # 8. Test remove_stock_group
        res_del = stock_service.remove_stock_group(new_gid)
        self.assertTrue(res_del["success"])
        conf = stock_service.load_stock_config()
        self.assertEqual(len(conf["groups"]), 1)

        # 9. Test cannot delete last remaining group
        res_del_last = stock_service.remove_stock_group("g_default")
        self.assertFalse(res_del_last["success"])

if __name__ == "__main__":
    unittest.main()
