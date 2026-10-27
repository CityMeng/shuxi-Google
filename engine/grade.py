# -*- coding: utf-8 -*-
"""
数玺核心引擎 · 勾稽与四级判定 (实现《数玺协议规范 v1.2》第 6、7 节)

判定顺序 (先命中先定级): 状态前置 -> 甲 -> 丁 -> 丙(相对基准) -> 乙 -> 待人工复核。
把握为基线值, 多个封顶同时命中取最低者 (规范 §6)。
勾稽编号: G1 合计复算 / G2 金额大小写 / G3 字段间提示 (不入丙级比对)。
"""
from __future__ import annotations

import re
from decimal import Decimal

from engine import fp

TOL_ABS = 0.01
TOL_REL = 1e-6

# ---------------------------------------------------------------- G2 大写金额

_CN_DIGITS = {"零": 0, "壹": 1, "贰": 2, "叁": 3, "肆": 4, "伍": 5,
              "陆": 6, "柒": 7, "捌": 8, "玖": 9}
_CN_UNITS = {"拾": 10, "佰": 100, "仟": 1000, "万": 10000, "亿": 100000000}


def _cn_int(s: str):
    """中文大写整数部分 -> int; 含非法字符返回 None。"""
    total, section, num = 0, 0, 0
    for ch in s:
        if ch in _CN_DIGITS:
            num = _CN_DIGITS[ch]
        elif ch in _CN_UNITS:
            u = _CN_UNITS[ch]
            if u >= 10000:
                section = (section + num) * u
                total += section
                section, num = 0, 0
            else:
                section += (num or 1) * u
                num = 0
        else:
            return None
    return total + section + num


def chinese_amount(text: str):
    """中文大写金额 -> Decimal 元 (含角/分); 解析失败返回 None。"""
    m = re.search(r"([零壹贰叁肆伍陆柒捌玖拾佰仟万亿]+)(?:元|圆)([零壹贰叁肆伍陆柒捌玖]角)?"
                  r"([零壹贰叁肆伍陆柒捌玖]分)?整?", text)
    if not m:
        return None
    whole = _cn_int(m.group(1))
    if whole is None:
        return None
    val = Decimal(whole)
    if m.group(2):
        val += Decimal(_CN_DIGITS[m.group(2)[0]]) * Decimal("0.1")
    if m.group(3):
        val += Decimal(_CN_DIGITS[m.group(3)[0]]) * Decimal("0.01")
    return val


# ---------------------------------------------------------------- 勾稽审计

