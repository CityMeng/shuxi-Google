# -*- coding: utf-8 -*-
"""
数玺 1c 测试: 界面逻辑函数无头测试 + AppTest 三页冒烟。
运行: .venv/bin/python tests/run_app_tests.py
"""
import os
import sys
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)
sys.path.insert(0, os.path.join(BASE, "vectors"))

R = []


def check(label, cond, extra=""):
    R.append(bool(cond))
    print(("PASS" if cond else "FAIL"), label, extra)


def main():
    os.environ["SHUXI_DATA_DIR"] = tempfile.mkdtemp(prefix="shuxi-1c-")
    import gen_samples
    gen_samples.main()
    sdir = os.path.join(BASE, "vectors", "samples")

    def load(n):
        with open(os.path.join(sdir, n), "rb") as f:
            return f.read()

    import app as appmod
    ledger, packages, actors = appmod.init_stores(os.environ["SHUXI_DATA_DIR"])
    reg_kp = actors[appmod.REGISTRAR_NAME]
    ver_kp = actors[appmod.VERIFIER_NAME]

    certs = appmod.seed_demo(ledger, packages, reg_kp)
    check("演示数据载入 3 张凭证", len(certs) == 3, str(certs))
    check("重复载入跳过", appmod.seed_demo(ledger, packages, reg_kp) == [])

    cert_report = appmod.find_cert_by_filename(ledger, "report.txt")
    r = appmod.do_verify(ledger, packages, ver_kp, cert_report,
                         "report.txt", load("report.txt"))
    check("原件验真甲级", r["report"]["grade"] == "甲级")
    check("耗时为实测正数", r["elapsed_ms"] > 0)
    r2 = appmod.do_verify(ledger, packages, ver_kp, cert_report,
                          "report_tampered.txt", load("report_tampered.txt"))
    check("篡改件验真丁级", r2["report"]["grade"] == "丁级")
    r3 = appmod.do_verify(ledger, packages, ver_kp, cert_report,
                          "report_converted.txt", load("report_converted.txt"))
    check("转格式件验真乙级", r3["report"]["grade"] == "乙级")

    new_cert = appmod.do_register(ledger, packages, reg_kp,
                                  "contract_bad.txt", load("contract_bad.txt"))
    check("界面路径登记新凭证", new_cert.startswith("SX-"))

    # 批量按文件名匹配凭证: 篡改件在真实场景中与原件同名、内容被改
    rows, stats, total = appmod.do_batch(ledger, packages, ver_kp, [
        ("report.txt", load("report.txt")),
        ("report.txt", load("report_tampered.txt")),
        ("unknown.txt", b"no registration for this"),
    ])
    check("批量: 原件甲/同名篡改丁/未登记分流",
          rows[0]["等级"] == "甲级"
          and rows[1]["等级"] == "丁级"
          and rows[2]["等级"] in ("未登记", "丙级"),
          str([r["等级"] for r in rows]))
    check("批量统计与行数一致", sum(stats.values()) == 3 and total > 0)

    # AppTest 冒烟: 三页逐个真跑 (若已安装 streamlit)
    try:
        from streamlit.testing.v1 import AppTest
        os.environ["SHUXI_DATA_DIR"] = tempfile.mkdtemp(prefix="shuxi-1c-ui-")
        at = AppTest.from_file(os.path.join(BASE, "app.py"), default_timeout=120)
        at.run()
        check("AppTest 登记页无异常", not at.exception,
              str(at.exception[0].stack_trace)[:200] if at.exception else "")
        at.sidebar.button[0].click().run()
        check("AppTest 一键载入演示数据无异常", not at.exception)
        for page in ("验真", "授权与账本"):
            at.sidebar.radio[0].set_value(page).run()
            check(f"AppTest {page}页无异常", not at.exception,
                  str(at.exception[0].stack_trace)[:200] if at.exception else "")
        from engine.ledger import Ledger
        led = Ledger(os.path.join(os.environ["SHUXI_DATA_DIR"], "ledger.jsonl"))
        check("AppTest 侧栏载入已写入 3 张凭证",
              len(led.by_type("registration")) == 3)
    except ImportError:
        print("[SKIP] streamlit 未安装，跳过 AppTest 模拟测试")

    print(f"\n==== 1c 测试: {sum(R)}/{len(R)} PASS ====")
    return 0 if all(R) else 1


if __name__ == "__main__":
    sys.exit(main())
