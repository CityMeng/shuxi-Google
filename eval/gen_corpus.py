# -*- coding: utf-8 -*-
"""
数玺评测语料生成器 (corpus-v1, 全部虚构, 确定性种子)。

生成 36 个基础文档 (24 报表 + 12 合同) 与约 300 个变异用例;
真值 (期望等级) 写入 answer_key.json 并立即记录其 SHA-256 到
key_hash.txt — 盲测协议: 评分前先落盘预测, 再拆封对照。
"""
import hashlib
import io
import json
import os
import random

BASE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.join(BASE, "corpus")
os.makedirs(CORPUS, exist_ok=True)

COMPANIES = ["示例新能源", "衡州仪器", "湘江物流", "云岭农业科技", "星城半导体",
             "沅水生物医药", "麓山新材料", "潇湘智能装备", "洞庭水产开发", "武陵山茶业",
             "雁城轨道交通", "株洲陶瓷集团", "湘潭电机", "岳阳化工", "常德食品",
             "郴州矿业服务", "永州电子", "怀化木业", "娄底钢铁贸易", "益阳纺织",
             "邵阳印刷", "张家界旅游服务", "湘西药材", "长沙软件园运营"]
CN_BIG = [(100000, "壹拾万元整"), (250000, "贰拾伍万元整"), (486000, "肆拾捌万陆仟元整"),
          (500000, "伍拾万元整"), (720000, "柒拾贰万元整"), (880000, "捌拾捌万元整"),
          (960000, "玖拾陆万元整"), (1200000, "壹佰贰拾万元整"),
          (1500000, "壹佰伍拾万元整"), (2000000, "贰佰万元整"),
          (360000, "叁拾陆万元整"), (640000, "陆拾肆万元整")]


def report_text(rng, company, idx):
    a = rng.randrange(500, 1500) * 10000
    b = rng.randrange(100, 600) * 10000
    cost = rng.randrange(300, 900) * 10000
    total = a + b
    profit = total - cost
    month = 3 + (idx % 3) * 3
    return (f"2026年{month}月经营报表\n"
            f"报告单位：{company}有限公司\n"
            f"报告日期：2026年{month}月{28}日\n"
            f"产品销售收入 | {a}\n"
            f"服务收入 | {b}\n"
            f"合计 | {total}\n"
            f"营业收入：{total}元\n"
            f"营业成本：{cost}元\n"
            f"净利润：{profit}元\n")


def contract_text(company, amount, big, idx):
    return (f"设备采购合同\n"
            f"甲方：{company}有限公司\n"
            f"乙方：衡州仪器设备有限公司\n"
            f"合同金额：{amount}元\n"
            f"金额大写：{big}\n"
            f"签订日期：2026年9月{10 + idx}日\n")


def to_pdf_bytes(text):
    import fitz
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    y = 72
    for line in text.splitlines():
        page.insert_text((56, y), line, fontsize=12, fontname="china-s")
        y += 26
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def to_docx_bytes(text):
    import docx
    d = docx.Document()
    for line in text.splitlines():
        d.add_paragraph(line)
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def to_scan_jpg(text, seed):
    import fitz
    from PIL import Image
    pdf = to_pdf_bytes(text)
    doc = fitz.open(stream=pdf, filetype="pdf")
    pix = doc[0].get_pixmap(dpi=150)
    img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
    out = Image.new("RGB", img.size, "white")
    out.paste(img, (3, 2))
    rnd = random.Random(seed)
    px = out.load()
    for _ in range(6000):
        x, y = rnd.randrange(out.width), rnd.randrange(out.height)
        g = rnd.randrange(120, 210)
        px[x, y] = (g, g, g)
    buf = io.BytesIO()
    out.save(buf, format="JPEG", quality=86)
    return buf.getvalue()


