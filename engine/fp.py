"""
数玺 · 三层指纹引擎 (engine/fp.py)
规范版本: 1.3
套件标识: SXA1
包含:
1. 精确层指纹 (256KB分块、双Merkle树、SHA-256 + SM3、域分隔)
2. 感知层指纹 (pHash 63个AC系数均值、文本3-gram Jaccard相似度)
3. 语义层指纹 (字段抽取、规范化、加盐Merkle树、选择性披露证明)
"""

import os
import re
import math
import unicodedata
import hashlib
from typing import List, Dict, Any, Tuple, Optional

SPEC_VERSION = "1.3"
SUITE_ID = "SXA1"
CHUNK_SIZE = 256 * 1024  # 256 KB
MAX_PERCEPTUAL_PAGES = 512
MAX_FILE_SIZE = 500 * 1024 * 1024  # 500 MB (SX-E04)


# ==========================================================
# 密码学基础设施: SM3 国密标准实现 (GM/T 0004-2012)
# ==========================================================
def _sm3_rotl(x: int, n: int) -> int:
    return ((x << n) | (x >> (32 - n))) & 0xFFFFFFFF

def _sm3_ff(j: int, x: int, y: int, z: int) -> int:
    if 0 <= j <= 15:
        return x ^ y ^ z
    return (x & y) | (x & z) | (y & z)

def _sm3_gg(j: int, x: int, y: int, z: int) -> int:
    if 0 <= j <= 15:
        return x ^ y ^ z
    return (x & y) | ((~x) & z)

def _sm3_p0(x: int) -> int:
    return x ^ _sm3_rotl(x, 9) ^ _sm3_rotl(x, 17)

def _sm3_p1(x: int) -> int:
    return x ^ _sm3_rotl(x, 15) ^ _sm3_rotl(x, 23)

def sm3_hash(data: bytes) -> str:
    """计算字节串的标准 SM3 哈希 (64字符十六进制)"""
    length = len(data) * 8
    pad = bytearray(data)
    pad.append(0x80)
    while (len(pad) % 64) != 56:
        pad.append(0x00)
    pad.extend(length.to_bytes(8, byteorder='big'))

    v = [
        0x7380166F, 0x4914B2B9, 0x172442D7, 0xDA8A0600,
        0xA96F30BC, 0x163138AA, 0xE38DEE4D, 0xB0FB0E4E
    ]

    for b in range(0, len(pad), 64):
        chunk = pad[b:b+64]
        w = [int.from_bytes(chunk[i*4:(i+1)*4], byteorder='big') for i in range(16)]
        for j in range(16, 68):
            w.append(_sm3_p1(w[j-16] ^ w[j-9] ^ _sm3_rotl(w[j-3], 15)) ^ _sm3_rotl(w[j-13], 7) ^ w[j-6])
        w1 = [w[j] ^ w[j+4] for j in range(64)]

        a, b_reg, c, d, e, f, g, h = v
        for j in range(64):
            t = 0x79CC4519 if j < 16 else 0x7A879D8A
            ss1 = _sm3_rotl((_sm3_rotl(a, 12) + e + _sm3_rotl(t, j % 32)) & 0xFFFFFFFF, 7)
            ss2 = ss1 ^ _sm3_rotl(a, 12)
            tt1 = (_sm3_ff(j, a, b_reg, c) + d + ss2 + w1[j]) & 0xFFFFFFFF
            tt2 = (_sm3_gg(j, e, f, g) + h + ss1 + w[j]) & 0xFFFFFFFF
            d = c
            c = _sm3_rotl(b_reg, 9)
            b_reg = a
            a = tt1
            h = g
            g = _sm3_rotl(f, 19)
            f = e
            e = _sm3_p0(tt2)

        v = [
            (v[0] ^ a) & 0xFFFFFFFF, (v[1] ^ b_reg) & 0xFFFFFFFF,
            (v[2] ^ c) & 0xFFFFFFFF, (v[3] ^ d) & 0xFFFFFFFF,
            (v[4] ^ e) & 0xFFFFFFFF, (v[5] ^ f) & 0xFFFFFFFF,
            (v[6] ^ g) & 0xFFFFFFFF, (v[7] ^ h) & 0xFFFFFFFF
        ]

    return ''.join(f"{x:08x}" for x in v)


def sha256_hash(data: bytes) -> str:
    """计算 SHA-256 哈希"""
    return hashlib.sha256(data).hexdigest()


