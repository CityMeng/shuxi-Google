"""
数玺 · 勾稽审计与四级判定引擎 (engine/grade.py)
规范版本: 1.3
套件标识: SXA1
包含:
1. G1 合计复算 (同列/同行条目之和，容差 max(0.01, 1e-6))
2. G2 大小写一致 (小写金额 vs 中文大写换算值)
3. G3 经营勾稽 (营业收入 - 营业成本 - 净利润 != 0 仅提示，不参与丙级)
4. 四级判定 (严格分诊顺序: 甲级/丁级/丙级/乙级/待人工复核)
"""

import time
import math
import re
from typing import List, Dict, Any, Tuple, Optional
from engine.fp import parse_cn_amount, normalize_amount_string


# ==========================================================
# 5.5 勾稽审计 (G1, G2, G3)
# ==========================================================
def run_g1_audit(fields: List[Tuple[str, str]]) -> Dict[str, Any]:
    """
    G1 合计复算:
    合计 = 同列/同行分项条目之和
    容差取绝对 0.01 与相对 1e-6 两者之大: max(0.01, 1e-6 * abs(total))
    """
    total_val = None
    sub_vals = []
    has_total = False

    for k, v in fields:
        clean_k = re.sub(r'#\d+$', '', k).strip()
        # 清洗数值
        val_str = normalize_amount_string(v)
        try:
            num = float(val_str)
        except ValueError:
            continue

        if clean_k in ['合计', '总计', '总额', '合计数']:
            total_val = num
            has_total = True
        elif any(sub in clean_k for sub in ['销售收入', '服务收入', '产品销售', '主营业务', '分项', '分项收入', '条目']):
            sub_vals.append((k, num))

    if not has_total or not sub_vals:
        return {
            "id": "G1",
            "name": "合计复算",
            "status": "PASS",
            "applicable": False,
            "message": "未检测到多条目汇总结构，跳过合计复算"
        }

    sum_subs = sum(num for _, num in sub_vals)
    tolerance = max(0.01, 1e-6 * abs(total_val))
    diff = abs(total_val - sum_subs)

    if diff <= tolerance:
        return {
            "id": "G1",
            "name": "合计复算",
            "status": "PASS",
            "applicable": True,
            "total": total_val,
            "calculated_sum": sum_subs,
            "diff": round(diff, 4),
            "message": f"合计复算平衡 (合计 {total_val} == 各分项之和 {sum_subs})"
        }
    else:
        return {
            "id": "G1",
            "name": "合计复算",
            "status": "FAIL",
            "applicable": True,
            "total": total_val,
            "calculated_sum": sum_subs,
            "diff": round(diff, 4),
            "message": f"合计复算不平: 报表合计为 {total_val}，分项实际之和为 {sum_subs}，差额 {round(diff, 2)}"
        }


def run_g2_audit(fields: List[Tuple[str, str]]) -> Dict[str, Any]:
    """
    G2 大小写一致:
    小写金额 = 中文大写金额换算值 (支持拾佰仟万亿、角分、整)
    """
    lower_val = None
    upper_parsed_val = None
    upper_raw = None

    for k, v in fields:
        clean_k = re.sub(r'#\d+$', '', k).strip()
        if '大写' in clean_k:
            upper_raw = v
            parsed = parse_cn_amount(v)
            if parsed is not None:
                upper_parsed_val = parsed
        elif any(w in clean_k for w in ['合同金额', '总金额', '金额', '价款']) and '大写' not in clean_k:
            try:
                num = float(normalize_amount_string(v))
                lower_val = num
            except ValueError:
                pass

    if lower_val is None or upper_parsed_val is None:
        return {
            "id": "G2",
            "name": "大小写一致",
            "status": "PASS",
            "applicable": False,
            "message": "未同时检出小写金额与大写金额，跳过大小写一致校验"
        }

    tolerance = 0.01
    diff = abs(lower_val - upper_parsed_val)
    if diff <= tolerance:
        return {
            "id": "G2",
            "name": "大小写一致",
            "status": "PASS",
            "applicable": True,
            "lower": lower_val,
            "upper_raw": upper_raw,
            "upper_parsed": upper_parsed_val,
            "message": f"大小写金额一致: 小写 {lower_val} 元，大写「{upper_raw}」"
        }
    else:
        return {
            "id": "G2",
            "name": "大小写一致",
            "status": "FAIL",
            "applicable": True,
            "lower": lower_val,
            "upper_raw": upper_raw,
            "upper_parsed": upper_parsed_val,
            "message": f"大小写金额不符: 小写为 {lower_val} 元，大写「{upper_raw}」换算为 {upper_parsed_val} 元"
        }


