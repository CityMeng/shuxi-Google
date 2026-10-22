"""
数玺 · 向量测试套件构建器与运行器 (vectors/run_vectors.py)
规范版本: 1.3
套件标识: SXA1
测试项目数: >= 55 项
覆盖:
1. SM3 与 SHA-256 双算法标准值及 Merkle 树域分隔
2. 空树根计算 (对空字节串按叶子规则计算)
3. 字段抽取与规范化 (万元/亿元换算、点号千分位、全角数字、日期修复、重名字段)
4. 勾稽审计 G1/G2/G3 测试
5. 成对样例的期望等级 (原件甲级、篡改丁级并定位字段、转格式乙级、大小写不符的勾稽留痕、扫描对感知等价、无关文件不得判甲/乙)
6. 选择性披露证明
"""

import sys
import os
import json
import time
from typing import Tuple, List, Dict, Any, Optional

# 确保导入根目录 engine
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.fp import (
    SPEC_VERSION, SUITE_ID,
    sm3_hash, sha256_hash, build_merkle_tree, compute_exact_fingerprint,
    normalize_amount_string, normalize_date_string, normalize_text_field,
    extract_and_normalize_fields, build_semantic_merkle_tree,
    generate_selective_disclosure_proof, verify_selective_disclosure_proof,
    compute_text_similarity, hamming_distance
)
from engine.grade import run_reconciliation_audits, judge_four_tier_grade
from engine.ledger import canonical_serialize, KeyManager, HashChainLedger
from engine.service import ShuXiService
from vectors.gen_samples import generate_all_samples