# ==========================================================
# 5.2 第一层 · 精确指纹
# ==========================================================
def build_merkle_tree(leaf_payloads: List[bytes], algo: str = "sha256") -> Tuple[str, List[List[str]]]:
    """
    按协议 5.2 规则构建 Merkle 树:
    - 叶子节点: Hash(0x00 || payload)
    - 内部节点: Hash(0x01 || left_hash || right_hash)
    - 奇数节点: 复制尾节点补齐
    - 空树根: Hash(0x00 || b"")
    """
    hash_fn = sha256_hash if algo == "sha256" else sm3_hash

    if not leaf_payloads:
        # 空树根 = 对空字节串按叶子规则计算的哈希
        empty_root = hash_fn(b"\x00")
        return empty_root, [[empty_root]]

    # 1. 计算所有叶子哈希 (0x00 域分隔)
    leaves = [hash_fn(b"\x00" + p) for p in leaf_payloads]
    levels = [leaves]

    current = leaves
    while len(current) > 1:
        if len(current) % 2 != 0:
            current = list(current) + [current[-1]]
        next_level = []
        for i in range(0, len(current), 2):
            left_bytes = bytes.fromhex(current[i])
            right_bytes = bytes.fromhex(current[i+1])
            parent = hash_fn(b"\x01" + left_bytes + right_bytes)
            next_level.append(parent)
        levels.append(next_level)
        current = next_level

    return current[0], levels


def compute_exact_fingerprint(data: bytes) -> Dict[str, Any]:
    """
    分块 (256 KB) 并计算 SHA-256 与 SM3 双 Merkle 树及根。
    异常处理:
    - 0 字节: 抛出协议错误 SX-E01
    - > 500 MB: 抛出协议错误 SX-E04
    """
    if len(data) == 0:
        raise ValueError("SX-E01: 0 字节文件拒收")
    if len(data) > MAX_FILE_SIZE:
        raise ValueError("SX-E04: 超过 500 MB 拒收")

    chunks = []
    for i in range(0, len(data), CHUNK_SIZE):
        chunks.append(data[i:i + CHUNK_SIZE])

    sha256_root, _ = build_merkle_tree(chunks, algo="sha256")
    sm3_root, _ = build_merkle_tree(chunks, algo="sm3")

    return {
        "chunk_count": len(chunks),
        "chunk_size": CHUNK_SIZE,
        "total_bytes": len(data),
        "sha256_root": sha256_root,
        "sm3_root": sm3_root,
        "exact_dual_root": {
            "sha256": sha256_root,
            "sm3": sm3_root
        }
    }


# ==========================================================
# 5.3 第二层 · 感知指纹 (pHash & 文本 3-gram)
# ==========================================================
def _dct_1d(vec: List[float]) -> List[float]:
    N = len(vec)
    res = [0.0] * N
    factor = math.pi / (2.0 * N)
    for k in range(N):
        s = 0.0
        for n in range(N):
            s += vec[n] * math.cos((2 * n + 1) * k * factor)
        c = math.sqrt(1.0 / N) if k == 0 else math.sqrt(2.0 / N)
        res[k] = s * c
    return res

def _dct_2d(matrix: List[List[float]]) -> List[List[float]]:
    # 行变换
    row_transformed = [_dct_1d(row) for row in matrix]
    # 列变换
    rows, cols = len(matrix), len(matrix[0])
    transposed = [[row_transformed[r][c] for r in range(rows)] for c in range(cols)]
    col_transformed = [_dct_1d(col) for col in transposed]
    final = [[col_transformed[c][r] for c in range(cols)] for r in range(rows)]
    return final

def compute_phash_from_pixels_32x32(gray_32x32: List[List[float]]) -> str:
    """
    按协议 5.3 计算 pHash:
    - 32x32 灰度矩阵
    - 二维 DCT
    - 取左上 8x8 低频系数
    - 均值只取除直流分量外的 63 个交流系数 (排除 [0,0])
    - 系数 > 均值 记 1, 否则 0 (得到 64 位)
    - 输出 16 位十六进制字符串
    """
    dct = _dct_2d(gray_32x32)
    # 取左上 8x8
    sub = [[dct[r][c] for c in range(8)] for r in range(8)]
    # 计算 63 个 AC 系数均值 (排除 sub[0][0])
    ac_sum = 0.0
    for r in range(8):
        for c in range(8):
            if r == 0 and c == 0:
                continue
            ac_sum += sub[r][c]
    ac_mean = ac_sum / 63.0

    bits = 0
    for r in range(8):
        for c in range(8):
            bit = 1 if sub[r][c] > ac_mean else 0
            bits = (bits << 1) | bit

    return f"{bits:016x}"