def _num(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        c = fp.canon_amount(v)
        if c is not None and "%" not in v:
            try:
                return float(c)
            except ValueError:
                return None
    return None


def audit(data: bytes, ext: str, text: str, fields: dict) -> dict:
    """返回 {issues: [{code, key, msg}], hints: [str]}。issues 仅含 G1/G2。"""
    issues: list[dict] = []
    hints: list[str] = []

    # G1 合计复算
    for grid in fp.extract_tables(data, ext):
        if not grid:
            continue
        ncols = max((len(r) for r in grid), default=0)
        # 列向: 标签在首列, 数值在同列上方累加
        for c in range(1, ncols):
            for r, row in enumerate(grid):
                label = str(row[0]) if row and row[0] is not None else ""
                if "合计" not in label and "总计" not in label:
                    continue
                total = _num(row[c]) if c < len(row) else None
                if total is None:
                    continue
                items = []
                for up in grid[:r]:
                    lab = str(up[0]) if up and up[0] is not None else ""
                    if "合计" in lab or "总计" in lab:
                        continue
                    v = _num(up[c]) if c < len(up) else None
                    if v is not None:
                        items.append(v)
                if len(items) >= 2 and abs(sum(items) - total) > max(TOL_ABS, abs(total) * TOL_REL):
                    issues.append({
                        # key 用 标签+合计值 (不用列号/行号): 表格插行后
                        # 同一老问题仍同 key, 不被误判为新问题 (相对丙基准)
                        "code": "G1", "key": f"G1|{label}|{total:g}",
                        "msg": f"「{label}」列条目之和 {sum(items):g} ≠ 合计 {total:g}"})
        # 行向: 同行 合计标签 + 多个数值, 末位为合计
        for row in grid:
            labels = [str(x) for x in row if isinstance(x, str)]
            if not any("合计" in x or "总计" in x for x in labels):
                continue
            nums = [v for v in (_num(x) for x in row) if v is not None]
            if len(nums) >= 3:
                total, items = nums[-1], nums[:-1]
                if abs(sum(items) - total) > max(TOL_ABS, abs(total) * TOL_REL):
                    lab = next(x for x in labels if "合计" in x or "总计" in x)
                    issues.append({
                        "code": "G1", "key": f"G1|{lab}|{total:g}",
                        "msg": f"「{lab}」行条目之和 {sum(items):g} ≠ 合计 {total:g}"})

    # G2 金额大小写一致
    m_small = re.search(r"(?:金额|价款|总价|合同价)[^0-9]{0,6}([0-9][0-9,．.]*)\s*元", text or "")
    if m_small and ("大写" in (text or "") or "人民币" in (text or "")):
        big = chinese_amount(text or "")
        small = fp.canon_amount(m_small.group(1) + "元")
        if big is not None and small is not None and abs(Decimal(small) - big) > Decimal("0.01"):
            issues.append({
                "code": "G2", "key": "G2|金额大小写",
                "msg": f"金额小写 {small} 元 ≠ 大写换算 {big} 元"})

    # G3 字段间勾稽 (仅提示)
    if all(k in fields for k in ("营业收入", "营业成本", "净利润")):
        try:
            diff = (Decimal(fields["营业收入"]) - Decimal(fields["营业成本"])
                    - Decimal(fields["净利润"]))
            if diff != 0:
                hints.append(f"G3 提示: 营业收入-营业成本-净利润 = {diff} (可能含其他收支, 仅提示)")
        except Exception:
            pass

    # 去重 (同一 key 只报一次)
    seen, uniq = set(), []
    for i in issues:
        if i["key"] not in seen:
            seen.add(i["key"])
            uniq.append(i)
    return {"issues": uniq, "hints": hints}


def _align_ocr_keys(fields: dict, other: dict) -> dict:
    """把仅键尾数字不同、且值与对方同名键相同的键对齐到对方键名。
    例: OCR 把'服务收入 |'读成'服务收入1' — 值未变, 属标签噪声。"""
    out = dict(fields)
    for k in list(out):
        if k not in other and re.search(r"\d$", k):
            base = k.rstrip("0123456789")
            if base in other and other[base] == out[k] and base not in out:
                out[base] = out.pop(k)
    return out


# ---------------------------------------------------------------- 四级判定

def grade(reg: dict, cand: dict, reg_audit: dict, cand_audit: dict,
          reg_fields: dict | None, status: str = "有效",
          annotations: list[str] | None = None) -> dict:
    """reg 为 fp.public_view 结构 (登记记录侧); cand 为 fp.compute_all 结构
    (待验文件当场计算); reg_fields 为登记包出示的字段表 (可为 None)。
    返回 {grade, confidence, reasons, evidence}。"""
    reasons: list[str] = list(annotations or [])
    evidence: dict = {}

    if status == "已作废":
        return {"grade": "已作废", "confidence": 1.0,
                "reasons": ["凭证已被登记方作废, 不进入分级判定"], "evidence": evidence}
    if status == "争议":
        reasons.append("该登记处于争议状态 (规范第 11 节)")

    cand_exact = cand["exact"]
    cand_phashes = cand["perceptual"]["phashes"]
    cand_sem_root = cand["semantic"]["root"]
    cand_text = cand["text"]
    cand_fields = cand["fields"]
    # 登记侧原文不进登记记录 (规范 §2); 由调用方以 reg["text"] 另行传入,
    # 缺失时按空文本处理 (相似度记不可用/0, 由其余证据定级)。
    reg_text = reg.get("text", "")

    exact = (reg["exact"]["sha256_root"] == cand_exact["sha256_root"]
             and reg["exact"]["sm3_root"] == cand_exact["sm3_root"])
    evidence["exact"] = exact
    reg_keys = {i["key"] for i in reg_audit["issues"]}
    cand_issues = cand_audit["issues"]

    if exact:
        reasons.append("精确双根 (SHA-256 与 SM3) 与登记完全一致, 原件未动")
        same = [i["msg"] for i in cand_issues if i["key"] in reg_keys]
        if same:
            reasons.append("注: 原文自带勾稽问题 (登记时即如此, 不改级): " + "; ".join(same))
        return {"grade": "甲级", "confidence": 0.99, "reasons": reasons, "evidence": evidence}

    # 字段比对 (规范 §6: 允许键尾 OCR 伪影对齐 — 键仅尾部数字不同
    # 且值相同者视为同键; 值不同绝不对齐, 防真篡改借对齐脱身)
    cand_fields = _align_ocr_keys(cand_fields, reg_fields) if reg_fields else cand_fields
    diffs: list[dict] = []
    fields_known = reg_fields is not None
    if fields_known:
        reg_aligned = _align_ocr_keys(reg_fields, cand_fields)
        for k in sorted(set(reg_aligned) | set(cand_fields), key=lambda x: x.encode("utf-8")):
            if reg_aligned.get(k) != cand_fields.get(k):
                diffs.append({"field": k, "registered": reg_aligned.get(k),
                              "candidate": cand_fields.get(k)})
    fields_changed = bool(diffs)
    roots_equal = reg["semantic_root"] == cand_sem_root
    # 规范 §6 (v1.3): 字段一项"无法核验"的两种情形 —
    #   (a) 登记方未出示字段表: 语义根经加盐, 无盐不可复算比对
    #       (v1.2 的"比根判丁级嫌疑"路径与加盐设计矛盾, 已删除);
    #   (b) 待验文件抽不出字段而登记侧有字段: 抽不出 != 被删改。
    # 无法核验时不判丁, 走感知判定, 命中乙级把握封顶 60%。
    empty_sem_root = fp.merkle_root("sha256", [])
    reg_has_fields = reg["semantic_root"] != empty_sem_root
    fields_unverifiable = (not fields_known) or (not cand_fields and reg_has_fields)
    evidence["field_diffs"] = diffs
    evidence["semantic_root_equal"] = roots_equal
    evidence["fields_unverifiable"] = fields_unverifiable

    if fields_known and fields_changed and not fields_unverifiable:
        reasons.append(f"关键字段被改动 {len(diffs)} 处 (见差异表)")
        return {"grade": "丁级", "confidence": 0.95, "reasons": reasons, "evidence": evidence}

    # 丙级 (相对基准: 只判登记后新增的 G1/G2 问题)
    new_issues = [i for i in cand_issues if i["key"] not in reg_keys]
    if new_issues:
        reasons.append("文件出现登记时没有的勾稽问题: "
                       + "; ".join(i["msg"] for i in new_issues))
        return {"grade": "丙级", "confidence": 0.85, "reasons": reasons, "evidence": evidence}

    # 感知层
    rp, cp = reg["phashes"], cand_phashes
    page_mismatch = len(rp) != len(cp)
    dist = None
    if rp and cp and not page_mismatch:
        dist = sum(fp.hamming_hex(a, b) for a, b in zip(rp, cp)) / len(rp)
    sim = fp.text_similarity(reg_text, cand_text)
    evidence["phash_mean_dist"] = dist
    evidence["text_sim"] = sim
    evidence["page_mismatch"] = page_mismatch
    perc_pass = (dist is not None and dist <= 8) or (sim is not None and sim >= 0.90)

    if perc_pass:
        base = 0.90 if (dist is not None and dist <= 4) or (sim is not None and sim >= 0.98) else 0.75
        caps = []
        if page_mismatch:
            caps.append(0.70)
            reasons.append("页数与登记不一致, 感知哈希不参与判定, 把握封顶 70%")
        if fields_unverifiable:
            caps.append(0.60)
            if not fields_known:
                reasons.append("登记方未出示字段表, 字段一项无法核验, 把握封顶 60%, 建议人工复核关键页")
            else:
                reasons.append("待验文件抽不出语义字段, 字段一项无法核验, 把握封顶 60%, 建议人工复核关键页")
        conf = min([base] + caps)
        reasons.append("字节已变, 但页面长相/文本与关键事实未变 — 载体变更, 内容等价")
        return {"grade": "乙级", "confidence": conf, "reasons": reasons, "evidence": evidence}

    reasons.append("三层证据不足以定级 (字段未变但感知层不通过, 或字段与感知均不可用), 按规范不下结论")
    return {"grade": "待人工复核", "confidence": 0.40, "reasons": reasons, "evidence": evidence}


def grade_standalone(cand_audit: dict) -> dict:
    if cand_audit["issues"]:
        return {"grade": "丙级", "confidence": 0.85,
                "reasons": ["未登记文件, 仅作勾稽审计: "
                            + "; ".join(i["msg"] for i in cand_audit["issues"])],
                "evidence": {}}
    return {"grade": "未登记", "confidence": 0.30,
            "reasons": ["该文件未登记, 勾稽未见异常 — 未登记 ≠ 真实"],
            "evidence": {}}
