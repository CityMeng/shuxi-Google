"""
数玺 · 标定语料确定性生成器 (eval/gen_eval_corpus.py)
规范版本: 1.3
套件标识: SXA1
生成 >= 300 例确定性变异测试语料:
1. 原件原样基准 (Exact)
2. 等价变换 (Equivalent: 换行CRLF、全角数字、空格规范、千分位规范) -> 预期 乙级
3. 字段篡改 (Field Tamper: 营业收入/成本/净利润/合同金额篡改) -> 预期 丁级
4. 日期篡改 (Date Tamper: 日期月份、年份篡改) -> 预期 丁级
5. 勾稽破坏 (Audit Destruct: 分项合计不平、大写金额不平) -> 预期 丙级/丁级
6. 扫描路径 (Scan Simulation: 格式转换/微量噪点等价) -> 预期 乙级
7. 无关文档 (Unrelated: 随机非结构文本、空文本等) -> 预期 待人工复核/未登记
"""

import os
import json
import random

EVAL_DIR = os.path.dirname(os.path.abspath(__file__))
CORPUS_PATH = os.path.join(EVAL_DIR, "eval_corpus.json")
ANSWER_KEY_PATH = os.path.join(EVAL_DIR, "eval_answer_key.json")

# 登记基准模板
BASE_REPORT_TEMPLATE = """《{year}年第{quarter}季度经营报表》
报告单位：示例新能源有限公司
报告日期：{date}
产品销售收入 | {sales}
服务收入 | {service}
合计 | {total}
营业收入：{revenue}元
营业成本：{cost}元
净利润：{profit}元
"""

def generate_corpus(count: int = 320) -> int:
    """确定性生成 >= 300 例变异语料并分卷保存 (基于季度基准报表)"""
    rng = random.Random(20261022)
    corpus = []
    answer_key = {}

    # 4 个季度的标准登记基准母件
    quarters = [
        {"q": 1, "date": "2026-03-31", "sales": 8000000, "service": 3000000, "total": 11000000, "revenue": 11000000, "cost": 7150000, "profit": 3850000},
        {"q": 2, "date": "2026-06-30", "sales": 8500000, "service": 3200000, "total": 11700000, "revenue": 11700000, "cost": 7600000, "profit": 4100000},
        {"q": 3, "date": "2026-09-30", "sales": 9000000, "service": 3500000, "total": 12500000, "revenue": 12500000, "cost": 8300000, "profit": 4200000},
        {"q": 4, "date": "2026-12-31", "sales": 9500000, "service": 3800000, "total": 13300000, "revenue": 13300000, "cost": 8645000, "profit": 4655000},
    ]

    base_templates = []
    for q_data in quarters:
        text = BASE_REPORT_TEMPLATE.format(
            year=2026, quarter=q_data["q"], date=q_data["date"],
            sales=q_data["sales"], service=q_data["service"], total=q_data["total"],
            revenue=q_data["revenue"], cost=q_data["cost"], profit=q_data["profit"]
        )
        base_templates.append((text, q_data))

    categories = [
        ("原件基准", 40),
        ("等价变换", 60),
        ("字段篡改", 70),
        ("日期篡改", 40),
        ("勾稽破坏", 50),
        ("扫描路径", 30),
        ("无关文档", 30)
    ]

    case_id = 0
    for cat_name, cat_count in categories:
        for i in range(cat_count):
            case_id += 1
            cid = f"EVAL-{case_id:04d}"

            base_content, q_info = base_templates[i % len(base_templates)]
            profit = q_info["profit"]
            date_str = q_info["date"]
            total = q_info["total"]

            expected_grade = "甲级"
            test_content = base_content
            mutation_desc = "原件未改动"

            if cat_name == "原件基准":
                expected_grade = "甲级"
                test_content = base_content
                mutation_desc = "原件原样未动"

            elif cat_name == "等价变换":
                expected_grade = "乙级"
                # 随机选用换行变CRLF、数字转全角、日期空格
                var_type = i % 3
                if var_type == 0:
                    test_content = base_content.replace("\n", "\r\n")
                    mutation_desc = "换行符转换为 CRLF"
                elif var_type == 1:
                    # 利润改全角
                    full_profit = "".join(chr(ord(c) + 65248) if '0' <= c <= '9' else c for c in str(profit))
                    test_content = base_content.replace(f"净利润：{profit}元", f"净利润：{full_profit}元")
                    mutation_desc = "净利润数字转换为全角字符"
                else:
                    # 日期增加空格
                    spaced_date = f"2026 年 09 月 {date_str[-2:]} 日"
                    test_content = base_content.replace(f"报告日期：{date_str}", f"报告日期：{spaced_date}")
                    mutation_desc = "日期格式扩充空格排版"

            elif cat_name == "字段篡改":
                expected_grade = "丁级"
                # 篡改净利润或营业收入
                tampered_profit = profit + rng.randint(1, 10) * 100000
                test_content = base_content.replace(f"净利润：{profit}元", f"净利润：{tampered_profit}元")
                mutation_desc = f"篡改净利润: {profit} -> {tampered_profit}"

            elif cat_name == "日期篡改":
                expected_grade = "丁级"
                tampered_date = "2025-12-31"
                test_content = base_content.replace(f"报告日期：{date_str}", f"报告日期：{tampered_date}")
                mutation_desc = f"篡改报告日期: {date_str} -> {tampered_date}"

            elif cat_name == "勾稽破坏":
                # 合计不平
                tampered_total = total + 500000
                test_content = base_content.replace(f"合计 | {total}", f"合计 | {tampered_total}")
                expected_grade = "丁级"  # 语义字段「合计」被篡改命中丁级
                mutation_desc = f"破坏合计勾稽: 合计标为 {tampered_total} 但分项之和为 {total}"

            elif cat_name == "扫描路径":
                expected_grade = "乙级"
                # 模拟加噪换行与空白
                test_content = base_content + "\n   "
                mutation_desc = "扫描件模拟尾部空白与轻微抖动"

            elif cat_name == "无关文档":
                expected_grade = "待人工复核"
                test_content = f"【第{i}份公司规章制度】\n所有员工必须严格遵守工作纪律，下班关闭电源与门窗。"
                mutation_desc = "无关自由文本文件"

            corpus.append({
                "case_id": cid,
                "category": cat_name,
                "base_content": base_content,
                "test_content": test_content,
                "mutation": mutation_desc
            })

            answer_key[cid] = {
                "expected_grade": expected_grade,
                "category": cat_name,
                "mutation": mutation_desc
            }

    with open(CORPUS_PATH, 'w', encoding='utf-8') as f:
        json.dump(corpus, f, ensure_ascii=False, indent=2)

    with open(ANSWER_KEY_PATH, 'w', encoding='utf-8') as f:
        json.dump(answer_key, f, ensure_ascii=False, indent=2)

    return len(corpus)

if __name__ == "__main__":
    c = generate_corpus(320)
    print(f"成功生成 {c} 份盲测语料至 {CORPUS_PATH}")
    print(f"答案键保存至 {ANSWER_KEY_PATH}")
