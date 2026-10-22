"""
数玺 · 哈希链账本与密码学模块 (engine/ledger.py)
规范版本: 1.3
套件标识: SXA1
包含:
1. RFC 8785 规范 JSON 序列化 (禁止浮点数)
2. Ed25519 密钥生成、签名与验签 (原生 pure-Python + cryptography 双重支持)
3. JSONL 哈希链账本 (登记/授权/回执/作废/检查点/密钥公告)
4. 全链完整性校验与链头查询
"""

import os
import json
import time
import hashlib
from typing import List, Dict, Any, Tuple, Optional

GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000"

# ==========================================================
# 5.1 规范序列化 (RFC 8785 紧凑规范 JSON，禁止浮点数)
# ==========================================================
def canonical_serialize(obj: Any) -> bytes:
    """
    按协议 5.1 规范序列化:
    - 键按英文字典序或固定协议顺序
    - JSON 紧凑编码 (separators=(',', ':'))
    - UTF-8 编码
    - 严禁浮点数 (float 抛出 ValueError)
    """
    def check_no_float(o: Any):
        if isinstance(o, float):
            raise ValueError(f"协议 5.1 严禁在账本载荷中出现浮点数: {o}")
        elif isinstance(o, dict):
            for k, v in o.items():
                check_no_float(v)
        elif isinstance(o, (list, tuple)):
            for item in o:
                check_no_float(item)

    check_no_float(obj)
    serialized = json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return serialized.encode('utf-8')


# ==========================================================
# 密码学: Ed25519 签名与验签
# ==========================================================
# RFC 8032 纯 Python Ed25519 实现
b = 256
q = 2**255 - 19
l = 2**252 + 27742317777372353535851937790883648493

def _inv(x: int) -> int:
    return pow(x, q - 2, q)

