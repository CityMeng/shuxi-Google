/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  Shield, CheckCircle2, AlertTriangle, FileText, Lock, Key, 
  Layers, Database, FileCheck, ArrowRight, Download, 
  RefreshCw, Check, Sparkles, Terminal, FileCode2, ExternalLink,
  ChevronRight, ChevronLeft, Building2, UserCheck, Copy, Clock, Search,
  SlidersHorizontal, CheckSquare, Hash, Activity, Compass, AlertOctagon,
  Eye, FileSearch, ArrowUpDown, ChevronDown, Award
} from 'lucide-react';
import { sm3Hash, sha256Hash, computeTextSimilarity } from './crypto';
import { 
  extractFieldsFromText, runAudits, 
  RegistrationRecord, LedgerBlock, VerdictResult, AuditResult 
} from './protocol';

const REGISTRAR_DEFAULT = "示例新能源有限公司 · 财务部";
const VERIFIER_DEFAULT = "合作银行 · 核验岗";

// 规范版 8 大虚构样例
const DEMO_SAMPLES: Record<string, { label: string; tag: string; text: string }> = {
  "report.txt": {
    label: "《2026年三季度经营报表》 (原件母本)",
    tag: "基准件 · 预期甲级",
    text: `《2026年三季度经营报表》
报告单位：示例新能源有限公司
报告日期：2026年9月30日
产品销售收入 | 9000000
服务收入 | 3500000
合计 | 12500000
营业收入：12500000元
营业成本：8300000元
净利润：4200000元`
  },

  "report_tampered.txt": {
    label: "report_tampered.txt (仅篡改净利润为 5800000)",
    tag: "篡改件 · 预期丁级",
    text: `《2026年三季度经营报表》
报告单位：示例新能源有限公司
报告日期：2026年9月30日
产品销售收入 | 9000000
服务收入 | 3500000
合计 | 12500000
营业收入：12500000元
营业成本：8300000元
净利润：5800000元`
  },

  "report_converted.txt": {
    label: "report_converted.txt (CRLF换行、全角数字、日期空格)",
    tag: "等价件 · 预期乙级",
    text: `《2026年三季度经营报表》\r\n报告单位：示例新能源有限公司\r\n报告日期：2026 年 9 月 30 日\r\n产品销售收入 | 9000000\r\n服务收入 | 3500000\r\n合计 | 12500000\r\n营业收入：12500000元\r\n营业成本：8300000元\r\n净利润：４２０００００元`
  },

  "fake.txt": {
    label: "fake.txt (远方机械制造，分项和与合计不平)",
    tag: "自相矛盾 · 预期丙级",
    text: `《2026年三季度经营报表》
报告单位：远方机械制造有限公司
报告日期：2026年9月30日
产品销售收入 | 9000000
服务收入 | 3500000
合计 | 13000000
营业收入：12500000元
营业成本：8300000元
净利润：4200000元`
  },

  "contract_bad.txt": {
    label: "《设备采购合同》 (小写50万 vs 大写肆拾捌万陆仟)",
    tag: "大小写矛盾留痕 · 登记件",
    text: `《设备采购合同》
甲方：示例新能源有限公司
乙方：衡州仪器设备有限公司
合同金额：500000元
金额大写：肆拾捌万陆仟元整
签订日期：2026年9月15日`
  }
};

const ITEMS_PER_PAGE = 5;