def run_g3_audit(fields: List[Tuple[str, str]]) -> Dict[str, Any]:
    """
    G3 经营勾稽:
    营业收入 - 营业成本 - 净利润 != 0 时仅提示，不参与丙级判定 (丙级只比 G1、G2)
    """
    rev = None
    cost = None
    profit = None

    for k, v in fields:
        clean_k = re.sub(r'#\d+$', '', k).strip()
        val_str = normalize_amount_string(v)
        try:
            num = float(val_str)
        except ValueError:
            continue

        if '营业收入' in clean_k or '主营业务收入' in clean_k:
            rev = num
        elif '营业成本' in clean_k or '主营业务成本' in clean_k:
            cost = num
        elif '净利润' in clean_k or '利润总额' in clean_k:
            profit = num

    if rev is None or cost is None or profit is None:
        return {
            "id": "G3",
            "name": "经营勾稽",
            "status": "PASS",
            "applicable": False,
            "message": "报表未完整包含收入、成本与净利润字段，跳过经营勾稽"
        }

    calc_profit = rev - cost
    diff = abs(calc_profit - profit)
    tolerance = max(0.01, 1e-6 * abs(profit))

    if diff <= tolerance:
        return {
            "id": "G3",
            "name": "经营勾稽",
            "status": "PASS",
            "applicable": True,
            "revenue": rev,
            "cost": cost,
            "net_profit": profit,
            "message": f"经营勾稽平衡 (营业收入 {rev} - 营业成本 {cost} == 净利润 {profit})"
        }
    else:
        return {
            "id": "G3",
            "name": "经营勾稽",
            "status": "WARN",
            "applicable": True,
            "revenue": rev,
            "cost": cost,
            "net_profit": profit,
            "diff": round(diff, 2),
            "message": f"经营勾稽提示: 营业收入 {rev} - 营业成本 {cost} = {calc_profit}，与报送净利润 {profit} 差异 {round(diff, 2)}（仅作经营分析提示，不影响结论等级）"
        }


def run_reconciliation_audits(fields: List[Tuple[str, str]]) -> List[Dict[str, Any]]:
    """运行全套勾稽审计 G1/G2/G3"""
    return [run_g1_audit(fields), run_g2_audit(fields), run_g3_audit(fields)]


# ==========================================================
# 5.6 四级判定 (严格分诊式)
# ==========================================================
def diff_fields_with_tail_alignment(
    registered_fields: List[Tuple[str, str]],
    current_fields: List[Tuple[str, str]]
) -> List[Dict[str, Any]]:
    """
    语义字段比对:
    附加规则: 键尾 OCR 伪影对齐: 字段键仅尾部数字不同且值相同者视为同键 (防扫描件标签噪声误判丁)
    值不同绝不适用此条！
    """
    reg_dict = dict(registered_fields)
    curr_dict = dict(current_fields)

    diffs = []
    visited_curr_keys = set()

    for r_k, r_v in registered_fields:
        if r_k in curr_dict:
            c_v = curr_dict[r_k]
            visited_curr_keys.add(r_k)
            if c_v != r_v:
                diffs.append({
                    "field": r_k,
                    "registered_val": r_v,
                    "current_val": c_v,
                    "reason": "字段值被篡改"
                })
        else:
            # 尝试键尾 OCR 伪影对齐 (如 合计#2 与 合计 且值相同)
            aligned_match = None
            base_rk = re.sub(r'#\d+$', '', r_k)
            for c_k, c_v in curr_dict.items():
                if c_k not in visited_curr_keys:
                    base_ck = re.sub(r'#\d+$', '', c_k)
                    if base_rk == base_ck and c_v == r_v:
                        aligned_match = c_k
                        break

            if aligned_match:
                visited_curr_keys.add(aligned_match)
                # 键尾对齐且值相同，视为未改
            else:
                diffs.append({
                    "field": r_k,
                    "registered_val": r_v,
                    "current_val": "【已缺失/未抽取到】",
                    "reason": "字段在当前待验文件中缺失"
                })

    return diffs


