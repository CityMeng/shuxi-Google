# -*- coding: utf-8 -*-
"""
数玺 1b 场景测试: 账本/签名/授权/回执/作废/密钥公告/验真报告。
在临时目录中跑完整流程, 不污染正式数据。运行:
  .venv/bin/python tests/run_ledger_tests.py
"""
import copy
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vectors"))
from engine import service as svc  # noqa: E402
from engine.ledger import KeyPair, Ledger, canonical_bytes  # noqa: E402
import gen_samples  # noqa: E402

TZ = timezone(timedelta(hours=8))
BASE_T = datetime(2026, 10, 22, 20, 0, 0, tzinfo=TZ)


def T(days=0, hours=0):
    return (BASE_T + timedelta(days=days, hours=hours)).isoformat(timespec="seconds")


R = []


def check(label, cond, extra=""):
    R.append(bool(cond))
    print(("PASS" if cond else "FAIL"), label, extra)


def main():
    gen_samples.main()
    samples = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "vectors", "samples")

    def load(name):
        with open(os.path.join(samples, name), "rb") as f:
            return f.read()

    tmp = tempfile.mkdtemp(prefix="shuxi-1b-")
    ledger = Ledger(os.path.join(tmp, "ledger.jsonl"))
    packages = svc.PackageStore(os.path.join(tmp, "packages.json"))
    registrar = KeyPair.generate()
    verifier = KeyPair.generate()
    stranger = KeyPair.generate()
    report_data = load("report.txt")
    tampered_data = load("report_tampered.txt")

    # 1. 登记
    cert = svc.register_file(ledger, packages, registrar, "示例公司财务部",
                             "report.txt", report_data, "txt", "pass-1", ts=T())
    check("1 凭证号格式 SX-NNNN-XXXX", re.fullmatch(r"SX-\d{4}-[0-9A-F]{4}", cert) is not None, cert)
    ok, broken, _ = ledger.verify_chain()
    check("1 全链校验通过", ok)
    with open(ledger.path, encoding="utf-8") as f:
        raw = f.read()
    check("1 账本无字段明文 (净利润值不入账)", "4200000" not in raw)

    # 2. 验真原件 -> 甲级 + 报告可复核 + 回执入账
    rep = svc.verify_file(ledger, packages, verifier, "合作银行", cert,
                          report_data, "txt", "report.txt", ts=T(hours=1))
    check("2 原件判甲级", rep["grade"] == "甲级")
    check("2 验真报告可被第三方复核", svc.verify_report(ledger, rep))
    receipts = ledger.by_type("receipt")
    check("2 回执入账且随机数合规", len(receipts) == 1
          and re.fullmatch(r"[0-9a-f]{32}", receipts[0]["payload"]["nonce"]) is not None)
    bad_rep = copy.deepcopy(rep)
    bad_rep["grade"] = "乙级"
    check("2 篡改后的报告复核不通过", not svc.verify_report(ledger, bad_rep))

    # 3. 验真篡改件 -> 丁级定位
    rep2 = svc.verify_file(ledger, packages, verifier, "合作银行", cert,
                           tampered_data, "txt", "report_tampered.txt", ts=T(hours=2))
    diffs = [d["field"] for d in rep2["field_diffs"]]
    check("3 篡改判丁级并定位净利润", rep2["grade"] == "丁级" and "净利润" in diffs, str(diffs))

    # 4. 账本文件被改 -> 断链定位
    lines = open(ledger.path, encoding="utf-8").read().splitlines()
    e0 = json.loads(lines[0])
    e0["payload"]["filename"] = "hacked.txt"
    p2 = os.path.join(tmp, "ledger_tampered.jsonl")
    with open(p2, "w", encoding="utf-8") as f:
        f.write(json.dumps(e0, ensure_ascii=False) + "\n" + "\n".join(lines[1:]) + "\n")
    ok2, broken2, reason2 = Ledger(p2).verify_chain()
    check("4 改账被检出并定位序号", (not ok2) and broken2 == 1, reason2)

    # 5. 伪造登记 (签名主体与登记公钥不一致) -> 不予采信
    forged = dict(ledger.find_registration(cert)["payload"])
    forged["cert_id"] = "SX-0099-AAAA"
    ledger.append("registration", forged, stranger, ts=T(hours=3))
    st = svc.resolve_status(ledger, "SX-0099-AAAA")
    check("5 伪造登记被标记记录异常", st["status"] == "记录异常")
    err = svc.verify_file(ledger, packages, verifier, "合作银行", "SX-0099-AAAA",
                          report_data, "txt", "report.txt", ts=T(hours=3))
    check("5 伪造登记验真被拒", "error" in err)

    # 6. 授权: 次数上限与过期 (账本时间口径)
    cert2 = svc.register_file(ledger, packages, registrar, "示例公司财务部",
                              "report.txt", report_data, "txt", "pass-1", ts=T(hours=4))
    au = svc.create_authorization(ledger, registrar, cert2, "合作银行",
                                  verifier.fingerprint, days=7, max_count=2, ts=T(hours=4))
    r = svc.verify_file(ledger, packages, verifier, "合作银行", cert2,
                        report_data, "txt", "report.txt", auth_id=au, ts=T(hours=5))
    check("6 授权内第 1 次验真通过", r.get("grade") == "甲级")
    svc.verify_file(ledger, packages, verifier, "合作银行", cert2,
                    report_data, "txt", "report.txt", auth_id=au, ts=T(hours=6))
    r3 = svc.verify_file(ledger, packages, verifier, "合作银行", cert2,
                         report_data, "txt", "report.txt", auth_id=au, ts=T(hours=7))
    check("6 第 3 次被次数上限拦下", "error" in r3 and "次数" in r3["error"])
    au2 = svc.create_authorization(ledger, registrar, cert2, "合作银行",
                                   verifier.fingerprint, days=1, max_count=5, ts=T(hours=8))
    svc.checkpoint(ledger, registrar, ts=T(days=3))
    r4 = svc.verify_file(ledger, packages, verifier, "合作银行", cert2,
                         report_data, "txt", "report.txt", auth_id=au2, ts=T(days=3))
    check("6 过期授权被拦下 (账本时间)", "error" in r4 and "过期" in r4["error"])

    # 7. 作废: 非登记方无权, 登记方作废后验真报已作废
    try:
        svc.revoke(ledger, stranger, cert2, ts=T(days=3, hours=1))
        check("7 非登记方作废被拒", False)
    except ValueError:
        check("7 非登记方作废被拒", True)
    svc.revoke(ledger, registrar, cert2, ts=T(days=3, hours=2))
    r5 = svc.verify_file(ledger, packages, verifier, "合作银行", cert2,
                         report_data, "txt", "report.txt", ts=T(days=3, hours=3))
    check("7 作废后验真报已作废", r5.get("grade") == "已作废")

    # 8. 密钥丢失路径: 公告 -> 新密钥作废; 无公告直接作废被拒
    reg2 = KeyPair.generate()
    cert3 = svc.register_file(ledger, packages, reg2, "另一家公司",
                              "report.txt", report_data, "txt", "pass-2", ts=T(days=3, hours=4))
    new_key = KeyPair.generate()
    try:
        svc.revoke(ledger, new_key, cert3, ts=T(days=3, hours=5))
        check("8 无公告的新密钥作废被拒", False)
    except ValueError:
        check("8 无公告的新密钥作废被拒", True)
    nid = svc.key_notice(ledger, new_key, reg2.fingerprint, "失效",
                         "私钥介质损坏", ts=T(days=3, hours=6))
    svc.revoke(ledger, new_key, cert3, notice_id=nid, ts=T(days=3, hours=7))
    check("8 公告后新密钥作废成功",
          svc.resolve_status(ledger, cert3)["status"] == "已作废")
    st3 = svc.resolve_status(ledger, cert3)
    check("8 作废件状态解析含密钥失效注记",
          any("已失效" in a for a in st3["annotations"]))

    # 9. 争议与解除
    reg3 = KeyPair.generate()
    cert4 = svc.register_file(ledger, packages, reg3, "第三家公司",
                              "report.txt", report_data, "txt", "pass-3", ts=T(days=3, hours=8))
    svc.key_notice(ledger, KeyPair.generate(), reg3.fingerprint, "争议",
                   "疑似冒用, 核查中", ts=T(days=3, hours=9))
    r6 = svc.verify_file(ledger, packages, verifier, "合作银行", cert4,
                         report_data, "txt", "report.txt", ts=T(days=3, hours=10))
    check("9 争议状态照常判甲级并加注",
          r6.get("grade") == "甲级" and any("争议" in x for x in r6["reasons"]))
    svc.key_notice(ledger, KeyPair.generate(), reg3.fingerprint, "解除",
                   "核查完毕, 系误报", ts=T(days=3, hours=11))
    check("9 争议解除后状态恢复有效",
          svc.resolve_status(ledger, cert4)["status"] == "有效")

    # 10. 检查点与规范序列化纪律
    cp = svc.checkpoint(ledger, registrar, ts=T(days=3, hours=12))
    check("10 检查点含高度/链头/锚点预留",
          cp["payload"]["height"] == cp["seq"]
          and len(cp["payload"]["head_hash"]) == 64
          and cp["payload"]["anchor"]["type"] == "reserved")
    try:
        canonical_bytes({"x": 0.99})
        check("10 浮点数被规范序列化拒绝", False)
    except ValueError:
        check("10 浮点数被规范序列化拒绝", True)
    ok3, _, _ = Ledger(ledger.path).verify_chain()
    check("10 全流程后重载账本全链仍可验", ok3)

    # 11. 登记包私钥: 口令错误打不开, 正确口令可恢复且指纹一致
    pkg = packages.get(cert)
    try:
        KeyPair.from_encrypted_pem(pkg["privkey_pem"], "wrong-pass")
        check("11 私钥口令错误被拒", False)
    except Exception:
        check("11 私钥口令错误被拒", True)
    kp2 = KeyPair.from_encrypted_pem(pkg["privkey_pem"], "pass-1")
    check("11 正确口令恢复私钥且指纹一致", kp2.fingerprint == registrar.fingerprint)

    # 12. 回执重放: 同 nonce 再次入账被账本拦截
    old_receipt = ledger.by_type("receipt")[0]["payload"]
    try:
        ledger.append("receipt", dict(old_receipt), verifier, ts=T(days=3, hours=13))
        check("12 回执同随机数重放被拦截", False)
    except ValueError:
        check("12 回执同随机数重放被拦截", True)

    # 13. v1.3 无登记包验真 (第三方只有登记记录):
    #   txt 无感知指纹、原文不入账 -> 无可比证据, 判待人工复核 (不再丁级嫌疑);
    #   扫描件感知指纹在记录内 -> 可判乙并封顶 60%。
    from engine import service as _svc
    empty_pk = _svc.PackageStore(os.path.join(tmp, "none.json"))
    conv = load("report_converted.txt")
    repX = svc.verify_file(ledger, empty_pk, verifier, "合作银行", cert,
                           conv, "txt", "report_converted.txt", ts=T(days=3, hours=14))
    check("13 无包验真文本件无证据判待复核 (非丁级嫌疑)",
          repX.get("grade") == "待人工复核",
          f"got {repX.get('grade')}/{repX.get('confidence')}")
    scan_cert = svc.register_file(ledger, packages, registrar, "示例公司财务部",
                                  "scan_a.png", load("scan_a.png"), "png",
                                  "pass-1", ts=T(days=3, hours=14))
    repZ = svc.verify_file(ledger, empty_pk, verifier, "合作银行", scan_cert,
                           load("scan_b.jpg"), "jpg", "scan_b.jpg",
                           ts=T(days=3, hours=14))
    check("13 无包验真扫描件凭感知指纹判乙封顶60%",
          repZ.get("grade") == "乙级" and repZ.get("confidence") == "0.6",
          f"got {repZ.get('grade')}/{repZ.get('confidence')}")
    repY = svc.verify_file(ledger, packages, verifier, "合作银行", cert,
                           conv, "txt", "report_converted.txt", ts=T(days=3, hours=15))
    from engine import fp as _fp
    compY = _fp.compute_all(conv, "txt", packages.get(cert)["salts"])
    root_equal = (compY["semantic"]["root"]
                  == ledger.find_registration(cert)["payload"]["semantic_root"])
    check("13 有登记包时语义根可比 (证据自洽)",
          root_equal and repY.get("grade") == "乙级"
          and repY.get("confidence") == "0.9",
          f"root_equal={root_equal}")

    # 14. v1.3 授权记名绑定: 他人持授权号验真被拒, 本人通过
    au3 = svc.create_authorization(ledger, registrar, cert, "合作银行",
                                   verifier.fingerprint, days=7, max_count=3,
                                   ts=T(days=3, hours=16))
    repS = svc.verify_file(ledger, packages, stranger, "路人", cert,
                           report_data, "txt", "report.txt", auth_id=au3,
                           ts=T(days=3, hours=17))
    check("14 陌生人持他人授权被拒", "error" in repS and "被授权方" in repS["error"])
    repT = svc.verify_file(ledger, packages, verifier, "合作银行", cert,
                           report_data, "txt", "report.txt", auth_id=au3,
                           ts=T(days=3, hours=18))
    check("14 被授权方本人验真通过", repT.get("grade") == "甲级")

    # 15. 文件集 (§13): 全甲汇总 / 成员篡改定位 / 成员缺失明示
    set_cert = svc.register_file_set(
        ledger, packages, registrar, "示例公司财务部", "季度材料包",
        [("report.txt", report_data), ("contract_bad.txt", load("contract_bad.txt"))],
        "pass-1", ts=T(days=3, hours=19))
    vs = svc.verify_file_set(ledger, packages, verifier, "合作银行", set_cert,
                             [("report.txt", report_data),
                              ("contract_bad.txt", load("contract_bad.txt"))],
                             ts=T(days=3, hours=20))
    check("15 文件集全甲汇总甲级", vs["summary"] == "甲级" and vs["complete"])
    vs2 = svc.verify_file_set(ledger, packages, verifier, "合作银行", set_cert,
                              [("report.txt", tampered_data)],
                              ts=T(days=3, hours=21))
    check("15 成员篡改定位且缺失明示不完整",
          vs2["members"]["report.txt"]["grade"] == "丁级"
          and vs2["members"]["contract_bad.txt"]["grade"] == "缺失"
          and not vs2["complete"])

    # 16. 异常码 (§14): 不支持类型 E03 / 损坏 PDF E02 明示入账
    c_bin = svc.register_file(ledger, packages, registrar, "示例公司财务部",
                              "data.bin", b"\x01\x02\x03", "bin", "pass-1",
                              ts=T(days=3, hours=22))
    codes = ledger.find_registration(c_bin)["payload"]["error_codes"]
    check("16 不支持类型打 SX-E03", "SX-E03" in codes, str(codes))
    c_pdf = svc.register_file(ledger, packages, registrar, "示例公司财务部",
                              "broken.pdf", b"%PDF-1.4 fake content", "pdf",
                              "pass-1", ts=T(days=3, hours=23))
    codes2 = ledger.find_registration(c_pdf)["payload"]["error_codes"]
    check("16 损坏 PDF 打 SX-E02", "SX-E02" in codes2, str(codes2))

    # 17. 对标补齐 (2026-10-22 吸收 AI Studio 版场景覆盖):
    #     未登记审计 / 空链 / 未入账报告 / 选择性披露 / 重复作废 / E01
    from engine import fp as _fp2, grade as _gr
    fake_bytes = load("fake.txt")
    fake_fields = _fp2.extract_fields(_fp2.extract_text(fake_bytes, "txt"))
    g_fake = _gr.grade_standalone(_gr.audit(fake_bytes, "txt",
                                            _fp2.extract_text(fake_bytes, "txt"),
                                            fake_fields))
    check("17 未登记文件勾稽不平判丙级", g_fake["grade"] == "丙级",
          g_fake["grade"])
    rep_bytes = load("report.txt")
    rep_fields = _fp2.extract_fields(_fp2.extract_text(rep_bytes, "txt"))
    g_clean = _gr.grade_standalone(_gr.audit(rep_bytes, "txt",
                                             _fp2.extract_text(rep_bytes, "txt"),
                                             rep_fields))
    check("17 未登记文件勾稽平报未登记", g_clean["grade"] == "未登记",
          g_clean["grade"])
    empty = Ledger(os.path.join(tmp, "empty-ledger.jsonl"))
    ok_e, _, _ = empty.verify_chain()
    check("17 空账本全链可验", ok_e and len(empty.entries) == 0)
    forged = copy.deepcopy(rep)
    forged["confidence"] = "0.01"
    check("17 未入账报告 (哈希未登记) 复核被拒",
          not svc.verify_report(ledger, forged))
    c17 = svc.register_file(ledger, packages, registrar, "示例公司财务部",
                            "report.txt", rep_bytes, "txt", "pass-1",
                            ts=T(days=3, hours=23))
    pkg17 = packages.get(c17)
    sem17 = _fp2.build_semantic(rep_fields, pkg17["salts"])
    root17 = ledger.find_registration(c17)["payload"]["semantic_root"]
    proof17 = _fp2.field_proof(sem17, "净利润")
    check("17 选择性披露证明验算通过",
          sem17["root"] == root17 and proof17 is not None
          and _fp2.verify_field_proof("净利润", proof17["value"],
                                       proof17["salt"], proof17["proof"],
                                       root17))
    check("17 披露错盐被拒",
          not _fp2.verify_field_proof("净利润", proof17["value"],
                                      "00" * 16, proof17["proof"], root17))
    svc.revoke(ledger, registrar, c17, ts=T(days=3, hours=24))
    svc.revoke(ledger, registrar, c17, ts=T(days=3, hours=25))
    ok_d, _, _ = ledger.verify_chain()
    check("17 重复作废不破坏账本且状态仍已作废",
          ok_d and svc.resolve_status(ledger, c17)["status"] == "已作废")
    try:
        svc.register_file(ledger, packages, registrar, "示例公司财务部",
                          "zero.txt", b"", "txt", "pass-1",
                          ts=T(days=3, hours=26))
        check("17 零字节拒收 SX-E01", False)
    except ValueError as e:
        check("17 零字节拒收 SX-E01", "SX-E01" in str(e), str(e))

    print(f"\n==== 1b 场景测试: {sum(R)}/{len(R)} PASS ====")
    return 0 if all(R) else 1


if __name__ == "__main__":
    sys.exit(main())
