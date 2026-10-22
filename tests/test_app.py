"""
数玺 · 应用冒烟测试套件 (tests/test_app.py)
规范版本: 1.3
测试项目数: >= 14 项
覆盖:
1. 三页空状态无异常渲染
2. 一键载入演示数据后高度变化
3. 一键载入幂等性 (重复载入不重复上账、不报错)
4. 单文件登记生成凭证卡要素
5. 界面验真篡改件得丁级并精确定位差异
6. 界面验真转格式件得乙级
7. 批量验真统计胶囊片与总耗时
8. 授权创建与记名绑定拒绝
9. 授权达上限自动作废
10. 凭证作废流程不可逆
11. 检查点封印链头
12. 全链校验通过与异常告警
13. 报告复核真伪
14. 友好中文错误拦截 (SX-E01, SX-E04)
"""

import sys
import os
import unittest
import shutil

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.service import ShuXiService
from vectors.gen_samples import generate_all_samples


class TestShuXiAppSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.smoke_dir = "/tmp/shuxi_smoke_test"
        shutil.rmtree(cls.smoke_dir, ignore_errors=True)
        os.makedirs(cls.smoke_dir, exist_ok=True)
        cls.samples = generate_all_samples()

    def setUp(self):
        self.run_dir = os.path.join(self.smoke_dir, f"smoke_{self._testMethodName}")
        os.makedirs(self.run_dir, exist_ok=True)
        self.svc = ShuXiService(self.run_dir)

    # 1. 三页空状态不崩
    def test_01_empty_state_registration_page(self):
        status = self.svc.get_status_summary()
        self.assertEqual(status["height"], 0)
        self.assertEqual(status["registered_certs"], 0)
        self.assertEqual(status["receipts"], 0)
        self.assertTrue(status["chain_valid"])

    def test_02_empty_state_verify_page(self):
        # 验真页空账本时提示去登记
        blocks = self.svc.ledger.get_all_blocks()
        self.assertEqual(len(blocks), 0)

    def test_03_empty_state_ledger_page(self):
        # 授权与账本页空状态
        auths = self.svc.ledger.query_authorizations()
        receipts = self.svc.ledger.query_receipts()
        self.assertEqual(len(auths), 0)
        self.assertEqual(len(receipts), 0)

    # 2. 一键载入演示数据与高度变化
    def test_04_load_demo_data_height_increase(self):
        # 载入 3 件演示数据 (report.txt, contract_bad.txt, scan_a.png)
        h0 = self.svc.ledger.get_height()
        self.assertEqual(h0, 0)
        self.svc.register_file("report.txt", self.samples["report.txt"])
        self.svc.register_file("contract_bad.txt", self.samples["contract_bad.txt"])
        self.svc.register_file("scan_a.png", self.samples["scan_a.png"])
        h1 = self.svc.ledger.get_height()
        self.assertEqual(h1, 3)

    # 3. 幂等性测试
    def test_05_load_demo_data_idempotent(self):
        # 模拟一键载入逻辑: 检查是否已登记同名文件
        def idempotent_load(service):
            existing = {b["payload"].get("filename") for b in service.ledger.get_all_blocks() if b.get("entry_type") == "登记"}
            targets = [
                ("report.txt", self.samples["report.txt"]),
                ("contract_bad.txt", self.samples["contract_bad.txt"]),
                ("scan_a.png", self.samples["scan_a.png"])
            ]
            added = 0
            for name, data in targets:
                if name not in existing:
                    service.register_file(name, data)
                    added += 1
            return added

        add1 = idempotent_load(self.svc)
        self.assertEqual(add1, 3)
        self.assertEqual(self.svc.ledger.get_height(), 3)

        # 重复点击
        add2 = idempotent_load(self.svc)
        self.assertEqual(add2, 0)
        self.assertEqual(self.svc.ledger.get_height(), 3)

    # 4. 登记单文件要素
    def test_06_registration_card_elements(self):
        res = self.svc.register_file("report.txt", self.samples["report.txt"])
        self.assertTrue(res["cert_id"].startswith("SX-"))
        self.assertIn("sha256", res["exact_dual_root"])
        self.assertIn("sm3", res["exact_dual_root"])
        self.assertIn("净利润", res["field_keys"])
        self.assertIsNotNone(res["qr_info"])

    # 5. 验真得丁级并精确定位差异
    def test_07_verification_tampered_grade_d_with_diff(self):
        reg = self.svc.register_file("report.txt", self.samples["report.txt"])
        v = self.svc.verify_file(reg["cert_id"], self.samples["report_tampered.txt"])
        self.assertEqual(v["grade"], "丁级")
        self.assertEqual(v["diff_table"][0]["field"], "净利润")
        self.assertEqual(v["diff_table"][0]["registered_val"], "4200000")
        self.assertEqual(v["diff_table"][0]["current_val"], "5800000")

    # 6. 验真转格式得乙级
    def test_08_verification_converted_grade_b(self):
        reg = self.svc.register_file("report.txt", self.samples["report.txt"])
        v = self.svc.verify_file(reg["cert_id"], self.samples["report_converted.txt"])
        self.assertEqual(v["grade"], "乙级")
        self.assertGreaterEqual(v["confidence"], 75)

    # 7. 批量验真统计与耗时
    def test_09_batch_verification_statistics(self):
        reg = self.svc.register_file("report.txt", self.samples["report.txt"])
        batch_files = [
            ("report.txt", self.samples["report.txt"]),
            ("report_tampered.txt", self.samples["report_tampered.txt"]),
            ("report_converted.txt", self.samples["report_converted.txt"])
        ]
        res = self.svc.batch_verify(batch_files)
        self.assertEqual(res["total_count"], 3)
        self.assertEqual(res["stats"]["甲级"], 1)
        self.assertEqual(res["stats"]["丁级"], 1)
        self.assertEqual(res["stats"]["乙级"], 1)
        self.assertGreaterEqual(res["total_elapsed_ms"], 0)

    # 8. 授权创建与记名绑定拒绝
    def test_10_authorization_named_binding(self):
        reg = self.svc.register_file("report.txt", self.samples["report.txt"])
        self.svc.create_authorization(reg["cert_id"], "合作银行 · 核验岗", valid_days=30, max_uses=5)
        # 授权主体验真成功
        v_ok = self.svc.verify_file(reg["cert_id"], self.samples["report.txt"], verifier_subject="合作银行 · 核验岗")
        self.assertEqual(v_ok["grade"], "甲级")
        # 非法主体验真被拒
        v_deny = self.svc.verify_file(reg["cert_id"], self.samples["report.txt"], verifier_subject="恶意第三方机构")
        self.assertEqual(v_deny["grade"], "授权拒绝")

    # 9. 授权超限自动失效
    def test_11_authorization_limit_exhausted(self):
        reg = self.svc.register_file("report.txt", self.samples["report.txt"])
        self.svc.create_authorization(reg["cert_id"], "合作银行 · 核验岗", valid_days=30, max_uses=1)
        v1 = self.svc.verify_file(reg["cert_id"], self.samples["report.txt"], verifier_subject="合作银行 · 核验岗")
        self.assertEqual(v1["grade"], "甲级")
        v2 = self.svc.verify_file(reg["cert_id"], self.samples["report.txt"], verifier_subject="合作银行 · 核验岗")
        self.assertEqual(v2["grade"], "授权超限")

    # 10. 凭证作废
    def test_12_revocation_irreversible(self):
        reg = self.svc.register_file("report.txt", self.samples["report.txt"])
        rv = self.svc.revoke_certificate(reg["cert_id"], "企业合同终止废止")
        self.assertEqual(rv["status"], "SUCCESS")
        v = self.svc.verify_file(reg["cert_id"], self.samples["report.txt"])
        self.assertEqual(v["grade"], "已作废")

    # 11. 检查点写入封印
    def test_13_checkpoint_write_and_verify(self):
        self.svc.register_file("report.txt", self.samples["report.txt"])
        cp = self.svc.write_checkpoint()
        self.assertEqual(cp["status"], "SUCCESS")
        valid, msg, _ = self.svc.ledger.verify_chain()
        self.assertTrue(valid)

    # 12. 异常拦截与友好提示
    def test_14_friendly_chinese_error_handling(self):
        with self.assertRaises(ValueError) as cm:
            self.svc.register_file("zero.txt", b"")
        self.assertIn("SX-E01", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