def hamming_distance(hex1: str, hex2: str) -> int:
    """计算两个 16 进制 64-bit 哈希的汉明距离"""
    try:
        v1 = int(hex1, 16)
        v2 = int(hex2, 16)
        xor_val = v1 ^ v2
        return bin(xor_val).count('1')
    except Exception:
        return 64


def compute_text_similarity(t1: str, t2: str) -> Tuple[Optional[float], str]:
    """
    按协议 5.3 计算文本相似度:
    - 抽取文本后去空白
    - 全角转半角 (NFKC)
    - 英文转小写
    - 字符 3-gram 集合的 Jaccard 系数
    - 一侧为空集记 0，两侧均空记「不可用」
    """
    def clean(t: str) -> str:
        t = unicodedata.normalize('NFKC', t)
        t = re.sub(r'\s+', '', t)
        return t.lower()

    c1, c2 = clean(t1), clean(t2)
    if not c1 and not c2:
        return None, "不可用"
    if not c1 or not c2:
        return 0.0, "0.0000"

    def get_3grams(s: str) -> set:
        if len(s) < 3:
            return {s}
        return {s[i:i+3] for i in range(len(s) - 2)}

    g1, g2 = get_3grams(c1), get_3grams(c2)
    intersection = len(g1 & g2)
    union = len(g1 | g2)
    if union == 0:
        return 0.0, "0.0000"
    sim = intersection / union
    return sim, f"{sim:.4f}"


# ==========================================================
# 5.4 第三层 · 语义指纹 (抽取、规范化、盐与Merkle树)
# ==========================================================
# 中文大写数字映射
CN_NUMS = {
    '零': 0, '壹': 1, '贰': 2, '叁': 3, '肆': 4,
    '伍': 5, '陆': 6, '柒': 7, '捌': 8, '玖': 9
}
CN_UNITS = {
    '拾': 10, '佰': 100, '仟': 1000, '万': 10000, '亿': 100000000
}

def parse_cn_amount(cn_str: str) -> Optional[float]:
    """将中文大写金额转换为数值（支持 拾佰仟万亿、角分、整）"""
    s = cn_str.strip().replace('元', '').replace('圆', '').replace('整', '').replace('正', '')
    if not s:
        return None

    # 分离元和角分
    jiao_fen = 0.0
    if '角' in s or '分' in s:
        m = re.search(r'(?:(.*?)角)?(?:(.*?)分)?$', s)
        # 精细化切分角分
        parts = re.split(r'([角分])', s)
        # 简单模式抽取
        jiao_match = re.search(r'([零壹贰叁肆伍陆柒捌玖])角', s)
        fen_match = re.search(r'([零壹贰叁肆伍陆柒捌玖])分', s)
        if jiao_match:
            jiao_fen += CN_NUMS.get(jiao_match.group(1), 0) * 0.1
        if fen_match:
            jiao_fen += CN_NUMS.get(fen_match.group(1), 0) * 0.01
        s = re.sub(r'[零壹贰叁肆伍陆柒捌玖]角|[零壹贰叁肆伍陆柒捌玖]分', '', s)

    if not s:
        return round(jiao_fen, 2)

    def parse_section(sec_str: str) -> int:
        total = 0
        r = 0
        for char in sec_str:
            if char in CN_NUMS:
                r = CN_NUMS[char]
            elif char in CN_UNITS:
                unit = CN_UNITS[char]
                if r == 0:
                    r = 1
                total += r * unit
                r = 0
        total += r
        return total

    # 分割亿和万
    total = 0
    if '亿' in s:
        yi_parts = s.split('亿')
        total += parse_section(yi_parts[0]) * 100000000
        s = yi_parts[1]
    if '万' in s:
        wan_parts = s.split('万')
        total += parse_section(wan_parts[0]) * 10000
        s = wan_parts[1]
    total += parse_section(s)
    return round(float(total) + jiao_fen, 2)