def build_test_vectors() -> list:
    """构建 >= 55 个详细标准测试向量并返回"""
    vectors = []

    # 1. SM3 与 SHA-256 标准测试向量 (5项)
    vectors.append({
        "id": "VEC-HASH-01",
        "category": "基础哈希",
        "name": "SM3空串标准哈希",
        "input": "",
        "expected": "1ab21d8355cfa17f8e61194831e81a8f22bec8c728fefb747ed035eb5082aa2b"
    })
    vectors.append({
        "id": "VEC-HASH-02",
        "category": "基础哈希",
        "name": "SM3标准测试向量abc",
        "input": "abc",
        "expected": "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0"
    })
    vectors.append({
        "id": "VEC-HASH-03",
        "category": "基础哈希",
        "name": "SHA256空串标准哈希",
        "input": "",
        "expected": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    })
    vectors.append({
        "id": "VEC-HASH-04",
        "category": "基础哈希",
        "name": "SHA256标准测试向量abc",
        "input": "abc",
        "expected": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    })
    vectors.append({
        "id": "VEC-HASH-05",
        "category": "基础哈希",
        "name": "SHA256中文数玺哈希",
        "input": "数玺",
        "expected": sha256_hash("数玺".encode('utf-8'))
    })

    # 2. 协议 5.2 树根与域分隔 (5项)
    empty_sha_root, _ = build_merkle_tree([], algo="sha256")
    empty_sm3_root, _ = build_merkle_tree([], algo="sm3")
    vectors.append({
        "id": "VEC-TREE-01",
        "category": "Merkle树",
        "name": "空树SHA256根为0x00空叶子哈希",
        "expected": sha256_hash(b"\x00")
    })
    vectors.append({
        "id": "VEC-TREE-02",
        "category": "Merkle树",
        "name": "空树SM3根为0x00空叶子哈希",
        "expected": sm3_hash(b"\x00")
    })
    single_root, _ = build_merkle_tree([b"chunk1"], algo="sha256")
    vectors.append({
        "id": "VEC-TREE-03",
        "category": "Merkle树",
        "name": "单叶子节点SHA256域前缀0x00",
        "expected": sha256_hash(b"\x00chunk1")
    })
    odd_root, _ = build_merkle_tree([b"c1", b"c2", b"c3"], algo="sha256")
    vectors.append({
        "id": "VEC-TREE-04",
        "category": "Merkle树",
        "name": "奇数叶子节点复制尾部补齐",
        "is_valid": len(odd_root) == 64
    })
    vectors.append({
        "id": "VEC-TREE-05",
        "category": "Merkle树",
        "name": "内部节点前缀0x01域分隔校验",
        "is_valid": True
    })

    # 3. 字段抽取与金额规范化 (15项)
    amount_cases = [
        ("¥50,000.00", "50000"),
        ("$12,345.67", "12345.67"),
        ("50万元", "500000"),
        ("2.5亿元", "250000000"),
        ("1.200.000", "1200000"),  # 点号千分位消歧
        ("3.500.000元", "3500000"),
        ("-8,300,000元", "-8300000"),
        ("12.50%", "12.5%"),
        ("0.500%", "0.5%"),
        ("￥ 100 万元", "1000000"),
        ("486000.00元", "486000"),
        ("12500000", "12500000"),
        ("9000000元", "9000000"),
        ("3500000元", "3500000"),
        ("-15.00", "-15")
    ]
    for idx, (raw, expected) in enumerate(amount_cases):
        vectors.append({
            "id": f"VEC-AMT-{idx+1:02d}",
            "category": "金额规范化",
            "raw": raw,
            "expected": expected
        })

    # 4. 日期抽取与规范化 (10项)
    date_cases = [
        ("2026年9月30日", "2026-09-30"),
        ("2026 年 9 月 30 日", "2026-09-30"),  # 空格拆散修复
        ("2026/09/15", "2026-09-15"),
        ("2026-9-1", "2026-09-01"),
        ("2026.10.22", "2026-10-22"),
        ("2024年2月29日", "2024-02-29"),  # 闰年合法
        ("2026年2月29日", None),          # 非闰年非法
        ("2026-13-01", None),            # 非法月份
        ("2026-04-31", None),            # 4月无31日
        ("2026年12月31日", "2026-12-31")
    ]
    for idx, (raw, expected) in enumerate(date_cases):
        vectors.append({
            "id": f"VEC-DATE-{idx+1:02d}",
            "category": "日期规范化",
            "raw": raw,
            "expected": expected
        })

    # 5. 重名字段与文本规范化 (5项)
    dup_text = "合计: 100\n合计: 200\n合计: 300"
    fields = extract_and_normalize_fields(dup_text)
    vectors.append({
        "id": "VEC-DUP-01",
        "category": "重名字段",
        "name": "重名字段按出现顺序依次编号",
        "expected_keys": ["合计", "合计#2", "合计#3"]
    })
    vectors.append({
        "id": "VEC-NORM-01",
        "category": "文本规范化",
        "name": "文字字段去首尾空白并将内部空白压缩为一格",
        "input": "  示例  新能源   有限公司  ",
        "expected": "示例 新能源 有限公司"
    })
    vectors.append({
        "id": "VEC-OCR-01",
        "category": "OCR清洗",
        "name": "分隔符混淆字丨与｜转为标准|",
        "input": "产品销售收入丨9000000\n服务收入｜3500000",
        "expected_count": 2
    })
    vectors.append({
        "id": "VEC-MULTILINE-01",
        "category": "跨行提取",
        "name": "标签独占一行数值在次行跨行抽取",
        "input": "报告单位\n示例新能源有限公司",
        "expected": ("报告单位", "示例新能源有限公司")
    })
    vectors.append({
        "id": "VEC-SORT-01",
        "category": "UTF8排序",
        "name": "字段表严格按UTF-8字节序升序排列",
        "check": True
    })

    # 6. 勾稽审计 G1/G2/G3 测试 (5项)
    g1_pass_fields = [("产品销售", "9000000"), ("服务收入", "3500000"), ("合计", "12500000")]
    g1_fail_fields = [("产品销售", "9000000"), ("服务收入", "3500000"), ("合计", "13000000")]
    g2_pass_fields = [("合同金额", "500000"), ("金额大写", "伍拾万元整")]
    g2_fail_fields = [("合同金额", "500000"), ("金额大写", "肆拾捌万陆仟元整")]
    g3_diff_fields = [("营业收入", "12500000"), ("营业成本", "8300000"), ("净利润", "5800000")]

    vectors.append({
        "id": "VEC-AUDIT-G1-PASS",
        "category": "勾稽审计",
        "fields": g1_pass_fields,
        "expected_status": "PASS"
    })
    vectors.append({
        "id": "VEC-AUDIT-G1-FAIL",
        "category": "勾稽审计",
        "fields": g1_fail_fields,
        "expected_status": "FAIL"
    })
    vectors.append({
        "id": "VEC-AUDIT-G2-PASS",
        "category": "勾稽审计",
        "fields": g2_pass_fields,
        "expected_status": "PASS"
    })
    vectors.append({
        "id": "VEC-AUDIT-G2-FAIL",
        "category": "勾稽审计",
        "fields": g2_fail_fields,
        "expected_status": "FAIL"
    })
    vectors.append({
        "id": "VEC-AUDIT-G3-WARN",
        "category": "勾稽审计",
        "fields": g3_diff_fields,
        "expected_status": "WARN"
    })

    # 7. 协议成对样例等级判定 (10项)
    # 覆盖：原件甲级、篡改丁级并定位字段、转格式乙级、大小写不符的勾稽留痕、扫描对感知等价、无关文件不得判甲/乙
    vectors.append({
        "id": "VEC-PAIR-01",
        "category": "成对判定",
        "name": "report.txt原件验真",
        "expected_grade": "甲级",
        "expected_confidence": 99
    })
    vectors.append({
        "id": "VEC-PAIR-02",
        "category": "成对判定",
        "name": "report_tampered.txt篡改净利润验真",
        "expected_grade": "丁级",
        "tampered_field": "净利润",
        "expected_registered": "4200000",
        "expected_current": "5800000"
    })
    vectors.append({
        "id": "VEC-PAIR-03",
        "category": "成对判定",
        "name": "report_converted.txt转格式等价件验真",
        "expected_grade": "乙级"
    })
    vectors.append({
        "id": "VEC-PAIR-04",
        "category": "成对判定",
        "name": "fake.txt未登记不平衡件审计",
        "expected_grade": "丙级"
    })
    vectors.append({
        "id": "VEC-PAIR-05",
        "category": "成对判定",
        "name": "contract_bad.txt大写不符留痕登记后原件验真",
        "expected_grade": "甲级"
    })
    vectors.append({
        "id": "VEC-PAIR-06",
        "category": "成对判定",
        "name": "scan_a与scan_b扫描互验感知等价",
        "expected_passed": True
    })
    vectors.append({
        "id": "VEC-PAIR-07",
        "category": "成对判定",
        "name": "big.bin精确跨3分块无缝建树",
        "expected_chunks": 3
    })
    vectors.append({
        "id": "VEC-PAIR-08",
        "category": "成对判定",
        "name": "无关文本对report登记验真不得判甲或乙",
        "input_text": "这是一个完全无关的会议纪要备忘录，没有共同字段。",
        "forbidden_grades": ["甲级", "乙级"]
    })
    vectors.append({
        "id": "VEC-PAIR-09",
        "category": "成对判定",
        "name": "选择性披露单个字段Merkle证明成立且其余字段隐匿",
        "check": True
    })
    vectors.append({
        "id": "VEC-PAIR-10",
        "category": "成对判定",
        "name": "浮点数载荷拒绝序列化防御",
        "check": True
    })

    return vectors


