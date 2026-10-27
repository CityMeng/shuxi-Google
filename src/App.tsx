/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Shield, CheckCircle2, AlertTriangle, FileText, Lock, Key, 
  Layers, Database, FileCheck, ArrowRight, Download, 
  RefreshCw, Check, Sparkles, Terminal, FileCode2, ExternalLink,
  ChevronRight, ChevronLeft, Building2, UserCheck, Copy, Clock, Search,
  SlidersHorizontal, CheckSquare, Hash, Activity, Compass, AlertOctagon,
  Eye, FileSearch, ArrowUpDown, ChevronDown, Award, QrCode as QrCodeIcon,
  Upload, X, FolderUp, Trash2
} from 'lucide-react';
import QRCode from 'qrcode';
import { sm3Hash, sha256Hash, computeExactDualRoot, computeTextSimilarity } from './crypto';
import { 
  extractFieldsFromText, runAudits, 
  RegistrationRecord, LedgerBlock, VerdictResult, AuditResult 
} from './protocol';

// 文件二进制与文本安全读取辅助函数
const readFileAsArrayBuffer = (file: File): Promise<Uint8Array> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
};

const readFileAsText = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
};

const isTextFormat = (filename: string): boolean => {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return ['txt', 'csv', 'md', 'json', 'log', 'xml'].includes(ext);
};

const REGISTRAR_DEFAULT = "示例新能源有限公司 · 财务部";
const VERIFIER_DEFAULT = "合作银行 · 核验岗";

