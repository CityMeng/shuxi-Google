"""
数玺 · 演示样例确定性生成器 (vectors/gen_samples.py)
规范版本: 1.3
严格按第七部分规范生成 8 个虚构样例文件
"""

import os
import zlib
import struct
import random
from typing import Tuple, Dict

SAMPLE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples")
os.makedirs(SAMPLE_DIR, exist_ok=True)

# 1. report.txt
REPORT_TXT = """《2026年三季度经营报表》
报告单位：示例新能源有限公司
报告日期：2026年9月30日
产品销售收入 | 9000000
服务收入 | 3500000
合计 | 12500000
营业收入：12500000元
营业成本：8300000元
净利润：4200000元
"""

# 2. report_tampered.txt (仅净利润改为 5800000元)
REPORT_TAMPERED_TXT = """《2026年三季度经营报表》
报告单位：示例新能源有限公司
报告日期：2026年9月30日
产品销售收入 | 9000000
服务收入 | 3500000
合计 | 12500000
营业收入：12500000元
营业成本：8300000元
净利润：5800000元
"""

# 3. report_converted.txt (换行改 CRLF、净利润数字改全角、日期改为「2026 年 9 月 30 日」)
REPORT_CONVERTED_TXT = (
    "《2026年三季度经营报表》\r\n"
    "报告单位：示例新能源有限公司\r\n"
    "报告日期：2026 年 9 月 30 日\r\n"
    "产品销售收入 | 9000000\r\n"
    "服务收入 | 3500000\r\n"
    "合计 | 12500000\r\n"
    "营业收入：12500000元\r\n"
    "营业成本：8300000元\r\n"
    "净利润：４２０００００元\r\n"
)

# 4. fake.txt (远方机械制造有限公司，合计 13000000 与分项和 12500000 不符)
FAKE_TXT = """《2026年三季度经营报表》
报告单位：远方机械制造有限公司
报告日期：2026年9月30日
产品销售收入 | 9000000
服务收入 | 3500000
合计 | 13000000
营业收入：12500000元
营业成本：8300000元
净利润：4200000元
"""

# 5. contract_bad.txt (小写 500000元，大写 肆拾捌万陆仟元整 = 486000，G2 留痕)
CONTRACT_BAD_TXT = """《设备采购合同》
甲方：示例新能源有限公司
乙方：衡州仪器设备有限公司
合同金额：500000元
金额大写：肆拾捌万陆仟元整
签订日期：2026年9月15日
"""

# 7. big.bin (约 600 KB，恰跨 3 个分块，测试 256KB 分块与 Merkle)
BIG_BIN = bytes(range(256)) * 2343 + b"shuxi-tail"


def _create_pure_png(width: int, height: int, pixels_rgb: bytes) -> bytes:
    """生成合规的无依赖纯标准 PNG 文件"""
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    hdr = b'\x89PNG\r\n\x1a\n'
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    ihdr = chunk(b'IHDR', ihdr_data)

    # 扫描线添加过滤器字节 0
    raw = bytearray()
    row_bytes = width * 3
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        raw.extend(pixels_rgb[y * row_bytes : (y + 1) * row_bytes])

    compressed = zlib.compress(bytes(raw), level=6)
    idat = chunk(b'IDAT', compressed)
    iend = chunk(b'IEND', b'')
    return hdr + ihdr + idat + iend


