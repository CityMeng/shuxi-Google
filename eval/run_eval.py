# -*- coding: utf-8 -*-
"""
数玺盲测评分器 (corpus-v1)。

协议: 先运行系统并把全部预测落盘 predictions.json, 再打开
answer_key.json 对照评分 — 生成与评分分离, 杜绝事后调参。
同场基线: 行业单哈希法 (字节全等=真, 否则=假) 在同一语料上的表现。
产出: results.json + REPORT.md (实测数字, 失败用例逐条列明)。
"""
import hashlib
import json
import os
import sys
import tempfile
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BASE)
sys.path.insert(0, ROOT)
from engine.ledger import KeyPair, Ledger  # noqa: E402
from engine import service as svc  # noqa: E402

CORPUS = os.path.join(BASE, "corpus")


def load(name):
    with open(os.path.join(CORPUS, name), "rb") as f:
        return f.read()


def main():
    manifest = json.load(open(os.path.join(BASE, "manifest.json"), encoding="utf-8"))
    key_hash = open(os.path.join(BASE, "key_hash.txt")).read().strip()

    tmp = tempfile.mkdtemp(prefix="shuxi-eval-")
    ledger = Ledger(os.path.join(tmp, "ledger.jsonl"))
    packages = svc.PackageStore(os.path.join(tmp, "packages.json"))
    registrar, verifier = KeyPair.generate(), KeyPair.generate()

    certs = {}
    for bid, fname in manifest["bases"].items():
        certs[bid] = svc.register_file(ledger, packages, registrar, "评测登记方",
                                       fname, load(fname), "txt", "eval-pass")

    # ---- 盲测: 只看 manifest (无真值), 预测先落盘
    predictions = {}
    base_bytes = {bid: load(fn) for bid, fn in manifest["bases"].items()}
    for case in manifest["cases"]:
        data = load(case["file"])
        ext = case["file"].rsplit(".", 1)[-1].lower()
        rep = svc.verify_file(ledger, packages, verifier, "评测验真方",
                              certs[case["base"]], data, ext, case["file"])
        predictions[case["case_id"]] = {
            "grade": rep.get("grade", "错误"),
            "confidence": rep.get("confidence"),
            # 基线: 单哈希 (文件字节哈希与登记原件全等才判真)
            "baseline_same": hashlib.sha256(data).digest()
            == hashlib.sha256(base_bytes[case["base"]]).digest(),
        }
    with open(os.path.join(BASE, "predictions.json"), "w", encoding="utf-8") as f:
        json.dump(predictions, f, ensure_ascii=False, indent=1)

    # ---- 拆封评分
    key_bytes = open(os.path.join(BASE, "answer_key.json"), "rb").read()
    assert hashlib.sha256(key_bytes).hexdigest() == key_hash, "答案键哈希不符!"
    key = json.loads(key_bytes)

    total = len(key)
    correct = 0
    by_mutation = defaultdict(lambda: [0, 0])
    pred_grade_stats = defaultdict(lambda: [0, 0])  # grade -> [correct, total]
    exp_grade_stats = defaultdict(lambda: [0, 0])  # 期望主等级 -> [命中, 总数] (召回)
    failures = []
    baseline_correct = 0
    equiv_total = equiv_baseline_ok = 0
    for cid, truth in key.items():
        case = next(c for c in manifest["cases"] if c["case_id"] == cid)
        pred = predictions[cid]
        ok = pred["grade"] in truth["expected"]
        correct += ok
        by_mutation[case["mutation"]][0] += ok
        by_mutation[case["mutation"]][1] += 1
        pred_grade_stats[pred["grade"]][0] += ok
        pred_grade_stats[pred["grade"]][1] += 1
        exp_grade_stats[truth["expected"][0]][0] += ok
        exp_grade_stats[truth["expected"][0]][1] += 1
        if not ok:
            failures.append({"case": cid, "mutation": case["mutation"],
                             "expected": truth["expected"], "got": pred["grade"],
                             "confidence": pred["confidence"],
                             "class": truth["class"]})
        # 基线评分 (任务口径): 原件与等价件应"接受", 篡改/矛盾/无关应"拒绝";
        # 单哈希只能按字节全等接受 — 等价类必然全军覆没, 这正是其失败点
        should_accept = truth["class"] in ("identity", "equivalent")
        b_ok = pred["baseline_same"] == should_accept
        baseline_correct += b_ok
        if truth["class"] == "equivalent":
            equiv_total += 1
            equiv_baseline_ok += pred["baseline_same"]

    results = {
        "corpus": manifest["corpus"], "total": total, "correct": correct,
        "accuracy": round(correct / total, 4),
        "by_mutation": {k: {"correct": v[0], "total": v[1],
                            "accuracy": round(v[0] / v[1], 4)}
                        for k, v in sorted(by_mutation.items())},
        "by_predicted_grade": {k: {"as_expected": v[0], "total": v[1],
                                   "precision": round(v[0] / v[1], 4) if v[1] else None}
                               for k, v in sorted(pred_grade_stats.items())},
        "by_expected_grade": {k: {"as_expected": v[0], "total": v[1],
                                  "recall": round(v[0] / v[1], 4) if v[1] else None}
                              for k, v in sorted(exp_grade_stats.items())},
        "baseline": {"binary_accuracy": round(baseline_correct / total, 4),
                     "equivalent_cases": equiv_total,
                     "equivalent_accepted": equiv_baseline_ok},
        "failures": failures,
    }
    with open(os.path.join(BASE, "results.json"), "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)

    lines = [
        "# 数玺评测报告 · corpus-v1",
        "",
        f"- 用例总数：{total}（基础文档 {len(manifest['bases'])} 份，全部虚构，确定性生成）",
        f"- 盲测协议：预测先落盘 predictions.json，再拆封 answer_key.json 评分；"
        f"答案键 SHA-256 校验：{key_hash[:16]}… 一致",
        f"- **数玺总准确率：{correct}/{total} = {results['accuracy']:.2%}**",
        f"- 行业单哈希基线（二值判定）准确率：{results['baseline']['binary_accuracy']:.2%}；",
        f"  其中内容等价用例 {equiv_total} 例，基线接受 0 例的反面是 — 基线对等价类"
        f"全部判“假”（接受 {equiv_baseline_ok} 例），这正是分级验真要解决的问题。",
        "",
        "## 按变异类型",
        "",
        "| 变异 | 正确/总数 | 准确率 |",
        "|---|---|---|",
    ]
    for m, s in results["by_mutation"].items():
        lines.append(f"| {m} | {s['correct']}/{s['total']} | {s['accuracy']:.2%} |")
    lines += ["", "## 按预测等级的实测精度（标定依据）", "",
              "| 预测等级 | 符合期望/总数 | 实测精度 |", "|---|---|---|"]
    for g, s in results["by_predicted_grade"].items():
        lines.append(f"| {g} | {s['as_expected']}/{s['total']} | "
                     f"{s['precision'] if s['precision'] is not None else '—'} |")
    lines += ["", "## 按期望等级的实测召回", "",
              "| 期望等级 | 命中/总数 | 实测召回 |", "|---|---|---|"]
    for g, s in results["by_expected_grade"].items():
        lines.append(f"| {g} | {s['as_expected']}/{s['total']} | "
                     f"{s['recall'] if s['recall'] is not None else '—'} |")
    lines += ["", f"## 失败用例（{len(failures)} 条，逐条列明不藏）", ""]
    if failures:
        for fa in failures:
            lines.append(f"- {fa['case']}（{fa['mutation']}）：期望 {fa['expected']}，"
                         f"实判 {fa['got']}（把握 {fa['confidence']}）")
    else:
        lines.append("- 无")
    lines += ["", "注：本语料为脚本生成的合成语料，实测精度是合成分布上的结果，"
                  "不等于真实世界精度；真实语料验证（法定披露文件）为下一轮工作。"]
    with open(os.path.join(BASE, "REPORT.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"total={total} correct={correct} acc={results['accuracy']:.4f} "
          f"baseline={results['baseline']['binary_accuracy']:.4f} "
          f"failures={len(failures)}")
    for fa in failures:
        print("FAIL", fa["case"], fa["mutation"], "expected", fa["expected"],
              "got", fa["got"], fa["confidence"])


if __name__ == "__main__":
    main()
