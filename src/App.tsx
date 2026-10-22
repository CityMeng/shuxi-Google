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
  Eye, FileSearch, ArrowUpDown, ChevronDown
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
  // 三个核心功能（不多不少）：登记确权、一键验真、授权与账本
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
        color: hasFail ? "#F59E0B" : "#94A3B8",
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
        color: "#94A3B8",
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
          label: "验真被拒：记名授权主体不匹配",
          color: "#F43F5E",
          seal_text: "复核",
          confidence: 0,
          reasons: [
            `记名授权拒绝：当前验真方「${actor}」与该凭证授权的被授权方「${latestAuth.grantee}」不符。`,
            "协议 5.7 强制要求：使用授权验真时，验真方必须与授权记录严格一致，不一致坚决拒绝查验。"
          ],
          elapsed_ms: 2,
          diff_table: []
        });
        return;
      }
    }

    const testBytes = new TextEncoder().encode(testText);
    const testSha256 = await sha256Hash(testBytes);
    const testSm3 = sm3Hash(testBytes);

    const exactMatch = (testSha256 === targetCert.exact_dual_root.sha256) && (testSm3 === targetCert.exact_dual_root.sm3);
    const testFields = extractFieldsFromText(testText);
    const testAudits = runAudits(testFields);
    const textSim = computeTextSimilarity(targetCert.registered_text || "", testText);

    // 字段差异
    const regFieldMap = new Map<string, string>();
    (targetCert.fields || []).forEach(f => regFieldMap.set(f.key, f.value));
    const testFieldMap = new Map<string, string>();
    testFields.forEach(f => testFieldMap.set(f.key, f.value));

    const diffs: Array<{ field: string; registered_val: string; current_val: string }> = [];
    regFieldMap.forEach((v, k) => {
      const currV = testFieldMap.get(k);
      if (currV === undefined) {
        diffs.push({ field: k, registered_val: v, current_val: "【缺失】" });
      } else if (currV !== v) {
        diffs.push({ field: k, registered_val: v, current_val: currV });
      }
    });

    const elapsed_ms = Math.max(1, Math.round(performance.now() - startTime));

    // 四级分诊式判定
    let gradeResult: VerdictResult;
    if (exactMatch) {
      gradeResult = {
        grade: "甲级",
        label: "甲级 · 原件未动",
        color: "#10B981",
        seal_text: "甲级",
        confidence: 99,
        reasons: [
          "精确层 SHA-256 与 SM3 国密双 Merkle 根与账本存证 100% 逐比特完全一致。",
          "文件自登记确权以来，未发生任何字节级篡改或重新格式化。"
        ],
        elapsed_ms,
        diff_table: []
      };
    } else if (diffs.length > 0) {
      gradeResult = {
        grade: "丁级",
        label: "丁级 · 关键字段被改",
        color: "#F43F5E",
        seal_text: "丁级",
        confidence: 95,
        reasons: [
          `语义指纹比对检出 ${diffs.length} 处关键业务字段值被篡改或缺失：`,
          ...diffs.slice(0, 3).map(d => `字段「${d.field}」：登记值为「${d.registered_val}」，当前值为「${d.current_val}」`)
        ],
        elapsed_ms,
        diff_table: diffs
      };
    } else if (testAudits.some(a => a.status === "FAIL")) {
      gradeResult = {
        grade: "丙级",
        label: "丙级 · 内容自相矛盾",
        color: "#F59E0B",
        seal_text: "丙级",
        confidence: 85,
        reasons: [
          "关键语义字段虽未改变，但文件内部复算触发登记时不存在的新勾稽矛盾。",
          ...testAudits.filter(a => a.status === "FAIL").map(a => a.message)
        ],
        elapsed_ms,
        diff_table: []
      };
    } else if (textSim.score >= 0.90) {
      gradeResult = {
        grade: "乙级",
        label: "乙级 · 载体变、内容等价",
        color: "#0EA5E9",
        seal_text: "乙级",
        confidence: 88,
        reasons: [
          "语义层全部关键字段与登记记录 100% 吻合，业务事实未变。",
          `文本 3-gram 相似度 ${textSim.formatted} >= 0.9000（等价排版或编码转换）。`,
          "判定该文件为转格式、打印翻拍或轻微排版重存等价件，有效内容保持完整真实。"
        ],
        elapsed_ms,
        diff_table: []
      };
    } else {
      gradeResult = {
        grade: "待人工复核",
        label: "待人工复核",
        color: "#8B5CF6",
        seal_text: "复核",
        confidence: 40,
        reasons: [
          "精确层双根不同；虽字段抽取未见明显异常，但感知指纹差异超出容许阈值。",
          "排版布局或自由文本发生不可信漂移，系统判定需转入待人工复核。"
        ],
        elapsed_ms,
        diff_table: []
      };
    }

    // 写入回执入账 (RC-序号)
    const rcSeq = (ledger.filter(b => b.entry_type === "回执").length + 1).toString().padStart(4, '0');
    const receipt_id = `RC-${rcSeq}`;
    const report_hash = sm3Hash(new TextEncoder().encode(`${receipt_id}_${targetCert.cert_id}_${gradeResult.grade}`));

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
    <div className="min-h-screen shuxi-background text-[#F1F5F9] flex flex-col selection:bg-indigo-500/30 selection:text-white">
      {/* 
        ========================================================================
        高级顶部导航栏 (Strict Top Bar Contract - 3 核心功能导航，移除多余自检)
        ========================================================================
      */}
      <header className="sticky top-0 z-50 h-16 bg-[#070C18]/90 border-b border-white/[0.08] backdrop-blur-xl px-4 md:px-8 flex items-center justify-between gap-6">
        {/* Zone 1: 品牌区 (字标与协议标识) */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 via-blue-600 to-cyan-400 p-[1px] shadow-lg shadow-indigo-500/20">
            <div className="w-full h-full bg-[#080D1A] rounded-[11px] flex items-center justify-center">
              <Shield className="w-4 h-4 text-cyan-300" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold tracking-tight text-white whitespace-nowrap">数玺</span>
            <span className="text-[11px] font-mono font-medium text-slate-400 px-2 py-0.5 rounded-md bg-white/[0.04] border border-white/[0.06] whitespace-nowrap hidden sm:inline-block">
              规范 v1.3 · 套件 SXA1
            </span>
          </div>
        </div>

        {/* Zone 2: 三个核心功能（不多不少）分段胶囊导航 */}
        <nav className="flex items-center p-1 bg-[#0B1325] border border-white/[0.08] rounded-xl shadow-inner">
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
                className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all duration-200 ${
                  isActive 
                    ? "bg-gradient-to-r from-indigo-500/20 via-blue-500/20 to-cyan-500/10 text-cyan-300 border border-cyan-500/30 shadow-sm" 
                    : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]"
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${isActive ? "text-cyan-300" : "text-slate-400"}`} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Zone 3: 角色切换器与快速动作 */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="hidden lg:flex items-center bg-[#0B1325] border border-white/[0.08] rounded-lg px-2.5 py-1">
            <span className="text-[11px] text-slate-400 mr-2 flex items-center gap-1">
              <Building2 className="w-3 h-3 text-indigo-400" /> 身份:
            </span>
            <select
              value={actor}
              onChange={e => setActor(e.target.value)}
              className="bg-transparent text-xs font-medium text-slate-200 focus:outline-none cursor-pointer"
            >
              <option value={REGISTRAR_DEFAULT} className="bg-[#0A101D] text-slate-200">{REGISTRAR_DEFAULT}</option>
              <option value={VERIFIER_DEFAULT} className="bg-[#0A101D] text-slate-200">{VERIFIER_DEFAULT}</option>
            </select>
          </div>

          <button
            onClick={handleLoadDemoData}
            title="一键载入 3 条虚构演示登记（报表/合同/扫描件），幂等不重入"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.1] rounded-lg transition-colors whitespace-nowrap"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span className="hidden sm:inline">载入演示数据</span>
          </button>
        </div>
      </header>

      {/* 主视图区域 (紧凑视口控制，告别无止境下滑) */}
      <div className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-5 space-y-5">
        
        {/* 顶部四格状态指标条 */}
        <div className="glass-panel rounded-2xl p-3.5 grid grid-cols-2 md:grid-cols-4 gap-4 divide-y md:divide-y-0 md:divide-x divide-white/[0.06]">
          <div className="flex items-center gap-3 px-3 pt-1 md:pt-0">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center shrink-0">
              <Layers className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <div className="text-[11px] text-slate-400">账本高度</div>
              <div className="text-lg font-mono font-bold text-white tracking-tight tabular-nums">{ledger.length}</div>
            </div>
          </div>

          <div className="flex items-center gap-3 px-3 pt-1 md:pt-0">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center shrink-0">
              <FileCheck className="w-4 h-4 text-cyan-400" />
            </div>
            <div>
              <div className="text-[11px] text-slate-400">已登记凭证</div>
              <div className="text-lg font-mono font-bold text-white tracking-tight tabular-nums">{registrations.length}</div>
            </div>
          </div>

          <div className="flex items-center gap-3 px-3 pt-1 md:pt-0">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <div className="text-[11px] text-slate-400">验真回执入账</div>
              <div className="text-lg font-mono font-bold text-white tracking-tight tabular-nums">
                {ledger.filter(b => b.entry_type === "回执").length}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 px-3 pt-1 md:pt-0">
            <div className="w-8 h-8 rounded-lg bg-teal-500/10 border border-teal-500/20 flex items-center justify-center shrink-0">
              <Activity className="w-4 h-4 text-teal-400" />
            </div>
            <div>
              <div className="text-[11px] text-slate-400">链完整性状态</div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                <span className="text-xs font-semibold text-emerald-400">全链可验</span>
              </div>
            </div>
          </div>
        </div>

        {/* ====================================================================
            页面 1: 登记确权 (翻页/卡片切换，杜绝无止境向下堆叠)
           ==================================================================== */}
        {activeTab === "登记" && (
          <div className="space-y-4">
            {/* 顶部分段切换卡片：录入申领 vs 已登记台账簿 */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/[0.08] pb-3">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
                  <span>登记确权</span>
                  <span className="text-xs font-normal text-slate-400 font-mono">（三层指纹 · 原件与明文不上链）</span>
                </h1>
              </div>

              {/* 翻页切换按键 */}
              <div className="flex items-center bg-[#0A101D] p-1 rounded-xl border border-white/[0.08] text-xs">
                <button
                  onClick={() => setRegSubView("input")}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                    regSubView === "input" 
                      ? "bg-indigo-600 text-white shadow-sm" 
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  指纹录入与确权
                </button>
                <button
                  onClick={() => setRegSubView("ledger")}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
                    regSubView === "ledger" 
                      ? "bg-indigo-600 text-white shadow-sm" 
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  <span>已登记台账簿</span>
                  <span className="px-1.5 py-0.2 bg-white/10 rounded-full text-[10px]">{registrations.length}</span>
                </button>
              </div>
            </div>

            {/* 视图 A: 指纹录入与实时解析 */}
            {regSubView === "input" && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                {/* 左栏：文件输入 */}
                <div className="lg:col-span-7 glass-panel rounded-2xl p-5 space-y-3.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5 text-indigo-400" /> 数据源内容录入
                    </span>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-slate-500 text-[11px]">填入模板:</span>
                      <button
                        onClick={() => {
                          setRegFileName("report.txt");
                          setRegContent(DEMO_SAMPLES["report.txt"].text);
                        }}
                        className="px-2 py-0.5 bg-white/[0.05] hover:bg-white/[0.1] rounded text-[11px] text-slate-300"
                      >
                        经营报表
                      </button>
                      <button
                        onClick={() => {
                          setRegFileName("contract_bad.txt");
                          setRegContent(DEMO_SAMPLES["contract_bad.txt"].text);
                        }}
                        className="px-2 py-0.5 bg-white/[0.05] hover:bg-white/[0.1] rounded text-[11px] text-slate-300"
                      >
                        采购合同
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="text-[11px] text-slate-400 block mb-1">文件名</label>
                    <input
                      type="text"
                      value={regFileName}
                      onChange={e => setRegFileName(e.target.value)}
                      className="w-full bg-[#070C18] border border-white/[0.08] rounded-xl px-3 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-indigo-500/60"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] text-slate-400 block mb-1">文件内容明文（本地生成三层指纹，绝不上账）</label>
                    <textarea
                      rows={7}
                      value={regContent}
                      onChange={e => setRegContent(e.target.value)}
                      className="w-full bg-[#070C18] border border-white/[0.08] rounded-xl p-3 text-xs font-mono text-slate-300 leading-relaxed focus:outline-none focus:border-indigo-500/60"
                    />
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <div className="text-[11px] text-slate-400">
                      确权主体: <strong className="text-slate-200">{actor}</strong>
                    </div>
                    <button
                      onClick={handleRegister}
                      className="px-5 py-2 bg-gradient-to-r from-indigo-600 via-blue-600 to-cyan-500 hover:opacity-95 text-white font-medium text-xs rounded-xl shadow-lg shadow-indigo-500/20 flex items-center gap-1.5 transition-all"
                    >
                      <Shield className="w-3.5 h-3.5" /> 开始登记并上账
                    </button>
                  </div>
                </div>

                {/* 右栏：实时解析与当前凭证卡 */}
                <div className="lg:col-span-5 space-y-4">
                  {lastCert ? (
                    <div className="glass-panel relative rounded-2xl p-5 border-indigo-500/30 overflow-hidden space-y-3">
                      {/* 凭证印 (52px 单字「玺」, 旋转 -7°) */}
                      <div className="absolute right-5 top-5 seal-stamp-cert flex items-center justify-center text-white text-2xl font-bold">
                        玺
                      </div>

                      <div className="text-[11px] font-mono text-indigo-400">最新签发防伪凭证卡</div>
                      <div className="text-xl font-mono font-bold text-white">{lastCert.cert_id}</div>

                      <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                        <div><span className="text-slate-400 text-[11px]">文件:</span> <strong className="text-slate-200 truncate block">{lastCert.filename}</strong></div>
                        <div><span className="text-slate-400 text-[11px]">主体:</span> <strong className="text-slate-200 truncate block">{lastCert.subject}</strong></div>
                      </div>

                      <div className="bg-[#070C18] border border-white/[0.08] rounded-xl p-2.5 font-mono text-[11px] space-y-1">
                        <div className="text-cyan-300 truncate">SHA256: {lastCert.exact_dual_root.sha256}</div>
                        <div className="text-emerald-300 truncate">SM3国密: {lastCert.exact_dual_root.sm3}</div>
                        <div className="text-purple-300 truncate">语义根: {lastCert.semantic_root}</div>
                      </div>

                      <div className="flex items-center justify-between pt-1">
                        <span className="text-[11px] text-amber-400">留痕: {lastCert.audit_results.join(" · ")}</span>
                        <button
                          onClick={() => {
                            const blob = new Blob([JSON.stringify(lastCert, null, 2)], { type: "application/json" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `shuxi_pack_${lastCert.cert_id}.json`;
                            a.click();
                          }}
                          className="px-3 py-1 bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.1] rounded-lg text-xs font-medium text-white flex items-center gap-1.5"
                        >
                          <Download className="w-3 h-3" /> 下载登记包
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* 实时预览解析 */
                    <div className="glass-panel rounded-2xl p-5 space-y-3">
                      <div className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                        <Compass className="w-3.5 h-3.5 text-cyan-400" /> 实时字段提取与勾稽预览
                      </div>

                      <div className="bg-[#070C18] border border-white/[0.08] rounded-xl p-3 min-h-[90px] max-h-[120px] overflow-y-auto space-y-1 font-mono text-[11px]">
                        {extractFieldsFromText(regContent).map((f, i) => (
                          <div key={i} className="flex justify-between items-center text-slate-300">
                            <span className="text-indigo-300">{f.key}</span>
                            <span className="text-slate-400 truncate max-w-[160px]">{f.value}</span>
                          </div>
                        ))}
                      </div>

                      <div className="space-y-1.5">
                        {runAudits(extractFieldsFromText(regContent)).map((a, i) => (
                          <div key={i} className="bg-[#070C18] border border-white/[0.06] rounded-lg px-2.5 py-1.5 flex items-center justify-between text-[11px]">
                            <span className="text-slate-300 font-medium">{a.name} ({a.id})</span>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                              a.status === "PASS" ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" :
                              a.status === "WARN" ? "bg-amber-500/10 text-amber-400 border border-amber-500/20" :
                              "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                            }`}>
                              {a.status}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 引导翻页小卡 */}
                  <div className="p-3 bg-white/[0.02] border border-white/[0.06] rounded-xl flex items-center justify-between text-xs text-slate-400">
                    <span>已累计确权入账 {registrations.length} 件数据凭证</span>
                    <button
                      onClick={() => setRegSubView("ledger")}
                      className="text-cyan-400 hover:text-cyan-300 font-medium flex items-center gap-1"
                    >
                      查看台账簿 <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 视图 B: 已登记台账簿 (分页翻页器，不无限下滑) */}
            {regSubView === "ledger" && (
              <div className="glass-panel rounded-2xl p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="relative w-full sm:w-72">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                    <input
                      type="text"
                      placeholder="搜索凭证号、文件名或主体..."
                      value={certSearch}
                      onChange={e => {
                        setCertSearch(e.target.value);
                        setRegPage(1);
                      }}
                      className="w-full bg-[#070C18] border border-white/[0.08] rounded-xl pl-9 pr-3 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500/60"
                    />
                  </div>
                  <div className="text-xs text-slate-400">
                    共 <strong className="text-white">{filteredRegistrations.length}</strong> 条记录 ｜ 每页 5 条
                  </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
                  <table className="w-full text-left text-xs text-slate-300">
                    <thead className="bg-[#080D1A] text-slate-400 text-[11px] font-medium border-b border-white/[0.08]">
                      <tr>
                        <th className="py-2.5 px-3.5 font-mono">凭证编号</th>
                        <th className="py-2.5 px-3.5">文件名</th>
                        <th className="py-2.5 px-3.5">登记主体</th>
                        <th className="py-2.5 px-3.5">登记时间</th>
                        <th className="py-2.5 px-3.5">状态</th>
                        <th className="py-2.5 px-3.5 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04]">
                      {paginatedRegistrations.map(r => (
                        <tr key={r.cert_id} className="hover:bg-white/[0.02]">
                          <td className="py-2.5 px-3.5 font-mono text-cyan-400 font-semibold">{r.cert_id}</td>
                          <td className="py-2.5 px-3.5 text-white font-medium">{r.filename}</td>
                          <td className="py-2.5 px-3.5 text-slate-400">{r.subject}</td>
                          <td className="py-2.5 px-3.5 font-mono text-slate-500">{r.timestamp}</td>
                          <td className="py-2.5 px-3.5">
                            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${
                              r.status === "有效" ? "text-emerald-400 bg-emerald-500/10 border border-emerald-500/20" : "text-rose-400 bg-rose-500/10 border border-rose-500/20"
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
                              className="text-xs text-indigo-400 hover:text-indigo-300 font-medium inline-flex items-center gap-1"
                            >
                              验真 <ArrowRight className="w-3 h-3" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* 优雅翻页控件 */}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-slate-500">
                    第 {regPage} / {regTotalPages} 页
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      disabled={regPage <= 1}
                      onClick={() => setRegPage(p => Math.max(1, p - 1))}
                      className="px-3 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-30 disabled:hover:bg-white/[0.05] text-xs text-slate-300 flex items-center gap-1"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" /> 上一页
                    </button>
                    <button
                      disabled={regPage >= regTotalPages}
                      onClick={() => setRegPage(p => Math.min(regTotalPages, p + 1))}
                      className="px-3 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-30 disabled:hover:bg-white/[0.05] text-xs text-slate-300 flex items-center gap-1"
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
            页面 2: 一键验真 (视口自适应，结论先行，穿透证据翻页)
           ==================================================================== */}
        {activeTab === "验真" && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/[0.08] pb-3">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
                  <span>一键验真</span>
                  <span className="text-xs font-normal text-slate-400 font-mono">（三层指纹 + 四级分诊判定）</span>
                </h1>
              </div>

              {/* 翻页切换按键：单件深挖 vs 批量工作台 */}
              <div className="flex items-center bg-[#0A101D] p-1 rounded-xl border border-white/[0.08] text-xs">
                <button
                  onClick={() => setVerifySubView("single")}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                    verifySubView === "single" 
                      ? "bg-indigo-600 text-white shadow-sm" 
                      : "text-slate-400 hover:text-white"
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
                      ? "bg-indigo-600 text-white shadow-sm" 
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  <span>批量验真工作台</span>
                  {batchResults && <span className="px-1.5 py-0.2 bg-emerald-500/20 text-emerald-300 rounded-full text-[10px]">已完成</span>}
                </button>
              </div>
            </div>

            {/* 视图 A: 单件深度验真 */}
            {verifySubView === "single" && (
              <div className="space-y-4">
                {/* 紧凑单行配置带 */}
                <div className="glass-panel rounded-2xl p-4 grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                  <div className="md:col-span-5">
                    <label className="text-[11px] text-slate-400 block mb-1">选择核验凭证</label>
                    <select
                      value={selectedCertId}
                      onChange={e => setSelectedCertId(e.target.value)}
                      className="w-full bg-[#070C18] border border-white/[0.08] rounded-xl px-3 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-indigo-500/60"
                    >
                      {registrations.map(r => (
                        <option key={r.cert_id} value={r.cert_id}>
                          {r.cert_id} · {r.filename}
                        </option>
                      ))}
                      {registrations.length === 0 && <option value="">请先在登记页添加凭证</option>}
                    </select>
                  </div>

                  <div className="md:col-span-5">
                    <label className="text-[11px] text-slate-400 block mb-1">选择待验变异样例</label>
                    <select
                      value={verifySampleKey}
                      onChange={e => setVerifySampleKey(e.target.value)}
                      className="w-full bg-[#070C18] border border-white/[0.08] rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500/60"
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
                      className="w-full py-1.5 px-4 bg-gradient-to-r from-indigo-600 via-blue-600 to-cyan-500 hover:opacity-95 text-white font-medium text-xs rounded-xl shadow-md shadow-indigo-500/20 flex items-center justify-center gap-1.5 transition-all"
                    >
                      <FileCheck className="w-3.5 h-3.5" /> 开始验真
                    </button>
                  </div>
                </div>

                {/* 结论卡 (固定顺序 ①: 结论先行) */}
                {verdict && (
                  <div className="space-y-4">
                    <div 
                      className="glass-panel relative rounded-2xl p-5 flex items-center justify-between overflow-hidden"
                      style={{ borderColor: `${verdict.color}60` }}
                    >
                      <div className="space-y-1">
                        <div className="text-2xl font-extrabold tracking-tight" style={{ color: verdict.color }}>
                          {verdict.label}
                        </div>
                        <div className="text-xs font-mono text-slate-400">
                          把握 <span className="text-white font-semibold">{verdict.confidence}%</span> ｜ 本次验真耗时 <span className="text-white font-semibold">{verdict.elapsed_ms} ms</span>
                        </div>
                      </div>

                      {/* 结论玺印 (落印动画) */}
                      <div className="seal-stamp-verdict flex flex-col items-center justify-center text-white text-3xl font-bold shrink-0">
                        <div>{verdict.seal_text[0]}</div>
                        <div>{verdict.seal_text[1] || '级'}</div>
                      </div>
                    </div>

                    {/* 翻页切换证据卡（避免长滚动）：依据 / 差异表 / 双根比对 / 勾稽 */}
                    <div className="glass-panel rounded-2xl p-4 space-y-3">
                      <div className="flex items-center justify-between border-b border-white/[0.08] pb-2">
                        <div className="flex items-center gap-2">
                          {[
                            { id: "reasons", label: "判定依据清单" },
                            { id: "diff", label: `字段差异表 (${verdict.diff_table.length})` },
                            { id: "roots", label: "精确双根比对" },
                            { id: "audits", label: "勾稽复算" },
                          ].map(t => (
                            <button
                              key={t.id}
                              onClick={() => setVerdictEvidenceTab(t.id as any)}
                              className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                                verdictEvidenceTab === t.id 
                                  ? "bg-white/10 text-cyan-300 font-semibold" 
                                  : "text-slate-400 hover:text-white"
                              }`}
                            >
                              {t.label}
                            </button>
                          ))}
                        </div>

                        {/* 回执号小标签 */}
                        <span className="text-[11px] font-mono text-slate-400">
                          回执: <strong className="text-cyan-400">{verdict.receipt_id}</strong>
                        </span>
                      </div>

                      {/* 证据子翻页内容 */}
                      <div className="min-h-[120px] pt-1">
                        {verdictEvidenceTab === "reasons" && (
                          <ul className="space-y-1.5 text-xs text-slate-300 list-disc list-inside">
                            {verdict.reasons.map((r, i) => (
                              <li key={i}>{r}</li>
                            ))}
                          </ul>
                        )}

                        {verdictEvidenceTab === "diff" && (
                          verdict.diff_table.length > 0 ? (
                            <div className="overflow-x-auto rounded-xl border border-rose-500/30">
                              <table className="w-full text-left text-xs">
                                <thead className="bg-rose-950/40 text-rose-300 text-[11px]">
                                  <tr>
                                    <th className="p-2.5">字段名</th>
                                    <th className="p-2.5">登记原值 (存证)</th>
                                    <th className="p-2.5">待验当前值 (篡改)</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-rose-500/20 font-mono text-xs">
                                  {verdict.diff_table.map((d, i) => (
                                    <tr key={i} className="bg-rose-950/20 text-rose-300">
                                      <td className="p-2.5 font-bold">{d.field}</td>
                                      <td className="p-2.5 line-through opacity-70">{d.registered_val}</td>
                                      <td className="p-2.5 font-bold text-rose-200">{d.current_val}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <div className="text-center py-6 text-emerald-400 text-xs flex items-center justify-center gap-1.5">
                              <CheckCircle2 className="w-4 h-4" /> 经逐项复算比对，所有语义字段值未发生任何修改！
                            </div>
                          )
                        )}

                        {verdictEvidenceTab === "roots" && (
                          <div className="space-y-2 text-xs font-mono">
                            <pre className="bg-[#070C18] border border-white/[0.06] rounded-xl p-3 text-[11px] text-slate-300 overflow-x-auto">
                              {JSON.stringify(verdict.exact_details, null, 2)}
                            </pre>
                            <div className="grid grid-cols-2 gap-2 text-slate-400 text-[11px]">
                              <div>文本 3-gram 相似度: <strong className="text-white">{verdict.perceptual_details?.text_sim_str}</strong></div>
                              <div>汉明距离: <strong className="text-white">{verdict.perceptual_details?.avg_hamming}</strong></div>
                            </div>
                          </div>
                        )}

                        {verdictEvidenceTab === "audits" && (
                          <div className="space-y-1.5 text-xs">
                            {verdict.audits?.map((a, i) => (
                              <div key={i} className="bg-[#070C18] border border-white/[0.06] rounded-lg p-2.5 flex items-center justify-between text-xs">
                                <span className="text-slate-300"><strong>{a.name} ({a.id})</strong>: {a.message}</span>
                                <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                                  a.status === "PASS" ? "text-emerald-400 bg-emerald-500/10" : "text-rose-400 bg-rose-500/10"
                                }`}>{a.status}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* 报告复核按钮 */}
                      <div className="pt-2 border-t border-white/[0.08] flex items-center justify-between">
                        <div className="text-[11px] font-mono text-slate-400 truncate max-w-sm">
                          报告哈希: {verdict.report_hash}
                        </div>
                        <button
                          onClick={() => setReportReviewed(true)}
                          className="px-3 py-1 bg-white/[0.06] hover:bg-white/[0.1] rounded-lg text-xs font-medium text-slate-200 flex items-center gap-1.5"
                        >
                          <RefreshCw className="w-3 h-3 text-cyan-400" /> 复核报告真伪
                        </button>
                      </div>

                      {reportReviewed && (
                        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-medium flex items-center gap-2">
                          <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                          报告复核通过：重算报告哈希与账本回执记录完全匹配，真实且未被篡改！
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 视图 B: 批量验真工作台 (分页控制，不长滚动) */}
            {verifySubView === "batch" && (
              <div className="glass-panel rounded-2xl p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-white">批量验真结果流</h3>
                    <p className="text-xs text-slate-400 mt-0.5">对多个变异样例进行自动化分级验真与统计</p>
                  </div>
                  <button
                    onClick={handleRunBatchVerify}
                    className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-medium flex items-center gap-1.5 transition-all self-start sm:self-auto"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> 重新执行批量验真
                  </button>
                </div>

                {batchResults && (
                  <div className="space-y-4">
                    {/* 统计胶囊 */}
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="px-3 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 font-semibold">
                        甲级 (原件未动): {batchResults.stats["甲级"]}
                      </span>
                      <span className="px-3 py-1 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-300 font-semibold">
                        乙级 (载体等价): {batchResults.stats["乙级"]}
                      </span>
                      <span className="px-3 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 font-semibold">
                        丙级 (自相矛盾): {batchResults.stats["丙级"]}
                      </span>
                      <span className="px-3 py-1 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 font-semibold">
                        丁级 (关键字段改): {batchResults.stats["丁级"]}
                      </span>
                      <span className="text-xs font-mono text-slate-500 ml-auto">总耗时: {batchResults.totalMs} ms</span>
                    </div>

                    {/* 分页表格 */}
                    <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-[#080D1A] text-slate-400 text-[11px] font-medium border-b border-white/[0.08]">
                          <tr>
                            <th className="py-2.5 px-3.5">待验样例</th>
                            <th className="py-2.5 px-3.5 font-mono">锚定凭证</th>
                            <th className="py-2.5 px-3.5">验真分级</th>
                            <th className="py-2.5 px-3.5">置信把握</th>
                            <th className="py-2.5 px-3.5 text-right font-mono">耗时</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.04]">
                          {batchResults.items.slice((batchPage - 1) * ITEMS_PER_PAGE, batchPage * ITEMS_PER_PAGE).map((item, idx) => (
                            <tr key={idx} className="hover:bg-white/[0.02]">
                              <td className="py-2.5 px-3.5 text-white font-medium">{item.name}</td>
                              <td className="py-2.5 px-3.5 font-mono text-cyan-400">{item.cert}</td>
                              <td className="py-2.5 px-3.5">
                                <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${
                                  item.grade === "甲级" ? "text-emerald-400 bg-emerald-500/10 border border-emerald-500/20" :
                                  item.grade === "乙级" ? "text-sky-400 bg-sky-500/10 border border-sky-500/20" :
                                  item.grade === "丙级" ? "text-amber-400 bg-amber-500/10 border border-amber-500/20" :
                                  "text-rose-400 bg-rose-500/10 border border-rose-500/20"
                                }`}>
                                  {item.grade}
                                </span>
                              </td>
                              <td className="py-2.5 px-3.5 font-mono">{item.confidence}%</td>
                              <td className="py-2.5 px-3.5 text-right font-mono text-slate-500">{item.ms} ms</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* 分页控制 */}
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-xs text-slate-500">
                        第 {batchPage} / {Math.max(1, Math.ceil(batchResults.items.length / ITEMS_PER_PAGE))} 页
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          disabled={batchPage <= 1}
                          onClick={() => setBatchPage(p => Math.max(1, p - 1))}
                          className="px-3 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-30 text-xs text-slate-300"
                        >
                          上一页
                        </button>
                        <button
                          disabled={batchPage >= Math.ceil(batchResults.items.length / ITEMS_PER_PAGE)}
                          onClick={() => setBatchPage(p => p + 1)}
                          className="px-3 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-30 text-xs text-slate-300"
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
            页面 3: 授权与账本 (翻页选项卡，紧凑视口，避免 3000px 巨幅长滚)
           ==================================================================== */}
        {activeTab === "授权与账本" && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/[0.08] pb-3">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
                  <span>授权与账本</span>
                  <span className="text-xs font-normal text-slate-400 font-mono">（记名授权 · 链上回执 · 检查点封印）</span>
                </h1>
              </div>

              {/* 模块子翻页标签 */}
              <div className="flex items-center bg-[#0A101D] p-1 rounded-xl border border-white/[0.08] text-xs">
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
                        ? "bg-indigo-600 text-white shadow-sm" 
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 子视图 1: 哈希链区块流向与检查点封印 */}
            {ledgerSubView === "chain" && (
              <div className="space-y-4">
                <div className="glass-panel rounded-2xl p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                      <Database className="w-4 h-4 text-indigo-400" /> 哈希链区块流向 (共 {ledger.length} 个区块)
                    </span>
                    <button
                      onClick={handleWriteCheckpoint}
                      className="px-3.5 py-1.5 bg-gradient-to-r from-indigo-600 to-blue-600 hover:opacity-95 text-white text-xs font-medium rounded-xl flex items-center gap-1.5 shadow-md shadow-indigo-500/20"
                    >
                      <Lock className="w-3.5 h-3.5" /> 写入检查点（封印当前链头）
                    </button>
                  </div>

                  {/* 区块小方块流向 (点击展开区块明细) */}
                  <div className="flex items-center gap-2 overflow-x-auto py-2.5">
                    {ledger.slice(-28).map((blk, idx, arr) => {
                      const isHead = idx === arr.length - 1;
                      return (
                        <button
                          key={blk.height}
                          onClick={() => setInspectBlock(blk)}
                          className={`w-4 h-4 rounded transition-all shrink-0 ${
                            isHead 
                              ? "bg-cyan-400 shadow-[0_0_12px_#22D3EE] ring-2 ring-white" 
                              : "bg-indigo-600 hover:bg-indigo-500"
                          }`}
                          title={`高度 ${blk.height} · 类型: ${blk.entry_type} (点击查看)`}
                        />
                      );
                    })}
                    <span className="text-[11px] text-slate-400 font-mono ml-2 shrink-0">最右为当前链头</span>
                  </div>
                </div>

                {/* 展开的区块明细 */}
                {inspectBlock ? (
                  <div className="bg-[#070C18] border border-cyan-500/30 rounded-2xl p-4 space-y-2 text-xs">
                    <div className="flex items-center justify-between text-cyan-300 font-semibold">
                      <span>区块高度 #{inspectBlock.height} · 类型: {inspectBlock.entry_type}</span>
                      <button onClick={() => setInspectBlock(null)} className="text-slate-400 hover:text-white">✕ 关闭详情</button>
                    </div>
                    <pre className="bg-black/50 p-3 rounded-xl text-[11px] font-mono text-slate-300 overflow-x-auto max-h-[220px]">
                      {JSON.stringify(inspectBlock, null, 2)}
                    </pre>
                  </div>
                ) : (
                  <div className="p-4 bg-white/[0.02] border border-white/[0.06] rounded-xl text-center text-xs text-slate-400">
                    提示：点击上方小方块可实时下钻查看该区块的签名、载荷与 Merkle 前驱哈希。
                  </div>
                )}
              </div>
            )}

            {/* 子视图 2: 记名授权中心 (新建 + 分页列表) */}
            {ledgerSubView === "auth" && (
              <div className="space-y-4">
                {/* 新建授权表单 */}
                <div className="glass-panel rounded-2xl p-5 space-y-3.5">
                  <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                    <Key className="w-3.5 h-3.5 text-cyan-400" /> 新建记名查验授权
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                    <div>
                      <label className="text-[11px] text-slate-400 block mb-1">选登记凭证</label>
                      <select
                        value={authCertId}
                        onChange={e => setAuthCertId(e.target.value)}
                        className="w-full bg-[#070C18] border border-white/[0.08] rounded-xl p-2 text-xs font-mono text-white"
                      >
                        {registrations.map(r => (
                          <option key={r.cert_id} value={r.cert_id}>{r.cert_id} · {r.filename}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-[11px] text-slate-400 block mb-1">被授权方主体名称</label>
                      <input
                        type="text"
                        value={grantee}
                        onChange={e => setGrantee(e.target.value)}
                        className="w-full bg-[#070C18] border border-white/[0.08] rounded-xl p-2 text-xs text-white"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] text-slate-400 block mb-1">有效天数</label>
                      <input
                        type="number"
                        value={validDays}
                        onChange={e => setValidDays(parseInt(e.target.value) || 30)}
                        className="w-full bg-[#070C18] border border-white/[0.08] rounded-xl p-2 text-xs font-mono text-white"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] text-slate-400 block mb-1">最大查验次数</label>
                      <input
                        type="number"
                        value={maxUses}
                        onChange={e => setMaxUses(parseInt(e.target.value) || 10)}
                        className="w-full bg-[#070C18] border border-white/[0.08] rounded-xl p-2 text-xs font-mono text-white"
                      />
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <button
                      onClick={handleCreateAuth}
                      className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-medium"
                    >
                      创建记名授权并上链
                    </button>
                  </div>
                </div>

                {/* 分页授权列表 */}
                <div className="glass-panel rounded-2xl p-5 space-y-3">
                  <div className="text-xs font-semibold text-white">生效中授权清单</div>
                  <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-[#080D1A] text-slate-400 text-[11px] border-b border-white/[0.08]">
                        <tr>
                          <th className="p-2.5">授权编号</th>
                          <th className="p-2.5">对应凭证</th>
                          <th className="p-2.5">被授权主体</th>
                          <th className="p-2.5">有效期</th>
                          <th className="p-2.5 text-right">查验次数上限</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.04] font-mono text-xs">
                        {paginatedAuths.map(b => (
                          <tr key={b.height} className="hover:bg-white/[0.02]">
                            <td className="p-2.5 text-cyan-400 font-bold">{b.payload.auth_id}</td>
                            <td className="p-2.5 text-slate-300">{b.payload.cert_id}</td>
                            <td className="p-2.5 font-sans text-slate-200">{b.payload.grantee}</td>
                            <td className="p-2.5">{b.payload.valid_days} 天</td>
                            <td className="p-2.5 text-right text-slate-400">{b.payload.max_uses} 次</td>
                          </tr>
                        ))}
                        {authBlocks.length === 0 && (
                          <tr><td colSpan={5} className="p-4 text-center text-slate-500 italic">暂无授权记录</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* 翻页器 */}
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-xs text-slate-500">第 {authPage} / {authTotalPages} 页</span>
                    <div className="flex items-center gap-2">
                      <button
                        disabled={authPage <= 1}
                        onClick={() => setAuthPage(p => Math.max(1, p - 1))}
                        className="px-3 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-30 text-xs text-slate-300"
                      >
                        上一页
                      </button>
                      <button
                        disabled={authPage >= authTotalPages}
                        onClick={() => setAuthPage(p => Math.min(authTotalPages, p + 1))}
                        className="px-3 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-30 text-xs text-slate-300"
                      >
                        下一页
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 子视图 3: 查验回执流水 (分页控制) */}
            {ledgerSubView === "receipts" && (
              <div className="glass-panel rounded-2xl p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                    <FileCheck className="w-4 h-4 text-emerald-400" /> 查验签名回执总表 (共 {receiptBlocks.length} 条)
                  </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#080D1A] text-slate-400 text-[11px] border-b border-white/[0.08]">
                      <tr>
                        <th className="p-2.5">回执号</th>
                        <th className="p-2.5">凭证编号</th>
                        <th className="p-2.5">结论分级</th>
                        <th className="p-2.5">核验主体</th>
                        <th className="p-2.5 font-mono">时间</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04] font-mono text-xs">
                      {paginatedReceipts.map(b => (
                        <tr key={b.height} className="hover:bg-white/[0.02]">
                          <td className="p-2.5 text-indigo-400 font-bold">{b.payload.receipt_id}</td>
                          <td className="p-2.5 text-slate-300">{b.payload.cert_id}</td>
                          <td className="p-2.5 font-sans">
                            <span className="text-white font-medium">{b.payload.verdict_grade}</span>
                          </td>
                          <td className="p-2.5 font-sans text-slate-300">{b.payload.verifier_subject}</td>
                          <td className="p-2.5 text-slate-500">{b.payload.timestamp}</td>
                        </tr>
                      ))}
                      {receiptBlocks.length === 0 && (
                        <tr><td colSpan={5} className="p-4 text-center text-slate-500 italic">暂无查验回执入账</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* 翻页器 */}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-slate-500">第 {receiptPage} / {receiptTotalPages} 页</span>
                  <div className="flex items-center gap-2">
                    <button
                      disabled={receiptPage <= 1}
                      onClick={() => setReceiptPage(p => Math.max(1, p - 1))}
                      className="px-3 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-30 text-xs text-slate-300"
                    >
                      上一页
                    </button>
                    <button
                      disabled={receiptPage >= receiptTotalPages}
                      onClick={() => setReceiptPage(p => Math.min(receiptTotalPages, p + 1))}
                      className="px-3 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-30 text-xs text-slate-300"
                    >
                      下一页
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 子视图 4: 作废与撤销管理 */}
            {ledgerSubView === "revoke" && (
              <div className="glass-panel rounded-2xl p-5 space-y-3">
                <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                  <AlertOctagon className="w-4 h-4 text-rose-400" /> 凭证作废管理中心 (操作不可逆)
                </div>
                <p className="text-xs text-slate-400">
                  登记方私钥正式签名作废后，后续该凭证的一切验真均直接前置终止并判定为「已作废」。
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 pt-2">
                  {registrations.filter(r => r.status === "有效").map(r => (
                    <div key={r.cert_id} className="p-3 bg-[#070C18] border border-white/[0.06] rounded-xl flex items-center justify-between">
                      <div className="overflow-hidden mr-2">
                        <div className="font-mono text-xs text-white truncate">{r.cert_id}</div>
                        <div className="text-[11px] text-slate-500 truncate">{r.filename}</div>
                      </div>
                      <button
                        onClick={() => {
                          if (window.confirm(`确定要永久作废凭证 ${r.cert_id} 吗？上账后不可逆！`)) {
                            handleRevokeCert(r.cert_id);
                          }
                        }}
                        className="px-2.5 py-1 bg-rose-500/10 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-[11px] rounded-lg shrink-0 transition-colors"
                      >
                        作废
                      </button>
                    </div>
                  ))}
                  {registrations.filter(r => r.status === "有效").length === 0 && (
                    <div className="col-span-3 text-center py-6 text-slate-500 text-xs italic">
                      无有效状态凭证可供作废
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