def normalize_amount_string(val_str: str) -> str:
    """
    金额规范化 (5.4):
    - 去逗号与货币符号
    - 「万元」「亿元」统一换算为元
    - 点号千分位消歧: 形如 1.200.000 (点号后恰3位成组) 去除点号
    - 负号保留
    - 小数归一 (如 12.50 -> 12.5, 500000.00 -> 500000)
    - 百分数同理归一 (12.50% -> 12.5%)
    """
    s = val_str.strip()
    s = re.sub(r'[¥$￥元]', '', s)
    s = unicodedata.normalize('NFKC', s)

    is_percent = False
    if s.endswith('%'):
        is_percent = True
        s = s[:-1].strip()

    is_negative = s.startswith('-')
    if is_negative:
        s = s[1:].strip()

    # 点号千分位消歧: 形如 1.200.000 (至少两个分段且不以0开头，或千分位点号如 1.200.000)
    # 0.500 或 0.123 属于小数，非千分位
    if re.match(r'^[1-9]\d{0,2}(\.\d{3}){2,}$', s) or (re.match(r'^[1-9]\d{0,2}\.\d{3}$', s) and not is_percent and float(s.replace('.', '')) >= 1000):
        # 检查是否为 1.200.000
        if s.count('.') >= 2:
            s = s.replace('.', '')
        elif re.match(r'^[1-9]\d{0,2}\.\d{3}$', s) and '.' in val_str and ',' not in val_str:
            # 只有当后面不是百分数，且明确是金额千分位场景
            if any(term in val_str for term in ['元', '¥', '$', '￥']):
                s = s.replace('.', '')
    else:
        # 去普通逗号
        s = s.replace(',', '')

    # 万元 / 亿元换算
    multiplier = 1.0
    if '万' in s:
        s = s.replace('万', '')
        multiplier = 10000.0
    elif '亿' in s:
        s = s.replace('亿', '')
        multiplier = 100000000.0

    try:
        num = float(s) * multiplier
        if is_negative:
            num = -num
        # 归一化格式: 整数显示为整数，小数去除末尾多余0
        if num.is_integer():
            res = str(int(num))
        else:
            res = f"{num:.6f}".rstrip('0').rstrip('.')
        if is_percent:
            return f"{res}%"
        return res
    except ValueError:
        return val_str.strip()