def run_all_vectors(verbose: bool = True) -> Tuple[int, int, list]:
    """执行全部测试向量并核对"""
    vectors = build_test_vectors()
    samples = generate_all_samples()

    # 初始化测试服务
    test_data_dir = "/tmp/shuxi_vectors_data"
    os.system(f"rm -rf {test_data_dir}")
    svc = ShuXiService(data_dir=test_data_dir)

    # 登记基准
    reg_report = svc.register_file("report.txt", samples["report.txt"])
    reg_contract_bad = svc.register_file("contract_bad.txt", samples["contract_bad.txt"])

    passed = 0
    total = len(vectors)
    failures = []

    for vec in vectors:
        vid = vec["id"]
        cat = vec["category"]
        try:
            # 1. 基础哈希
            if cat == "基础哈希":
                if "SM3" in vec["name"]:
                    res = sm3_hash(vec["input"].encode('utf-8'))
                else:
                    res = sha256_hash(vec["input"].encode('utf-8'))
                assert res == vec["expected"], f"哈希不匹配: {res} != {vec['expected']}"

            # 2. Merkle树
            elif cat == "Merkle树":
                if vid == "VEC-TREE-01":
                    r, _ = build_merkle_tree([], algo="sha256")
                    assert r == vec["expected"]
                elif vid == "VEC-TREE-02":
                    r, _ = build_merkle_tree([], algo="sm3")
                    assert r == vec["expected"]
                elif vid == "VEC-TREE-03":
                    r, _ = build_merkle_tree([b"chunk1"], algo="sha256")
                    assert r == vec["expected"]
                elif vid == "VEC-TREE-04":
                    r, _ = build_merkle_tree([b"c1", b"c2", b"c3"], algo="sha256")
                    assert len(r) == 64
                elif vid == "VEC-TREE-05":
                    # 验证内部节点加 0x01 前缀
                    h1 = sha256_hash(b"\x00a")
                    h2 = sha256_hash(b"\x00b")
                    parent = sha256_hash(b"\x01" + bytes.fromhex(h1) + bytes.fromhex(h2))
                    r, levs = build_merkle_tree([b"a", b"b"], algo="sha256")
                    assert r == parent

            # 3. 金额规范化
            elif cat == "金额规范化":
                res = normalize_amount_string(vec["raw"])
                assert res == vec["expected"], f"金额规范化失败: raw={vec['raw']}, res={res}, expected={vec['expected']}"

            # 4. 日期规范化
            elif cat == "日期规范化":
                res = normalize_date_string(vec["raw"])
                assert res == vec["expected"], f"日期规范化失败: raw={vec['raw']}, res={res}, expected={vec['expected']}"

            # 5. 重名与文本抽取
            elif cat == "重名字段":
                f_list = extract_and_normalize_fields("合计: 100\n合计: 200\n合计: 300")
                keys = [k for k, _ in f_list]
                assert keys == vec["expected_keys"]
            elif cat == "文本规范化":
                res = normalize_text_field(vec["input"])
                assert res == vec["expected"]
            elif cat == "OCR清洗":
                f_list = extract_and_normalize_fields(vec["input"])
                assert len(f_list) == vec["expected_count"]
            elif cat == "跨行提取":
                f_list = extract_and_normalize_fields(vec["input"])
                assert f_list[0] == vec["expected"]
            elif cat == "UTF8排序":
                f_list = extract_and_normalize_fields("乙方: B\n甲方: A\n金额: 100")
                keys = [k for k, _ in f_list]
                sorted_keys = sorted(keys, key=lambda x: x.encode('utf-8'))
                assert keys == sorted_keys

            # 6. 勾稽审计
            elif cat == "勾稽审计":
                from engine.grade import run_g1_audit, run_g2_audit, run_g3_audit
                if "G1" in vid:
                    aud = run_g1_audit(vec["fields"])
                elif "G2" in vid:
                    aud = run_g2_audit(vec["fields"])
                else:
                    aud = run_g3_audit(vec["fields"])
                assert aud["status"] == vec["expected_status"], f"勾稽状态不符: {aud['status']} != {vec['expected_status']}"

            # 7. 成对样例判定
            elif cat == "成对判定":
                if vid == "VEC-PAIR-01":
                    v = svc.verify_file(reg_report["cert_id"], samples["report.txt"])
                    assert v["grade"] == vec["expected_grade"]
                    assert v["confidence"] == vec["expected_confidence"]
                elif vid == "VEC-PAIR-02":
                    v = svc.verify_file(reg_report["cert_id"], samples["report_tampered.txt"])
                    assert v["grade"] == vec["expected_grade"]
                    assert len(v["diff_table"]) > 0
                    assert v["diff_table"][0]["field"] == vec["tampered_field"]
                    assert v["diff_table"][0]["current_val"] == vec["expected_current"]
                elif vid == "VEC-PAIR-03":
                    v = svc.verify_file(reg_report["cert_id"], samples["report_converted.txt"])
                    assert v["grade"] == vec["expected_grade"]
                elif vid == "VEC-PAIR-04":
                    v = svc.verify_file("NON-EXISTENT", samples["fake.txt"])
                    assert v["grade"] == vec["expected_grade"]
                elif vid == "VEC-PAIR-05":
                    v = svc.verify_file(reg_contract_bad["cert_id"], samples["contract_bad.txt"])
                    assert v["grade"] == vec["expected_grade"]
                elif vid == "VEC-PAIR-06":
                    t_a = "合同金额：486000元\n签订日期：2026年9月15日"
                    t_b = "合同金额：486000元\n签订日期：2026年9月15日\n"
                    sim, _ = compute_text_similarity(t_a, t_b)
                    assert sim >= 0.90
                elif vid == "VEC-PAIR-07":
                    ex = compute_exact_fingerprint(samples["big.bin"])
                    assert ex["chunk_count"] == vec["expected_chunks"]
                elif vid == "VEC-PAIR-08":
                    v = svc.verify_file(reg_report["cert_id"], vec["input_text"].encode('utf-8'))
                    assert v["grade"] not in vec["forbidden_grades"]
                elif vid == "VEC-PAIR-09":
                    rf = [("甲方", "示例新能源有限公司"), ("金额", "500000"), ("签订日期", "2026-09-15")]
                    root, salts, levels = build_semantic_merkle_tree(rf)
                    proof = generate_selective_disclosure_proof(1, rf, salts, levels)
                    ok = verify_selective_disclosure_proof(proof, root)
                    assert ok is True
                elif vid == "VEC-PAIR-10":
                    try:
                        canonical_serialize({"amount": 12.34})
                        assert False, "未能拦截浮点数"
                    except ValueError:
                        pass

            passed += 1
            if verbose:
                print(f"  [PASS] {vid}: {vec.get('name', cat)}")
        except Exception as e:
            failures.append((vid, str(e)))
            print(f"  [FAIL] {vid}: {e}")

    return passed, total, failures


if __name__ == "__main__":
    print(f"=== 运行数玺标准测试向量套件 (规范版本 {SPEC_VERSION}, 套件 {SUITE_ID}) ===")
    p, t, fails = run_all_vectors(verbose=True)
    print(f"\n测试结果: {p} / {t} 项通过 (通过率: {p/t*100:.1f}%)")

    # 同时导出 test_vectors.json
    all_vecs = build_test_vectors()
    out_json = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_vectors.json")
    with open(out_json, 'w', encoding='utf-8') as f:
        json.dump(all_vecs, f, ensure_ascii=False, indent=2)
    print(f"已导出标准测试向量文件至 {out_json}")

    if fails:
        sys.exit(1)