def judge_four_tier_grade(
    exact_match: bool,
    registered_record: Optional[Dict[str, Any]],
    current_fields: Optional[List[Tuple[str, str]]],
    registered_fields: Optional[List[Tuple[str, str]]],
    perceptual_passed: Optional[bool],
    perceptual_stats: Dict[str, Any],
    current_audits: List[Dict[str, Any]],
    start_time_ns: int,
    key_status: str = "VALID", # "VALID", "REVOKED", "DISPUTED"
) -> Dict[str, Any]:
    """
    严格按照 5.6 四级判定顺序命中:
    前置:
      1. 凭证已作废 -> 结论「已作废」终止
      2. 状态争议 -> 照常判但结论加注
      3. 登记密钥已失效 -> 照常判但加注
    顺序:
      1. 精确双根全部一致 -> 甲级 · 原件未动 (基线 99%)
      2. 任一语义字段值与登记不同 (含被删) -> 丁级 · 关键字段被改 (基线 95%)
      3. 字段未变，但出现登记时没有的新勾稽问题 (仅 G1/G2) -> 丙级 · 内容自相矛盾 (基线 85%)
      4. 字段未变且感知通过 (汉明 <= 8 或相似度 >= 0.90) -> 乙级 · 载体变、内容等价 (基线 75-90%)
      5. 其余情形 -> 待人工复核 (<= 40%)
    """
    elapsed_ms = max(1, int((time.perf_counter_ns() - start_time_ns) / 1_000_000))
    reasons: List[str] = []
    caps: List[int] = []

    # 1. 前置状态处理
    if registered_record:
        rec_status = registered_record.get("status", "有效")
        if rec_status == "已作废":
            return {
                "grade": "已作废",
                "label": "凭证已作废",
                "color": "#94A3B8",
                "seal_text": "作废",
                "confidence": 100,
                "reasons": ["此登记记录已被登记方私钥正式签名作废，链上凭证不再受采信。"],
                "elapsed_ms": elapsed_ms,
                "diff_table": []
            }
        elif rec_status == "争议":
            reasons.append("【链上警示】该凭证处于争议公告存续状态，下述结论照常输出但请审慎使用。")

    if key_status == "REVOKED":
        reasons.append("【密钥状态提示】原登记私钥已发布公钥失效公告，历史记录签名仍保留存证效力。")
    elif key_status == "DISPUTED":
        reasons.append("【密钥状态提示】原登记私钥已列入争议公告，需待澄清。")

    # 检查未登记文件
    if registered_record is None:
        # 未登记文件: 只做勾稽审计
        has_g1_fail = any(a["id"] == "G1" and a["status"] == "FAIL" for a in current_audits)
        has_g2_fail = any(a["id"] == "G2" and a["status"] == "FAIL" for a in current_audits)
        if has_g1_fail or has_g2_fail:
            reasons.append("该文件未在数玺账本中登记，经本地勾稽审计发现内部账目数据自相矛盾。")
            if has_g1_fail:
                reasons.append("合计复算存在差额，同列或同行分项条目与报表合计不符。")
            if has_g2_fail:
                reasons.append("小写金额与中文大写金额计算值不一致。")
            return {
                "grade": "丙级",
                "label": "丙级 · 内容自相矛盾",
                "color": "#FBBF24",
                "seal_text": "丙级",
                "confidence": 85,
                "reasons": reasons,
                "elapsed_ms": elapsed_ms,
                "diff_table": []
            }
        else:
            reasons.append("该文件未在数玺账本中登记存证。")
            reasons.append("文件内部数据未发现明显勾稽异常（注意：勾稽未见异常不等于内容本身真实）。")
            return {
                "grade": "未登记",
                "label": "未登记，勾稽未见异常（不等于真实）",
                "color": "#94A3B8",
                "seal_text": "复核",
                "confidence": 50,
                "reasons": reasons,
                "elapsed_ms": elapsed_ms,
                "diff_table": []
            }

    # 页数不一致规则 (5.3 规则 3): 感知哈希不参与判定，把握封顶 70%，结论注明页数差异
    page_count_mismatch = perceptual_stats.get("page_count_mismatch", False)
    if page_count_mismatch:
        caps.append(70)
        reasons.append(f"文件页数与登记记录不一致 (原文件 {perceptual_stats.get('reg_pages', 1)} 页，待验文件 {perceptual_stats.get('curr_pages', 1)} 页)，把握封顶 70%。")

    # 附加规则: 登记方未出示登记包 (无字段表) 或 待验文件抽不出字段
    no_registration_pack = (registered_fields is None)
    no_current_fields = (current_fields is None or len(current_fields) == 0)

    # 1. 顺位 1: 精确双根全部一致 -> 甲级 · 原件未动
    if exact_match:
        reasons.append("精确层 SHA-256 与 SM3 国密双 Merkle 根与账本存证 100% 逐比特完全一致。")
        reasons.append("文件自登记确权以来，未发生任何字节级篡改或重新格式化。")
        # 丙级相对基准：与登记时相同的勾稽老问题不构成丙级，只注明（甲级同理，注明不改级）
        old_audit = registered_record.get("audit_results", [])
        if any("FAIL" in str(r) for r in old_audit):
            reasons.append("注：该文件登记时即存在历史勾稽警示，因双根完全匹配，原件确权保持甲级。")
        conf = 99
        if caps:
            conf = min(conf, min(caps))
        return {
            "grade": "甲级",
            "label": "甲级 · 原件未动",
            "color": "#34D399",
            "seal_text": "甲级",
            "confidence": conf,
            "reasons": reasons,
            "elapsed_ms": elapsed_ms,
            "diff_table": []
        }

    # 缺少登记包或抽不出字段的分支
    if no_registration_pack or no_current_fields:
        sub_reason = "登记方未出示登记包（无法提取字段明文比对）" if no_registration_pack else "待验文件未能抽取出带标签语义字段"
        reasons.append(f"精确层双根发生变动（非原始字节）；且{sub_reason}。")
        caps.append(60)
        if perceptual_passed:
            reasons.append("第二层感知指纹（pHash 或文本相似度）比对通过，版面布局与内容等价。")
            reasons.append("依据协议规则：缺乏语义字段表但感知通过时，判定为乙级，把握封顶 60%，建议人工复核关键页。")
            conf = min(60, min(caps))
            return {
                "grade": "乙级",
                "label": "乙级 · 载体变、内容等价",
                "color": "#38BDF8",
                "seal_text": "乙级",
                "confidence": conf,
                "reasons": reasons,
                "elapsed_ms": elapsed_ms,
                "diff_table": []
            }
        else:
            reasons.append("第二层感知指纹比对亦未通过或页面形态发生较大差异。")
            reasons.append("依据协议规则：转入待人工复核。")
            conf = min(40, min(caps))
            return {
                "grade": "待人工复核",
                "label": "待人工复核",
                "color": "#A78BFA",
                "seal_text": "复核",
                "confidence": conf,
                "reasons": reasons,
                "elapsed_ms": elapsed_ms,
                "diff_table": []
            }

    # 计算字段差异 (带尾部 OCR 伪影对齐)
    field_diffs = diff_fields_with_tail_alignment(registered_fields, current_fields)

    # 2. 顺位 2: 任一语义字段值与登记不同 (含被删) -> 丁级 · 关键字段被改
    if len(field_diffs) > 0:
        reasons.append(f"语义指纹比对发现异常：检出 {len(field_diffs)} 处关键业务字段值被改动或缺失。")
        for d in field_diffs[:5]:
            reasons.append(f"字段「{d['field']}」：登记值为「{d['registered_val']}」，当前值为「{d['current_val']}」")
        if len(field_diffs) > 5:
            reasons.append(f"... 及其余 {len(field_diffs) - 5} 处字段变动。")
        conf = 95
        if caps:
            conf = min(conf, min(caps))
        return {
            "grade": "丁级",
            "label": "丁级 · 关键字段被改",
            "color": "#FB7185",
            "seal_text": "丁级",
            "confidence": conf,
            "reasons": reasons,
            "elapsed_ms": elapsed_ms,
            "diff_table": field_diffs
        }

    # 3. 顺位 3: 字段未变，但出现登记时没有的新勾稽问题 (仅 G1/G2) -> 丙级 · 内容自相矛盾
    reg_audits_str = str(registered_record.get("audit_results", []))
    old_g1_fail = "G1-FAIL" in reg_audits_str
    old_g2_fail = "G2-FAIL" in reg_audits_str

    curr_g1_fail = any(a["id"] == "G1" and a["status"] == "FAIL" for a in current_audits)
    curr_g2_fail = any(a["id"] == "G2" and a["status"] == "FAIL" for a in current_audits)

    new_g1_problem = curr_g1_fail and not old_g1_fail
    new_g2_problem = curr_g2_fail and not old_g2_fail

    if new_g1_problem or new_g2_problem:
        reasons.append("关键语义字段虽未改变，但文件内部复算触发登记时不存在的新勾稽矛盾。")
        if new_g1_problem:
            reasons.append("新检出 G1 合计复算不平：各分项明细之和与报表合计金额不一致。")
        if new_g2_problem:
            reasons.append("新检出 G2 大小写不符：阿拉伯小写金额与中文大写金额计算值矛盾。")
        conf = 85
        if caps:
            conf = min(conf, min(caps))
        return {
            "grade": "丙级",
            "label": "丙级 · 内容自相矛盾",
            "color": "#FBBF24",
            "seal_text": "丙级",
            "confidence": conf,
            "reasons": reasons,
            "elapsed_ms": elapsed_ms,
            "diff_table": []
        }

    # 4. 顺位 4: 字段未变且感知通过 (汉明 <= 8 或相似度 >= 0.90) -> 乙级 · 载体变、内容等价
    if perceptual_passed:
        reasons.append("语义层全部关键字段与登记记录 100% 吻合，业务事实未变。")
        p_reasons = []
        if perceptual_stats.get("avg_hamming") is not None and perceptual_stats["avg_hamming"] <= 8:
            p_reasons.append(f"页面 pHash 平均汉明距离 {perceptual_stats['avg_hamming']:.2f} <= 8（长相未变）")
        if perceptual_stats.get("text_sim") is not None and perceptual_stats["text_sim"] >= 0.90:
            p_reasons.append(f"文本 3-gram 相似度 {perceptual_stats['text_sim']:.4f} >= 0.90（文本等价）")
        reasons.append(f"第二层感知指纹校验通过：{', '.join(p_reasons)}。")
        reasons.append("判定该文件为转格式、打印翻拍或轻微排版重存等价件，有效内容保持完整真实。")
        # 乙级基线 75 - 90%
        base_conf = 88
        if caps:
            conf = min(base_conf, min(caps))
        else:
            conf = base_conf
        return {
            "grade": "乙级",
            "label": "乙级 · 载体变、内容等价",
            "color": "#38BDF8",
            "seal_text": "乙级",
            "confidence": conf,
            "reasons": reasons,
            "elapsed_ms": elapsed_ms,
            "diff_table": []
        }

    # 5. 顺位 5: 其余情形 -> 待人工复核
    reasons.append("精确层双根不同；虽字段抽取未见明显异常，但感知指纹差异超出容许阈值。")
    reasons.append("排版布局或自由文本发生不可信漂移，系统判定需转入待人工复核。")
    conf = min(40, min(caps) if caps else 40)
    return {
        "grade": "待人工复核",
        "label": "待人工复核",
        "color": "#A78BFA",
        "seal_text": "复核",
        "confidence": conf,
        "reasons": reasons,
        "elapsed_ms": elapsed_ms,
        "diff_table": []
    }