def normalize_date_string(date_str: str) -> Optional[str]:
    """
    日期规范化 (5.4):
    - 统一 YYYY-MM-DD
    - 必须为真实日历日期 (如 2026-02-31 非法)
    - 修复空格拆散的日期 (如 2026 年 9 月 30 日)
    """
    s = unicodedata.normalize('NFKC', date_str).strip()
    s = re.sub(r'\s+', '', s)

    # 匹配各类格式
    m = re.search(r'(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?', s)
    if not m:
        return None
    y, m_val, d = int(m.group(1)), int(m.group(2)), int(m.group(3))

    # 真实日历校验
    if m_val < 1 or m_val > 12 or d < 1 or d > 31:
        return None
    days_in_month = [31, 29 if (y % 4 == 0 and y % 100 != 0) or (y % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if d > days_in_month[m_val - 1]:
        return None

    return f"{y:04d}-{m_val:02d}-{d:02d}"


def normalize_text_field(text_str: str) -> str:
    """去首尾空白，内部空白压为一格"""
    s = unicodedata.normalize('NFKC', text_str).strip()
    return re.sub(r'\s+', ' ', s)


def extract_and_normalize_fields(text: str) -> List[Tuple[str, str]]:
    """
    从文本中抽取带标签字段 (主体类/金额类/日期类/表格标签行)
    支持:
    - 分隔符混淆归一 (丨、｜ -> |)
    - 跨行键值合并
    - 重名字段出现顺序编号 (合计, 合计#2...)
    - 字典按 UTF-8 字节序排列
    """
    normalized_text = text.replace('丨', '|').replace('｜', '|')
    lines = [ln.strip() for ln in normalized_text.splitlines() if ln.strip()]

    raw_pairs: List[Tuple[str, str]] = []

    i = 0
    while i < len(lines):
        line = lines[i]
        # 表格行识别: 标签 | 数值
        if '|' in line:
            parts = [p.strip() for p in line.split('|')]
            if len(parts) >= 2 and parts[0]:
                raw_pairs.append((parts[0], parts[1]))
            i += 1
            continue

        # 冒号键值对识别: 键：值 或 键: 值
        colon_match = re.match(r'^([^:：\s]+)\s*[:：]\s*(.*)$', line)
        if colon_match:
            k = colon_match.group(1).strip()
            v = colon_match.group(2).strip()
            if not v and i + 1 < len(lines):
                # 跨行合并: 标签独占一行，数值在次行
                next_line = lines[i+1]
                if not re.search(r'[:：|]', next_line):
                    v = next_line
                    i += 1
            if k:
                raw_pairs.append((k, v))
            i += 1
            continue

        # 针对常见标题/字段的无冒号匹配 (如 报告单位 示例新能源有限公司 或 报告单位\n示例新能源有限公司)
        known_prefix = re.match(r'^(报告单位|报告日期|甲方|乙方|合同金额|金额大写|营业收入|营业成本|净利润|签订日期)\s*(.*)$', line)
        if known_prefix:
            k = known_prefix.group(1).strip()
            v = known_prefix.group(2).strip()
            if not v and i + 1 < len(lines):
                next_line = lines[i+1]
                if not re.search(r'[:：|]', next_line):
                    v = next_line
                    i += 1
            if k and v:
                raw_pairs.append((k, v))
            i += 1
            continue

        i += 1

    # 规范化值
    name_counts: Dict[str, int] = {}
    normalized_fields: List[Tuple[str, str]] = []

    for raw_k, raw_v in raw_pairs:
        k = normalize_text_field(raw_k)
        # 判断类型规范化
        norm_v = raw_v
        if any(w in k for w in ['日期', '时间', '签订日', '报告日']):
            parsed_date = normalize_date_string(raw_v)
            if parsed_date:
                norm_v = parsed_date
        elif any(w in k for w in ['金额', '收入', '成本', '利润', '合计', '价款', '数值']) and not '大写' in k:
            norm_v = normalize_amount_string(raw_v)
        else:
            norm_v = normalize_text_field(raw_v)

        # 重名字段编号
        if k in name_counts:
            name_counts[k] += 1
            final_k = f"{k}#{name_counts[k]}"
        else:
            name_counts[k] = 1
            final_k = k

        normalized_fields.append((final_k, norm_v))

    # 按键名 UTF-8 字节序排列
    normalized_fields.sort(key=lambda item: item[0].encode('utf-8'))
    return normalized_fields


def build_semantic_merkle_tree(fields: List[Tuple[str, str]], salts: Optional[List[str]] = None) -> Tuple[str, List[str], List[List[str]]]:
    """
    按协议 5.4 构建语义 Merkle 树:
    - 每个字段独立 >= 128 位随机盐 (hex 32字符)
    - 叶子 = SHA-256(0x00 || salt.encode() || (f"{k}={v}").encode('utf-8'))
    - 按 5.2 规则建树
    返回: (semantic_root, salts, tree_levels)
    """
    if not fields:
        empty_root = sha256_hash(b"\x00")
        return empty_root, [], [[empty_root]]

    if salts is None or len(salts) != len(fields):
        salts = [os.urandom(16).hex() for _ in fields]

    leaf_payloads = []
    for (k, v), salt in zip(fields, salts):
        entry_str = f"{k}={v}"
        leaf_payload = salt.encode('utf-8') + entry_str.encode('utf-8')
        leaf_payloads.append(leaf_payload)

    root, levels = build_merkle_tree(leaf_payloads, algo="sha256")
    return root, salts, levels


def generate_selective_disclosure_proof(field_index: int, fields: List[Tuple[str, str]], salts: List[str], levels: List[List[str]]) -> Dict[str, Any]:
    """
    生成选择性披露证明 (5.4 规则 6):
    包含字段值、该字段盐、Merkle 路径。
    """
    k, v = fields[field_index]
    salt = salts[field_index]

    path = []
    curr_idx = field_index
    for level_idx in range(len(levels) - 1):
        level = levels[level_idx]
        is_odd = (len(level) % 2 != 0)
        padded_level = list(level) + ([level[-1]] if is_odd else [])

        sibling_idx = curr_idx + 1 if curr_idx % 2 == 0 else curr_idx - 1
        sibling_hash = padded_level[sibling_idx]
        is_left = (curr_idx % 2 == 1)  # sibling 在左边还是右边
        path.append({"sibling": sibling_hash, "sibling_is_left": is_left})
        curr_idx = curr_idx // 2

    return {
        "field_key": k,
        "field_value": v,
        "salt": salt,
        "path": path,
        "expected_root": levels[-1][0]
    }


def verify_selective_disclosure_proof(proof: Dict[str, Any], semantic_root: str) -> bool:
    """验证选择性披露证明与账本语义根是否一致"""
    k = proof["field_key"]
    v = proof["field_value"]
    salt = proof["salt"]
    path = proof["path"]

    entry_str = f"{k}={v}"
    leaf_payload = salt.encode('utf-8') + entry_str.encode('utf-8')
    current_hash = sha256_hash(b"\x00" + leaf_payload)

    for step in path:
        sibling_bytes = bytes.fromhex(step["sibling"])
        curr_bytes = bytes.fromhex(current_hash)
        if step["sibling_is_left"]:
            parent = sha256_hash(b"\x01" + sibling_bytes + curr_bytes)
        else:
            parent = sha256_hash(b"\x01" + curr_bytes + sibling_bytes)
        current_hash = parent

    return current_hash.lower() == semantic_root.lower()
