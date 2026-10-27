# -*- coding: utf-8 -*-
"""确定性生成测试向量样本 (虚构数据)。重复运行结果完全一致。"""
import hashlib
import os
import random

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples")
os.makedirs(BASE, exist_ok=True)

REPORT = """2026年三季度经营报表
报告单位：示例新能源有限公司
报告日期：2026年9月30日
产品销售收入 | 9000000
服务收入 | 3500000
合计 | 12500000
营业收入：12500000元
营业成本：8300000元
净利润：4200000元
"""

TAMPERED = REPORT.replace("净利润：4200000元", "净利润：5800000元")

# 转格式等价件: CRLF + 全角冒号 + 全角数字 (NFKC 后与原件等价)
CONVERTED = (REPORT.replace("：", "：").replace("\n", "\r\n")
             .replace("净利润：4200000元", "净利润：４２０００００元")
             .replace("报告日期：2026年9月30日", "报告日期：2026 年 9 月 30 日"))

FAKE = """2026年三季度经营报表
报告单位：远方机械制造有限公司
报告日期：2026年9月30日
产品销售收入 | 9000000
服务收入 | 3500000
合计 | 13000000
营业收入：12500000元
营业成本：8300000元
净利润：4200000元
"""

CONTRACT_BAD = """设备采购合同
甲方：示例新能源有限公司
乙方：衡州仪器设备有限公司
合同金额：500000元
金额大写：肆拾捌万陆仟元整
签订日期：2026年9月15日
"""


def _write(name: str, content):
    mode = "wb" if isinstance(content, bytes) else "w"
    with open(os.path.join(BASE, name), mode, encoding=None if mode == "wb" else "utf-8") as f:
        f.write(content)


_FONT_CANDIDATES = (
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)


def _load_font(size: int):
    """按环境候选路径解析字体 (云端靠 packages.txt 的 fonts-noto-cjk 提供
    第一条路径); 全落空时退回 PIL 内置字体, 绝不因字体缺失崩溃。"""
    from PIL import ImageFont
    for path in _FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def _scans():
    scan_a = os.path.join(BASE, "scan_a.png")
    scan_b = os.path.join(BASE, "scan_b.jpg")
    if os.path.exists(scan_a) and os.path.exists(scan_b):
        return
    try:
        from PIL import Image, ImageDraw
        font = _load_font(30)
        img = Image.new("RGB", (900, 620), "white")
        d = ImageDraw.Draw(img)
        lines = ["设备采购合同", "甲方：示例新能源有限公司", "乙方：衡州仪器设备有限公司",
                 "合同金额：486000元", "签订日期：2026年9月15日"]
        y = 60
        for ln in lines:
            d.text((70, y), ln, fill="black", font=font)
            y += 100
        img.save(scan_a)
        # 扫描模拟: 平移 2px + 固定随机噪点 + JPEG 压一遍再转回
        b = Image.new("RGB", (900, 620), "white")
        b.paste(img, (2, 1))
        rnd = random.Random(42)
        px = b.load()
        for _ in range(2500):
            x, y2 = rnd.randrange(900), rnd.randrange(620)
            g = rnd.randrange(110, 200)
            px[x, y2] = (g, g, g)
        b.save(scan_b, quality=88)
    except Exception:
        pass


def main():
    _write("report.txt", REPORT)
    _write("report_tampered.txt", TAMPERED)
    _write("report_converted.txt", CONVERTED)
    _write("fake.txt", FAKE)
    _write("contract_bad.txt", CONTRACT_BAD)
    _write("big.bin", bytes(range(256)) * 2343 + b"shuxi-tail")  # ~600KB, 3 个分块
    _scans()
    out = {}
    for n in sorted(os.listdir(BASE)):
        with open(os.path.join(BASE, n), "rb") as f:
            out[n] = hashlib.sha256(f.read()).hexdigest()
    return out


if __name__ == "__main__":
    for k, v in main().items():
        print(k, v[:16])
