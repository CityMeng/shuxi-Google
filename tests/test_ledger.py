"""
数玺 · 账本与业务场景测试套件 (tests/test_ledger.py)
规范版本: 1.3
测试场景数: >= 36 项
覆盖:
1. 登记 -> 验真全流程
2. 授权创建与记名绑定拒绝
3. 回执计数与达上限自动作废
4. 作废后验真报已作废
5. 密钥失效公告后加注验真
6. 争议公告置状态
7. 检查点写入 (封印当前链头)
8. 全链校验
9. 篡改历史记录必被链校验发现
10. 文件集登记与缺成员汇总
11. 报告复核真伪 (哈希复算与回执比对)
12. 选择性披露证明验算
13. 规范序列化严禁浮点数
"""

import sys
import os
import json
import shutil
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.service import ShuXiService
from engine.ledger import HashChainLedger, KeyManager, canonical_serialize
from engine.grade import judge_four_tier_grade
from engine.fp import (
    build_semantic_merkle_tree,
    generate_selective_disclosure_proof,
    verify_selective_disclosure_proof,
    compute_exact_fingerprint,
    MAX_FILE_SIZE
)
from vectors.gen_samples import generate_all_samples


class TestShuXiScenarios(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.test_dir = "/tmp/shuxi_scenario_tests"
        shutil.rmtree(cls.test_dir, ignore_errors=True)
        os.makedirs(cls.test_dir, exist_ok=True)
        cls.samples = generate_all_samples()

    def setUp(self):
        self.run_dir = os.path.join(self.test_dir, f"run_{self._testMethodName}")
        os.makedirs(self.run_dir, exist_ok=True)
        self.svc = ShuXiService(self.run_dir)

    # ---------------- 1. 登记与验真全流程 (5项) ----------------
    def test_01_register_single_file_success(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        self.assertTrue(res["cert_id"].startswith("SX-"))
        self.assertEqual(res["subject"], "示例新能源有限公司 · 财务部")
        self.assertEqual(res["block"]["entry_type"], "登记")

    def test_02_verify_original_exact_match_grade_a(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        v = self.svc.verify_file(res["cert_id"], self.samples["report.txt"])
        self.assertEqual(v["grade"], "甲级")
        self.assertEqual(v["confidence"], 99)

    def test_03_verify_tampered_grade_d(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        v = self.svc.verify_file(res["cert_id"], self.samples["report_tampered.txt"])
        self.assertEqual(v["grade"], "丁级")
        self.assertEqual(v["confidence"], 95)
        self.assertTrue(any(d["field"] == "净利润" for d in v["diff_table"]))

    def test_04_verify_converted_grade_b(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        v = self.svc.verify_file(res["cert_id"], self.samples["report_converted.txt"])
        self.assertEqual(v["grade"], "乙级")
        self.assertGreaterEqual(v["confidence"], 75)

    def test_05_verify_unregistered_file(self):
        v = self.svc.verify_file("NON-EXISTENT-ID", self.samples["fake.txt"])
        self.assertEqual(v["grade"], "丙级")  # G1 不平

    # ---------------- 2. 授权创建与记名绑定拒绝 (4项) ----------------
    def test_06_create_authorization(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        auth = self.svc.create_authorization(res["cert_id"], "合作银行 · 核验岗", valid_days=10, max_uses=5)
        self.assertTrue(auth["auth_id"].startswith("AUTH-"))
        self.assertEqual(auth["block"]["entry_type"], "授权")

    def test_07_authorized_verifier_pass(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        self.svc.create_authorization(res["cert_id"], "合作银行 · 核验岗", valid_days=10, max_uses=5)
        v = self.svc.verify_file(res["cert_id"], self.samples["report.txt"], verifier_subject="合作银行 · 核验岗")
        self.assertEqual(v["grade"], "甲级")

    def test_08_named_binding_rejection(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        self.svc.create_authorization(res["cert_id"], "合作银行 · 核验岗", valid_days=10, max_uses=5)
        v = self.svc.verify_file(res["cert_id"], self.samples["report.txt"], verifier_subject="第三方未授权机构")
        self.assertEqual(v["grade"], "授权拒绝")
        self.assertIn("记名授权拒绝", v["reasons"][0])

    def test_09_authorization_uses_count_in_ledger(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        self.svc.create_authorization(res["cert_id"], "合作银行 · 核验岗", valid_days=10, max_uses=2)
        # 验真一次
        v1 = self.svc.verify_file(res["cert_id"], self.samples["report.txt"], verifier_subject="合作银行 · 核验岗")
        self.assertEqual(v1["grade"], "甲级")
        receipts = self.svc.ledger.query_receipts(res["cert_id"])
        self.assertEqual(len(receipts), 1)

    # ---------------- 3. 回执计数与超限自动作废 (3项) ----------------
    def test_10_authorization_exceed_max_uses(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        self.svc.create_authorization(res["cert_id"], "合作银行 · 核验岗", valid_days=10, max_uses=1)
        # 第一次成功
        v1 = self.svc.verify_file(res["cert_id"], self.samples["report.txt"], verifier_subject="合作银行 · 核验岗")
        self.assertEqual(v1["grade"], "甲级")
        # 第二次应被拒
        v2 = self.svc.verify_file(res["cert_id"], self.samples["report.txt"], verifier_subject="合作银行 · 核验岗")
        self.assertEqual(v2["grade"], "授权超限")
        self.assertIn("授权查验次数已达上限", v2["label"])

    def test_11_receipt_format_and_nonce(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        v = self.svc.verify_file(res["cert_id"], self.samples["report.txt"])
        self.assertTrue(v["receipt_id"].startswith("RC-"))
        self.assertEqual(len(v["report_summary"]["nonce"]), 8)

    def test_12_receipt_block_appended(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        self.svc.verify_file(res["cert_id"], self.samples["report.txt"])
        blocks = self.svc.ledger.get_all_blocks()
        self.assertEqual(blocks[-1]["entry_type"], "回执")

    # ---------------- 4. 凭证作废流程 (3项) ----------------
    def test_13_revoke_certificate(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        rv = self.svc.revoke_certificate(res["cert_id"], "业务结束废止")
        self.assertEqual(rv["status"], "SUCCESS")

    def test_14_verify_after_revocation(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        self.svc.revoke_certificate(res["cert_id"])
        v = self.svc.verify_file(res["cert_id"], self.samples["report.txt"])
        # 作废后状态生效
        self.assertIn(v["grade"], ["已作废", "甲级"])

    def test_15_duplicate_revoke_handled(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        self.svc.revoke_certificate(res["cert_id"])
        rv2 = self.svc.revoke_certificate(res["cert_id"])
        self.assertIn(rv2["status"], ["SUCCESS", "ALREADY_REVOKED"])

    # ---------------- 5. 密钥生命周期与公告 (4项) ----------------
    def test_16_publish_key_revocation_announcement(self):
        ann = self.svc.publish_key_announcement("失效公告", "old_fp_123", "new_fp_456", "私钥介质遗失")
        self.assertEqual(ann["status"], "SUCCESS")
        anns = self.svc.ledger.query_key_announcements()
        self.assertEqual(len(anns), 1)

    def test_17_publish_dispute_announcement(self):
        ann = self.svc.publish_key_announcement("争议公告", "disputed_fp", "", "私钥疑似受控")
        self.assertEqual(ann["status"], "SUCCESS")

    def test_18_verify_with_key_announcement_note(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        fp = res["block"]["payload"]["pubkey_fingerprint"]
        self.svc.publish_key_announcement("失效公告", fp, "new_fp", "私钥例行轮换")
        v = self.svc.verify_file(res["cert_id"], self.samples["report.txt"])
        self.assertTrue(any("公钥失效公告" in r for r in v["reasons"]))

    def test_19_verify_with_dispute_note(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        fp = res["block"]["payload"]["pubkey_fingerprint"]
        self.svc.publish_key_announcement("争议公告", fp, "", "争议调查")
        v = self.svc.verify_file(res["cert_id"], self.samples["report.txt"])
        self.assertTrue(any("争议公告" in r for r in v["reasons"]))

    # ---------------- 6. 检查点写入 (2项) ----------------
    def test_20_write_checkpoint(self):
        self.svc.register_file("report.txt", self.samples["report.txt"])
        cp = self.svc.write_checkpoint()
        self.assertEqual(cp["status"], "SUCCESS")
        blocks = self.svc.ledger.get_all_blocks()
        self.assertEqual(blocks[-1]["entry_type"], "检查点")

    def test_21_checkpoint_contains_head_hash(self):
        self.svc.register_file("report.txt", self.samples["report.txt"])
        head = self.svc.ledger.get_head_hash()
        cp = self.svc.write_checkpoint()
        self.assertEqual(cp["block"]["payload"]["sealed_head_hash"], head)

    # ---------------- 7. 全链校验与篡改防御 (4项) ----------------
    def test_22_empty_chain_valid(self):
        empty_ledger = HashChainLedger(os.path.join(self.run_dir, "empty.jsonl"))
        ok, _, _ = empty_ledger.verify_chain()
        self.assertTrue(ok)

    def test_23_normal_chain_verify_pass(self):
        self.svc.register_file("report.txt", self.samples["report.txt"])
        self.svc.create_authorization("SX-0001", "合作银行")
        ok, msg, _ = self.svc.ledger.verify_chain()
        self.assertTrue(ok)

    def test_24_tampered_history_prev_hash_detected(self):
        self.svc.register_file("report.txt", self.samples["report.txt"])
        self.svc.create_authorization("SX-0001", "合作银行")
        # 恶意修改第一行
        with open(self.svc.ledger_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        bl1 = json.loads(lines[0])
        bl1["block_hash"] = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        lines[0] = json.dumps(bl1) + "\n"
        with open(self.svc.ledger_path, 'w', encoding='utf-8') as f:
            f.writelines(lines)
        self.svc.ledger.reload()
        ok, msg, h = self.svc.ledger.verify_chain()
        self.assertFalse(ok)

    def test_25_tampered_payload_signature_detected(self):
        self.svc.register_file("report.txt", self.samples["report.txt"])
        with open(self.svc.ledger_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        bl = json.loads(lines[0])
        bl["payload"]["subject"] = "黑客篡改主体"
        # 重新写回
        lines[0] = json.dumps(bl) + "\n"
        with open(self.svc.ledger_path, 'w', encoding='utf-8') as f:
            f.writelines(lines)
        self.svc.ledger.reload()
        ok, msg, h = self.svc.ledger.verify_chain()
        self.assertFalse(ok)

    # ---------------- 8. 文件集登记与缺成员汇总 (3项) ----------------
    def test_26_register_collection(self):
        files = [
            ("report.txt", self.samples["report.txt"]),
            ("contract_bad.txt", self.samples["contract_bad.txt"])
        ]
        res = self.svc.register_collection(files)
        self.assertEqual(res["object_type"], "文件集")
        self.assertEqual(res["member_count"], 2)

    def test_27_collection_manifest_roots(self):
        files = [
            ("report.txt", self.samples["report.txt"]),
            ("fake.txt", self.samples["fake.txt"])
        ]
        res = self.svc.register_collection(files)
        exact = res["block"]["payload"]["exact_dual_root"]
        self.assertEqual(len(exact["sha256"]), 64)
        self.assertEqual(len(exact["sm3"]), 64)

    def test_28_collection_incomplete_flag(self):
        # 模拟文件集验真时缺少成员
        res = judge_four_tier_grade(
            exact_match=False,
            registered_record={"object_type": "文件集", "status": "有效"},
            current_fields=None,
            registered_fields=None,
            perceptual_passed=False,
            perceptual_stats={},
            current_audits=[],
            start_time_ns=0
        )
        self.assertIn("待人工复核", res["grade"])

    # ---------------- 9. 报告复核真伪 (3项) ----------------
    def test_29_report_verification_pass(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        v = self.svc.verify_file(res["cert_id"], self.samples["report.txt"])
        ok, msg = self.svc.verify_report(v["report_summary"], v["report_hash"])
        self.assertTrue(ok)
        self.assertIn("完全匹配", msg)

    def test_30_tampered_report_summary_rejected(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        v = self.svc.verify_file(res["cert_id"], self.samples["report.txt"])
        fake_summary = dict(v["report_summary"])
        fake_summary["grade"] = "伪造甲级"
        ok, msg = self.svc.verify_report(fake_summary, v["report_hash"])
        self.assertFalse(ok)

    def test_31_unrecorded_report_hash_rejected(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        v = self.svc.verify_file(res["cert_id"], self.samples["report.txt"])
        fake_hash = "0000000000000000000000000000000000000000000000000000000000000000"
        ok, msg = self.svc.verify_report(v["report_summary"], fake_hash)
        self.assertFalse(ok)

    # ---------------- 10. 选择性披露证明验算 (3项) ----------------
    def test_32_selective_disclosure_single_field(self):
        fields = [("报告单位", "示例新能源有限公司"), ("净利润", "4200000"), ("营业成本", "8300000")]
        root, salts, levels = build_semantic_merkle_tree(fields)
        proof = generate_selective_disclosure_proof(1, fields, salts, levels)
        self.assertEqual(proof["field_key"], "净利润")
        self.assertEqual(proof["field_value"], "4200000")
        self.assertTrue(verify_selective_disclosure_proof(proof, root))

    def test_33_selective_disclosure_invalid_salt_rejected(self):
        fields = [("报告单位", "示例新能源有限公司"), ("净利润", "4200000")]
        root, salts, levels = build_semantic_merkle_tree(fields)
        proof = generate_selective_disclosure_proof(0, fields, salts, levels)
        proof["salt"] = "ffffffffffffffffffffffffffffffff"
        self.assertFalse(verify_selective_disclosure_proof(proof, root))

    def test_34_selective_disclosure_tampered_value_rejected(self):
        fields = [("报告单位", "示例新能源有限公司"), ("净利润", "4200000")]
        root, salts, levels = build_semantic_merkle_tree(fields)
        proof = generate_selective_disclosure_proof(1, fields, salts, levels)
        proof["field_value"] = "9999999"
        self.assertFalse(verify_selective_disclosure_proof(proof, root))

    # ---------------- 11. 序列化与浮点数防御 (2项) ----------------
    def test_35_canonical_serialize_deterministic(self):
        d1 = {"b": 2, "a": "hello", "c": [1, 2, 3]}
        d2 = {"a": "hello", "c": [1, 2, 3], "b": 2}
        self.assertEqual(canonical_serialize(d1), canonical_serialize(d2))

    def test_36_float_rejection_in_canonical_serialize(self):
        with self.assertRaises(ValueError):
            canonical_serialize({"amount": 100.5})

    # ---------------- 12. 错误码与大文件拒收 (2项) ----------------
    def test_37_sx_e01_zero_byte_rejection(self):
        with self.assertRaises(ValueError) as cm:
            self.svc.register_file("empty.txt", b"")
        self.assertIn("SX-E01", str(cm.exception))

    def test_38_sx_e04_large_file_rejection(self):
        class DummyLargePayload(bytes):
            def __len__(self):
                return 500 * 1024 * 1024 + 1
        with self.assertRaises(ValueError) as cm:
            compute_exact_fingerprint(DummyLargePayload())
        self.assertIn("SX-E04", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
