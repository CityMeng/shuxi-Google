"""
数玺 · 数据可信管理系统引擎
"""
from engine.fp import (
    SPEC_VERSION, SUITE_ID,
    compute_exact_fingerprint,
    compute_phash_from_pixels_32x32,
    compute_text_similarity,
    extract_and_normalize_fields,
    build_semantic_merkle_tree
)
from engine.grade import (
    run_reconciliation_audits,
    judge_four_tier_grade
)
from engine.ledger import HashChainLedger, KeyManager
from engine.service import ShuXiService

__all__ = [
    "SPEC_VERSION",
    "SUITE_ID",
    "compute_exact_fingerprint",
    "compute_phash_from_pixels_32x32",
    "compute_text_similarity",
    "extract_and_normalize_fields",
    "build_semantic_merkle_tree",
    "run_reconciliation_audits",
    "judge_four_tier_grade",
    "HashChainLedger",
    "KeyManager",
    "ShuXiService"
]