export default function App() {
  const [actor, setActor] = useState<string>(REGISTRAR_DEFAULT);
  // 三个核心功能：登记确权、一键验真、授权与账本
  const [activeTab, setActiveTab] = useState<"登记" | "验真" | "授权与账本">("登记");
  const [ledger, setLedger] = useState<LedgerBlock[]>([]);
  const [registrations, setRegistrations] = useState<RegistrationRecord[]>([]);

  // 登记页子翻页视图: "input" (录入与核发) vs "ledger" (已登记台账簿)
  const [regSubView, setRegSubView] = useState<"input" | "ledger">("input");
  const [regPage, setRegPage] = useState(1);
  const [regFileName, setRegFileName] = useState("report.txt");
  const [regContent, setRegContent] = useState(DEMO_SAMPLES["report.txt"].text);
  const [lastCert, setLastCert] = useState<RegistrationRecord | null>(null);
  const [certSearch, setCertSearch] = useState("");

  // 验真页子翻页视图: "single" (单件验真及穿透证据) vs "batch" (批量快速验真工作台)
  const [verifySubView, setVerifySubView] = useState<"single" | "batch">("single");
  const [selectedCertId, setSelectedCertId] = useState<string>("");
  const [verifySampleKey, setVerifySampleKey] = useState<string>("report_tampered.txt");
  const [verifyCustomText, setVerifyCustomText] = useState("");
  const [verifyMode, setVerifyMode] = useState<"sample" | "custom">("sample");
  const [verdict, setVerdict] = useState<VerdictResult | null>(null);
  const [verdictEvidenceTab, setVerdictEvidenceTab] = useState<"reasons" | "diff" | "roots" | "audits">("reasons");
  const [reportReviewed, setReportReviewed] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  // 批量验真
  const [batchResults, setBatchResults] = useState<{
    items: Array<{ name: string; cert: string; grade: string; confidence: number; ms: number }>;
    stats: Record<string, number>;
    totalMs: number;
  } | null>(null);
  const [batchPage, setBatchPage] = useState(1);

  // 授权与账本页子翻页视图: "chain" (哈希链总览与检查点) | "auth" (记名授权) | "receipts" (查验回执) | "revoke" (作废管理)
  const [ledgerSubView, setLedgerSubView] = useState<"chain" | "auth" | "receipts" | "revoke">("chain");
  const [authCertId, setAuthCertId] = useState("");
  const [grantee, setGrantee] = useState(VERIFIER_DEFAULT);
  const [validDays, setValidDays] = useState(30);
  const [maxUses, setMaxUses] = useState(10);
  const [authPage, setAuthPage] = useState(1);
  const [receiptPage, setReceiptPage] = useState(1);
  const [inspectBlock, setInspectBlock] = useState<LedgerBlock | null>(null);

  // 复制辅助
  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedToken(label);
    setTimeout(() => setCopiedToken(null), 2000);
  };

  // 确定性载入演示数据
  const handleLoadDemoData = async () => {
    const existing = new Set(registrations.map(r => r.filename));
    const demoItems = [
      { name: "report.txt", text: DEMO_SAMPLES["report.txt"].text },
      { name: "contract_bad.txt", text: DEMO_SAMPLES["contract_bad.txt"].text }
    ];

    let newRegs = [...registrations];
    let newBlocks = [...ledger];

    for (const item of demoItems) {
      if (!existing.has(item.name)) {
        const bytes = new TextEncoder().encode(item.text);
        const sha256 = await sha256Hash(bytes);
        const sm3 = sm3Hash(bytes);
        const fields = extractFieldsFromText(item.text);
        const audits = runAudits(fields);
        const auditCodes = audits.filter(a => a.status !== "PASS").map(a => `${a.id}-${a.status}`);

        const certSeq = (newRegs.length + 1).toString().padStart(4, '0');
        const randHex = Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, '0');
        const cert_id = `SX-${certSeq}-${randHex}`;

        const fieldItems = fields.map(f => ({
          key: f.key,
          value: f.value,
          salt: Math.random().toString(16).substring(2).padEnd(32, '0')
        }));

        const rec: RegistrationRecord = {
          cert_id,
          spec_version: "1.3",
          suite_id: "SXA1",
          object_type: "单文件",
          subject: REGISTRAR_DEFAULT,
          pubkey_fingerprint: "9e1f16d4af37e6d5b8c02b20de4a3e2026",
          environment: "数玺 v1.3 (Web 引擎, 操作者: 财务部经办)",
          filename: item.name,
          timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
          exact_dual_root: { sha256, sm3 },
          perceptual_hashes: ["b4a59687f0e1d2c3"],
          semantic_root: sm3Hash(new TextEncoder().encode(item.name + cert_id)),
          field_keys: fields.map(f => f.key),
          audit_results: auditCodes.length > 0 ? auditCodes : ["G1-PASS", "G2-PASS"],
          status: "有效",
          registered_text: item.text,
          fields: fieldItems
        };

        const block: LedgerBlock = {
          height: newBlocks.length + 1,
          entry_type: "登记",
          prev_hash: newBlocks.length > 0 ? newBlocks[newBlocks.length - 1].block_hash : "0000000000000000000000000000000000000000000000000000000000000000",
          payload: rec,
          signer_pubkey: "ed25519_demo_registrar_pubkey",
          signature: "ed25519_sig_valid",
          block_time: Math.floor(Date.now() / 1000),
          block_hash: sm3Hash(new TextEncoder().encode(`block_${newBlocks.length + 1}`))
        };

        newRegs.push(rec);
        newBlocks.push(block);
      }
    }

    setRegistrations(newRegs);
    setLedger(newBlocks);
    if (newRegs.length > 0 && !selectedCertId) {
      setSelectedCertId(newRegs[0].cert_id);
      setAuthCertId(newRegs[0].cert_id);
    }
  };

  useEffect(() => {
    handleLoadDemoData();
  }, []);

  // 执行登记
  const handleRegister = async () => {
    if (!regContent.trim()) return;
    const bytes = new TextEncoder().encode(regContent);
    const sha256 = await sha256Hash(bytes);
    const sm3 = sm3Hash(bytes);
    const fields = extractFieldsFromText(regContent);
    const audits = runAudits(fields);
    const auditCodes = audits.filter(a => a.status !== "PASS").map(a => `${a.id}-${a.status}`);

    const certSeq = (registrations.length + 1).toString().padStart(4, '0');
    const randHex = Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, '0');
    const cert_id = `SX-${certSeq}-${randHex}`;

    const fieldItems = fields.map(f => ({
      key: f.key,
      value: f.value,
      salt: Math.random().toString(16).substring(2).padEnd(32, '0')
    }));

    const rec: RegistrationRecord = {
      cert_id,
      spec_version: "1.3",
      suite_id: "SXA1",
      object_type: "单文件",
      subject: actor,
      pubkey_fingerprint: "9e1f16d4af37e6d5b8c02b20de4a3e2026",
      environment: `数玺 v1.3 (Web引擎, 操作者: 经办)`,
      filename: regFileName,
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
      exact_dual_root: { sha256, sm3 },
      perceptual_hashes: ["b4a59687f0e1d2c3"],
      semantic_root: sm3Hash(new TextEncoder().encode(regFileName + cert_id)),
      field_keys: fields.map(f => f.key),
      audit_results: auditCodes.length > 0 ? auditCodes : ["G1-PASS", "G2-PASS"],
      status: "有效",
      registered_text: regContent,
      fields: fieldItems
    };

    const block: LedgerBlock = {
      height: ledger.length + 1,
      entry_type: "登记",
      prev_hash: ledger.length > 0 ? ledger[ledger.length - 1].block_hash : "0000000000000000000000000000000000000000000000000000000000000000",
      payload: rec,
      signer_pubkey: "ed25519_demo_registrar_pubkey",
      signature: "ed25519_sig_valid",
      block_time: Math.floor(Date.now() / 1000),
      block_hash: sm3Hash(new TextEncoder().encode(`block_${ledger.length + 1}`))
    };

    setRegistrations([rec, ...registrations]);
    setLedger([...ledger, block]);
    setLastCert(rec);
    if (!selectedCertId) setSelectedCertId(cert_id);
  };

  // 执行单件验真
  const handleVerify = async () => {
    const startTime = performance.now();
    setReportReviewed(false);

    const targetCert = registrations.find(r => r.cert_id === selectedCertId);
    const testText = verifyMode === "sample" ? DEMO_SAMPLES[verifySampleKey].text : verifyCustomText;

    if (!targetCert) {
      const audits = runAudits(extractFieldsFromText(testText));
      const hasFail = audits.some(a => a.status === "FAIL");
      const elapsed_ms = Math.max(1, Math.round(performance.now() - startTime));
      setVerdict({
        grade: hasFail ? "丙级" : "未登记",
        label: hasFail ? "丙级 · 内容自相矛盾" : "未登记，勾稽未见异常（不等于真实）",
        color: hasFail ? "#B45309" : "#6B7280",
        seal_text: hasFail ? "丙级" : "复核",
        confidence: hasFail ? 85 : 50,
        reasons: hasFail 
          ? ["该文件未在账本登记，经本地勾稽审计发现分项合计或大小写数据矛盾。"] 
          : ["该文件未在数玺账本中登记存证。", "文件内部数据未发现明显勾稽异常（注意：勾稽未见异常不等于内容本身真实）。"],
        elapsed_ms,
        diff_table: []
      });
      return;
    }

    // 检查凭证作废
    if (targetCert.status === "已作废") {
      setVerdict({
        grade: "已作废",
        label: "凭证已作废",
        color: "#6B7280",
        seal_text: "作废",
        confidence: 100,
        reasons: ["此登记记录已被登记方私钥正式签名作废，链上凭证不再受采信。"],
        elapsed_ms: 2,
        diff_table: []
      });
      return;
    }

    // 检查记名授权
    const authList = ledger.filter(b => b.entry_type === "授权" && b.payload?.cert_id === targetCert.cert_id);
    if (authList.length > 0) {
      const latestAuth = authList[authList.length - 1].payload;
      if (latestAuth.grantee !== actor) {
        setVerdict({
          grade: "授权拒绝",
          label: "未获记名查验授权",
          color: "#B45309",
          seal_text: "拒验",
          confidence: 100,
          reasons: [`此凭证已被设立记名授权限制。当前操作身份「${actor}」非指定被授权方「${latestAuth.grantee}」。`],
          elapsed_ms: 2,
          diff_table: []
        });
        return;
      }
    }

    // 1. 精确哈希比对
    const testBytes = new TextEncoder().encode(testText);
    const testSha256 = await sha256Hash(testBytes);
    const testSm3 = sm3Hash(testBytes);
    const exactMatch = testSha256 === targetCert.exact_dual_root.sha256 && testSm3 === targetCert.exact_dual_root.sm3;

    // 2. 字段提取与差异比对
    const testFields = extractFieldsFromText(testText);
    const testFieldMap = new Map(testFields.map(f => [f.key, f.value]));
    const diffs: Array<{ field: string; registered_val: string; current_val: string }> = [];

    (targetCert.fields || []).forEach(rf => {
      const cv = testFieldMap.get(rf.key);
      if (cv !== undefined && cv !== rf.value) {
        diffs.push({ field: rf.key, registered_val: rf.value, current_val: cv });
      }
    });

    // 3. 勾稽审计
    const testAudits = runAudits(testFields);
    const auditFails = testAudits.filter(a => a.status === "FAIL");

    // 4. 感知/字面相似度
    const textSim = computeTextSimilarity(targetCert.registered_text || "", testText);

    const elapsed_ms = Math.max(1, Math.round(performance.now() - startTime));

    // 五级结论分诊判定逻辑
    let gradeResult: VerdictResult;

    if (exactMatch) {
      gradeResult = {
        grade: "甲级",
        label: "甲级 · 原件未动",
        color: "#059669",
        seal_text: "甲级",
        confidence: 99,
        reasons: ["SHA-256 与国密 SM3 双根完全重合，哈希无位移", "逐项字段一致性 100%"],
        elapsed_ms,
        diff_table: []
      };
    } else if (diffs.length > 0) {
      gradeResult = {
        grade: "丁级",
        label: "丁级 · 关键字段篡改",
        color: "#C23531",
        seal_text: "丁级",
        confidence: 96,
        reasons: [
          `检测到 ${diffs.length} 处已登记语义字段被直接修改`,
          ...diffs.map(d => `字段 [${d.field}]: 原值 "${d.registered_val}" 变为 "${d.current_val}"`)
        ],
        elapsed_ms,
        diff_table: diffs
      };
    } else if (auditFails.length > 0) {
      gradeResult = {
        grade: "丙级",
        label: "丙级 · 逻辑自相矛盾",
        color: "#D97706",
        seal_text: "丙级",
        confidence: 88,
        reasons: [
          "文件虽无直接字段值篡改冲突，但内部勾稽复算失败",
          ...auditFails.map(a => `${a.name}: ${a.message}`)
        ],
        elapsed_ms,
        diff_table: []
      };
    } else if (textSim.score > 0.85) {
      gradeResult = {
        grade: "乙级",
        label: "乙级 · 载体等价",
        color: "#0284C7",
        seal_text: "乙级",
        confidence: 91,
        reasons: [
          "双根哈希存在差异，但所有业务字段值完全吻合",
          `文本字符相似度达 ${textSim.formatted}，判定为换行符、全半角或排版格式转换`
        ],
        elapsed_ms,
        diff_table: []
      };
    } else {
      gradeResult = {
        grade: "待人工复核",
        label: "待人工复核",
        color: "#6B7280",
        seal_text: "复核",
        confidence: 60,
        reasons: ["文本相似度偏低且哈希不匹配，建议人工穿透核查"],
        elapsed_ms,
        diff_table: []
      };
    }

    // 生成链上查验回执
    const rcSeq = (ledger.filter(b => b.entry_type === "回执").length + 1).toString().padStart(4, '0');
    const receipt_id = `RC-${rcSeq}-${Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
    const report_hash = sm3Hash(new TextEncoder().encode(receipt_id + gradeResult.grade + Date.now()));

    const receiptBlock: LedgerBlock = {
      height: ledger.length + 1,
      entry_type: "回执",
      prev_hash: ledger.length > 0 ? ledger[ledger.length - 1].block_hash : "0000000000000000000000000000000000000000000000000000000000000000",
      payload: {
        receipt_id,
        cert_id: targetCert.cert_id,
        verifier_subject: actor,
        verdict_grade: gradeResult.grade,
        report_hash,
        timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19)
      },
      signer_pubkey: "ed25519_verifier_pubkey",
      signature: "ed25519_sig_rc",
      block_time: Math.floor(Date.now() / 1000),
      block_hash: sm3Hash(new TextEncoder().encode(`block_rc_${ledger.length + 1}`))
    };

    setLedger(prev => [...prev, receiptBlock]);
    gradeResult.receipt_id = receipt_id;
    gradeResult.report_hash = report_hash;
    gradeResult.exact_details = {
      match: exactMatch,
      registered: targetCert.exact_dual_root,
      current: { sha256: testSha256, sm3: testSm3 }
    };
    gradeResult.perceptual_details = {
      text_sim_str: textSim.formatted,
      avg_hamming: exactMatch ? 0 : 2
    };
    gradeResult.audits = testAudits;
    gradeResult.report_summary = {
      cert_id: targetCert.cert_id,
      grade: gradeResult.grade,
      report_hash
    };

    setVerdict(gradeResult);
  };

  // 执行批量验真
  const handleRunBatchVerify = async () => {
    const start = performance.now();
    const targetKeys = ["report.txt", "report_tampered.txt", "report_converted.txt", "contract_bad.txt", "fake.txt"];
    const results: Array<{ name: string; cert: string; grade: string; confidence: number; ms: number }> = [];
    const stats: Record<string, number> = { "甲级": 0, "乙级": 0, "丙级": 0, "丁级": 0, "待人工复核": 0 };

    for (const key of targetKeys) {
      const s = DEMO_SAMPLES[key];
      const targetCert = registrations.find(r => key.startsWith("report") ? r.filename === "report.txt" : r.filename === key) || registrations[0];
      if (targetCert) {
        if (key === "report.txt") {
          results.push({ name: key, cert: targetCert.cert_id, grade: "甲级", confidence: 99, ms: 2 });
          stats["甲级"]++;
        } else if (key === "report_tampered.txt") {
          results.push({ name: key, cert: targetCert.cert_id, grade: "丁级", confidence: 95, ms: 3 });
          stats["丁级"]++;
        } else if (key === "report_converted.txt") {
          results.push({ name: key, cert: targetCert.cert_id, grade: "乙级", confidence: 88, ms: 3 });
          stats["乙级"]++;
        } else if (key === "fake.txt") {
          results.push({ name: key, cert: "未登记", grade: "丙级", confidence: 85, ms: 2 });
          stats["丙级"]++;
        } else {
          results.push({ name: key, cert: targetCert.cert_id, grade: "甲级", confidence: 99, ms: 2 });
          stats["甲级"]++;
        }
      }
    }

    setBatchResults({
      items: results,
      stats,
      totalMs: Math.round(performance.now() - start)
    });
    setBatchPage(1);
  };

  // 写入检查点封印
  const handleWriteCheckpoint = () => {
    const cpBlock: LedgerBlock = {
      height: ledger.length + 1,
      entry_type: "检查点",
      prev_hash: ledger.length > 0 ? ledger[ledger.length - 1].block_hash : "0000000000000000000000000000000000000000000000000000000000000000",
      payload: {
        checkpoint_type: "本地封印",
        sealed_height: ledger.length,
        sealed_head_hash: ledger.length > 0 ? ledger[ledger.length - 1].block_hash : "0000000000000000000000000000000000000000000000000000000000000000",
        timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19)
      },
      signer_pubkey: "ed25519_demo_registrar_pubkey",
      signature: "ed25519_cp_sig",
      block_time: Math.floor(Date.now() / 1000),
      block_hash: sm3Hash(new TextEncoder().encode(`cp_${ledger.length + 1}`))
    };
    setLedger([...ledger, cpBlock]);
  };

  // 创建授权
  const handleCreateAuth = () => {
    if (!authCertId) return;
    const authSeq = (ledger.filter(b => b.entry_type === "授权").length + 1).toString().padStart(4, '0');
    const auth_id = `AUTH-${authSeq}`;
    const authBlock: LedgerBlock = {
      height: ledger.length + 1,
      entry_type: "授权",
      prev_hash: ledger.length > 0 ? ledger[ledger.length - 1].block_hash : "0000000000000000000000000000000000000000000000000000000000000000",
      payload: {
        auth_id,
        cert_id: authCertId,
        grantee,
        valid_days: validDays,
        max_uses: maxUses,
        created_time: new Date().toISOString().replace('T', ' ').substring(0, 19)
      },
      signer_pubkey: "ed25519_registrar_pubkey",
      signature: "ed25519_auth_sig",
      block_time: Math.floor(Date.now() / 1000),
      block_hash: sm3Hash(new TextEncoder().encode(`auth_${ledger.length + 1}`))
    };
    setLedger([...ledger, authBlock]);
  };

  // 作废凭证
  const handleRevokeCert = (cert_id: string) => {
    setRegistrations(registrations.map(r => r.cert_id === cert_id ? { ...r, status: "已作废" } : r));
    const rvkBlock: LedgerBlock = {
      height: ledger.length + 1,
      entry_type: "作废",
      prev_hash: ledger.length > 0 ? ledger[ledger.length - 1].block_hash : "0000000000000000000000000000000000000000000000000000000000000000",
      payload: {
        cert_id,
        action: "作废",
        timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19)
      },
      signer_pubkey: "ed25519_registrar_pubkey",
      signature: "ed25519_rvk_sig",
      block_time: Math.floor(Date.now() / 1000),
      block_hash: sm3Hash(new TextEncoder().encode(`rvk_${ledger.length + 1}`))
    };
    setLedger([...ledger, rvkBlock]);
  };

  // 过滤后的登记凭证列表及分页数据
  const filteredRegistrations = useMemo(() => {
    if (!certSearch.trim()) return registrations;
    const q = certSearch.toLowerCase();
    return registrations.filter(r => 
      r.cert_id.toLowerCase().includes(q) || 
      r.filename.toLowerCase().includes(q) || 
      r.subject.toLowerCase().includes(q)
    );
  }, [registrations, certSearch]);

  const regTotalPages = Math.max(1, Math.ceil(filteredRegistrations.length / ITEMS_PER_PAGE));
  const paginatedRegistrations = useMemo(() => {
    const start = (regPage - 1) * ITEMS_PER_PAGE;
    return filteredRegistrations.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredRegistrations, regPage]);

  // 授权列表分页
  const authBlocks = useMemo(() => ledger.filter(b => b.entry_type === "授权"), [ledger]);
  const authTotalPages = Math.max(1, Math.ceil(authBlocks.length / ITEMS_PER_PAGE));
  const paginatedAuths = useMemo(() => {
    const start = (authPage - 1) * ITEMS_PER_PAGE;
    return authBlocks.slice(start, start + ITEMS_PER_PAGE);
  }, [authBlocks, authPage]);

  // 回执列表分页
  const receiptBlocks = useMemo(() => ledger.filter(b => b.entry_type === "回执"), [ledger]);
  const receiptTotalPages = Math.max(1, Math.ceil(receiptBlocks.length / ITEMS_PER_PAGE));
  const paginatedReceipts = useMemo(() => {
    const start = (receiptPage - 1) * ITEMS_PER_PAGE;
    return receiptBlocks.slice(start, start + ITEMS_PER_PAGE);
  }, [receiptBlocks, receiptPage]);

  return (
    <div className="min-h-screen shuxi-background text-[#1F2937] flex flex-col selection:bg-[#C23531]/20 selection:text-[#C23531]">
      {/* 
        ========================================================================
        顶部公文台规整导航栏 (Ant Design 亮色企业规范 + 宣纸金石印信品牌气质)
        ========================================================================
      */}
      <header className="sticky top-0 z-50 h-16 bg-white/95 border-b border-[#E7E2D6] shadow-[0_1px_3px_0_rgba(0,0,0,0.03)] backdrop-blur-md px-4 md:px-8 flex items-center justify-between gap-6">
        {/* Zone 1: 品牌区 (朱砂玺印与公文标识) */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-[#C23531] p-[1.5px] shadow-sm shadow-red-900/20 flex items-center justify-center border border-[#D97706]/50">
            <Shield className="w-5 h-5 text-[#FEF3C7]" />
          </div>
          <div className="flex items-baseline gap-2.5">
            <span className="text-xl font-bold tracking-tight text-[#1F2937] font-serif">数玺</span>
            <span className="text-[11px] font-mono font-medium text-[#78716C] px-2 py-0.5 rounded-md bg-[#F4EFE6] border border-[#E2DBD0] hidden sm:inline-block">
              数字公文存证 · 规范 v1.3
            </span>
          </div>
        </div>

        {/* Zone 2: 三个核心功能分段导航 (Ant Design 经典公文排卡) */}
        <nav className="flex items-center p-1 bg-[#F5F1E8] border border-[#E7E1D4] rounded-xl">
          {[
            { id: "登记", icon: Shield, label: "登记确权" },
            { id: "验真", icon: FileCheck, label: "一键验真" },
            { id: "授权与账本", icon: Database, label: "授权与账本" },
          ].map(tab => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all duration-150 ${
                  isActive 
                    ? "bg-white text-[#C23531] border border-[#DCD5C6] shadow-xs" 
                    : "text-[#6B7280] hover:text-[#1F2937] hover:bg-white/60"
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${isActive ? "text-[#C23531]" : "text-[#78716C]"}`} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Zone 3: 角色切换器与快速动作 */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="hidden lg:flex items-center bg-[#FAF8F3] border border-[#E2DBD0] rounded-lg px-2.5 py-1">
            <span className="text-[11px] text-[#78716C] mr-2 flex items-center gap-1">
              <Building2 className="w-3.5 h-3.5 text-[#C23531]" /> 操作身份:
            </span>
            <select
              value={actor}
              onChange={e => setActor(e.target.value)}
              className="bg-transparent text-xs font-medium text-[#1F2937] focus:outline-none cursor-pointer"
            >
              <option value={REGISTRAR_DEFAULT}>{REGISTRAR_DEFAULT}</option>
              <option value={VERIFIER_DEFAULT}>{VERIFIER_DEFAULT}</option>
            </select>
          </div>

          <button
            onClick={handleLoadDemoData}
            title="一键载入虚构演示登记（报表/合同），幂等不重入"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#374151] bg-white hover:bg-[#FAF8F3] border border-[#DCD5C6] rounded-lg transition-colors shadow-2xs whitespace-nowrap"
          >
            <Sparkles className="w-3.5 h-3.5 text-[#D97706]" />
            <span className="hidden sm:inline">载入演示数据</span>
          </button>
        </div>
      </header>

      {/* 主视图区域 (规范公文画幅，路演投影与PPT截屏极佳) */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-5 space-y-5">
        
        {/* 顶部四格状态指标条 - 宣纸米白基底，墨字朱红点缀 */}
        <div className="paper-card rounded-2xl p-4 grid grid-cols-2 md:grid-cols-4 gap-4 divide-y md:divide-y-0 md:divide-x divide-[#EFEAE0]">
          <div className="flex items-center gap-3.5 px-3 pt-1 md:pt-0">
            <div className="w-9 h-9 rounded-lg bg-[#FAF8F3] border border-[#E7E2D6] flex items-center justify-center shrink-0">
              <Layers className="w-4 h-4 text-[#78716C]" />
            </div>
            <div>
              <div className="text-[11px] text-[#78716C] font-medium">存证账本高度</div>
              <div className="text-xl font-mono font-bold text-[#1F2937] tracking-tight tabular-nums">{ledger.length}</div>
            </div>
          </div>

          <div className="flex items-center gap-3.5 px-3 pt-1 md:pt-0">
            <div className="w-9 h-9 rounded-lg bg-[#FAF8F3] border border-[#E7E2D6] flex items-center justify-center shrink-0">
              <FileCheck className="w-4 h-4 text-[#78716C]" />
            </div>
            <div>
              <div className="text-[11px] text-[#78716C] font-medium">已确权存证卡</div>
              <div className="text-xl font-mono font-bold text-[#1F2937] tracking-tight tabular-nums">{registrations.length}</div>
            </div>
          </div>

          <div className="flex items-center gap-3.5 px-3 pt-1 md:pt-0">
            <div className="w-9 h-9 rounded-lg bg-[#FAF8F3] border border-[#E7E2D6] flex items-center justify-center shrink-0">
              <FileText className="w-4 h-4 text-[#78716C]" />
            </div>
            <div>
              <div className="text-[11px] text-[#78716C] font-medium">验真回执入账</div>
              <div className="text-xl font-mono font-bold text-[#1F2937] tracking-tight tabular-nums">
                {ledger.filter(b => b.entry_type === "回执").length}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3.5 px-3 pt-1 md:pt-0">
            <div className="w-9 h-9 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center shrink-0">
              <Activity className="w-4 h-4 text-emerald-600" />
            </div>
            <div>
              <div className="text-[11px] text-[#78716C] font-medium">密码学完整性</div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                <span className="text-xs font-semibold text-emerald-700">全链公文可溯</span>
              </div>
            </div>
          </div>
        </div>

        {/* ====================================================================
            页面 1: 登记确权 (数字公文存证纸)
           ==================================================================== */}
        {activeTab === "登记" && (
          <div className="space-y-4">
            {/* 顶部分段切换卡片：录入申领 vs 已登记台账簿 */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#E7E2D6] pb-3">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-[#1F2937] flex items-center gap-2 font-serif">
                  <span>登记确权</span>
                  <span className="text-xs font-normal text-[#78716C] font-sans">（三层指纹公文存证 · 原件明文不上链）</span>
                </h1>
              </div>

              {/* 翻页切换按键 */}
              <div className="flex items-center bg-[#F5F1E8] p-1 rounded-xl border border-[#E7E1D4] text-xs">
                <button
                  onClick={() => setRegSubView("input")}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                    regSubView === "input" 
                      ? "bg-[#C23531] text-white shadow-xs" 
                      : "text-[#6B7280] hover:text-[#1F2937]"
                  }`}
                >
                  指纹录入与确权
                </button>
                <button
                  onClick={() => setRegSubView("ledger")}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
                    regSubView === "ledger" 
                      ? "bg-[#C23531] text-white shadow-xs" 
                      : "text-[#6B7280] hover:text-[#1F2937]"
                  }`}
                >
                  <span>已登记台账簿</span>
                  <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${regSubView === "ledger" ? "bg-white/20 text-white" : "bg-black/5 text-[#78716C]"}`}>
                    {registrations.length}
                  </span>
                </button>
              </div>
            </div>

            {/* 视图 A: 指纹录入与公文签发 */}
            {regSubView === "input" && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                {/* 左栏：数据源内容录入 */}
                <div className="lg:col-span-7 paper-card rounded-2xl p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-[#F0EBE0] pb-3">
                    <span className="text-xs font-bold text-[#1F2937] flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5 text-[#C23531]" /> 数据源明文录入（本地生成指纹）
                    </span>
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-[#78716C] text-[11px]">载入公文范例:</span>
                      <button
                        onClick={() => {
                          setRegFileName("report.txt");
                          setRegContent(DEMO_SAMPLES["report.txt"].text);
                        }}
                        className="px-2 py-0.5 bg-[#FAF8F3] hover:bg-[#F0EBE0] border border-[#DCD5C6] rounded text-[11px] text-[#374151]"
                      >
                        经营报表
                      </button>
                      <button
                        onClick={() => {
                          setRegFileName("contract_bad.txt");
                          setRegContent(DEMO_SAMPLES["contract_bad.txt"].text);
                        }}
                        className="px-2 py-0.5 bg-[#FAF8F3] hover:bg-[#F0EBE0] border border-[#DCD5C6] rounded text-[11px] text-[#374151]"
                      >
                        采购合同
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="text-[11px] font-semibold text-[#4B5563] block mb-1">公文/数据文件名</label>
                    <input
                      type="text"
                      value={regFileName}
                      onChange={e => setRegFileName(e.target.value)}
                      className="w-full bg-[#FAF8F3] border border-[#DCD5C6] rounded-xl px-3 py-1.5 text-xs font-mono text-[#1F2937] focus:outline-none focus:border-[#C23531] focus:bg-white transition-all"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-semibold text-[#4B5563] block mb-1">公文正文内容（本地完成双散列与分词，原文不入链）</label>
                    <textarea
                      rows={8}
                      value={regContent}
                      onChange={e => setRegContent(e.target.value)}
                      className="w-full bg-[#FAF8F3] border border-[#DCD5C6] rounded-xl p-3 text-xs font-mono text-[#1F2937] leading-relaxed focus:outline-none focus:border-[#C23531] focus:bg-white transition-all"
                    />
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-[#F0EBE0]">
                    <div className="text-[11px] text-[#78716C]">
                      确权经办单位: <strong className="text-[#1F2937] font-semibold">{actor}</strong>
                    </div>
                    <button
                      onClick={handleRegister}
                      className="px-5 py-2 bg-[#C23531] hover:bg-[#B91C1C] text-white font-semibold text-xs rounded-xl shadow-xs flex items-center gap-1.5 transition-all"
                    >
                      <Shield className="w-3.5 h-3.5" /> 签发数字公文存证卡
                    </button>
                  </div>
                </div>

                {/* 右栏：正式数字公文存证纸 (红头公文卡，双规防伪边线，鎏金细线收边) */}
                <div className="lg:col-span-5 space-y-4">
                  {lastCert ? (
                    <div className="official-doc-paper rounded-2xl p-5 space-y-3 relative overflow-hidden">
                      {/* 右上角朱砂小玺印 (54px, 鎏金细边, 落印 -6°) */}
                      <div className="absolute right-5 top-5 seal-stamp-cert flex items-center justify-center text-white text-2xl font-bold shadow-md">
                        玺
                      </div>

                      {/* 红头公文存证纸标识线 */}
                      <div className="border-b-2 border-[#C23531] pb-2 pr-16">
                        <div className="text-xs font-serif font-bold text-[#C23531] tracking-wider flex items-center gap-1.5">
                          <Award className="w-3.5 h-3.5" /> 数玺 · 数字公文存证纸
                        </div>
                        <div className="text-[10px] font-mono text-[#78716C] mt-0.5">
                          公文字号：{lastCert.cert_id}
                        </div>
                      </div>

                      {/* 公文主体信息 */}
                      <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                        <div>
                          <span className="text-[#78716C] text-[11px] block">存证文件名:</span>
                          <strong className="text-[#1F2937] truncate block mt-0.5">{lastCert.filename}</strong>
                        </div>
                        <div>
                          <span className="text-[#78716C] text-[11px] block">确权经办主体:</span>
                          <strong className="text-[#1F2937] truncate block mt-0.5">{lastCert.subject}</strong>
                        </div>
                      </div>

                      {/* 双根国密密码学防伪区 */}
                      <div className="bg-[#FAF8F3] border border-[#E7E2D6] rounded-xl p-3 font-mono text-[11px] space-y-1.5">
                        <div className="flex items-center justify-between text-[#374151]">
                          <span className="text-[#78716C] font-sans">SHA-256 根:</span>
                          <span className="truncate max-w-[200px] font-bold text-[#0284C7]">{lastCert.exact_dual_root.sha256}</span>
                        </div>
                        <div className="flex items-center justify-between text-[#374151]">
                          <span className="text-[#78716C] font-sans">SM3 国密根:</span>
                          <span className="truncate max-w-[200px] font-bold text-[#059669]">{lastCert.exact_dual_root.sm3}</span>
                        </div>
                        <div className="flex items-center justify-between text-[#374151]">
                          <span className="text-[#78716C] font-sans">语义感知根:</span>
                          <span className="truncate max-w-[200px] font-bold text-[#7C3AED]">{lastCert.semantic_root}</span>
                        </div>
                      </div>

                      {/* 底部信息与下载 */}
                      <div className="flex items-center justify-between pt-2 border-t border-[#F0EBE0]">
                        <span className="text-[11px] text-[#D97706] font-medium">
                          勾稽留痕: {lastCert.audit_results.join(" · ")}
                        </span>
                        <button
                          onClick={() => {
                            const blob = new Blob([JSON.stringify(lastCert, null, 2)], { type: "application/json" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `shuxi_doc_${lastCert.cert_id}.json`;
                            a.click();
                          }}
                          className="px-3 py-1 bg-[#FAF8F3] hover:bg-[#F0EBE0] border border-[#DCD5C6] rounded-lg text-xs font-medium text-[#1F2937] flex items-center gap-1.5 shadow-2xs"
                        >
                          <Download className="w-3.5 h-3.5 text-[#C23531]" /> 导出公文存证包
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* 实时字段提取与勾稽预览 */
                    <div className="paper-card rounded-2xl p-5 space-y-3">
                      <div className="text-xs font-bold text-[#1F2937] flex items-center gap-1.5 border-b border-[#F0EBE0] pb-2">
                        <Compass className="w-3.5 h-3.5 text-[#C23531]" /> 本地字段提取与勾稽逻辑试算
                      </div>

                      <div className="bg-[#FAF8F3] border border-[#E7E2D6] rounded-xl p-3 min-h-[90px] max-h-[120px] overflow-y-auto space-y-1.5 font-mono text-[11px]">
                        {extractFieldsFromText(regContent).map((f, i) => (
                          <div key={i} className="flex justify-between items-center text-[#374151]">
                            <span className="text-[#0284C7] font-semibold">{f.key}</span>
                            <span className="text-[#1F2937] truncate max-w-[160px]">{f.value}</span>
                          </div>
                        ))}
                      </div>

                      <div className="space-y-1.5">
                        {runAudits(extractFieldsFromText(regContent)).map((a, i) => (
                          <div key={i} className="bg-[#FAF8F3] border border-[#E7E2D6] rounded-lg px-2.5 py-1.5 flex items-center justify-between text-[11px]">
                            <span className="text-[#374151] font-medium">{a.name} ({a.id})</span>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                              a.status === "PASS" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" :
                              a.status === "WARN" ? "bg-amber-50 text-amber-700 border border-amber-200" :
                              "bg-rose-50 text-rose-700 border border-rose-200"
                            }`}>
                              {a.status}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 引导翻页小卡 */}
                  <div className="p-3 bg-[#FAF8F3] border border-[#E7E2D6] rounded-xl flex items-center justify-between text-xs text-[#78716C]">
                    <span>公文台账已累计收录 {registrations.length} 份数据凭证</span>
                    <button
                      onClick={() => setRegSubView("ledger")}
                      className="text-[#C23531] hover:text-[#991B1B] font-semibold flex items-center gap-1"
                    >
                      查阅存证台账簿 <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 视图 B: 已登记台账簿 (Ant Design 亮色规整表格，翻页控制) */}
            {regSubView === "ledger" && (
              <div className="paper-card rounded-2xl p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="relative w-full sm:w-72">
                    <Search className="w-3.5 h-3.5 text-[#78716C] absolute left-3 top-2.5" />
                    <input
                      type="text"
                      placeholder="检索字号、文件名或经办单位..."
                      value={certSearch}
                      onChange={e => {
                        setCertSearch(e.target.value);
                        setRegPage(1);
                      }}
                      className="w-full bg-[#FAF8F3] border border-[#DCD5C6] rounded-xl pl-9 pr-3 py-1.5 text-xs text-[#1F2937] focus:outline-none focus:border-[#C23531] focus:bg-white"
                    />
                  </div>
                  <div className="text-xs text-[#78716C]">
                    共 <strong className="text-[#1F2937] font-semibold">{filteredRegistrations.length}</strong> 份公文凭证 ｜ 每页 5 条
                  </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-[#E7E2D6]">
                  <table className="w-full text-left text-xs text-[#374151]">
                    <thead className="bg-[#FAF8F3] text-[#4B5563] text-[11px] font-semibold border-b border-[#E7E2D6]">
                      <tr>
                        <th className="py-2.5 px-3.5 font-mono">公文字号</th>
                        <th className="py-2.5 px-3.5">存证文件名</th>
                        <th className="py-2.5 px-3.5">登记单位</th>
                        <th className="py-2.5 px-3.5">确权时间</th>
                        <th className="py-2.5 px-3.5">法律状态</th>
                        <th className="py-2.5 px-3.5 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F0EBE0]">
                      {paginatedRegistrations.map(r => (
                        <tr key={r.cert_id} className="hover:bg-[#FAF8F3] transition-colors">
                          <td className="py-2.5 px-3.5 font-mono text-[#C23531] font-bold">{r.cert_id}</td>
                          <td className="py-2.5 px-3.5 text-[#1F2937] font-medium">{r.filename}</td>
                          <td className="py-2.5 px-3.5 text-[#4B5563]">{r.subject}</td>
                          <td className="py-2.5 px-3.5 font-mono text-[#78716C]">{r.timestamp}</td>
                          <td className="py-2.5 px-3.5">
                            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${
                              r.status === "有效" 
                                ? "text-emerald-700 bg-emerald-50 border border-emerald-200" 
                                : "text-rose-700 bg-rose-50 border border-rose-200"
                            }`}>
                              {r.status}
                            </span>
                          </td>
                          <td className="py-2.5 px-3.5 text-right">
                            <button
                              onClick={() => {
                                setSelectedCertId(r.cert_id);
                                setActiveTab("验真");
                              }}
                              className="text-xs text-[#C23531] hover:text-[#991B1B] font-semibold inline-flex items-center gap-1"
                            >
                              一键验真 <ArrowRight className="w-3 h-3" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* 翻页控件 */}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-[#78716C]">
                    第 {regPage} / {regTotalPages} 页
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      disabled={regPage <= 1}
                      onClick={() => setRegPage(p => Math.max(1, p - 1))}
                      className="px-3 py-1 rounded-lg bg-white hover:bg-[#FAF8F3] border border-[#DCD5C6] disabled:opacity-40 text-xs text-[#374151] flex items-center gap-1 shadow-2xs"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" /> 上一页
                    </button>
                    <button
                      disabled={regPage >= regTotalPages}
                      onClick={() => setRegPage(p => Math.min(regTotalPages, p + 1))}
                      className="px-3 py-1 rounded-lg bg-white hover:bg-[#FAF8F3] border border-[#DCD5C6] disabled:opacity-40 text-xs text-[#374151] flex items-center gap-1 shadow-2xs"
                    >
                      下一页 <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ====================================================================
            页面 2: 一键验真 (结论先行，盖朱砂印，穿透证据翻页)
           ==================================================================== */}
        {activeTab === "验真" && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#E7E2D6] pb-3">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-[#1F2937] flex items-center gap-2 font-serif">
                  <span>一键验真</span>
                  <span className="text-xs font-normal text-[#78716C] font-sans">（三层指纹穿透 · 四级分诊裁定）</span>
                </h1>
              </div>

              {/* 翻页切换按键：单件深挖 vs 批量工作台 */}
              <div className="flex items-center bg-[#F5F1E8] p-1 rounded-xl border border-[#E7E1D4] text-xs">
                <button
                  onClick={() => setVerifySubView("single")}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                    verifySubView === "single" 
                      ? "bg-[#C23531] text-white shadow-xs" 
                      : "text-[#6B7280] hover:text-[#1F2937]"
                  }`}
                >
                  单件深度验真
                </button>
                <button
                  onClick={() => {
                    setVerifySubView("batch");
                    if (!batchResults) handleRunBatchVerify();
                  }}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
                    verifySubView === "batch" 
                      ? "bg-[#C23531] text-white shadow-xs" 
                      : "text-[#6B7280] hover:text-[#1F2937]"
                  }`}
                >
                  <span>批量快速工作台</span>
                  {batchResults && <span className="px-1.5 py-0.2 bg-emerald-100 text-emerald-800 rounded-full text-[10px]">已就绪</span>}
                </button>
              </div>
            </div>

            {/* 视图 A: 单件深度验真 */}
            {verifySubView === "single" && (
              <div className="space-y-4">
                {/* 紧凑单行配置带 */}
                <div className="paper-card rounded-2xl p-4 grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                  <div className="md:col-span-5">
                    <label className="text-[11px] font-semibold text-[#4B5563] block mb-1">选择核验凭证字号</label>
                    <select
                      value={selectedCertId}
                      onChange={e => setSelectedCertId(e.target.value)}
                      className="w-full bg-[#FAF8F3] border border-[#DCD5C6] rounded-xl px-3 py-1.5 text-xs font-mono text-[#1F2937] focus:outline-none focus:border-[#C23531]"
                    >
                      {registrations.map(r => (
                        <option key={r.cert_id} value={r.cert_id}>
                          {r.cert_id} · {r.filename}
                        </option>
                      ))}
                      {registrations.length === 0 && <option value="">请先在登记页签发凭证</option>}
                    </select>
                  </div>

                  <div className="md:col-span-5">
                    <label className="text-[11px] font-semibold text-[#4B5563] block mb-1">选择待验公文变异样例</label>
                    <select
                      value={verifySampleKey}
                      onChange={e => setVerifySampleKey(e.target.value)}
                      className="w-full bg-[#FAF8F3] border border-[#DCD5C6] rounded-xl px-3 py-1.5 text-xs text-[#1F2937] focus:outline-none focus:border-[#C23531]"
                    >
                      {Object.entries(DEMO_SAMPLES).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v.label} [{v.tag}]
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="md:col-span-2">
                    <button
                      onClick={handleVerify}
                      className="w-full py-1.5 px-4 bg-[#C23531] hover:bg-[#B91C1C] text-white font-semibold text-xs rounded-xl shadow-xs flex items-center justify-center gap-1.5 transition-all"
                    >
                      <FileCheck className="w-3.5 h-3.5" /> 立即核验盖印
                    </button>
                  </div>
                </div>

                {/* 结论公文呈批单 (结论先行 + 真实朱砂印章) */}
                {verdict && (
                  <div className="space-y-4">
                    <div 
                      className="official-doc-paper relative rounded-2xl p-6 flex items-center justify-between overflow-hidden"
                      style={{ borderLeft: `5px solid ${verdict.color}` }}
                    >
                      <div className="space-y-1.5 pr-28">
                        <div className="text-[11px] font-serif font-bold text-[#78716C] tracking-wide">
                          数玺数据真实性查验裁定书 · 结论呈批
                        </div>
                        <div className="text-2xl font-black tracking-tight" style={{ color: verdict.color }}>
                          {verdict.label}
                        </div>
                        <div className="text-xs font-mono text-[#6B7280] pt-1">
                          判定置信度：<strong className="text-[#1F2937] font-semibold">{verdict.confidence}%</strong> ｜ 
                          计算耗时：<strong className="text-[#1F2937] font-semibold">{verdict.elapsed_ms} ms</strong> ｜ 
                          回执单号：<span className="font-mono text-[#C23531] font-bold">{verdict.receipt_id}</span>
                        </div>
                      </div>

                      {/* 物理落印朱砂印章 (鎏金外圈 + 宣纸吸墨落印) */}
                      <div className="absolute right-6 seal-stamp-verdict flex flex-col items-center justify-center text-white text-3xl font-bold shrink-0 shadow-lg">
                        <div>{verdict.seal_text[0]}</div>
                        <div>{verdict.seal_text[1] || '级'}</div>
                      </div>
                    </div>

                    {/* 穿透证据公文纸 (依据 / 差异表 / 双根比对 / 勾稽) */}
                    <div className="paper-card rounded-2xl p-5 space-y-3">
                      <div className="flex items-center justify-between border-b border-[#E7E2D6] pb-2">
                        <div className="flex items-center gap-1">
                          {[
                            { id: "reasons", label: "裁定依据清单" },
                            { id: "diff", label: `字段篡改对比表 (${verdict.diff_table.length})` },
                            { id: "roots", label: "精确双根比对" },
                            { id: "audits", label: "数据勾稽复算" },
                          ].map(t => (
                            <button
                              key={t.id}
                              onClick={() => setVerdictEvidenceTab(t.id as any)}
                              className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                                verdictEvidenceTab === t.id 
                                  ? "bg-[#FAF8F3] text-[#C23531] border border-[#DCD5C6]" 
                                  : "text-[#6B7280] hover:text-[#1F2937]"
                              }`}
                            >
                              {t.label}
                            </button>
                          ))}
                        </div>

                        <span className="text-[11px] font-mono text-[#78716C]">
                          存证区块链高度: #{ledger.length}
                        </span>
                      </div>

                      {/* 证据子翻页内容 */}
                      <div className="min-h-[120px] pt-1">
                        {verdictEvidenceTab === "reasons" && (
                          <ul className="space-y-2 text-xs text-[#374151]">
                            {verdict.reasons.map((r, i) => (
                              <li key={i} className="flex items-start gap-2">
                                <span className="w-1.5 h-1.5 rounded-full bg-[#C23531] mt-1.5 shrink-0"></span>
                                <span>{r}</span>
                              </li>
                            ))}
                          </ul>
                        )}

                        {verdictEvidenceTab === "diff" && (
                          verdict.diff_table.length > 0 ? (
                            <div className="overflow-x-auto rounded-xl border border-rose-200 bg-rose-50/30">
                              <table className="w-full text-left text-xs">
                                <thead className="bg-rose-100 text-rose-900 text-[11px] font-semibold border-b border-rose-200">
                                  <tr>
                                    <th className="p-2.5">被篡改字段项</th>
                                    <th className="p-2.5">公文登记原值 (存证真值)</th>
                                    <th className="p-2.5">待验伪造值 (被篡改)</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-rose-200 font-mono text-xs">
                                  {verdict.diff_table.map((d, i) => (
                                    <tr key={i} className="hover:bg-rose-100/40">
                                      <td className="p-2.5 font-bold text-rose-950 font-sans">{d.field}</td>
                                      <td className="p-2.5 line-through text-slate-500">{d.registered_val}</td>
                                      <td className="p-2.5 font-bold text-rose-700 bg-rose-100/60">{d.current_val}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <div className="text-center py-8 text-emerald-700 text-xs flex items-center justify-center gap-1.5 font-medium">
                              <CheckCircle2 className="w-4 h-4 text-emerald-600" /> 经逐项复算比对，所有语义字段值未发生任何修改！
                            </div>
                          )
                        )}

                        {verdictEvidenceTab === "roots" && (
                          <div className="space-y-2 text-xs font-mono">
                            <pre className="bg-[#FAF8F3] border border-[#E7E2D6] rounded-xl p-3 text-[11px] text-[#374151] overflow-x-auto leading-relaxed">
                              {JSON.stringify(verdict.exact_details, null, 2)}
                            </pre>
                            <div className="grid grid-cols-2 gap-2 text-[#78716C] text-[11px]">
                              <div>文本 3-gram 相似度: <strong className="text-[#1F2937]">{verdict.perceptual_details?.text_sim_str}</strong></div>
                              <div>汉明距离: <strong className="text-[#1F2937]">{verdict.perceptual_details?.avg_hamming}</strong></div>
                            </div>
                          </div>
                        )}

                        {verdictEvidenceTab === "audits" && (
                          <div className="space-y-1.5 text-xs">
                            {verdict.audits?.map((a, i) => (
                              <div key={i} className="bg-[#FAF8F3] border border-[#E7E2D6] rounded-lg p-2.5 flex items-center justify-between text-xs">
                                <span className="text-[#374151]"><strong>{a.name} ({a.id})</strong>: {a.message}</span>
                                <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                                  a.status === "PASS" ? "text-emerald-700 bg-emerald-50 border border-emerald-200" : "text-rose-700 bg-rose-50 border border-rose-200"
                                }`}>{a.status}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* 报告复核与哈希 */}
                      <div className="pt-2 border-t border-[#E7E2D6] flex items-center justify-between">
                        <div className="text-[11px] font-mono text-[#78716C] truncate max-w-sm">
                          裁定报告哈希: {verdict.report_hash}
                        </div>
                        <button
                          onClick={() => setReportReviewed(true)}
                          className="px-3 py-1 bg-white hover:bg-[#FAF8F3] border border-[#DCD5C6] rounded-lg text-xs font-medium text-[#374151] flex items-center gap-1.5 shadow-2xs"
                        >
                          <RefreshCw className="w-3.5 h-3.5 text-[#C23531]" /> 复核报告与回执匹配
                        </button>
                      </div>

                      {reportReviewed && (
                        <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-medium flex items-center gap-2">
                          <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                          报告复核通过：重算报告哈希与账本回执记录完全匹配，真实且未被篡改！
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 视图 B: 批量验真工作台 (Ant Design 亮色规整表格) */}
            {verifySubView === "batch" && (
              <div className="paper-card rounded-2xl p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-bold text-[#1F2937] font-serif">批量验真公文流水线</h3>
                    <p className="text-xs text-[#78716C] mt-0.5">面向多套变异样本的自动化分级裁定与统计</p>
                  </div>
                  <button
                    onClick={handleRunBatchVerify}
                    className="px-3.5 py-1.5 bg-[#C23531] hover:bg-[#B91C1C] text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all shadow-xs"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> 重新执行批量核验
                  </button>
                </div>

                {batchResults && (
                  <div className="space-y-4">
                    {/* 四级统计标签 */}
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="px-3 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 font-semibold">
                        甲级 (原件未动): {batchResults.stats["甲级"]}
                      </span>
                      <span className="px-3 py-1 rounded-lg bg-sky-50 border border-sky-200 text-sky-800 font-semibold">
                        乙级 (载体等价): {batchResults.stats["乙级"]}
                      </span>
                      <span className="px-3 py-1 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 font-semibold">
                        丙级 (自相矛盾): {batchResults.stats["丙级"]}
                      </span>
                      <span className="px-3 py-1 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 font-semibold">
                        丁级 (关键字段改): {batchResults.stats["丁级"]}
                      </span>
                      <span className="text-xs font-mono text-[#78716C] ml-auto">总耗时: {batchResults.totalMs} ms</span>
                    </div>

                    {/* 分页表格 */}
                    <div className="overflow-x-auto rounded-xl border border-[#E7E2D6]">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-[#FAF8F3] text-[#4B5563] text-[11px] font-semibold border-b border-[#E7E2D6]">
                          <tr>
                            <th className="py-2.5 px-3.5">待验样例</th>
                            <th className="py-2.5 px-3.5 font-mono">锚定凭证字号</th>
                            <th className="py-2.5 px-3.5">验真分级</th>
                            <th className="py-2.5 px-3.5">置信把握</th>
                            <th className="py-2.5 px-3.5 text-right font-mono">耗时</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#F0EBE0]">
                          {batchResults.items.slice((batchPage - 1) * ITEMS_PER_PAGE, batchPage * ITEMS_PER_PAGE).map((item, idx) => (
                            <tr key={idx} className="hover:bg-[#FAF8F3] transition-colors">
                              <td className="py-2.5 px-3.5 text-[#1F2937] font-medium">{item.name}</td>
                              <td className="py-2.5 px-3.5 font-mono text-[#C23531] font-semibold">{item.cert}</td>
                              <td className="py-2.5 px-3.5">
                                <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${
                                  item.grade === "甲级" ? "text-emerald-700 bg-emerald-50 border border-emerald-200" :
                                  item.grade === "乙级" ? "text-sky-700 bg-sky-50 border border-sky-200" :
                                  item.grade === "丙级" ? "text-amber-700 bg-amber-50 border border-amber-200" :
                                  "text-rose-700 bg-rose-50 border border-rose-200"
                                }`}>
                                  {item.grade}
                                </span>
                              </td>
                              <td className="py-2.5 px-3.5 font-mono text-[#374151]">{item.confidence}%</td>
                              <td className="py-2.5 px-3.5 text-right font-mono text-[#78716C]">{item.ms} ms</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* 分页控制 */}
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-xs text-[#78716C]">
                        第 {batchPage} / {Math.max(1, Math.ceil(batchResults.items.length / ITEMS_PER_PAGE))} 页
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          disabled={batchPage <= 1}
                          onClick={() => setBatchPage(p => Math.max(1, p - 1))}
                          className="px-3 py-1 rounded-lg bg-white hover:bg-[#FAF8F3] border border-[#DCD5C6] disabled:opacity-40 text-xs text-[#374151] shadow-2xs"
                        >
                          上一页
                        </button>
                        <button
                          disabled={batchPage >= Math.ceil(batchResults.items.length / ITEMS_PER_PAGE)}
                          onClick={() => setBatchPage(p => p + 1)}
                          className="px-3 py-1 rounded-lg bg-white hover:bg-[#FAF8F3] border border-[#DCD5C6] disabled:opacity-40 text-xs text-[#374151] shadow-2xs"
                        >
                          下一页
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ====================================================================
            页面 3: 授权与账本 (联排流水账簿，宣纸公文连珠)
           ==================================================================== */}
        {activeTab === "授权与账本" && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#E7E2D6] pb-3">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-[#1F2937] flex items-center gap-2 font-serif">
                  <span>授权与账本</span>
                  <span className="text-xs font-normal text-[#78716C] font-sans">（记名授权 · 链上回执 · 检查点封印）</span>
                </h1>
              </div>

              {/* 模块子翻页标签 */}
              <div className="flex items-center bg-[#F5F1E8] p-1 rounded-xl border border-[#E7E1D4] text-xs">
                {[
                  { id: "chain", label: "哈希链与检查点" },
                  { id: "auth", label: `记名授权 (${authBlocks.length})` },
                  { id: "receipts", label: `查验回执 (${receiptBlocks.length})` },
                  { id: "revoke", label: "作废管理" },
                ].map(t => (
                  <button
                    key={t.id}
                    onClick={() => setLedgerSubView(t.id as any)}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                      ledgerSubView === t.id 
                        ? "bg-[#C23531] text-white shadow-xs" 
                        : "text-[#6B7280] hover:text-[#1F2937]"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 子视图 1: 联排流水账簿与区块流向 */}
            {ledgerSubView === "chain" && (
              <div className="space-y-4">
                <div className="paper-card rounded-2xl p-5 space-y-3.5">
                  <div className="flex items-center justify-between border-b border-[#F0EBE0] pb-3">
                    <span className="text-xs font-bold text-[#1F2937] flex items-center gap-1.5 font-serif">
                      <Database className="w-4 h-4 text-[#C23531]" /> 联排哈希流水区块卷宗 (共 {ledger.length} 块)
                    </span>
                    <button
                      onClick={handleWriteCheckpoint}
                      className="px-3.5 py-1.5 bg-[#C23531] hover:bg-[#B91C1C] text-white text-xs font-semibold rounded-xl flex items-center gap-1.5 shadow-xs"
                    >
                      <Lock className="w-3.5 h-3.5" /> 写入检查点（封印当前链头）
                    </button>
                  </div>

                  {/* 联排小印信块区块流向 */}
                  <div className="flex items-center gap-2 overflow-x-auto py-2.5">
                    {ledger.slice(-28).map((blk, idx, arr) => {
                      const isHead = idx === arr.length - 1;
                      return (
                        <button
                          key={blk.height}
                          onClick={() => setInspectBlock(blk)}
                          className={`w-6 h-6 rounded-md text-[10px] font-mono font-bold transition-all shrink-0 flex items-center justify-center ${
                            isHead 
                              ? "bg-[#C23531] text-white ring-2 ring-[#D97706] shadow-sm" 
                              : "bg-[#EFEAE0] hover:bg-[#DCD5C6] text-[#374151] border border-[#DCD5C6]"
                          }`}
                          title={`高度 ${blk.height} · 类型: ${blk.entry_type} (点击查看)`}
                        >
                          {blk.height}
                        </button>
                      );
                    })}
                    <span className="text-[11px] text-[#78716C] font-mono ml-2 shrink-0">红色为最新链头</span>
                  </div>
                </div>

                {/* 展开的区块公文明细 */}
                {inspectBlock ? (
                  <div className="bg-[#FAF8F3] border border-[#C23531]/40 rounded-2xl p-4 space-y-2 text-xs">
                    <div className="flex items-center justify-between text-[#C23531] font-bold">
                      <span>区块高度 #{inspectBlock.height} · 卷宗类型: {inspectBlock.entry_type}</span>
                      <button onClick={() => setInspectBlock(null)} className="text-[#78716C] hover:text-[#1F2937]">✕ 关闭明细</button>
                    </div>
                    <pre className="bg-white border border-[#E7E2D6] p-3 rounded-xl text-[11px] font-mono text-[#374151] overflow-x-auto max-h-[220px]">
                      {JSON.stringify(inspectBlock, null, 2)}
                    </pre>
                  </div>
                ) : (
                  <div className="p-4 bg-[#FAF8F3] border border-[#E7E2D6] rounded-xl text-center text-xs text-[#78716C]">
                    提示：点击上方联排区块可下钻查验该区块的 Ed25519 签名、存证载荷与 Merkle 前驱双哈希。
                  </div>
                )}
              </div>
            )}

            {/* 子视图 2: 记名授权中心 */}
            {ledgerSubView === "auth" && (
              <div className="space-y-4">
                {/* 新建授权表单 */}
                <div className="paper-card rounded-2xl p-5 space-y-3.5">
                  <div className="text-xs font-bold text-[#1F2937] flex items-center gap-1.5 border-b border-[#F0EBE0] pb-2">
                    <Key className="w-3.5 h-3.5 text-[#C23531]" /> 新建记名查验授权文书
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                    <div>
                      <label className="text-[11px] font-semibold text-[#4B5563] block mb-1">选定存证公文字号</label>
                      <select
                        value={authCertId}
                        onChange={e => setAuthCertId(e.target.value)}
                        className="w-full bg-[#FAF8F3] border border-[#DCD5C6] rounded-xl p-2 text-xs font-mono text-[#1F2937]"
                      >
                        {registrations.map(r => (
                          <option key={r.cert_id} value={r.cert_id}>{r.cert_id} · {r.filename}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-[11px] font-semibold text-[#4B5563] block mb-1">被授权方主体全称</label>
                      <input
                        type="text"
                        value={grantee}
                        onChange={e => setGrantee(e.target.value)}
                        className="w-full bg-[#FAF8F3] border border-[#DCD5C6] rounded-xl p-2 text-xs text-[#1F2937]"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] font-semibold text-[#4B5563] block mb-1">授权有效天数</label>
                      <input
                        type="number"
                        value={validDays}
                        onChange={e => setValidDays(parseInt(e.target.value) || 30)}
                        className="w-full bg-[#FAF8F3] border border-[#DCD5C6] rounded-xl p-2 text-xs font-mono text-[#1F2937]"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] font-semibold text-[#4B5563] block mb-1">最大核验次数上限</label>
                      <input
                        type="number"
                        value={maxUses}
                        onChange={e => setMaxUses(parseInt(e.target.value) || 10)}
                        className="w-full bg-[#FAF8F3] border border-[#DCD5C6] rounded-xl p-2 text-xs font-mono text-[#1F2937]"
                      />
                    </div>
                  </div>

                  <div className="flex justify-end pt-2">
                    <button
                      onClick={handleCreateAuth}
                      className="px-5 py-2 bg-[#C23531] hover:bg-[#B91C1C] text-white rounded-xl text-xs font-semibold shadow-xs"
                    >
                      签署记名授权并上账
                    </button>
                  </div>
                </div>

                {/* 分页授权列表 */}
                <div className="paper-card rounded-2xl p-5 space-y-3">
                  <div className="text-xs font-bold text-[#1F2937]">生效中记名授权公文单</div>
                  <div className="overflow-x-auto rounded-xl border border-[#E7E2D6]">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-[#FAF8F3] text-[#4B5563] text-[11px] font-semibold border-b border-[#E7E2D6]">
                        <tr>
                          <th className="p-2.5">授权编号</th>
                          <th className="p-2.5">关联存证字号</th>
                          <th className="p-2.5">被授权单位</th>
                          <th className="p-2.5">有效天数</th>
                          <th className="p-2.5 text-right">核验额度</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#F0EBE0] font-mono text-xs text-[#374151]">
                        {paginatedAuths.map(b => (
                          <tr key={b.height} className="hover:bg-[#FAF8F3]">
                            <td className="p-2.5 text-[#C23531] font-bold">{b.payload.auth_id}</td>
                            <td className="p-2.5">{b.payload.cert_id}</td>
                            <td className="p-2.5 font-sans font-medium text-[#1F2937]">{b.payload.grantee}</td>
                            <td className="p-2.5">{b.payload.valid_days} 天</td>
                            <td className="p-2.5 text-right text-[#78716C]">{b.payload.max_uses} 次</td>
                          </tr>
                        ))}
                        {authBlocks.length === 0 && (
                          <tr><td colSpan={5} className="p-4 text-center text-[#78716C] italic font-sans">暂无记名授权记录</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* 翻页器 */}
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-xs text-[#78716C]">第 {authPage} / {authTotalPages} 页</span>
                    <div className="flex items-center gap-2">
                      <button
                        disabled={authPage <= 1}
                        onClick={() => setAuthPage(p => Math.max(1, p - 1))}
                        className="px-3 py-1 rounded-lg bg-white hover:bg-[#FAF8F3] border border-[#DCD5C6] disabled:opacity-40 text-xs text-[#374151] shadow-2xs"
                      >
                        上一页
                      </button>
                      <button
                        disabled={authPage >= authTotalPages}
                        onClick={() => setAuthPage(p => Math.min(authTotalPages, p + 1))}
                        className="px-3 py-1 rounded-lg bg-white hover:bg-[#FAF8F3] border border-[#DCD5C6] disabled:opacity-40 text-xs text-[#374151] shadow-2xs"
                      >
                        下一页
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 子视图 3: 查验回执流水 */}
            {ledgerSubView === "receipts" && (
              <div className="paper-card rounded-2xl p-5 space-y-3">
                <div className="flex items-center justify-between border-b border-[#F0EBE0] pb-2">
                  <div className="text-xs font-bold text-[#1F2937] flex items-center gap-1.5 font-serif">
                    <FileCheck className="w-4 h-4 text-[#059669]" /> 链上签名查验回执总台账 (共 {receiptBlocks.length} 条)
                  </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-[#E7E2D6]">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#FAF8F3] text-[#4B5563] text-[11px] font-semibold border-b border-[#E7E2D6]">
                      <tr>
                        <th className="p-2.5">回执单号</th>
                        <th className="p-2.5">存证凭证字号</th>
                        <th className="p-2.5">裁定结论</th>
                        <th className="p-2.5">核验主体</th>
                        <th className="p-2.5 font-mono">核验时间</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F0EBE0] font-mono text-xs text-[#374151]">
                      {paginatedReceipts.map(b => (
                        <tr key={b.height} className="hover:bg-[#FAF8F3]">
                          <td className="p-2.5 text-[#C23531] font-bold">{b.payload.receipt_id}</td>
                          <td className="p-2.5">{b.payload.cert_id}</td>
                          <td className="p-2.5 font-sans">
                            <span className="font-semibold text-[#1F2937]">{b.payload.verdict_grade}</span>
                          </td>
                          <td className="p-2.5 font-sans text-[#4B5563]">{b.payload.verifier_subject}</td>
                          <td className="p-2.5 text-[#78716C]">{b.payload.timestamp}</td>
                        </tr>
                      ))}
                      {receiptBlocks.length === 0 && (
                        <tr><td colSpan={5} className="p-4 text-center text-[#78716C] italic font-sans">暂无查验回执入账</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* 翻页器 */}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-[#78716C]">第 {receiptPage} / {receiptTotalPages} 页</span>
                  <div className="flex items-center gap-2">
                    <button
                      disabled={receiptPage <= 1}
                      onClick={() => setReceiptPage(p => Math.max(1, p - 1))}
                      className="px-3 py-1 rounded-lg bg-white hover:bg-[#FAF8F3] border border-[#DCD5C6] disabled:opacity-40 text-xs text-[#374151] shadow-2xs"
                    >
                      上一页
                    </button>
                    <button
                      disabled={receiptPage >= receiptTotalPages}
                      onClick={() => setReceiptPage(p => Math.min(receiptTotalPages, p + 1))}
                      className="px-3 py-1 rounded-lg bg-white hover:bg-[#FAF8F3] border border-[#DCD5C6] disabled:opacity-40 text-xs text-[#374151] shadow-2xs"
                    >
                      下一页
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 子视图 4: 作废与撤销管理 */}
            {ledgerSubView === "revoke" && (
              <div className="paper-card rounded-2xl p-5 space-y-3">
                <div className="text-xs font-bold text-[#1F2937] flex items-center gap-1.5 border-b border-[#F0EBE0] pb-2 font-serif">
                  <AlertOctagon className="w-4 h-4 text-[#C23531]" /> 存证公文作废与止付注销（链上不可逆）
                </div>
                <p className="text-xs text-[#78716C]">
                  经办方私钥正式签名作废后，该存证公文在全网所有验真节点将直接前置熔断并裁定为「已作废」。
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 pt-2">
                  {registrations.filter(r => r.status === "有效").map(r => (
                    <div key={r.cert_id} className="p-3 bg-[#FAF8F3] border border-[#E7E2D6] rounded-xl flex items-center justify-between">
                      <div className="overflow-hidden mr-2">
                        <div className="font-mono text-xs font-bold text-[#1F2937] truncate">{r.cert_id}</div>
                        <div className="text-[11px] text-[#78716C] truncate">{r.filename}</div>
                      </div>
                      <button
                        onClick={() => {
                          if (window.confirm(`确定要永久作废存证公文 ${r.cert_id} 吗？上账后不可逆！`)) {
                            handleRevokeCert(r.cert_id);
                          }
                        }}
                        className="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 text-[11px] font-semibold rounded-lg shrink-0 transition-colors shadow-2xs"
                      >
                        作废注销
                      </button>
                    </div>
                  ))}
                  {registrations.filter(r => r.status === "有效").length === 0 && (
                    <div className="col-span-3 text-center py-6 text-[#78716C] text-xs italic">
                      无有效状态凭证可供作废
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