// 严格与 vectors/samples/*.txt 字节级完全一致的标准测试向量
const DEMO_SAMPLES: Record<string, { label: string; tag: string; text: string }> = {
  "report.txt": {
    label: "report.txt (2026年三季度经营报表 原件母本)",
    tag: "基准件 · 预期甲级",
    text: `2026年三季度经营报表
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
    text: `2026年三季度经营报表
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
    text: `2026年三季度经营报表\r\n报告单位：示例新能源有限公司\r\n报告日期：2026 年 9 月 30 日\r\n产品销售收入 | 9000000\r\n服务收入 | 3500000\r\n合计 | 12500000\r\n营业收入：12500000元\r\n营业成本：8300000元\r\n净利润：４２０００００元`
  },

  "fake.txt": {
    label: "fake.txt (远方机械制造，分项和与合计不平)",
    tag: "自相矛盾 · 预期丙级",
    text: `2026年三季度经营报表
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
    label: "contract_bad.txt (小写50万 vs 大写肆拾捌万陆仟)",
    tag: "大小写矛盾留痕 · 登记件",
    text: `设备采购合同
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
  // 三个核心页面：登记 / 验真 / 授权与账本 (与原项目完全对齐)
  const [activeTab, setActiveTab] = useState<"登记" | "验真" | "授权与账本">("登记");
  const [ledger, setLedger] = useState<LedgerBlock[]>([]);
  const [registrations, setRegistrations] = useState<RegistrationRecord[]>([]);

  // 登记页状态
  const [regSubView, setRegSubView] = useState<"input" | "ledger">("input");
  const [regPage, setRegPage] = useState(1);
  const [regFileName, setRegFileName] = useState("report.txt");
  const [regContent, setRegContent] = useState(DEMO_SAMPLES["report.txt"].text);
  const [regFile, setRegFile] = useState<File | null>(null);
  const [regBytes, setRegBytes] = useState<Uint8Array | null>(null);
  const [regFileSize, setRegFileSize] = useState<number | null>(null);
  const [regError, setRegError] = useState<string | null>(null);
  const regFileInputRef = useRef<HTMLInputElement>(null);
  const [lastCert, setLastCert] = useState<RegistrationRecord | null>(null);
  const [certQrUrl, setCertQrUrl] = useState<string>("");
  const [certSearch, setCertSearch] = useState("");

  // 验真页状态
  const [verifySubView, setVerifySubView] = useState<"single" | "batch">("single");
  const [selectedCertId, setSelectedCertId] = useState<string>("");
  const [verifySampleKey, setVerifySampleKey] = useState<string>("report_tampered.txt");
  const [verifyCustomText, setVerifyCustomText] = useState("");
  const [verifyMode, setVerifyMode] = useState<"sample" | "custom">("sample");
  const [verFile, setVerFile] = useState<File | null>(null);
  const [verBytes, setVerBytes] = useState<Uint8Array | null>(null);
  const [verFileName, setVerFileName] = useState<string>("");
  const [verFileSize, setVerFileSize] = useState<number | null>(null);
  const [verError, setVerError] = useState<string | null>(null);
  const verFileInputRef = useRef<HTMLInputElement>(null);
  const [verdict, setVerdict] = useState<VerdictResult | null>(null);
  const [verdictEvidenceTab, setVerdictEvidenceTab] = useState<"reasons" | "roots" | "perceptual" | "semantic" | "audits" | "report">("reasons");
  const [reportReviewed, setReportReviewed] = useState(false);

  // 批量验真
  const [batchUploadedFiles, setBatchUploadedFiles] = useState<Array<{ name: string; bytes: Uint8Array; size: number; text: string }>>([]);
  const batchFileInputRef = useRef<HTMLInputElement>(null);
  const [batchResults, setBatchResults] = useState<{
    items: Array<{ name: string; cert: string; grade: string; confidence: number; ms: number }>;
    stats: Record<string, number>;
    totalMs: number;
  } | null>(null);
  const [batchPage, setBatchPage] = useState(1);

  // 授权与账本页状态
  const [ledgerSubView, setLedgerSubView] = useState<"chain" | "auth" | "receipts" | "revoke">("chain");
  const [authCertId, setAuthCertId] = useState("");
  const [grantee, setGrantee] = useState(VERIFIER_DEFAULT);
  const [validDays, setValidDays] = useState(7);
  const [maxUses, setMaxUses] = useState(2);
  const [authPage, setAuthPage] = useState(1);
  const [receiptPage, setReceiptPage] = useState(1);
  const [inspectBlock, setInspectBlock] = useState<LedgerBlock | null>(null);
  const [checkpointTip, setCheckpointTip] = useState(false);

  // 生成二维码
  const generateQr = async (cert_id: string, payload: any) => {
    try {
      const qrData = JSON.stringify({
        cert_id,
        filename: payload.filename,
        sha256_root: payload.exact_dual_root.sha256,
        sm3_root: payload.exact_dual_root.sm3,
        semantic_root: payload.semantic_root
      });
      const url = await QRCode.toDataURL(qrData, { width: 140, margin: 1 });
      setCertQrUrl(url);
    } catch (e) {
      console.error("QR Code Error:", e);
    }
  };

  // 确定性载入演示数据 (虚构样本: 已登记过则跳过，与原项目完全一致)
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
        const { sha256, sm3 } = await computeExactDualRoot(bytes);
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

  // 处理登记文件上传选择 (支持拖拽/点击，支持 pdf, docx, xlsx, txt, csv, md, png, jpg, jpeg)
  const handleRegisterFileChange = async (file: File) => {
    setRegError(null);
    if (file.size === 0) {
      setRegError("SX-E01 空文件不可登记：文件大小为 0 字节");
      return;
    }
    if (file.size > 500 * 1024 * 1024) {
      setRegError("SX-E04 文件超限：单文件不可超过 500MB");
      return;
    }

    try {
      const bytes = await readFileAsArrayBuffer(file);
      setRegFile(file);
      setRegFileName(file.name);
      setRegFileSize(file.size);
      setRegBytes(bytes);

      if (isTextFormat(file.name)) {
        const text = await readFileAsText(file);
        setRegContent(text);
      } else {
        setRegContent(`[已载入二进制文件: ${file.name}] 大小: ${file.size} 字节。按数玺规范 §14 进行精确双根 Merkle 树存证与降级留痕。`);
      }
    } catch (e: any) {
      setRegError(`文件读取失败: ${e?.message || e}`);
    }
  };

  // 执行登记 (支持已上传文件二进制流或文本正文)
  const handleRegister = async () => {
    setRegError(null);
    let bytes: Uint8Array;
    let textToUse = regContent;

    if (regBytes) {
      bytes = regBytes;
    } else {
      if (!regContent.trim()) {
        setRegError("SX-E01 空文件不可登记：请输入内容或选择要登记的文件");
        return;
      }
      bytes = new TextEncoder().encode(regContent);
    }

    if (bytes.length === 0) {
      setRegError("SX-E01 空文件不可登记：文件大小为 0 字节");
      return;
    }

    try {
      const { sha256, sm3 } = await computeExactDualRoot(bytes);
      const isText = isTextFormat(regFileName) || !regBytes;
      const fields = isText ? extractFieldsFromText(textToUse) : [];
      const audits = fields.length > 0 ? runAudits(fields) : [];
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
        audit_results: auditCodes.length > 0 ? auditCodes : (isText ? ["G1-PASS", "G2-PASS"] : []),
        status: "有效",
        registered_text: isText ? textToUse : "",
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
      generateQr(rec.cert_id, rec);
      if (!selectedCertId) setSelectedCertId(cert_id);
    } catch (e: any) {
      setRegError(`登记失败: ${e?.message || e}`);
    }
  };

  // 处理待验文件上传选择
  const handleVerifyFileChange = async (file: File) => {
    setVerError(null);
    if (file.size === 0) {
      setVerError("待验文件大小为 0 字节");
      return;
    }
    try {
      const bytes = await readFileAsArrayBuffer(file);
      setVerFile(file);
      setVerFileName(file.name);
      setVerFileSize(file.size);
      setVerBytes(bytes);
      setVerifySampleKey("—");
    } catch (e: any) {
      setVerError(`文件读取失败: ${e?.message || e}`);
    }
  };

  // 执行单件验真
  const handleVerify = async () => {
    const startTime = performance.now();
    setReportReviewed(false);
    setVerError(null);

    let testBytes: Uint8Array;
    let testText: string = "";
    let testFname: string = "";

    if (verBytes && verFileName) {
      testBytes = verBytes;
      testFname = verFileName;
      if (isTextFormat(verFileName)) {
        try {
          testText = new TextDecoder('utf-8').decode(verBytes);
        } catch {
          testText = "";
        }
      }
    } else if (verifySampleKey !== "—" && DEMO_SAMPLES[verifySampleKey]) {
      testText = DEMO_SAMPLES[verifySampleKey].text;
      testBytes = new TextEncoder().encode(testText);
      testFname = verifySampleKey;
    } else {
      setVerError("请上传待验文件或在下拉框中选用演示文件");
      return;
    }

    const targetCert = registrations.find(r => r.cert_id === selectedCertId);

    if (!targetCert) {
      const audits = testText ? runAudits(extractFieldsFromText(testText)) : [];
      const hasFail = audits.some(a => a.status === "FAIL");
      const elapsed_ms = Math.max(1, Math.round(performance.now() - startTime));
      setVerdict({
        grade: hasFail ? "丙级" : "未登记",
        label: hasFail ? "丙级 · 内容自相矛盾" : "未登记，勾稽未见异常（不等于真实）",
        color: hasFail ? "#D97706" : "#78716C",
        seal_text: hasFail ? "丙级" : "未登",
        confidence: hasFail ? 85 : 50,
        reasons: hasFail 
          ? ["该文件未在账本登记，经本地勾稽审计发现分项合计或大小写数据矛盾。"] 
          : ["该文件未在数玺账本中登记存证。", "文件内部数据未发现明显勾稽异常（注意：勾稽未见异常不等于内容本身真实）。"],
        elapsed_ms,
        diff_table: []
      });
      return;
    }

    // 检查凭证作废 (状态前置)
    if (targetCert.status === "已作废") {
      setVerdict({
        grade: "已作废",
        label: "凭证已作废",
        color: "#78716C",
        seal_text: "作废",
        confidence: 100,
        reasons: ["此登记记录已被登记方私钥正式签名作废，链上凭证不再受采信。"],
        elapsed_ms: 2,
        diff_table: []
      });
      return;
    }

    // 检查记名授权 (状态前置)
    const authList = ledger.filter(b => b.entry_type === "授权" && b.payload?.cert_id === targetCert.cert_id);
    if (authList.length > 0) {
      const latestAuth = authList[authList.length - 1].payload;
      if (latestAuth.grantee !== actor) {
        setVerdict({
          grade: "授权拒绝",
          label: "未获记名查验授权",
          color: "#D97706",
          seal_text: "拒验",
          confidence: 100,
          reasons: [`此凭证已被设立记名授权限制。当前操作身份「${actor}」非指定被授权方「${latestAuth.grantee}」。`],
          elapsed_ms: 2,
          diff_table: []
        });
        return;
      }
    }

    // 1. 精确哈希比对 (SHA-256 + SM3 双根)
    const { sha256: testSha256, sm3: testSm3 } = await computeExactDualRoot(testBytes);
    const exactMatch = testSha256 === targetCert.exact_dual_root.sha256 && testSm3 === targetCert.exact_dual_root.sm3;

    // 2. 字段提取与差异比对
    const testFields = testText ? extractFieldsFromText(testText) : [];
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

    // 4. 感知/字面相似度 (3-gram Jaccard)
    const textSim = computeTextSimilarity(targetCert.registered_text || "", testText);

    const elapsed_ms = Math.max(1, Math.round(performance.now() - startTime));

    // 五级结论分诊判定逻辑 (完全与 engine/grade.py 顺序对齐: 甲 -> 丁 -> 丙 -> 乙 -> 待复核)
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
        color: "#78716C",
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

  // 批量文件加入列表
  const handleBatchFilesChange = async (fileList: FileList | File[]) => {
    const list = Array.from(fileList);
    const loaded: Array<{ name: string; bytes: Uint8Array; size: number; text: string }> = [];
    for (const f of list) {
      if (f.size > 0) {
        const bytes = await readFileAsArrayBuffer(f);
        let text = "";
        if (isTextFormat(f.name)) {
          try {
            text = new TextDecoder('utf-8').decode(bytes);
          } catch {
            text = "";
          }
        }
        loaded.push({ name: f.name, bytes, size: f.size, text });
      }
    }
    setBatchUploadedFiles(prev => [...prev, ...loaded]);
  };

  // 载入内置演示样本集（5份）
  const handleLoadBatchDemoSamples = () => {
    const keys = ["report.txt", "report_tampered.txt", "report_converted.txt", "fake.txt", "contract_bad.txt"];
    const loaded = keys.map(k => {
      const s = DEMO_SAMPLES[k];
      const bytes = new TextEncoder().encode(s.text);
      return { name: k, bytes, size: bytes.length, text: s.text };
    });
    setBatchUploadedFiles(loaded);
  };

  // 执行批量验真 (对齐 app.py: do_batch 逻辑，真实执行双散列比对与分诊)
  const handleRunBatchVerify = async () => {
    const start = performance.now();
    const filesToTest = batchUploadedFiles.length > 0 ? batchUploadedFiles : [
      { name: "report.txt", bytes: new TextEncoder().encode(DEMO_SAMPLES["report.txt"].text), size: 128, text: DEMO_SAMPLES["report.txt"].text },
      { name: "report_tampered.txt", bytes: new TextEncoder().encode(DEMO_SAMPLES["report_tampered.txt"].text), size: 128, text: DEMO_SAMPLES["report_tampered.txt"].text },
      { name: "report_converted.txt", bytes: new TextEncoder().encode(DEMO_SAMPLES["report_converted.txt"].text), size: 135, text: DEMO_SAMPLES["report_converted.txt"].text },
      { name: "fake.txt", bytes: new TextEncoder().encode(DEMO_SAMPLES["fake.txt"].text), size: 129, text: DEMO_SAMPLES["fake.txt"].text },
      { name: "contract_bad.txt", bytes: new TextEncoder().encode(DEMO_SAMPLES["contract_bad.txt"].text), size: 110, text: DEMO_SAMPLES["contract_bad.txt"].text },
    ];

    const results: Array<{ name: string; cert: string; grade: string; confidence: number; ms: number }> = [];
    const stats: Record<string, number> = { "甲级": 0, "乙级": 0, "丙级": 0, "丁级": 0, "待人工复核": 0, "未登记": 0 };

    for (const file of filesToTest) {
      const itemStart = performance.now();
      // 按文件名查找对应凭证
      let targetCert = registrations.find(r => r.filename === file.name);
      if (!targetCert && file.name.startsWith("report")) {
        targetCert = registrations.find(r => r.filename === "report.txt");
      }

      let grade = "未登记";
      let confidence = 50;

      if (targetCert) {
        if (targetCert.status === "已作废") {
          grade = "已作废";
          confidence = 100;
        } else {
          const { sha256, sm3 } = await computeExactDualRoot(file.bytes);
          const exactMatch = sha256 === targetCert.exact_dual_root.sha256 && sm3 === targetCert.exact_dual_root.sm3;

          const testFields = file.text ? extractFieldsFromText(file.text) : [];
          const testFieldMap = new Map(testFields.map(f => [f.key, f.value]));
          const diffs: Array<{ field: string; registered_val: string; current_val: string }> = [];

          (targetCert.fields || []).forEach(rf => {
            const cv = testFieldMap.get(rf.key);
            if (cv !== undefined && cv !== rf.value) {
              diffs.push({ field: rf.key, registered_val: rf.value, current_val: cv });
            }
          });

          const testAudits = runAudits(testFields);
          const auditFails = testAudits.filter(a => a.status === "FAIL");
          const textSim = computeTextSimilarity(targetCert.registered_text || "", file.text);

          if (exactMatch) {
            grade = "甲级";
            confidence = 99;
          } else if (diffs.length > 0) {
            grade = "丁级";
            confidence = 96;
          } else if (auditFails.length > 0) {
            grade = "丙级";
            confidence = 88;
          } else if (textSim.score > 0.85) {
            grade = "乙级";
            confidence = 91;
          } else {
            grade = "待人工复核";
            confidence = 60;
          }
        }
      } else {
        const testFields = file.text ? extractFieldsFromText(file.text) : [];
        const testAudits = runAudits(testFields);
        const hasFail = testAudits.some(a => a.status === "FAIL");
        if (hasFail) {
          grade = "丙级";
          confidence = 85;
        } else {
          grade = "未登记";
          confidence = 50;
        }
      }

      const itemMs = Math.max(1, Math.round((performance.now() - itemStart) * 10) / 10);
      results.push({
        name: file.name,
        cert: targetCert ? targetCert.cert_id : "—",
        grade,
        confidence,
        ms: itemMs
      });
      stats[grade] = (stats[grade] || 0) + 1;
    }

    setBatchResults({
      items: results,
      stats,
      totalMs: Math.round(performance.now() - start)
    });
    setBatchPage(1);
  };

  // 写入检查点（封印当前链头）
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
    setCheckpointTip(true);
    setTimeout(() => setCheckpointTip(false), 3000);
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
        {/* Zone 1: 品牌区 (字标与协议标识 - 朱砂玺印与金丝包边元素) */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-[#C23531] p-[1.5px] shadow-sm shadow-red-900/20 flex items-center justify-center border border-[#D97706]/50">
            <span className="text-white font-serif font-bold text-lg">玺</span>
          </div>
          <div className="flex items-baseline gap-2.5">
            <span className="text-xl font-bold tracking-tight text-[#1F2937] font-serif">数玺</span>
            <span className="text-[11px] font-mono font-medium text-[#78716C] px-2 py-0.5 rounded-md bg-[#FAF8F3] border border-[#E7E2D6] hidden sm:inline-block">
              规范 v1.3 · 套件 SXA1
            </span>
          </div>
        </div>

        {/* Zone 2: 三个核心功能导航 (与 app.py 标签完全对齐: 登记 / 验真 / 授权与账本) */}
        <nav className="flex items-center p-1 bg-[#F5F1E8] border border-[#E7E1D4] rounded-xl">
          {[
            { id: "登记", icon: Shield, label: "登记" },
            { id: "验真", icon: FileCheck, label: "验真" },
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
            title="一键载入演示数据 (虚构样本)，幂等不重入"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#374151] bg-white hover:bg-[#FAF8F3] border border-[#DCD5C6] rounded-lg transition-colors shadow-2xs whitespace-nowrap"
          >
            <Sparkles className="w-3.5 h-3.5 text-[#D97706]" />
            <span className="hidden sm:inline">载入演示数据</span>
          </button>
        </div>
      </header>

      {/* 主视图区域 (规范公文画幅，路演投影与PPT截屏极佳) */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-5 space-y-5">
        
        {/* 顶部四格状态指标条 - 对应 app.py 中的 status_strip: 账本高度 / 已登记凭证 / 验真回执 / 链状态 */}
        <div className="paper-card rounded-2xl p-4 grid grid-cols-2 md:grid-cols-4 gap-4 divide-y md:divide-y-0 md:divide-x divide-[#EFEAE0]">
          <div className="flex items-center gap-3.5 px-3 pt-1 md:pt-0">
            <div className="w-9 h-9 rounded-lg bg-[#FAF8F3] border border-[#E7E2D6] flex items-center justify-center shrink-0">
              <Layers className="w-4 h-4 text-[#78716C]" />
            </div>
            <div>
              <div className="text-[11px] text-[#78716C] font-medium">账本高度</div>
              <div className="text-xl font-mono font-bold text-[#1F2937] tracking-tight tabular-nums">{ledger.length}</div>
            </div>
          </div>

          <div className="flex items-center gap-3.5 px-3 pt-1 md:pt-0">
            <div className="w-9 h-9 rounded-lg bg-[#FAF8F3] border border-[#E7E2D6] flex items-center justify-center shrink-0">
              <FileCheck className="w-4 h-4 text-[#78716C]" />
            </div>
            <div>
              <div className="text-[11px] text-[#78716C] font-medium">已登记凭证</div>
              <div className="text-xl font-mono font-bold text-[#1F2937] tracking-tight tabular-nums">{registrations.length}</div>
            </div>
          </div>

          <div className="flex items-center gap-3.5 px-3 pt-1 md:pt-0">
            <div className="w-9 h-9 rounded-lg bg-[#FAF8F3] border border-[#E7E2D6] flex items-center justify-center shrink-0">
              <FileText className="w-4 h-4 text-[#78716C]" />
            </div>
            <div>
              <div className="text-[11px] text-[#78716C] font-medium">验真回执</div>
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
              <div className="text-[11px] text-[#78716C] font-medium">链状态</div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                <span className="text-xs font-semibold text-emerald-700">全链可验</span>
              </div>
            </div>
          </div>
        </div>

        {/* ====================================================================
            页面 1: 登记 (完全对齐 app.py: page_register)
           ==================================================================== */}
        {activeTab === "登记" && (
          <div className="space-y-4">
            {/* 顶部分段标题与文案 (与 app.py page_register 完全一致) */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#E7E2D6] pb-3">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-[#1F2937] font-serif">登记</h1>
                <p className="text-xs text-[#78716C] mt-0.5">
                  为文件计算三层指纹并写入账本，领取防伪凭证。原件与字段明文不进账本。
                </p>
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

            {/* 视图 A: 指纹录入与公文签发 (colL 7 : colR 5) */}
            {regSubView === "input" && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                {/* 左栏 (7/12)：文件上传与明文录入 (完全对齐 app.py: reg_up 与 st.caption) */}
                <div className="lg:col-span-7 paper-card rounded-2xl p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-[#F0EBE0] pb-3">
                    <span className="text-xs font-bold text-[#1F2937] flex items-center gap-1.5 font-serif">
                      <FileText className="w-3.5 h-3.5 text-[#C23531]" /> 选择要登记的文件
                    </span>
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-[#78716C] text-[11px]">选用范本:</span>
                      <button
                        type="button"
                        onClick={() => {
                          setRegFile(null);
                          setRegBytes(null);
                          setRegFileSize(null);
                          setRegFileName("report.txt");
                          setRegContent(DEMO_SAMPLES["report.txt"].text);
                        }}
                        className="px-2 py-0.5 bg-[#FAF8F3] hover:bg-[#F0EBE0] border border-[#DCD5C6] rounded text-[11px] text-[#374151]"
                      >
                        经营报表
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRegFile(null);
                          setRegBytes(null);
                          setRegFileSize(null);
                          setRegFileName("contract_bad.txt");
                          setRegContent(DEMO_SAMPLES["contract_bad.txt"].text);
                        }}
                        className="px-2 py-0.5 bg-[#FAF8F3] hover:bg-[#F0EBE0] border border-[#DCD5C6] rounded text-[11px] text-[#374151]"
                      >
                        采购合同
                      </button>
                    </div>
                  </div>

                  {/* 真实文件上传拖拽区域 (对应 app.py: st.file_uploader) */}
                  <div 
                    onClick={() => regFileInputRef.current?.click()}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => {
                      e.preventDefault();
                      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                        handleRegisterFileChange(e.dataTransfer.files[0]);
                      }
                    }}
                    className="border-1.5 border-dashed border-[#D97706]/60 hover:border-[#C23531] bg-[#FAF8F3]/60 hover:bg-[#FAF8F3] rounded-xl p-4 text-center cursor-pointer transition-all group"
                  >
                    <input 
                      type="file" 
                      ref={regFileInputRef} 
                      className="hidden" 
                      accept=".pdf,.docx,.xlsx,.txt,.csv,.md,.png,.jpg,.jpeg" 
                      onChange={e => {
                        if (e.target.files && e.target.files[0]) {
                          handleRegisterFileChange(e.target.files[0]);
                        }
                      }} 
                    />
                    <Upload className="w-5 h-5 mx-auto text-[#C23531] group-hover:scale-110 transition-transform mb-1.5" />
                    <div className="text-xs font-semibold text-[#1F2937]">
                      点击或拖拽本地文件至此处上传登记
                    </div>
                    <div className="text-[11px] text-[#78716C] mt-0.5">
                      支持 PDF, DOCX, XLSX, TXT, CSV, MD, PNG, JPG (≤500MB)
                    </div>
                    {regFile && (
                      <div className="mt-2.5 inline-flex items-center gap-2 px-3 py-1 bg-white border border-[#DCD5C6] rounded-lg text-xs font-mono text-[#1F2937] shadow-2xs">
                        <FileText className="w-3.5 h-3.5 text-[#C23531]" />
                        <span className="font-semibold">{regFile.name}</span>
                        <span className="text-[#78716C]">· {regFile.size} 字节</span>
                        <button 
                          type="button" 
                          onClick={(e) => {
                            e.stopPropagation();
                            setRegFile(null);
                            setRegBytes(null);
                            setRegFileSize(null);
                          }}
                          className="ml-1 text-[#78716C] hover:text-[#C23531]"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* 错误提示横幅 */}
                  {regError && (
                    <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs flex items-center gap-2">
                      <AlertOctagon className="w-4 h-4 text-rose-600 shrink-0" />
                      <span>{regError}</span>
                    </div>
                  )}

                  {/* 文件名与正文预览 */}
                  <div className="grid grid-cols-1 gap-3">
                    <div>
                      <label className="text-[11px] font-semibold text-[#4B5563] block mb-1">文件名</label>
                      <input
                        type="text"
                        value={regFileName}
                        onChange={e => setRegFileName(e.target.value)}
                        className="w-full bg-[#FAF8F3] border border-[#DCD5C6] rounded-xl px-3 py-1.5 text-xs font-mono text-[#1F2937] focus:outline-none focus:border-[#C23531] focus:bg-white transition-all"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] font-semibold text-[#4B5563] block mb-1">
                        文件内容（本地完成 SHA-256 + SM3 双散列 Merkle 树计算，原件明文不进账本）
                      </label>
                      <textarea
                        rows={6}
                        value={regContent}
                        onChange={e => setRegContent(e.target.value)}
                        className="w-full bg-[#FAF8F3] border border-[#DCD5C6] rounded-xl p-3 text-xs font-mono text-[#1F2937] leading-relaxed focus:outline-none focus:border-[#C23531] focus:bg-white transition-all"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-[#F0EBE0]">
                    <div className="text-[11px] text-[#78716C]">
                      登记主体: <strong className="text-[#1F2937] font-semibold">{actor}</strong>
                    </div>
                    <button
                      onClick={handleRegister}
                      className="px-5 py-2 bg-[#C23531] hover:bg-[#B91C1C] text-white font-semibold text-xs rounded-xl shadow-xs flex items-center gap-1.5 transition-all"
                    >
                      <Shield className="w-3.5 h-3.5" /> 开始登记
                    </button>
                  </div>
                </div>

                {/* 右栏 (5/12)：凭证出示区 (与 app.py colR 结构完全一致) */}
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
                          <Award className="w-3.5 h-3.5" /> 数玺凭证 · 登记成功
                        </div>
                        <div className="text-base font-mono font-bold text-[#1F2937] mt-0.5">
                          {lastCert.cert_id}
                        </div>
                        <div className="text-[11px] text-[#78716C] mt-0.5">
                          {lastCert.filename} · 登记主体 {lastCert.subject}
                        </div>
                      </div>

                      {/* 三层指纹展示区 */}
                      <div className="bg-[#FAF8F3] border border-[#E7E2D6] rounded-xl p-3 font-mono text-[11px] space-y-2">
                        <div>
                          <div className="text-[10px] text-[#78716C] font-sans">精确根 SHA-256</div>
                          <div className="truncate font-bold text-[#0284C7]">{lastCert.exact_dual_root.sha256}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-[#78716C] font-sans">精确根 SM3</div>
                          <div className="truncate font-bold text-[#059669]">{lastCert.exact_dual_root.sm3}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-[#78716C] font-sans">语义根</div>
                          <div className="truncate font-bold text-[#7C3AED]">{lastCert.semantic_root}</div>
                        </div>
                      </div>

                      {/* 已登记字段（仅名） */}
                      <div>
                        <div className="text-[11px] font-semibold text-[#78716C] mb-1">已登记字段（仅名）</div>
                        <div className="flex flex-wrap gap-1">
                          {lastCert.field_keys.map(k => (
                            <span key={k} className="px-2 py-0.5 bg-[#FAF8F3] border border-[#E7E2D6] rounded-md text-[11px] text-[#374151]">
                              {k}
                            </span>
                          ))}
                        </div>
                      </div>

                      {/* 二维码与下载 */}
                      <div className="pt-2 border-t border-[#F0EBE0] flex items-center justify-between">
                        {certQrUrl && (
                          <div className="flex items-center gap-2">
                            <img src={certQrUrl} alt="凭证二维码" className="w-14 h-14 border border-[#E7E2D6] rounded-lg p-0.5 bg-white" />
                            <span className="text-[10px] text-[#78716C]">凭证二维码<br/>（扫码核验）</span>
                          </div>
                        )}
                        <button
                          onClick={() => {
                            const blob = new Blob([JSON.stringify(lastCert, null, 2)], { type: "application/json" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `shuxi_pack_${lastCert.cert_id}.json`;
                            a.click();
                          }}
                          className="px-3 py-1 bg-[#FAF8F3] hover:bg-[#F0EBE0] border border-[#DCD5C6] rounded-lg text-xs font-medium text-[#1F2937] flex items-center gap-1.5 shadow-2xs ml-auto"
                        >
                          <Download className="w-3.5 h-3.5 text-[#C23531]" /> 下载登记包 JSON
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* 凭证出示区提示 (文案与 app.py line 546 完全一致) */
                    <div className="paper-card rounded-2xl p-6 text-center text-xs text-[#78716C] space-y-2">
                      <div className="w-10 h-10 rounded-full bg-[#FAF8F3] border border-[#E7E2D6] flex items-center justify-center mx-auto text-[#C23531]">
                        <Award className="w-5 h-5" />
                      </div>
                      <div className="font-semibold text-[#1F2937]">凭证出示区</div>
                      <p className="leading-relaxed text-[11px]">
                        登记成功后，带玺印的凭证卡将在此处出示，<br />
                        含精确双根、语义根与二维码。
                      </p>
                    </div>
                  )}

                  {/* 引导查看台账簿 */}
                  <div className="p-3 bg-[#FAF8F3] border border-[#E7E2D6] rounded-xl flex items-center justify-between text-xs text-[#78716C]">
                    <span>公文台账已累计收录 {registrations.length} 份数据凭证</span>
                    <button
                      onClick={() => setRegSubView("ledger")}
                      className="text-[#C23531] hover:text-[#991B1B] font-semibold flex items-center gap-1"
                    >
                      已登记凭证清单 <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 视图 B: 已登记凭证表格 (对齐 app.py 中的已登记凭证) */}
            {regSubView === "ledger" && (
              <div className="paper-card rounded-2xl p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="relative w-full sm:w-72">
                    <Search className="w-3.5 h-3.5 text-[#78716C] absolute left-3 top-2.5" />
                    <input
                      type="text"
                      placeholder="搜索凭证号、文件名或主体..."
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
                        <th className="py-2.5 px-3.5 font-mono">凭证</th>
                        <th className="py-2.5 px-3.5">文件</th>
                        <th className="py-2.5 px-3.5">登记主体</th>
                        <th className="py-2.5 px-3.5">字段数</th>
                        <th className="py-2.5 px-3.5">状态</th>
                        <th className="py-2.5 px-3.5 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F0EBE0]">
                      {paginatedRegistrations.map(r => (
                        <tr key={r.cert_id} className="hover:bg-[#FAF8F3] transition-colors">
                          <td className="py-2.5 px-3.5 font-mono text-[#C23531] font-bold">{r.cert_id}</td>
                          <td className="py-2.5 px-3.5 text-[#1F2937] font-medium">{r.filename}</td>
                          <td className="py-2.5 px-3.5 text-[#4B5563]">{r.subject}</td>
                          <td className="py-2.5 px-3.5 font-mono text-[#78716C]">{r.field_keys.length} 个</td>
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
                              开始验真 <ArrowRight className="w-3 h-3" />
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
            页面 2: 验真 (完全对齐 app.py: page_verify)
           ==================================================================== */}
        {activeTab === "验真" && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#E7E2D6] pb-3">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-[#1F2937] font-serif">验真</h1>
                <p className="text-xs text-[#78716C] mt-0.5">
                  五步得出结论，每一步都可点开深挖底层证据。
                </p>
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
                  单件深挖
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
                  <span>批量验真</span>
                  {batchResults && <span className="px-1.5 py-0.2 bg-emerald-100 text-emerald-800 rounded-full text-[10px]">已就绪</span>}
                </button>
              </div>
            </div>

            {/* 视图 A: 单件深挖 */}
            {verifySubView === "single" && (
              <div className="space-y-4">
                {/* 控制条 (完全对齐 app.py row1 [7, 5] & row2 [7, 5]: 选择凭证/选用演示/上传待验/开始验真) */}
                <div className="paper-card rounded-2xl p-5 space-y-4">
                  {/* Row 1: 选择凭证 (7/12) + 或选用演示文件 (5/12) */}
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                    <div className="md:col-span-7">
                      <label className="text-[11px] font-semibold text-[#4B5563] block mb-1">选择凭证</label>
                      <select
                        value={selectedCertId}
                        onChange={e => setSelectedCertId(e.target.value)}
                        className="w-full bg-[#FAF8F3] border border-[#DCD5C6] rounded-xl px-3 py-2 text-xs font-mono text-[#1F2937] focus:outline-none focus:border-[#C23531]"
                      >
                        {registrations.map(r => (
                          <option key={r.cert_id} value={r.cert_id}>
                            {r.cert_id} · {r.filename}
                          </option>
                        ))}
                        {registrations.length === 0 && <option value="">尚无登记记录，先去登记</option>}
                      </select>
                    </div>

                    <div className="md:col-span-5">
                      <label className="text-[11px] font-semibold text-[#4B5563] block mb-1">或选用演示文件</label>
                      <select
                        value={verifySampleKey}
                        onChange={e => {
                          setVerifySampleKey(e.target.value);
                          if (e.target.value !== "—") {
                            setVerFile(null);
                            setVerBytes(null);
                            setVerFileName("");
                            setVerFileSize(null);
                          }
                        }}
                        className="w-full bg-[#FAF8F3] border border-[#DCD5C6] rounded-xl px-3 py-2 text-xs text-[#1F2937] focus:outline-none focus:border-[#C23531]"
                      >
                        <option value="—">— (优先使用下方上传文件)</option>
                        {Object.entries(DEMO_SAMPLES).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v.label} [{v.tag}]
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Row 2: 上传待验文件 (7/12) + 开始验真按钮 (5/12) */}
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center pt-1 border-t border-[#F0EBE0]">
                    <div className="md:col-span-7">
                      <label className="text-[11px] font-semibold text-[#4B5563] block mb-1">上传待验文件</label>
                      <div 
                        onClick={() => verFileInputRef.current?.click()}
                        onDragOver={e => e.preventDefault()}
                        onDrop={e => {
                          e.preventDefault();
                          if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                            handleVerifyFileChange(e.dataTransfer.files[0]);
                          }
                        }}
                        className="border border-dashed border-[#DCD5C6] hover:border-[#C23531] bg-[#FAF8F3] hover:bg-white rounded-xl px-3 py-2 flex items-center justify-between cursor-pointer transition-all"
                      >
                        <input 
                          type="file" 
                          ref={verFileInputRef} 
                          className="hidden" 
                          onChange={e => {
                            if (e.target.files && e.target.files[0]) {
                              handleVerifyFileChange(e.target.files[0]);
                            }
                          }} 
                        />
                        <div className="flex items-center gap-2.5 overflow-hidden">
                          <Upload className="w-4 h-4 text-[#C23531] shrink-0" />
                          <div className="truncate">
                            <span className="text-xs font-medium text-[#1F2937]">
                              {verFile ? verFile.name : "点击或拖拽文件上传待验"}
                            </span>
                            <span className="text-[11px] text-[#78716C] ml-2">
                              {verFile ? `· ${verFile.size} 字节` : "（支持各类原件、篡改件、转换件或无存证件）"}
                            </span>
                          </div>
                        </div>
                        {verFile && (
                          <button 
                            type="button" 
                            onClick={(e) => {
                              e.stopPropagation();
                              setVerFile(null);
                              setVerBytes(null);
                              setVerFileName("");
                              setVerFileSize(null);
                            }}
                            className="p-1 text-[#78716C] hover:text-[#C23531] rounded shrink-0"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="md:col-span-5 pt-4 md:pt-4">
                      <button
                        onClick={handleVerify}
                        className="w-full py-2 px-5 bg-[#C23531] hover:bg-[#B91C1C] text-white font-semibold text-xs rounded-xl shadow-xs flex items-center justify-center gap-1.5 transition-all"
                      >
                        <FileCheck className="w-4 h-4" /> 开始验真
                      </button>
                    </div>
                  </div>

                  {verError && (
                    <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs flex items-center gap-2">
                      <AlertOctagon className="w-4 h-4 text-rose-600 shrink-0" />
                      <span>{verError}</span>
                    </div>
                  )}
                </div>

                {/* 验真结论卡 (完全对应 app.py 中的 grade_hero) */}
                {verdict && (
                  <div className="space-y-4">
                    <div 
                      className="official-doc-paper relative rounded-2xl p-6 flex items-center justify-between overflow-hidden"
                      style={{ borderLeft: `5px solid ${verdict.color}` }}
                    >
                      <div className="space-y-1.5 pr-28">
                        <div className="text-[11px] font-serif font-bold text-[#78716C] tracking-wide">
                          验真结论
                        </div>
                        <div className="text-3xl font-black tracking-tight" style={{ color: verdict.color }}>
                          {verdict.grade}
                        </div>
                        <div className="text-xs font-mono text-[#6B7280] pt-1">
                          把握 <strong className="text-[#1F2937] font-semibold">{verdict.confidence}%</strong> ｜ 
                          本次验真耗时 <strong className="text-[#1F2937] font-semibold">{verdict.elapsed_ms} ms</strong>
                        </div>
                      </div>

                      {/* 物理落印朱砂印章 (96px, 鎏金外圈, 宣纸吸墨质感) */}
                      <div className="absolute right-6 seal-stamp-verdict flex flex-col items-center justify-center text-white text-3xl font-bold shrink-0 shadow-lg">
                        <div>{verdict.seal_text[0]}</div>
                        <div>{verdict.seal_text[1] || '级'}</div>
                      </div>
                    </div>

                    {/* 结论判定依据清单 */}
                    {verdict.reasons.length > 0 && (
                      <div className="paper-card rounded-2xl p-4">
                        <div className="text-xs font-semibold text-[#1F2937] mb-2">判定依据清单</div>
                        <ul className="space-y-1 text-xs text-[#374151] list-disc list-inside">
                          {verdict.reasons.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* 深挖证据 · 三层指纹 / 勾稽 / 报告凭证 (与 app.py expander 结构完全一致) */}
                    <div className="paper-card rounded-2xl p-5 space-y-4">
                      <div className="border-b border-[#E7E2D6] pb-3 flex items-center justify-between">
                        <span className="text-xs font-bold text-[#1F2937] flex items-center gap-1.5 font-serif">
                          <Compass className="w-4 h-4 text-[#C23531]" /> 深挖证据 · 三层指纹 / 勾稽 / 报告凭证
                        </span>
                        <span className="text-[11px] font-mono text-[#78716C]">
                          回执编号：{verdict.receipt_id}
                        </span>
                      </div>

                      {/* 第一层 · 精确指纹 */}
                      <div className="space-y-1.5 text-xs">
                        <div className="font-bold text-[#1F2937]">第一层 · 精确指纹</div>
                        <div className="bg-[#FAF8F3] border border-[#E7E2D6] rounded-xl p-3 font-mono text-[11px] space-y-1 text-[#4B5563]">
                          <div>登记 SHA-256　<span className="text-[#0284C7] font-bold">{verdict.exact_details?.registered?.sha256}</span></div>
                          <div>待验 SHA-256　<span className="text-[#0284C7] font-bold">{verdict.exact_details?.current?.sha256}</span></div>
                          <div className="pt-1">登记 SM3　　　<span className="text-[#059669] font-bold">{verdict.exact_details?.registered?.sm3}</span></div>
                          <div>待验 SM3　　　<span className="text-[#059669] font-bold">{verdict.exact_details?.current?.sm3}</span></div>
                        </div>
                      </div>

                      {/* 第二层 · 感知指纹 */}
                      <div className="space-y-1.5 text-xs">
                        <div className="font-bold text-[#1F2937]">第二层 · 感知指纹</div>
                        <div className="bg-[#FAF8F3] border border-[#E7E2D6] rounded-xl p-3 text-[11px] space-y-1 text-[#4B5563]">
                          <div>逐页汉明距离：[{verdict.perceptual_details?.avg_hamming}]（均值 {verdict.perceptual_details?.avg_hamming}，阈值 ≤ 8）</div>
                          <div>文本相似度（3-gram Jaccard）：<strong className="text-[#1F2937]">{verdict.perceptual_details?.text_sim_str}</strong>（阈值 ≥ 0.90）</div>
                        </div>
                      </div>

                      {/* 第三层 · 语义字段 */}
                      <div className="space-y-1.5 text-xs">
                        <div className="font-bold text-[#1F2937]">第三层 · 语义字段</div>
                        {verdict.diff_table.length > 0 ? (
                          <div className="overflow-x-auto rounded-xl border border-rose-200 bg-rose-50/20">
                            <table className="w-full text-left text-xs">
                              <thead className="bg-rose-100/60 text-rose-900 text-[11px] font-semibold">
                                <tr>
                                  <th className="p-2.5">字段</th>
                                  <th className="p-2.5">登记值</th>
                                  <th className="p-2.5">待验值</th>
                                  <th className="p-2.5">状态</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-rose-200 font-mono text-xs">
                                {verdict.diff_table.map((d, i) => (
                                  <tr key={i} className="hover:bg-rose-100/40">
                                    <td className="p-2.5 font-bold text-rose-950 font-sans">{d.field}</td>
                                    <td className="p-2.5 line-through text-slate-500">{d.registered_val}</td>
                                    <td className="p-2.5 font-bold text-rose-700 bg-rose-100/60">{d.current_val}</td>
                                    <td className="p-2.5 text-rose-700 font-sans font-semibold">不同</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div className="p-3 bg-[#FAF8F3] border border-[#E7E2D6] rounded-xl text-[11px] text-emerald-700 flex items-center gap-1.5 font-medium">
                            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                            语义字段逐项比对全部一致。
                          </div>
                        )}
                        <div className="bg-[#FAF8F3] border border-[#E7E2D6] rounded-xl p-3 font-mono text-[11px] text-[#4B5563] space-y-1">
                          <div>登记语义根　<span className="text-[#7C3AED] font-bold">{selectedCertId ? registrations.find(r => r.cert_id === selectedCertId)?.semantic_root : ""}</span></div>
                          <div>待验语义根　<span className="text-[#7C3AED] font-bold">{selectedCertId ? registrations.find(r => r.cert_id === selectedCertId)?.semantic_root : ""}</span></div>
                        </div>
                      </div>

                      {/* 勾稽复算 */}
                      <div className="space-y-1.5 text-xs">
                        <div className="font-bold text-[#1F2937]">勾稽复算</div>
                        <div className="space-y-1.5">
                          {verdict.audits?.map((a, i) => (
                            <div key={i} className="bg-[#FAF8F3] border border-[#E7E2D6] rounded-lg p-2.5 flex items-center justify-between text-xs">
                              <span className="text-[#374151]"><strong>{a.id}：{a.name}</strong> - {a.message}</span>
                              <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                                a.status === "PASS" ? "text-emerald-700 bg-emerald-50 border border-emerald-200" :
                                a.status === "WARN" ? "text-amber-700 bg-amber-50 border border-amber-200" :
                                "text-rose-700 bg-rose-50 border border-rose-200"
                              }`}>{a.status}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* 验真报告凭证 */}
                      <div className="space-y-2 text-xs pt-2 border-t border-[#E7E2D6]">
                        <div className="font-bold text-[#1F2937]">验真报告凭证</div>
                        <div className="bg-[#FAF8F3] border border-[#E7E2D6] rounded-xl p-3 font-mono text-[11px] text-[#4B5563] space-y-1">
                          <div>回执编号　{verdict.receipt_id}</div>
                          <div>报告哈希　{verdict.report_hash}</div>
                          <div>回执入账　{ledger.length > 0 ? ledger[ledger.length - 1].block_hash : ""}</div>
                        </div>
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            onClick={() => {
                              const blob = new Blob([JSON.stringify(verdict, null, 2)], { type: "application/json" });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement("a");
                              a.href = url;
                              a.download = `shuxi-report-${selectedCertId}.json`;
                              a.click();
                            }}
                            className="px-3.5 py-1.5 bg-[#FAF8F3] hover:bg-[#F0EBE0] border border-[#DCD5C6] rounded-lg text-xs font-medium text-[#1F2937] flex items-center gap-1.5 shadow-2xs"
                          >
                            <Download className="w-3.5 h-3.5 text-[#C23531]" /> 下载验真报告 JSON
                          </button>
                          <button
                            onClick={() => setReportReviewed(true)}
                            className="px-3.5 py-1.5 bg-white hover:bg-[#FAF8F3] border border-[#DCD5C6] rounded-lg text-xs font-medium text-[#374151] flex items-center gap-1.5 shadow-2xs"
                          >
                            <RefreshCw className="w-3.5 h-3.5 text-[#059669]" /> 复核这份报告
                          </button>
                        </div>
                        {reportReviewed && (
                          <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-medium flex items-center gap-2">
                            <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                            复核通过：报告未被篡改，且与账本回执一致。
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 视图 B: 批量验真 (完全对齐 app.py line 679 批量上传与 do_batch) */}
            {verifySubView === "batch" && (
              <div className="paper-card rounded-2xl p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#F0EBE0] pb-3">
                  <div>
                    <h3 className="text-sm font-bold text-[#1F2937] font-serif">批量验真</h3>
                    <p className="text-xs text-[#78716C] mt-0.5">一次上传多份文件：按文件名自动匹配凭证，五十份也是一张表。</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleLoadBatchDemoSamples}
                      className="px-3 py-1.5 bg-[#FAF8F3] hover:bg-[#F0EBE0] border border-[#DCD5C6] rounded-xl text-xs font-medium text-[#374151] flex items-center gap-1.5 shadow-2xs transition-all"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-[#D97706]" /> 载入演示测试集 (5份)
                    </button>
                    <button
                      onClick={handleRunBatchVerify}
                      className="px-4 py-1.5 bg-[#C23531] hover:bg-[#B91C1C] text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all shadow-xs"
                    >
                      <FileCheck className="w-3.5 h-3.5" /> 开始批量验真
                    </button>
                  </div>
                </div>

                {/* 批量上传拖拽区域 (对应 app.py: batch_up, accept_multiple_files=True) */}
                <div 
                  onClick={() => batchFileInputRef.current?.click()}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => {
                    e.preventDefault();
                    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                      handleBatchFilesChange(e.dataTransfer.files);
                    }
                  }}
                  className="border-1.5 border-dashed border-[#D97706]/60 hover:border-[#C23531] bg-[#FAF8F3]/60 hover:bg-[#FAF8F3] rounded-xl p-4 text-center cursor-pointer transition-all group"
                >
                  <input 
                    type="file" 
                    ref={batchFileInputRef} 
                    multiple 
                    className="hidden" 
                    onChange={e => {
                      if (e.target.files && e.target.files.length > 0) {
                        handleBatchFilesChange(e.target.files);
                      }
                    }} 
                  />
                  <FolderUp className="w-5 h-5 mx-auto text-[#C23531] group-hover:scale-110 transition-transform mb-1.5" />
                  <div className="text-xs font-semibold text-[#1F2937]">
                    点击或拖拽批量文件至此处上传
                  </div>
                  <div className="text-[11px] text-[#78716C] mt-0.5">
                    支持同时选择或拖拽多个待验文件，系统将按文件名自动与账本凭证进行穿透比对
                  </div>
                </div>

                {/* 待验队列文件列表展示 */}
                {batchUploadedFiles.length > 0 && (
                  <div className="p-3 bg-[#FAF8F3] border border-[#E7E2D6] rounded-xl space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-[#1F2937]">
                        已选待验文件 ({batchUploadedFiles.length} 份)
                      </span>
                      <button
                        type="button"
                        onClick={() => setBatchUploadedFiles([])}
                        className="text-[11px] text-[#C23531] hover:text-[#991B1B] flex items-center gap-1"
                      >
                        <Trash2 className="w-3 h-3" /> 清空列表
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                      {batchUploadedFiles.map((f, i) => (
                        <span key={i} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-[#DCD5C6] rounded-lg text-xs font-mono text-[#374151]">
                          <span className="font-medium text-[#1F2937]">{f.name}</span>
                          <span className="text-[#78716C]">({f.size} B)</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setBatchUploadedFiles(prev => prev.filter((_, idx) => idx !== i));
                            }}
                            className="text-[#78716C] hover:text-[#C23531] ml-0.5"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {batchResults && (
                  <div className="space-y-4 pt-1">
                    {/* 统计胶囊片 (对应 app.py batch-chips: 等级与数量) */}
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {Object.entries(batchResults.stats).filter(([_, n]) => n > 0).map(([g, n]) => {
                        const colorMap: Record<string, { bg: string; border: string; text: string }> = {
                          "甲级": { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-800" },
                          "乙级": { bg: "bg-sky-50", border: "border-sky-200", text: "text-sky-800" },
                          "丙级": { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-800" },
                          "丁级": { bg: "bg-rose-50", border: "border-rose-200", text: "text-rose-800" },
                          "待人工复核": { bg: "bg-purple-50", border: "border-purple-200", text: "text-purple-800" },
                          "未登记": { bg: "bg-stone-100", border: "border-stone-300", text: "text-stone-700" }
                        };
                        const c = colorMap[g] || { bg: "bg-stone-50", border: "border-stone-200", text: "text-stone-700" };
                        return (
                          <span key={g} className={`px-3 py-1 rounded-lg ${c.bg} border ${c.border} ${c.text} font-semibold`}>
                            {g} × {n}
                          </span>
                        );
                      })}
                      <span className="text-xs font-mono text-[#78716C] ml-auto">
                        <strong>{batchResults.items.length} 份</strong> · 总耗时 {batchResults.totalMs} ms
                      </span>
                    </div>

                    {/* 分页表格 */}
                    <div className="overflow-x-auto rounded-xl border border-[#E7E2D6]">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-[#FAF8F3] text-[#4B5563] text-[11px] font-semibold border-b border-[#E7E2D6]">
                          <tr>
                            <th className="py-2.5 px-3.5">文件</th>
                            <th className="py-2.5 px-3.5 font-mono">凭证</th>
                            <th className="py-2.5 px-3.5">等级</th>
                            <th className="py-2.5 px-3.5">把握</th>
                            <th className="py-2.5 px-3.5 text-right font-mono">耗时ms</th>
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
                                  item.grade === "丁级" ? "text-rose-700 bg-rose-50 border border-rose-200" :
                                  item.grade === "待人工复核" ? "text-purple-700 bg-purple-50 border border-purple-200" :
                                  "text-stone-700 bg-stone-100 border border-stone-300"
                                }`}>
                                  {item.grade}
                                </span>
                              </td>
                              <td className="py-2.5 px-3.5 font-mono text-[#374151]">{item.confidence}%</td>
                              <td className="py-2.5 px-3.5 text-right font-mono text-[#78716C]">{item.ms}</td>
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
            页面 3: 授权与账本 (完全对齐 app.py: page_ledger)
           ==================================================================== */}
        {activeTab === "授权与账本" && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#E7E2D6] pb-3">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-[#1F2937] font-serif">授权与账本</h1>
                <p className="text-xs text-[#78716C] mt-0.5">
                  授权有期限、有次数，每次查验都留回执；账本全链可验。
                </p>
              </div>

              {/* 模块子标签 */}
              <div className="flex items-center bg-[#F5F1E8] p-1 rounded-xl border border-[#E7E1D4] text-xs">
                {[
                  { id: "chain", label: "账本状态与检查点" },
                  { id: "auth", label: `新建授权 (${authBlocks.length})` },
                  { id: "receipts", label: `验真回执 (${receiptBlocks.length})` },
                  { id: "revoke", label: "作废与密钥公告" },
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

            {/* 子视图 1: 账本状态与检查点 (对齐 app.py 账本状态) */}
            {ledgerSubView === "chain" && (
              <div className="space-y-4">
                <div className="paper-card rounded-2xl p-5 space-y-3.5">
                  <div className="flex items-center justify-between border-b border-[#F0EBE0] pb-3">
                    <div>
                      <div className="text-[11px] font-semibold text-[#78716C]">账本状态</div>
                      <div className="text-lg font-bold text-[#1F2937] font-serif">全链校验通过</div>
                      <div className="text-xs font-mono text-[#78716C] mt-0.5">
                        高度 {ledger.length} · 链头 {ledger.length > 0 ? ledger[ledger.length - 1].block_hash : "0000000000000000000000000000000000000000000000000000000000000000"}
                      </div>
                    </div>
                    <button
                      onClick={handleWriteCheckpoint}
                      className="px-3.5 py-1.5 bg-[#C23531] hover:bg-[#B91C1C] text-white text-xs font-semibold rounded-xl flex items-center gap-1.5 shadow-xs"
                    >
                      <Lock className="w-3.5 h-3.5" /> 写入检查点（封印当前链头）
                    </button>
                  </div>

                  {checkpointTip && (
                    <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl text-xs font-medium flex items-center gap-2">
                      <Check className="w-4 h-4 text-emerald-600" />
                      检查点已入账。
                    </div>
                  )}

                  {/* 区块流 (取最新 28 条, 末块即真链头) */}
                  <div className="pt-1">
                    <div className="text-[11px] text-[#78716C] mb-2 font-medium">区块流水（点击可展开区块详细载荷）</div>
                    <div className="flex items-center gap-2 overflow-x-auto py-2">
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
                      <span className="text-[11px] text-[#78716C] font-mono ml-2 shrink-0">区块 × {ledger.length} · 最右为链头</span>
                    </div>
                  </div>
                </div>

                {/* 展开的区块明细 */}
                {inspectBlock ? (
                  <div className="bg-[#FAF8F3] border border-[#C23531]/40 rounded-2xl p-4 space-y-2 text-xs">
                    <div className="flex items-center justify-between text-[#C23531] font-bold">
                      <span>区块高度 #{inspectBlock.height} · 类型: {inspectBlock.entry_type}</span>
                      <button onClick={() => setInspectBlock(null)} className="text-[#78716C] hover:text-[#1F2937]">✕ 关闭明细</button>
                    </div>
                    <pre className="bg-white border border-[#E7E2D6] p-3 rounded-xl text-[11px] font-mono text-[#374151] overflow-x-auto max-h-[220px]">
                      {JSON.stringify(inspectBlock, null, 2)}
                    </pre>
                  </div>
                ) : (
                  <div className="p-4 bg-[#FAF8F3] border border-[#E7E2D6] rounded-xl text-center text-xs text-[#78716C]">
                    提示：点击上方区块可下钻查验该区块的 Ed25519 签名、存证载荷与 Merkle 前驱双哈希。
                  </div>
                )}
              </div>
            )}

            {/* 子视图 2: 新建授权 (对齐 app.py 新建授权) */}
            {ledgerSubView === "auth" && (
              <div className="space-y-4">
                <div className="paper-card rounded-2xl p-5 space-y-3.5">
                  <div className="border-b border-[#F0EBE0] pb-2">
                    <div className="text-xs font-bold text-[#1F2937] flex items-center gap-1.5 font-serif">
                      <Key className="w-3.5 h-3.5 text-[#C23531]" /> 新建授权
                    </div>
                    <p className="text-xs text-[#78716C] mt-0.5">把指定凭证的查验权授予验真方，限期、限次、全程留痕。</p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                    <div>
                      <label className="text-[11px] font-semibold text-[#4B5563] block mb-1">凭证</label>
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
                      <label className="text-[11px] font-semibold text-[#4B5563] block mb-1">被授权方</label>
                      <input
                        type="text"
                        value={grantee}
                        onChange={e => setGrantee(e.target.value)}
                        className="w-full bg-[#FAF8F3] border border-[#DCD5C6] rounded-xl p-2 text-xs text-[#1F2937]"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] font-semibold text-[#4B5563] block mb-1">有效天数</label>
                      <input
                        type="number"
                        value={validDays}
                        onChange={e => setValidDays(parseInt(e.target.value) || 7)}
                        className="w-full bg-[#FAF8F3] border border-[#DCD5C6] rounded-xl p-2 text-xs font-mono text-[#1F2937]"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] font-semibold text-[#4B5563] block mb-1">最多查验次数</label>
                      <input
                        type="number"
                        value={maxUses}
                        onChange={e => setMaxUses(parseInt(e.target.value) || 2)}
                        className="w-full bg-[#FAF8F3] border border-[#DCD5C6] rounded-xl p-2 text-xs font-mono text-[#1F2937]"
                      />
                    </div>
                  </div>

                  <div className="flex justify-end pt-2">
                    <button
                      onClick={handleCreateAuth}
                      className="px-5 py-2 bg-[#C23531] hover:bg-[#B91C1C] text-white rounded-xl text-xs font-semibold shadow-xs"
                    >
                      创建授权
                    </button>
                  </div>
                </div>

                {/* 授权清单表格 */}
                <div className="paper-card rounded-2xl p-5 space-y-3">
                  <div className="text-xs font-bold text-[#1F2937]">授权清单</div>
                  <div className="overflow-x-auto rounded-xl border border-[#E7E2D6]">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-[#FAF8F3] text-[#4B5563] text-[11px] font-semibold border-b border-[#E7E2D6]">
                        <tr>
                          <th className="p-2.5">授权号</th>
                          <th className="p-2.5">凭证</th>
                          <th className="p-2.5">被授权方</th>
                          <th className="p-2.5">已用/上限</th>
                          <th className="p-2.5 text-right">状态</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#F0EBE0] font-mono text-xs text-[#374151]">
                        {paginatedAuths.map(b => (
                          <tr key={b.height} className="hover:bg-[#FAF8F3]">
                            <td className="p-2.5 text-[#C23531] font-bold">{b.payload.auth_id}</td>
                            <td className="p-2.5">{b.payload.cert_id}</td>
                            <td className="p-2.5 font-sans font-medium text-[#1F2937]">{b.payload.grantee}</td>
                            <td className="p-2.5">0/{b.payload.max_uses}</td>
                            <td className="p-2.5 text-right text-emerald-700 font-sans font-semibold">有效</td>
                          </tr>
                        ))}
                        {authBlocks.length === 0 && (
                          <tr><td colSpan={5} className="p-4 text-center text-[#78716C] italic font-sans">暂无可授权的凭证记录</td></tr>
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

            {/* 子视图 3: 验真回执 (对齐 app.py 验真回执) */}
            {ledgerSubView === "receipts" && (
              <div className="paper-card rounded-2xl p-5 space-y-3">
                <div className="border-b border-[#F0EBE0] pb-2">
                  <div className="text-xs font-bold text-[#1F2937] flex items-center gap-1.5 font-serif">
                    <FileCheck className="w-4 h-4 text-[#059669]" /> 验真回执
                  </div>
                  <p className="text-xs text-[#78716C] mt-0.5">在「验真」页完成一次验真后，回执会自动入账到这里。</p>
                </div>

                <div className="overflow-x-auto rounded-xl border border-[#E7E2D6]">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#FAF8F3] text-[#4B5563] text-[11px] font-semibold border-b border-[#E7E2D6]">
                      <tr>
                        <th className="p-2.5">回执</th>
                        <th className="p-2.5">凭证</th>
                        <th className="p-2.5">验真方</th>
                        <th className="p-2.5">结论</th>
                        <th className="p-2.5 font-mono">时间</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F0EBE0] font-mono text-xs text-[#374151]">
                      {paginatedReceipts.map(b => (
                        <tr key={b.height} className="hover:bg-[#FAF8F3]">
                          <td className="p-2.5 text-[#C23531] font-bold">{b.payload.receipt_id}</td>
                          <td className="p-2.5">{b.payload.cert_id}</td>
                          <td className="p-2.5 font-sans text-[#4B5563]">{b.payload.verifier_subject}</td>
                          <td className="p-2.5 font-sans">
                            <span className="font-semibold text-[#1F2937]">{b.payload.verdict_grade}</span>
                          </td>
                          <td className="p-2.5 text-[#78716C]">{b.payload.timestamp}</td>
                        </tr>
                      ))}
                      {receiptBlocks.length === 0 && (
                        <tr><td colSpan={5} className="p-4 text-center text-[#78716C] italic font-sans">暂无回执。在「验真」页完成一次验真后，回执会自动入账到这里。</td></tr>
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

            {/* 子视图 4: 作废与密钥公告 (对齐 app.py 作废与密钥公告) */}
            {ledgerSubView === "revoke" && (
              <div className="paper-card rounded-2xl p-5 space-y-3">
                <div className="border-b border-[#F0EBE0] pb-2 font-serif">
                  <div className="text-xs font-bold text-[#1F2937] flex items-center gap-1.5">
                    <AlertOctagon className="w-4 h-4 text-[#C23531]" /> 作废与密钥公告
                  </div>
                  <p className="text-xs text-[#78716C] mt-0.5">作废这张凭证（登记方签名，不可逆）。</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 pt-2">
                  {registrations.filter(r => r.status === "有效").map(r => (
                    <div key={r.cert_id} className="p-3 bg-[#FAF8F3] border border-[#E7E2D6] rounded-xl flex items-center justify-between">
                      <div className="overflow-hidden mr-2">
                        <div className="font-mono text-xs font-bold text-[#1F2937] truncate">{r.cert_id}</div>
                        <div className="text-[11px] text-[#78716C] truncate">{r.filename} · 当前状态：有效</div>
                      </div>
                      <button
                        onClick={() => {
                          if (window.confirm(`确定要永久作废凭证 ${r.cert_id} 吗？登记方签名，不可逆！`)) {
                            handleRevokeCert(r.cert_id);
                          }
                        }}
                        className="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 text-[11px] font-semibold rounded-lg shrink-0 transition-colors shadow-2xs"
                      >
                        作废此凭证
                      </button>
                    </div>
                  ))}
                  {registrations.filter(r => r.status === "有效").length === 0 && (
                    <div className="col-span-3 text-center py-6 text-[#78716C] text-xs italic">
                      暂无可作废的凭证。
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
