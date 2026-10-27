# -*- coding: utf-8 -*-
"""
数玺核心引擎 · 登记/验真服务 (实现《数玺协议规范 v1.2》
第 2、6、8、9、10、11、12 节的流程编排)

边界重申 (规范 §1): 只保证登记之后未被改动, 不保证登记时内容真实。
账本时间口径 (§2): 授权与过期判定一律以账本最新记录时间为准,
防止本地时钟回拨绕过过期。
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
from datetime import timedelta

from engine import fp, grade as gr
from engine.ledger import (KeyPair, Ledger, canonical_bytes, now_iso,
                           parse_ts, verify_signature)

SOFTWARE_ID = "shuxi-prototype/1b"


def _engine_versions() -> dict:
    env = {"extract": "pymupdf/python-docx/openpyxl", "ocr": "rapidocr-onnxruntime"}
    try:
        import importlib.metadata as md
        env["ocr"] = f"rapidocr-onnxruntime {md.version('rapidocr-onnxruntime')}"
    except Exception:
        pass
    return env


# ---------------------------------------------------------------- 登记包

class PackageStore:
    """登记包 (规范 §1): 字段表 + 各字段盐 + 登记原文, 只存登记方本地,
    绝不进账本。私钥以口令加密 PEM 形式保存在包外单独字段中。"""

    def __init__(self, path: str):
        self.path = path
        self.packages: dict[str, dict] = {}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                self.packages = json.load(f)

    def save(self, cert_id: str, pkg: dict):
        self.packages[cert_id] = pkg
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self.packages, f, ensure_ascii=False, indent=1)
            f.flush()
            os.fsync(f.fileno())

    def get(self, cert_id: str) -> dict | None:
        return self.packages.get(cert_id)


# ---------------------------------------------------------------- 登记 (§2)

def register_file(ledger: Ledger, packages: PackageStore, registrar: KeyPair,
                  registrar_name: str, filename: str, data: bytes, ext: str,
                  passphrase: str, ts: str | None = None) -> str:
    if len(data) == 0:
        raise ValueError("SX-E01: 0 字节文件拒收")
    if len(data) > 500 * 1024 * 1024:
        raise ValueError("SX-E04: 超过 500 MB 拒收")
    comp = fp.compute_all(data, ext)
    aud = gr.audit(data, ext, comp["text"], comp["fields"])
    n = len(ledger.by_type("registration")) + 1
    cert_id = f"SX-{n:04d}-{secrets.token_hex(2).upper()}"
    # 异常与降级 (规范 §14): 错误码明示入账, 不隐含处理
    error_codes: list[str] = []
    degraded: list[str] = []
    supported = {"pdf", "docx", "xlsx", "xlsm", "txt", "csv", "md",
                 "png", "jpg", "jpeg", "bmp", "webp"}
    has_pages = bool(comp["perceptual"]["phashes"])
    if ext not in supported:
        error_codes.append("SX-E03")
        degraded.append("SX-E03 不支持的类型: 仅精确层可用")
    elif not comp["text"] and not has_pages:
        if ext in ("pdf", "docx", "xlsx", "xlsm"):
            error_codes.append("SX-E02")
            degraded.append("SX-E02 文件损坏/无法解析: 仅精确层可用")
        else:
            error_codes.append("SX-E05")
            degraded.append("SX-E05 无字段且无页面图像: 仅精确层可用")
    if not has_pages and "SX-E03" not in error_codes and "SX-E02" not in error_codes:
        if ext in ("pdf", "png", "jpg", "jpeg", "bmp", "webp"):
            degraded.append("感知层不可用 (页面渲染失败)")
        else:
            degraded.append("无页面图像 (感知层以文本相似度为准)")
    if comp["perceptual"].get("truncated"):
        degraded.append("感知指纹截断于 512 页 (规范 §4.5)")
    if not comp["fields"] and "SX-E05" not in error_codes:
        degraded.append("语义层无字段")
    payload = {
        "cert_id": cert_id,
        "spec_version": fp.SPEC_VERSION,
        "suite": fp.SUITE_ID,
        "object_type": "file",
        "registrar": registrar_name,
        "pubkey_fp": registrar.fingerprint,
        "env": {"software": SOFTWARE_ID, "engine": _engine_versions(),
                "operator": registrar_name},
        "filename": filename,
        "exact": comp["exact"],
        "phashes": comp["perceptual"]["phashes"],
        "semantic_root": comp["semantic"]["root"],
        "field_keys": comp["semantic"]["keys"],
        "reg_audit": aud["issues"],
        "degraded": degraded,
        "error_codes": error_codes,
        "status": "有效",
    }
    entry = ledger.append("registration", payload, registrar, ts=ts)
    packages.save(cert_id, {
        "cert_id": cert_id, "filename": filename, "ext": ext,
        "fields": comp["fields"], "salts": comp["semantic"]["salts"],
        "text": comp["text"],
        "privkey_pem": registrar.private_pem_encrypted(passphrase),
    })
    return cert_id


# ---------------------------------------------------------------- 状态解析 (§9/§11)

def resolve_status(ledger: Ledger, cert_id: str) -> dict:
    # 说明: 密钥公告是新密钥对继承关系的自声明, 其效力只限于"加注/争议"
    # 与作废路径的引用校验; 正式部署时公告主体的身份核验在系统外完成
    # (规范 §11 的信任模型), 原型不冒充已核验。
    reg = ledger.find_registration(cert_id)
    if reg is None:
        return {"status": "不存在", "annotations": [], "reg": None}
    annotations: list[str] = []
    status = "有效"
    reg_fp = reg["payload"]["pubkey_fp"]
    if reg["signer_fp"] != reg_fp:
        return {"status": "记录异常", "annotations":
                ["登记记录的签名主体与登记公钥不一致, 不予采信"], "reg": reg}
    for e in ledger.entries:
        p = e["payload"]
        if e["type"] == "revocation" and p.get("cert_id") == cert_id:
            status = "已作废"
        if e["type"] == "key_notice" and p.get("old_fp") == reg_fp:
            if p["kind"] == "失效":
                annotations.append("登记密钥已失效 (见公告 "
                                   f"{p['notice_id']}), 历史签名仍有效")
            elif p["kind"] == "争议":
                if status == "有效":
                    status = "争议"
                annotations.append(f"登记密钥处于争议状态 (公告 {p['notice_id']})")
            elif p["kind"] == "解除":
                if status == "争议":
                    status = "有效"
                annotations.append(f"争议已解除 (公告 {p['notice_id']})")
    return {"status": status, "annotations": annotations, "reg": reg}


# ---------------------------------------------------------------- 授权 (§8)

def create_authorization(ledger: Ledger, registrar: KeyPair, cert_id: str,
                         grantee: str, grantee_fp: str, days: int,
                         max_count: int, ts: str | None = None) -> str:
    reg_state = resolve_status(ledger, cert_id)
    if reg_state["reg"] is None:
        raise ValueError("授权: 凭证不存在")
    if reg_state["reg"]["signer_fp"] != registrar.fingerprint:
        raise ValueError("授权: 只有登记方可以授权")
    auth_id = f"AU-{ledger.next_seq():06d}"
    payload = {"auth_id": auth_id, "cert_id": cert_id, "grantee": grantee,
               "grantee_fp": grantee_fp, "days": days, "max_count": max_count}
    ledger.append("authorization", payload, registrar, ts=ts)
    return auth_id


def check_authorization(ledger: Ledger, auth_id: str) -> dict:
    auth = next((e for e in ledger.entries
                 if e["type"] == "authorization"
                 and e["payload"].get("auth_id") == auth_id), None)
    if auth is None:
        return {"valid": False, "reason": "授权不存在", "used": 0}
    p = auth["payload"]
    used = sum(1 for e in ledger.entries
               if e["type"] == "receipt" and e["payload"].get("auth_id") == auth_id)
    latest = ledger.latest_ts()
    now = parse_ts(latest) if latest else parse_ts(auth["ts"])
    expires = parse_ts(auth["ts"]) + timedelta(days=p["days"])
    base = {"used": used, "max_count": p["max_count"],
            "cert_id": p["cert_id"], "grantee_fp": p["grantee_fp"]}
    if now > expires:
        return {"valid": False, "reason": "授权已过期 (以账本最新时间为准)", **base}
    if used >= p["max_count"]:
        return {"valid": False, "reason": "授权次数已用完", **base}
    return {"valid": True, "reason": "", **base}


# ---------------------------------------------------------------- 验真 (§6/§8/§10)

def verify_file(ledger: Ledger, packages: PackageStore, verifier: KeyPair,
                verifier_name: str, cert_id: str, data: bytes, ext: str,
                filename: str, auth_id: str | None = None,
                ts: str | None = None) -> dict:
    state = resolve_status(ledger, cert_id)
    if state["reg"] is None:
        return {"error": "凭证不存在"}
    if state["status"] == "记录异常":
        return {"error": state["annotations"][0]}
    reg = state["reg"]
    rp = reg["payload"]

    if auth_id is not None:
        chk = check_authorization(ledger, auth_id)
        if not chk["valid"]:
            return {"error": f"授权校验失败: {chk['reason']}"}
        if chk["cert_id"] != cert_id:
            return {"error": "授权校验失败: 授权与凭证不匹配"}
        # 记名绑定 (规范 §8.4): 验真方指纹须与被授权方一致
        if chk["grantee_fp"] != verifier.fingerprint:
            return {"error": "授权校验失败: 验真方与被授权方不一致"}

    pkg = packages.get(cert_id)
    reg_fields = pkg["fields"] if pkg else None
    reg_view = {
        "exact": rp["exact"], "phashes": rp["phashes"],
        "semantic_root": rp["semantic_root"],
        "text": pkg["text"] if pkg else "",
    }
    reg_audit = {"issues": rp["reg_audit"], "hints": []}

    # 待验件语义层须以登记包的盐复算 (规范 §5), 否则语义根不可比;
    # 无登记包时盐不可得, 字段一项由判定层按"无法核验"处理 (§6 v1.3)。
    comp = fp.compute_all(data, ext, pkg["salts"] if pkg else None)
    cand_audit = gr.audit(data, ext, comp["text"], comp["fields"])
    result = gr.grade(reg_view, comp, reg_audit, cand_audit, reg_fields,
                      status=state["status"], annotations=state["annotations"])

    # 验真报告 (§10): 数值只来自当次实际计算; 数值以字符串入账防序列化漂移
    ev = result["evidence"]
    report = {
        "cert_id": cert_id, "filename": filename,
        "registered_filename": rp["filename"],
        "exact_sha256_match": rp["exact"]["sha256_root"] == comp["exact"]["sha256_root"],
        "exact_sm3_match": rp["exact"]["sm3_root"] == comp["exact"]["sm3_root"],
        "phash_mean_dist": (None if ev.get("phash_mean_dist") is None
                            else str(round(ev["phash_mean_dist"], 4))),
        "text_sim": (None if ev.get("text_sim") is None
                     else str(round(ev["text_sim"], 4))),
        "field_diffs": ev.get("field_diffs", []),
        "grade": result["grade"],
        "confidence": str(result["confidence"]),
        "reasons": result["reasons"],
        "verifier": verifier_name, "verifier_fp": verifier.fingerprint,
    }
    report_hash = hashlib.sha256(canonical_bytes(report)).hexdigest()
    report["report_hash"] = report_hash
    report["verifier_sig"] = verifier.sign(bytes.fromhex(report_hash))

    # 验真回执 (§8): 签名 + 随机数防重放, 编号入账, 授权计数以回执为准
    receipt_id = f"RC-{ledger.next_seq():06d}"
    receipt_payload = {
        "receipt_id": receipt_id, "cert_id": cert_id, "auth_id": auth_id,
        "verifier": verifier_name, "verifier_fp": verifier.fingerprint,
        "grade": result["grade"], "confidence": str(result["confidence"]),
        "nonce": secrets.token_hex(16), "report_hash": report_hash,
    }
    entry = ledger.append("receipt", receipt_payload, verifier, ts=ts)
    report["receipt_id"] = receipt_id
    report["receipt_entry_hash"] = entry["hash"]
    return report


def verify_report(ledger: Ledger, report: dict) -> bool:
    """任何人持报告对照账本复核报告本身真伪 (§10)。"""
    body = {k: v for k, v in report.items()
            if k not in ("report_hash", "verifier_sig",
                         "receipt_id", "receipt_entry_hash")}
    if hashlib.sha256(canonical_bytes(body)).hexdigest() != report["report_hash"]:
        return False
    pub = None
    for e in ledger.entries:
        if (e["type"] == "receipt"
                and e["payload"].get("receipt_id") == report["receipt_id"]):
            if e["payload"].get("report_hash") != report["report_hash"]:
                return False
            if e["hash"] != report["receipt_entry_hash"]:
                return False
            pub = e["signer_pub"]
            break
    if pub is None:
        return False
    return verify_signature(pub, bytes.fromhex(report["report_hash"]),
                            report["verifier_sig"])


# ---------------------------------------------------------------- 作废 (§9)

def revoke(ledger: Ledger, signer: KeyPair, cert_id: str,
           notice_id: str | None = None, ts: str | None = None) -> dict:
    state = resolve_status(ledger, cert_id)
    if state["reg"] is None:
        raise ValueError("作废: 凭证不存在")
    reg_fp = state["reg"]["payload"]["pubkey_fp"]
    if signer.fingerprint == reg_fp:
        pass  # 原登记方本人作废
    else:
        # 私钥丢失路径: 须先有"公钥失效公告"(由新密钥签发), 且作废引用之
        ok = False
        for e in ledger.entries:
            p = e["payload"]
            if (e["type"] == "key_notice" and p.get("kind") == "失效"
                    and p.get("old_fp") == reg_fp
                    and e["signer_fp"] == signer.fingerprint
                    and notice_id is not None and p.get("notice_id") == notice_id):
                ok = True
        if not ok:
            raise ValueError("作废: 签名者非登记方, 且无有效的公钥失效公告路径")
    payload = {"cert_id": cert_id, "notice_ref": notice_id}
    return ledger.append("revocation", payload, signer, ts=ts)


# ---------------------------------------------------------------- 密钥公告 (§11)

def key_notice(ledger: Ledger, new_key: KeyPair, old_fp: str, kind: str,
               reason: str, ts: str | None = None) -> str:
    if kind not in ("失效", "争议", "解除"):
        raise ValueError("公告类型只能是 失效/争议/解除")
    notice_id = f"KN-{ledger.next_seq():06d}"
    payload = {"notice_id": notice_id, "old_fp": old_fp,
               "new_fp": new_key.fingerprint, "kind": kind, "reason": reason}
    ledger.append("key_notice", payload, new_key, ts=ts)
    return notice_id


# ---------------------------------------------------------------- 文件集 (§13)

def _ext_of(filename: str) -> str:
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def register_file_set(ledger: Ledger, packages: PackageStore,
                      registrar: KeyPair, registrar_name: str, set_name: str,
                      members: list[tuple[str, bytes]], passphrase: str,
                      ts: str | None = None) -> str:
    """文件集登记: 成员各自算指纹, 清单树 (双算法) 出总根, 一张凭证管一批。"""
    if not members:
        raise ValueError("文件集为空")
    member_recs, pkg_members = [], {}
    leaf_data = {"sha256": [], "sm3": []}
    sem_roots, total_size = [], 0
    for filename, data in members:
        if len(data) == 0:
            raise ValueError(f"SX-E01: 成员 {filename} 为 0 字节, 拒收")
        ext = _ext_of(filename)
        comp = fp.compute_all(data, ext)
        aud = gr.audit(data, ext, comp["text"], comp["fields"])
        member_recs.append({
            "filename": filename, "exact": comp["exact"],
            "phashes": comp["perceptual"]["phashes"],
            "semantic_root": comp["semantic"]["root"],
            "field_keys": comp["semantic"]["keys"],
            "reg_audit": aud["issues"],
        })
        pkg_members[filename] = {
            "fields": comp["fields"], "salts": comp["semantic"]["salts"],
            "text": comp["text"], "ext": ext,
        }
        for alg in ("sha256", "sm3"):
            leaf_data[alg].append(
                (filename + comp["exact"][f"{alg}_root"]).encode("utf-8"))
        sem_roots.append(bytes.fromhex(comp["semantic"]["root"]))
        total_size += len(data)
    n = len(ledger.by_type("registration")) + 1
    cert_id = f"SX-{n:04d}-{secrets.token_hex(2).upper()}"
    payload = {
        "cert_id": cert_id, "spec_version": fp.SPEC_VERSION,
        "suite": fp.SUITE_ID, "object_type": "fileset",
        "registrar": registrar_name, "pubkey_fp": registrar.fingerprint,
        "env": {"software": SOFTWARE_ID, "engine": _engine_versions(),
                "operator": registrar_name},
        "filename": set_name,
        "exact": {"sha256_root": fp.merkle_root("sha256", leaf_data["sha256"]),
                  "sm3_root": fp.merkle_root("sm3", leaf_data["sm3"]),
                  "chunk_count": len(members), "size": total_size},
        "phashes": [],
        "semantic_root": fp.merkle_root("sha256", sem_roots),
        "field_keys": [], "reg_audit": [], "degraded": [], "error_codes": [],
        "members": member_recs, "status": "有效",
    }
    ledger.append("registration", payload, registrar, ts=ts)
    packages.save(cert_id, {
        "cert_id": cert_id, "fileset": True, "members": pkg_members,
        "privkey_pem": registrar.private_pem_encrypted(passphrase),
    })
    return cert_id


def verify_file_set(ledger: Ledger, packages: PackageStore, verifier: KeyPair,
                    verifier_name: str, cert_id: str,
                    members: list[tuple[str, bytes]],
                    ts: str | None = None) -> dict:
    """逐成员按 §6 出级并汇总: 全甲才汇总甲级; 成员缺失明示不完整。"""
    state = resolve_status(ledger, cert_id)
    if state["reg"] is None:
        return {"error": "凭证不存在"}
    rp = state["reg"]["payload"]
    if rp.get("object_type") != "fileset":
        return {"error": "该凭证不是文件集"}
    pkg = packages.get(cert_id) or {}
    pkg_members = pkg.get("members", {})
    provided = dict(members)
    results, all_exact = {}, True
    for m in rp["members"]:
        fn = m["filename"]
        if fn not in provided:
            results[fn] = {"grade": "缺失"}
            all_exact = False
            continue
        data = provided[fn]
        pm = pkg_members.get(fn)
        reg_view = {"exact": m["exact"], "phashes": m.get("phashes", []),
                    "semantic_root": m["semantic_root"],
                    "text": pm["text"] if pm else ""}
        comp = fp.compute_all(data, _ext_of(fn), pm["salts"] if pm else None)
        aud = gr.audit(data, _ext_of(fn), comp["text"], comp["fields"])
        res = gr.grade(reg_view, comp, {"issues": m["reg_audit"], "hints": []},
                       aud, pm["fields"] if pm else None,
                       status=state["status"], annotations=state["annotations"])
        results[fn] = {"grade": res["grade"], "confidence": res["confidence"]}
        if res["grade"] != "甲级":
            all_exact = False
    extra = [fn for fn in provided if fn not in {m["filename"] for m in rp["members"]}]
    complete = all(r["grade"] != "缺失" for r in results.values())
    summary = "甲级" if all_exact and complete else "逐成员结论"
    receipt_id = f"RC-{ledger.next_seq():06d}"
    ledger.append("receipt", {
        "receipt_id": receipt_id, "cert_id": cert_id, "auth_id": None,
        "verifier": verifier_name, "verifier_fp": verifier.fingerprint,
        "grade": summary, "confidence": "1.0" if summary == "甲级" else "0",
        "nonce": secrets.token_hex(16),
        "report_hash": hashlib.sha256(canonical_bytes(
            {"cert_id": cert_id, "results": {k: v.get("grade") for k, v in results.items()}}
        )).hexdigest(),
    }, verifier, ts=ts)
    return {"cert_id": cert_id, "members": results, "complete": complete,
            "summary": summary, "extra_files": extra,
            "receipt_id": receipt_id}


# ---------------------------------------------------------------- 检查点 (§12)

def checkpoint(ledger: Ledger, kp: KeyPair, anchor: dict | None = None,
               ts: str | None = None) -> dict:
    payload = {
        "height": ledger.next_seq(),
        "head_hash": ledger.head_hash(),
        # 原型阶段锚点预留: 正式版接 RFC 3161 时间戳或公链检查点
        "anchor": anchor or {"type": "reserved", "value": None, "time": None},
    }
    return ledger.append("checkpoint", payload, kp, ts=ts)