def generate_scan_images() -> Tuple[bytes, bytes]:
    """
    生成 scan_a.png 与 scan_b.jpg (或感知等价图)
    内容包含 5 行合同文字：合同金额：486000元、签订日期：2026年9月15日等
    b 为 a 平移 2px + 固定随机种子噪点 2500 个
    """
    try:
        from PIL import Image, ImageDraw, ImageFont
        # 多路径候选字体
        font_candidates = [
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
            "/System/Library/Fonts/PingFang.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
        font = None
        for path in font_candidates:
            if os.path.exists(path):
                try:
                    font = ImageFont.truetype(path, 18)
                    break
                except Exception:
                    continue
        if font is None:
            font = ImageFont.load_default()

        # 生成 a 图
        img_a = Image.new("RGB", (400, 300), color=(255, 255, 255))
        draw_a = ImageDraw.Draw(img_a)
        lines = [
            "《设备采购合同附页》",
            "甲方：示例新能源有限公司",
            "乙方：衡州仪器设备有限公司",
            "合同金额：486000元",
            "签订日期：2026年9月15日"
        ]
        y_pos = 40
        for ln in lines:
            draw_a.text((30, y_pos), ln, fill=(20, 20, 20), font=font)
            y_pos += 45

        # 生成 b 图: a 平移 2px + 2500 个固定种子随机噪点
        img_b = Image.new("RGB", (400, 300), color=(255, 255, 255))
        img_b.paste(img_a, (2, 2))

        rng = random.Random(20260915)
        for _ in range(2500):
            x = rng.randint(0, 399)
            y = rng.randint(0, 299)
            noise_val = rng.randint(180, 230)
            img_b.putpixel((x, y), (noise_val, noise_val, noise_val))

        import io
        buf_a = io.BytesIO()
        img_a.save(buf_a, format="PNG")
        bytes_a = buf_a.getvalue()

        buf_b = io.BytesIO()
        img_b.save(buf_b, format="JPEG", quality=88)
        bytes_b = buf_b.getvalue()
        return bytes_a, bytes_b

    except Exception:
        # 纯 Python 兜底: 400x300 图像
        w, h = 400, 300
        # 基础白底并在固定位置绘制深色像素行代表文本
        base_pixels = bytearray([255] * (w * h * 3))
        # 模拟绘制 5 组黑线文本块
        for line_idx in range(5):
            top_y = 40 + line_idx * 45
            for y in range(top_y, top_y + 16):
                for x in range(30, 280):
                    if (x + y) % 5 in (0, 1):
                        idx = (y * w + x) * 3
                        base_pixels[idx] = 20
                        base_pixels[idx+1] = 20
                        base_pixels[idx+2] = 20

        bytes_a = _create_pure_png(w, h, bytes(base_pixels))

        # b 复制并平移 2px + 2500 个噪点
        b_pixels = bytearray([255] * (w * h * 3))
        for y in range(h - 2):
            for x in range(w - 2):
                src_idx = (y * w + x) * 3
                dst_idx = ((y + 2) * w + (x + 2)) * 3
                b_pixels[dst_idx] = base_pixels[src_idx]
                b_pixels[dst_idx+1] = base_pixels[src_idx+1]
                b_pixels[dst_idx+2] = base_pixels[src_idx+2]

        rng = random.Random(20260915)
        for _ in range(2500):
            x = rng.randint(0, w - 1)
            y = rng.randint(0, h - 1)
            noise_val = rng.randint(180, 230)
            idx = (y * w + x) * 3
            b_pixels[idx] = noise_val
            b_pixels[idx+1] = noise_val
            b_pixels[idx+2] = noise_val

        bytes_b = _create_pure_png(w, h, bytes(b_pixels))
        return bytes_a, bytes_b


def generate_all_samples(out_dir: str = SAMPLE_DIR) -> Dict[str, bytes]:
    """生成 8 个确定性样例并落盘"""
    os.makedirs(out_dir, exist_ok=True)
    scan_a, scan_b = generate_scan_images()

    samples = {
        "report.txt": REPORT_TXT.encode('utf-8'),
        "report_tampered.txt": REPORT_TAMPERED_TXT.encode('utf-8'),
        "report_converted.txt": REPORT_CONVERTED_TXT.encode('utf-8'),
        "fake.txt": FAKE_TXT.encode('utf-8'),
        "contract_bad.txt": CONTRACT_BAD_TXT.encode('utf-8'),
        "scan_a.png": scan_a,
        "scan_b.jpg": scan_b,
        "big.bin": BIG_BIN
    }

    for name, data in samples.items():
        path = os.path.join(out_dir, name)
        with open(path, 'wb') as f:
            f.write(data)

    return samples


if __name__ == "__main__":
    s = generate_all_samples()
    print(f"成功生成全部 {len(s)} 个规范样例文件于 {SAMPLE_DIR}")