def main():
    rng = random.Random(20261022)
    cases, key, bases = [], {}, {}

    def add_case(base_id, mutation, filename, data, expected, cls):
        path = os.path.join(CORPUS, filename)
        with open(path, "wb") as f:
            f.write(data)
        cid = f"{base_id}-{mutation}"
        cases.append({"case_id": cid, "base": base_id, "mutation": mutation,
                      "file": filename})
        key[cid] = {"expected": expected, "class": cls}

    def save_base(base_id, filename, text):
        path = os.path.join(CORPUS, filename)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        bases[base_id] = {"file": filename, "text": text}

    report_ids = []
    for i, comp_name in enumerate(COMPANIES):
        bid = f"R{i + 1:02d}"
        report_ids.append(bid)
        text = report_text(rng, comp_name, i)
        save_base(bid, f"{bid}.txt", text)
        enc = text.encode()
        add_case(bid, "identity", f"{bid}-identity.txt", enc, ["甲级"], "identity")
        # 篡改净利润 (+1370000)
        lines = text.splitlines()
        for j, ln in enumerate(lines):
            if ln.startswith("净利润："):
                v = int(ln.split("：")[1].rstrip("元"))
                lines[j] = f"净利润：{v + 1370000}元"
        add_case(bid, "tamper_profit", f"{bid}-tamper_profit.txt",
                 "\n".join(lines).encode(), ["丁级"], "tampered")
        # 篡改日期
        t2 = text.replace("报告日期：2026年", "报告日期：2025年", 1)
        add_case(bid, "tamper_date", f"{bid}-tamper_date.txt",
                 t2.encode(), ["丁级"], "tampered")
        # 删除净利润行
        t3 = "\n".join(ln for ln in text.splitlines() if not ln.startswith("净利润"))
        add_case(bid, "delete_field", f"{bid}-delete_field.txt",
                 t3.encode(), ["丁级"], "tampered")
        # 转格式等价: CRLF + 全角冒号/数字 + 日期空格
        t4 = text.replace("\n", "\r\n").replace("净利润：", "净利润：")
        for j, ln in enumerate(t4.split("\r\n")):
            if ln.startswith("净利润"):
                num = ln.split("：")[1]
                t4 = t4.replace(ln, "净利润：" + "".join(
                    chr(0xFF10 + int(ch)) if ch.isdigit() else ch for ch in num))
        add_case(bid, "convert_ws", f"{bid}-convert_ws.txt",
                 t4.encode(), ["乙级"], "equivalent")
        # 行序调换 (内容等价)
        ls = text.splitlines()
        ls[3], ls[4] = ls[4], ls[3]
        add_case(bid, "reorder", f"{bid}-reorder.txt",
                 "\n".join(ls).encode(), ["乙级"], "equivalent")
        # txt -> pdf (同内容)
        add_case(bid, "to_pdf", f"{bid}-to_pdf.pdf",
                 to_pdf_bytes(text), ["乙级"], "equivalent")
        # 无关文档 (下一家的原件)
        nxt = COMPANIES[(i + 1) % len(COMPANIES)]
        other = report_text(random.Random(9000 + i), nxt, i + 1)
        add_case(bid, "unrelated", f"{bid}-unrelated.txt",
                 other.encode(), ["丁级"], "unrelated")
        if i < 12:
            add_case(bid, "scan", f"{bid}-scan.jpg",
                     to_scan_jpg(text, 500 + i), ["乙级"], "equivalent")
            add_case(bid, "pdf_add_page", f"{bid}-pdf_add_page.pdf",
                     _pdf_add_blank(to_pdf_bytes(text)), ["乙级"], "equivalent")
            add_case(bid, "bom", f"{bid}-bom.txt",
                     b"\xef\xbb\xbf" + enc, ["乙级"], "equivalent")
        if i < 8:
            add_case(bid, "to_docx", f"{bid}-to_docx.docx",
                     to_docx_bytes(text), ["乙级"], "equivalent")

    for i, (amount, big) in enumerate(CN_BIG):
        bid = f"C{i + 1:02d}"
        text = contract_text(COMPANIES[i], amount, big, i)
        save_base(bid, f"{bid}.txt", text)
        add_case(bid, "identity", f"{bid}-identity.txt",
                 text.encode(), ["甲级"], "identity")
        # 改大写一字 -> 勾稽 G2 新问题 -> 丙 (字段不变)
        _rot = {"壹": "贰", "贰": "叁", "叁": "肆", "肆": "伍", "伍": "陆",
                "陆": "柒", "柒": "捌", "捌": "玖", "玖": "壹", "拾": "玖"}
        bad_big = _rot[big[0]] + big[1:]
        assert bad_big != big
        add_case(bid, "tamper_big", f"{bid}-tamper_big.txt",
                 text.replace(big, bad_big).encode(), ["丙级"], "inconsistent")
        # 改小写金额 -> 字段被改 -> 丁
        add_case(bid, "tamper_small", f"{bid}-tamper_small.txt",
                 text.replace(f"合同金额：{amount}元",
                              f"合同金额：{amount + 10000}元").encode(),
                 ["丁级"], "tampered")
        t4 = text.replace("\n", "\r\n")
        add_case(bid, "convert_ws", f"{bid}-convert_ws.txt",
                 t4.encode(), ["乙级"], "equivalent")
        add_case(bid, "to_pdf", f"{bid}-to_pdf.pdf",
                 to_pdf_bytes(text), ["乙级"], "equivalent")
        add_case(bid, "scan", f"{bid}-scan.jpg",
                 to_scan_jpg(text, 700 + i), ["乙级"], "equivalent")

    manifest = {"corpus": "corpus-v1", "bases": {k: v["file"] for k, v in bases.items()},
                "cases": cases}
    with open(os.path.join(BASE, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    key_bytes = json.dumps(key, ensure_ascii=False, indent=1).encode()
    with open(os.path.join(BASE, "answer_key.json"), "wb") as f:
        f.write(key_bytes)
    with open(os.path.join(BASE, "key_hash.txt"), "w") as f:
        f.write(hashlib.sha256(key_bytes).hexdigest())
    print(f"bases={len(bases)} cases={len(cases)} "
          f"key_sha256={hashlib.sha256(key_bytes).hexdigest()[:16]}")


def _pdf_add_blank(pdf_bytes):
    import fitz
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    doc.new_page(width=595, height=842)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


if __name__ == "__main__":
    main()