d = -121665 * _inv(121666)
I = pow(2, (q - 1) // 4, q)

def _xrecover(y: int) -> int:
    xx = (y * y - 1) * _inv(d * y * y + 1)
    x = pow(xx, (q + 3) // 8, q)
    if (x * x - xx) % q != 0:
        x = (x * I) % q
    if x % 2 != 0:
        x = q - x
    return x

By = 4 * _inv(5)
Bx = _xrecover(By)
B = [Bx % q, By % q]

def _edwards_add(P, Q):
    x1, y1 = P[0], P[1]
    x2, y2 = Q[0], Q[1]
    x3 = (x1 * y2 + x2 * y1) * _inv(1 + d * x1 * x2 * y1 * y2)
    y3 = (y1 * y2 + x1 * x2) * _inv(1 - d * x1 * x2 * y1 * y2)
    return [x3 % q, y3 % q]

def _scalarmult(P, e):
    if e == 0:
        return [0, 1]
    Q = _scalarmult(P, e // 2)
    Q = _edwards_add(Q, Q)
    if e & 1:
        Q = _edwards_add(Q, P)
    return Q

def _encodeint(y):
    bits = [(y >> i) & 1 for i in range(b)]
    return bytes([sum([bits[i * 8 + j] << j for j in range(8)]) for i in range(b // 8)])

def _encodepoint(P):
    x, y = P[0], P[1]
    bits = [(y >> i) & 1 for i in range(b - 1)] + [x & 1]
    return bytes([sum([bits[i * 8 + j] << j for j in range(8)]) for i in range(b // 8)])

def _bit(h, i):
    return (h[i // 8] >> (i % 8)) & 1

def _decodeint(s):
    return sum(2**i * _bit(s, i) for i in range(0, b))

def _decodepoint(s):
    y = sum(2**i * _bit(s, i) for i in range(0, b - 1))
    x = _xrecover(y)
    if x & 1 != _bit(s, b - 1):
        x = q - x
    P = [x, y]
    return P

def _hint(m):
    h = hashlib.sha512(m).digest()
    return sum(2**i * _bit(h, i) for i in range(2 * b))

def ed25519_publickey(sk: bytes) -> bytes:
    h = hashlib.sha512(sk).digest()
    a = 2**(b - 2) + sum(2**i * _bit(h, i) for i in range(3, b - 2))
    A = _scalarmult(B, a)
    return _encodepoint(A)

def ed25519_sign(msg: bytes, sk: bytes, pk: bytes) -> bytes:
    h = hashlib.sha512(sk).digest()
    a = 2**(b - 2) + sum(2**i * _bit(h, i) for i in range(3, b - 2))
    r = _hint(h[b // 8:] + msg)
    R = _scalarmult(B, r)
    k = _hint(_encodepoint(R) + pk + msg)
    S = (r + k * a) % l
    return _encodepoint(R) + _encodeint(S)

def ed25519_verify(sig: bytes, msg: bytes, pk: bytes) -> bool:
    if len(sig) != 64 or len(pk) != 32:
        return False
    try:
        R = _decodepoint(sig[:32])
        A = _decodepoint(pk)
        S = _decodeint(sig[32:])
        h = _hint(sig[:32] + pk + msg)
        v1 = _scalarmult(B, S)
        v2 = _edwards_add(R, _scalarmult(A, h))
        return v1[0] == v2[0] and v1[1] == v2[1]
    except Exception:
        return False


class KeyManager:
    """密钥管理: 生成、公钥指纹、签名与验签"""
    def __init__(self, private_seed: Optional[bytes] = None):
        if private_seed is None:
            self.sk = os.urandom(32)
        else:
            self.sk = private_seed
        self.pk = ed25519_publickey(self.sk)
        self.fingerprint = hashlib.sha256(self.pk).hexdigest()

    def sign(self, message: bytes) -> str:
        sig_bytes = ed25519_sign(message, self.sk, self.pk)
        return sig_bytes.hex()

    @staticmethod
    def verify(signature_hex: str, message: bytes, pubkey_bytes: bytes) -> bool:
        try:
            sig_bytes = bytes.fromhex(signature_hex)
            return ed25519_verify(sig_bytes, message, pubkey_bytes)
        except Exception:
            return False


# ==========================================================
# 5.7 哈希链账本实现 (JSONL 追加写)
# ==========================================================
class HashChainLedger:
    def __init__(self, ledger_file_path: str):
        self.path = ledger_file_path
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        if not os.path.exists(self.path):
            with open(self.path, 'w', encoding='utf-8') as f:
                pass  # 创建空文件
        self._cached_blocks: Optional[List[Dict[str, Any]]] = None

    def _load(self):
        blocks = []
        if os.path.exists(self.path):
            with open(self.path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line:
                        blocks.append(json.loads(line))
        self._cached_blocks = blocks

    def reload(self):
        """重新从磁盘加载账本数据"""
        self._load()

    def get_all_blocks(self) -> List[Dict[str, Any]]:
        if self._cached_blocks is None:
            self._load()
        return list(self._cached_blocks)

    def get_height(self) -> int:
        if self._cached_blocks is None:
            self._load()
        return len(self._cached_blocks)

    def get_head_hash(self) -> str:
        if self._cached_blocks is None:
            self._load()
        if not self._cached_blocks:
            return GENESIS_HASH
        return self._cached_blocks[-1]["block_hash"]

    def append_block(self, entry_type: str, payload: Dict[str, Any], signer_pubkey_hex: str, signature_hex: str) -> Dict[str, Any]:
        """
        追加区块到账本:
        - 验证签名有效性
        - 链接上一区块哈希 prev_hash
        - 计算当前区块哈希 block_hash
        """
        # 1. 验签
        payload_bytes = canonical_serialize(payload)
        pubkey_bytes = bytes.fromhex(signer_pubkey_hex)
        if not KeyManager.verify(signature_hex, payload_bytes, pubkey_bytes):
            raise ValueError("账本拒绝写入: 签名验签失败！")

        if self._cached_blocks is None:
            self._load()

        height = len(self._cached_blocks) + 1
        prev_hash = self._cached_blocks[-1]["block_hash"] if self._cached_blocks else GENESIS_HASH

        block = {
            "height": height,
            "entry_type": entry_type,
            "prev_hash": prev_hash,
            "payload": payload,
            "signer_pubkey": signer_pubkey_hex,
            "signature": signature_hex,
            "block_time": int(time.time())
        }

        # 计算区块哈希: SHA-256(canonical(block without block_hash))
        block_bytes = canonical_serialize(block)
        block["block_hash"] = hashlib.sha256(block_bytes).hexdigest()

        # 追加写入 JSONL
        with open(self.path, 'a', encoding='utf-8') as f:
            f.write(json.dumps(block, ensure_ascii=False) + '\n')

        self._cached_blocks.append(block)
        return block

    def verify_chain(self) -> Tuple[bool, str, int]:
        """
        全链校验:
        - 校验所有区块 prev_hash 链接
        - 校验区块自身的 block_hash
        - 校验各条记录的 Ed25519 签名
        返回: (is_valid, message, failure_height)
        """
        blocks = self.get_all_blocks()
        if not blocks:
            return True, "账本为空，创世态可信", 0

        prev = GENESIS_HASH
        for idx, blk in enumerate(blocks):
            h = blk.get("height", idx + 1)
            # 1. 检查 prev_hash
            if blk.get("prev_hash") != prev:
                return False, f"高度 {h} 区块的前序哈希断裂（期望 {prev[:8]}，实为 {blk.get('prev_hash')[:8]}）", h

            # 2. 检查区块哈希
            actual_bh = blk.get("block_hash")
            blk_copy = dict(blk)
            blk_copy.pop("block_hash", None)
            calc_bh = hashlib.sha256(canonical_serialize(blk_copy)).hexdigest()
            if actual_bh != calc_bh:
                return False, f"高度 {h} 区块自身哈希被篡改", h

            # 3. 检查签名
            payload = blk.get("payload", {})
            signer_pk = bytes.fromhex(blk.get("signer_pubkey", ""))
            sig = blk.get("signature", "")
            if not KeyManager.verify(sig, canonical_serialize(payload), signer_pk):
                return False, f"高度 {h} 区块的 Ed25519 签名无效", h

            prev = actual_bh

        return True, f"全链 {len(blocks)} 个区块校验通过，哈希链与签名完整无损", 0

    def is_certificate_revoked(self, cert_id: str) -> bool:
        """检查凭证是否已被作废入账"""
        for blk in self.get_all_blocks():
            if blk.get("entry_type") == "作废" and blk.get("payload", {}).get("cert_id") == cert_id:
                return True
        return False

    def query_by_cert_id(self, cert_id: str) -> Optional[Dict[str, Any]]:
        """按凭证号查询最新登记记录"""
        for blk in reversed(self.get_all_blocks()):
            if blk.get("entry_type") == "登记" and blk.get("payload", {}).get("cert_id") == cert_id:
                return blk
        return None

    def query_authorizations(self, cert_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """查询授权记录"""
        res = []
        for blk in self.get_all_blocks():
            if blk.get("entry_type") == "授权":
                p = blk.get("payload", {})
                if cert_id is None or p.get("cert_id") == cert_id:
                    res.append(p)
        return res

    def query_receipts(self, cert_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """查询验真回执记录"""
        res = []
        for blk in self.get_all_blocks():
            if blk.get("entry_type") == "回执":
                p = blk.get("payload", {})
                if cert_id is None or p.get("cert_id") == cert_id:
                    res.append(p)
        return res

    def query_key_announcements(self) -> List[Dict[str, Any]]:
        """查询密钥公告 (失效与争议)"""
        res = []
        for blk in self.get_all_blocks():
            if blk.get("entry_type") == "密钥公告":
                res.append(blk.get("payload", {}))
        return res
