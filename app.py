"""
数玺 · 数据文件可信管理系统 (app.py)
规范版本: 1.3
套件标识: SXA1
Streamlit 页面实现 (登记 / 验真 / 授权与账本)
"""

import os
import sys
import json
import time
import base64
from typing import Dict, Any, List

# 引入项目 engine 模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import streamlit as st
from engine.service import ShuXiService, REGISTRAR_SUBJECT, VERIFIER_SUBJECT
from vectors.gen_samples import generate_all_samples, SAMPLE_DIR

DATA_DIR = os.environ.get("SHUXI_DATA_DIR", "data")
DEMO_PASS = os.environ.get("SHUXI_DEMO_PASS", "shuxi-demo")

st.set_page_config(
    page_title="数玺 · 数据可信管理工具",
    page_icon="🛡️",
    layout="wide",
    initial_sidebar_state="expanded"
)

# 注入全局样式 (设计令牌，严格 Section 6 定版值)
CUSTOM_CSS = """
<style>
/* 全局页面底与环境光晕、蓝图网格 */
[data-testid="stAppViewContainer"] {
    background-color: #050811 !important;
    background-image: 
        radial-gradient(circle at 15% 10%, rgba(99,102,241,.16) 0%, transparent 45%),
        radial-gradient(circle at 85% 15%, rgba(14,165,233,.12) 0%, transparent 40%),
        radial-gradient(circle at 50% 90%, rgba(168,85,247,.08) 0%, transparent 50%),
        linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px) !important;
    background-size: 100% 100%, 100% 100%, 100% 100%, 48px 48px, 48px 48px !important;
    background-attachment: fixed !important;
    color: #F1F5F9 !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif !important;
    -webkit-font-smoothing: antialiased !important;
}

/* 主内容区居中与大字防切纪律 */
.main .block-container {
    max-width: 1060px !important;
    padding-top: 2.2rem !important;
    padding-bottom: 3.5rem !important;
}

/* 隐藏 Streamlit 默认菜单与页脚 */
#MainMenu {visibility: hidden;}
footer {visibility: hidden;}
header {visibility: hidden;}

/* 高级黑曜石玻璃质感卡片 */
.glass-card {
    background: linear-gradient(170deg, rgba(16, 24, 44, 0.85) 0%, rgba(9, 14, 28, 0.92) 100%);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 18px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 20px 40px -15px rgba(0,0,0,.6);
    backdrop-filter: blur(16px);
    padding: 24px 28px;
    margin-bottom: 24px;
}

/* 虚线空状态卡 */
.empty-state-card {
    border: 1.5px dashed rgba(255, 255, 255, 0.12);
    background: rgba(13, 20, 36, 0.4);
    border-radius: 18px;
    padding: 36px 24px;
    text-align: center;
    color: #94A3B8;
    margin-bottom: 24px;
}

/* 页头大标题 */
.page-title {
    font-size: 28px;
    font-weight: 800;
    line-height: 1.4;
    color: #F8FAFC;
    margin-bottom: 4px;
    letter-spacing: -0.02em;
}

.page-subtitle {
    font-size: 14px;
    color: #94A3B8;
    line-height: 1.5;
    margin-bottom: 22px;
}

/* 小节标题 (带 3.5px 渐变竖条) */
.section-header {
    font-size: 16px;
    font-weight: 700;
    color: #F8FAFC;
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 24px;
    margin-bottom: 12px;
}
.section-header::before {
    content: "";
    display: inline-block;
    width: 3.5px;
    height: 16px;
    background: linear-gradient(180deg, #6366F1, #0EA5E9);
    border-radius: 2px;
}

/* 顶部四格状态条 */
.status-bar-container {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    background: linear-gradient(170deg, rgba(16, 24, 44, 0.9) 0%, rgba(9, 14, 28, 0.95) 100%);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    padding: 14px 0;
    margin-bottom: 24px;
    box-shadow: 0 12px 28px -10px rgba(0, 0, 0, 0.5);
}
.status-col {
    text-align: center;
    border-right: 1px solid rgba(255, 255, 255, 0.06);
    padding: 4px 12px;
}
.status-col:last-child {
    border-right: none;
}
.status-label {
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.5px;
    color: #94A3B8;
    margin-bottom: 3px;
}
.status-val {
    font-family: "SF Mono", ui-monospace, Menlo, monospace;
    font-size: 20px;
    font-weight: 700;
    color: #F8FAFC;
    font-variant-numeric: tabular-nums;
}

/* 玺印样式与落印动画 (6.2) */
@keyframes stampDrop {
    0% { transform: scale(2.3) rotate(-20deg); opacity: 0; }
    70% { transform: scale(0.92) rotate(-5deg); opacity: 1; }
    85% { transform: scale(1.05) rotate(-8deg); }
    100% { transform: scale(1.0) rotate(-7deg); opacity: 1; }
}

.seal-verdict {
    width: 96px;
    height: 96px;
    background: radial-gradient(circle at 35% 35%, #DE4A3E, #C02B20 65%, #9E1F16);
    border: 3.5px solid #E6D5B8;
    box-shadow: 0 0 0 1.5px #D4AF37, 0 10px 25px rgba(222,74,62,.4);
    border-radius: 18px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    color: #FFFFFF;
    font-family: "Kaiti SC", "STKaiti", KaiTi, "楷体", serif;
    font-size: 26px;
    font-weight: 800;
    letter-spacing: 2px;
    line-height: 1.15;
    transform: rotate(-7deg);
    animation: stampDrop 0.45s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
    user-select: none;
}

.seal-cert {
    width: 56px;
    height: 56px;
    background: radial-gradient(circle at 35% 35%, #DE4A3E, #C02B20 65%, #9E1F16);
    border: 2px solid #E6D5B8;
    box-shadow: 0 0 0 1px #D4AF37, 0 6px 15px rgba(222,74,62,.35);
    border-radius: 12px;
    display: flex;
    justify-content: center;
    align-items: center;
    color: #FFFFFF;
    font-family: "Kaiti SC", "STKaiti", KaiTi, "楷体", serif;
    font-size: 26px;
    font-weight: 900;
    transform: rotate(-7deg);
    animation: stampDrop 0.45s ease-out forwards;
    user-select: none;
}

/* 结论卡大字与布局 */
.verdict-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.verdict-grade-title {
    font-size: 32px;
    font-weight: 800;
    line-height: 1.3;
}
.verdict-metrics {
    font-family: "SF Mono", ui-monospace, Menlo, monospace;
    font-size: 14px;
    color: #8CA0BE;
    margin-top: 6px;
}

/* 统计胶囊片 */
.stat-chip {
    display: inline-flex;
    align-items: center;
    padding: 4px 12px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 600;
    margin-right: 8px;
    margin-bottom: 8px;
}
.chip-green { background: rgba(52,211,153,.15); border: 1px solid #34D399; color: #34D399; }
.chip-blue { background: rgba(56,189,248,.15); border: 1px solid #38BDF8; color: #38BDF8; }
.chip-yellow { background: rgba(251,191,36,.15); border: 1px solid #FBBF24; color: #FBBF24; }
.chip-pink { background: rgba(251,113,133,.15); border: 1px solid #FB7185; color: #FB7185; }
.chip-purple { background: rgba(167,139,250,.15); border: 1px solid #A78BFA; color: #A78BFA; }
.chip-gray { background: rgba(148,163,184,.15); border: 1px solid #94A3B8; color: #94A3B8; }

/* 字段胶囊片 */
.field-capsule {
    display: inline-block;
    background: rgba(99,102,241,.16);
    border: 1px solid rgba(99,102,241,.35);
    color: #A9BCD9;
    padding: 3px 10px;
    border-radius: 6px;
    font-size: 12px;
    font-family: "SF Mono", ui-monospace, monospace;
    margin: 3px;
}

/* 链方块流向 */
.chain-blocks-row {
    display: flex;
    align-items: center;
    gap: 5px;
    overflow-x: auto;
    padding: 10px 0;
}
.chain-block-box {
    width: 13px;
    height: 13px;
    border-radius: 3px;
    flex-shrink: 0;
}
.chain-head-glow {
    box-shadow: 0 0 10px #22D3EE, 0 0 4px #22D3EE;
    border: 1px solid #FFFFFF;
}

/* 全宽成功横幅 */
.full-width-banner {
    background: rgba(52,211,153,.16);
    border: 1px solid #34D399;
    color: #34D399;
    border-radius: 12px;
    padding: 14px 20px;
    margin: 16px 0;
    font-weight: 600;
}
</style>
"""
st.markdown(CUSTOM_CSS, unsafe_allow_html=True)

# 确保演示数据文件已生成
generate_all_samples()

# 初始化服务
if "service" not in st.session_state:
    st.session_state.service = ShuXiService(DATA_DIR)
svc: ShuXiService = st.session_state.service


# ==========================================================
# 侧边栏: 品牌区、导航、演示主体、一键载入
# ==========================================================
with st.sidebar:
    # 顶部品牌区 (6.1)
    st.markdown("""
    <div style="padding: 10px 0 16px 0;">
        <div style="font-size: 24px; font-weight: 800; color: #F2F6FC; letter-spacing: 1px;">数玺</div>
        <div style="height: 3px; width: 100%; background: linear-gradient(90deg, #6366F1, #A855F7, #22D3EE, #34D399); border-radius: 2px; margin: 6px 0 8px 0;"></div>
        <div style="font-size: 11.5px; color: #7D8DB0; line-height: 1.4;">数据可信管理工具 · 原型 / 规范 v1.3 · 套件 SXA1</div>
    </div>
    """, unsafe_allow_html=True)

    # 演示主体选择器 (6.4 标签逐字:「演示主体」)
    actor_choice = st.selectbox(
        "演示主体",
        options=[REGISTRAR_SUBJECT, VERIFIER_SUBJECT],
        index=0,
        help=f"原型演示口令: {DEMO_PASS}"
    )

    # 侧栏导航 (单选，逐字: 登记、验真、授权与账本)
    nav_page = st.radio(
        "功能导航",
        options=["登记", "验真", "授权与账本"],
        index=0,
        label_visibility="collapsed"
    )

    st.markdown("---")

    # 诚实边界说明 (协议第二部分诚实边界要求)
    st.markdown("""
    <div style="font-size: 11.5px; color: #8CA0BE; line-height: 1.45; background: rgba(13,20,38,.6); padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(148,163,184,.12); margin-bottom: 16px;">
        <strong style="color: #FBBF24;">【协议诚实边界明示】</strong><br>
        本系统只能证明「登记之后未被改动」，不能证明「登记时内容本身真实」；语义层只覆盖带标签字段，无标签自由文本的改动仅靠文本相似度兜底，长文档小幅改动可能不被检出。
    </div>
    """, unsafe_allow_html=True)

    # 侧栏底部一键载入按钮 (6.4 逐字:「一键载入演示数据」)
    if st.button("一键载入演示数据", use_container_width=True):
        # 幂等载入
        existing_filenames = {b["payload"].get("filename") for b in svc.ledger.get_all_blocks() if b.get("entry_type") == "登记"}
        demo_files = [
            ("report.txt", os.path.join(SAMPLE_DIR, "report.txt")),
            ("contract_bad.txt", os.path.join(SAMPLE_DIR, "contract_bad.txt")),
            ("scan_a.png", os.path.join(SAMPLE_DIR, "scan_a.png"))
        ]
        loaded_count = 0
        for fname, fpath in demo_files:
            if fname not in existing_filenames and os.path.exists(fpath):
                with open(fpath, 'rb') as f:
                    content = f.read()
                svc.register_file(fname, content, subject=REGISTRAR_SUBJECT)
                loaded_count += 1
        st.success(f"已确定性载入 {loaded_count} 条演示登记数据！" if loaded_count > 0 else "演示数据已存在，未重复添加（幂等生效）。")
        time.sleep(0.5)
        st.rerun()

    st.caption("写入 3 条虚构演示登记（报表 / 合同 / 扫描件），数据为虚构。")


def render_status_bar():
    """渲染顶部四格状态条 (6.3)"""
    summary = svc.get_status_summary()
    st_dot = "#34D399" if summary["chain_valid"] else "#FB7185"
    st.markdown(f"""
    <div class="status-bar-container">
        <div class="status-col">
            <div class="status-label">账本高度</div>
            <div class="status-val">{summary["height"]}</div>
        </div>
        <div class="status-col">
            <div class="status-label">已登记凭证</div>
            <div class="status-val">{summary["registered_certs"]}</div>
        </div>
        <div class="status-col">
            <div class="status-label">验真回执</div>
            <div class="status-val">{summary["receipts"]}</div>
        </div>
        <div class="status-col">
            <div class="status-label">链状态</div>
            <div class="status-val" style="display: flex; align-items: center; justify-content: center; gap: 6px;">
                <span style="display:inline-block; width:9px; height:9px; border-radius:50%; background:{st_dot};"></span>
                <span style="font-size:15px; color:{st_dot};">{summary["chain_status_text"]}</span>
            </div>
        </div>
    </div>
    """, unsafe_allow_html=True)


# ==========================================================
# 页面 1: 登记
# ==========================================================
if nav_page == "登记":
    st.markdown('<div class="page-title">登记</div>', unsafe_allow_html=True)
    st.markdown('<div class="page-subtitle">为文件计算三层指纹并写入账本，领取防伪凭证。原件与字段明文不进账本。</div>', unsafe_allow_html=True)
    render_status_bar()

    uploaded_files = st.file_uploader(
        "上传待登记数据文件 (支持 PDF/DOCX/XLSX/TXT/CSV/MD/PNG/JPG，上限 500 MB)",
        accept_multiple_files=True,
        type=["pdf", "docx", "xlsx", "txt", "csv", "md", "png", "jpg", "jpeg", "bin"]
    )

    as_collection = False
    if uploaded_files and len(uploaded_files) >= 2:
        as_collection = st.checkbox("作为文件集登记", value=False)

    if st.button("开始登记", type="primary"):
        if not uploaded_files:
            st.error("请先选择或拖拽需要登记的文件。")
        else:
            try:
                if as_collection:
                    # 文件集登记 (5.8)
                    files_payload = [(f.name, f.getvalue()) for f in uploaded_files]
                    res = svc.register_collection(files_payload, subject=actor_choice)
                    st.success(f"文件集登记成功！共 {res['member_count']} 件，总凭证号: {res['cert_id']}")
                else:
                    # 单文件或逐份登记
                    for uf in uploaded_files:
                        data = uf.getvalue()
                        res = svc.register_file(uf.name, data, subject=actor_choice)

                        # 渲染凭证卡 (6.4: 玺印 + 凭证号 + 文件名 + 主体 + 精确双根与语义根 + 字段键名 + 勾稽提示 + 二维码)
                        cert_id = res["cert_id"]
                        reg_block = res["block"]
                        exact_roots = res["exact_dual_root"]
                        sem_root = res["semantic_root"]
                        field_capsules_html = "".join([f'<span class="field-capsule">{k}</span>' for k in res["field_keys"]])

                        audits_info = "、".join(res["audit_results"]) if res["audit_results"] else "未触发数值勾稽"

                        st.markdown(f"""
                        <div class="glass-card" style="position: relative;">
                            <div style="position: absolute; right: 26px; top: 22px;">
                                <div class="seal-cert">玺</div>
                            </div>
                            <div style="font-size: 11.5px; color: #7D8DB0; letter-spacing: 0.5px; margin-bottom: 4px;">确权防伪凭证</div>
                            <div style="font-size: 22px; font-weight: 800; color: #F2F6FC; font-family: monospace; margin-bottom: 12px;">{cert_id}</div>
                            
                            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; font-size: 13.5px; margin-bottom: 14px;">
                                <div><span style="color: #8CA0BE;">登记文件名:</span> <strong>{uf.name}</strong></div>
                                <div><span style="color: #8CA0BE;">确权主体:</span> <strong>{actor_choice}</strong></div>
                            </div>
                            
                            <div style="background: rgba(6,10,19,.75); padding: 12px 14px; border-radius: 10px; font-family: monospace; font-size: 12px; margin-bottom: 14px; border: 1px solid rgba(148,163,184,.1);">
                                <div style="color: #38BDF8; margin-bottom: 3px;">精确双根 (SHA-256): {exact_roots['sha256']}</div>
                                <div style="color: #34D399; margin-bottom: 3px;">精确双根 (SM3国密): {exact_roots['sm3']}</div>
                                <div style="color: #A78BFA;">语义清单根 (Merkle): {sem_root}</div>
                            </div>

                            <div style="margin-bottom: 12px;">
                                <div style="font-size: 12px; color: #8CA0BE; margin-bottom: 6px;">抽取业务字段键清单（仅键名留痕，明文不上账）：</div>
                                <div>{field_capsules_html if field_capsules_html else '<span style="color:#7D8DB0;font-size:12px;">未抽取到键值对</span>'}</div>
                            </div>

                            <div style="font-size: 12px; color: #FBBF24;">
                                勾稽留痕: {audits_info}
                            </div>
                        </div>
                        """, unsafe_allow_html=True)

                        # 下载登记包
                        pack_json = json.dumps(res["pack_data"], ensure_ascii=False, indent=2)
                        st.download_button(
                            label="下载登记包（JSON）",
                            data=pack_json,
                            file_name=f"shuxi_pack_{cert_id}.json",
                            mime="application/json",
                            help="注明：登记包是后续验真与选择性披露的唯一钥匙、须由登记方自行妥善保管！"
                        )
            except ValueError as ve:
                st.error(f"登记失败: {str(ve)}")
            except Exception as e:
                st.error("登记处理异常，请检查文件格式后重试。")

    # 页面下方「已登记凭证」表格
    st.markdown('<div class="section-header">已登记凭证</div>', unsafe_allow_html=True)
    blocks = svc.ledger.get_all_blocks()
    reg_rows = []
    for b in blocks:
        if b.get("entry_type") == "登记":
            p = b.get("payload", {})
            reg_rows.append({
                "凭证号": p.get("cert_id"),
                "文件名": p.get("filename"),
                "主体": p.get("subject"),
                "登记时间": p.get("timestamp"),
                "状态": p.get("status")
            })

    if reg_rows:
        st.dataframe(reg_rows, use_container_width=True)
    else:
        st.markdown("""
        <div class="empty-state-card">
            <div style="font-size: 16px; margin-bottom: 6px;">暂无已登记凭证记录</div>
            <div style="font-size: 13px;">请在上方上传文件登记确权，或在侧边栏点击「一键载入演示数据」。</div>
        </div>
        """, unsafe_allow_html=True)


# ==========================================================
# 页面 2: 验真
# ==========================================================
elif nav_page == "验真":
    st.markdown('<div class="page-title">验真</div>', unsafe_allow_html=True)
    st.markdown('<div class="page-subtitle">五步得出结论，每一步都可点开深挖底层证据。</div>', unsafe_allow_html=True)
    render_status_bar()

    all_blocks = svc.ledger.get_all_blocks()
    registered_certs = [b["payload"] for b in all_blocks if b.get("entry_type") == "登记"]

    if not registered_certs:
        st.markdown("""
        <div class="empty-state-card">
            <div style="font-size: 18px; font-weight: 700; color: #F2F6FC; margin-bottom: 8px;">账本尚无已登记数据</div>
            <div style="font-size: 14px; margin-bottom: 16px;">请先切换至「登记」页面完成确权，或点击侧边栏「一键载入演示数据」体验四级分级验真。</div>
        </div>
        """, unsafe_allow_html=True)
    else:
        cert_options = [f"{c['cert_id']} · {c['filename']}" for c in registered_certs]
        selected_option = st.selectbox("选择凭证", options=cert_options)
        selected_cert_id = selected_option.split(" · ")[0]

        col_src, col_file = st.columns([1, 1])
        with col_src:
            verify_source_mode = st.radio("待验文件来源", ["从演示样例选择", "上传本地待验文件"], horizontal=True)

        input_bytes = None
        input_filename = ""
        with col_file:
            if verify_source_mode == "从演示样例选择":
                sample_files = [f for f in os.listdir(SAMPLE_DIR) if not f.startswith(".")]
                chosen_sample = st.selectbox("选择演示待验文件", options=sorted(sample_files))
                sample_path = os.path.join(SAMPLE_DIR, chosen_sample)
                with open(sample_path, 'rb') as f:
                    input_bytes = f.read()
                input_filename = chosen_sample
            else:
                uf = st.file_uploader("上传待验文件", type=None)
                if uf:
                    input_bytes = uf.getvalue()
                    input_filename = uf.name

        if st.button("开始验真", type="primary"):
            if not input_bytes:
                st.error("请先选择或上传待验文件。")
            else:
                verdict = svc.verify_file(selected_cert_id, input_bytes, verifier_subject=actor_choice)

                # 1. 结论卡 (固定顺序 ①)
                grade_color = verdict.get("color", "#94A3B8")
                seal_label = verdict.get("seal_text", "复核")
                st.markdown(f"""
                <div class="glass-card" style="border-left: 5px solid {grade_color};">
                    <div class="verdict-header">
                        <div>
                            <div class="verdict-grade-title" style="color: {grade_color};">{verdict['label']}</div>
                            <div class="verdict-metrics">把握 {verdict['confidence']}% · 本次验真耗时 {verdict['elapsed_ms']} ms</div>
                        </div>
                        <div class="seal-verdict">
                            <div>{seal_label[0]}</div>
                            <div>{seal_label[1] if len(seal_label) > 1 else '级'}</div>
                        </div>
                    </div>
                </div>
                """, unsafe_allow_html=True)

                # 2. 判定依据卡 (固定顺序 ②)
                st.markdown('<div class="section-header">判定依据</div>', unsafe_allow_html=True)
                basis_html = "".join([f'<li style="margin-bottom: 6px; color: #E6EAF2;">{r}</li>' for r in verdict["reasons"]])
                st.markdown(f"""
                <div class="glass-card" style="padding: 16px 24px;">
                    <ul style="margin: 0; padding-left: 20px;">{basis_html}</ul>
                </div>
                """, unsafe_allow_html=True)

                # 3. 「复核这份报告」按钮 (固定顺序 ③)
                rep_summary = verdict.get("report_summary")
                rep_hash = verdict.get("report_hash")
                if rep_summary and rep_hash:
                    if st.button("复核这份报告"):
                        is_match, check_msg = svc.verify_report(rep_summary, rep_hash)
                        if is_match:
                            st.markdown(f"""
                            <div class="full-width-banner">
                                ✓ 报告复核全链校验通过：{check_msg}
                            </div>
                            """, unsafe_allow_html=True)
                        else:
                            st.error(f"复核失败: {check_msg}")

                # 4. 回执行 (固定顺序 ④)
                rc_id = verdict.get("receipt_id", "N/A")
                st.markdown(f"""
                <div style="font-family: monospace; font-size: 12.5px; color: #8CA0BE; margin: 10px 0 20px 0; background: rgba(13,20,38,.5); padding: 8px 14px; border-radius: 8px; border: 1px solid rgba(148,163,184,.1);">
                    验真回执入账: <strong style="color: #38BDF8;">{rc_id}</strong> ｜ 报告哈希: <span style="color: #A9BCD9;">{rep_hash}</span>
                </div>
                """, unsafe_allow_html=True)

                # 5. 折叠区「深挖证据 · 三层指纹 / 勾稽 / 报告凭证」(冰山下层 ⑤)
                with st.expander("深挖证据 · 三层指纹 / 勾稽 / 报告凭证", expanded=False):
                    tab_ex, tab_pc, tab_sm, tab_aud = st.tabs(["精确层 (字节)", "感知层 (长相)", "语义层 (事实)", "勾稽审计"])

                    with tab_ex:
                        ex_info = verdict.get("exact_details", {})
                        st.write("精确双根比对结果:", "逐字节 100% 匹配" if ex_info.get("match") else "精确层存在改动")
                        st.json(ex_info)

                    with tab_pc:
                        pc_info = verdict.get("perceptual_details", {})
                        st.markdown(f"""
                        - 平均汉明距离: **{pc_info.get('avg_hamming', 'N/A')}** (阈值 ≤ 8)
                        - 文本 3-gram 相似度: **{pc_info.get('text_sim_str', 'N/A')}** (阈值 ≥ 0.9000)
                        - 当前页面 pHash: `{pc_info.get('curr_phash')}`
                        - 登记存证 pHash: `{pc_info.get('reg_phash')}`
                        """)

                    with tab_sm:
                        diffs = verdict.get("diff_table", [])
                        if diffs:
                            st.warning(f"检出 {len(diffs)} 处业务事实改动:")
                            st.dataframe(diffs, use_container_width=True)
                        else:
                            st.success("所有语义字段值与登记完全一致，未发生业务数据篡改。")

                    with tab_aud:
                        audits = verdict.get("audits", [])
                        for a in audits:
                            st.markdown(f"- **{a['name']} ({a['id']})**: `{a['status']}` — {a['message']}")

        # 批量验真区 (6.4)
        st.markdown('<div class="section-header">批量验真</div>', unsafe_allow_html=True)
        batch_files = st.file_uploader("上传多个待验文件批量执行", accept_multiple_files=True, key="batch_upload")
        if batch_files and st.button("开始批量验真"):
            b_list = [(bf.name, bf.getvalue()) for bf in batch_files]
            batch_res = svc.batch_verify(b_list, verifier_subject=actor_choice)

            # 统计胶囊片
            st.markdown(f"""
            <div style="margin-bottom: 12px;">
                <span class="stat-chip chip-green">甲级 {batch_res['stats']['甲级']}</span>
                <span class="stat-chip chip-blue">乙级 {batch_res['stats']['乙级']}</span>
                <span class="stat-chip chip-yellow">丙级 {batch_res['stats']['丙级']}</span>
                <span class="stat-chip chip-pink">丁级 {batch_res['stats']['丁级']}</span>
                <span class="stat-chip chip-purple">复核 {batch_res['stats']['待人工复核']}</span>
                <span style="font-size: 13px; color: #8CA0BE; margin-left: 10px;">总耗时: {batch_res['total_elapsed_ms']} ms</span>
            </div>
            """, unsafe_allow_html=True)

            st.dataframe(batch_res["results"], use_container_width=True)


# ==========================================================
# 页面 3: 授权与账本
# ==========================================================
elif nav_page == "授权与账本":
    st.markdown('<div class="page-title">授权与账本</div>', unsafe_allow_html=True)
    st.markdown('<div class="page-subtitle">授权有期限、有次数，每次查验都留回执；账本全链可验。</div>', unsafe_allow_html=True)

    # 账本状态卡 (6.4)
    summary = svc.get_status_summary()
    st_title = "全链校验通过" if summary["chain_valid"] else "全链校验异常！"
    st_title_color = "#34D399" if summary["chain_valid"] else "#FB7185"

    all_blocks = svc.ledger.get_all_blocks()
    total_b = len(all_blocks)

    # 链方块流向生成 (最多 28 块)
    show_blocks = all_blocks[-28:]
    block_boxes_html = ""
    for idx, blk in enumerate(show_blocks):
        is_head = (idx == len(show_blocks) - 1)
        # 渐变从靛蓝到青绿
        box_class = "chain-block-box chain-head-glow" if is_head else "chain-block-box"
        color_hex = "#22D3EE" if is_head else "#6366F1"
        block_boxes_html += f'<div class="{box_class}" style="background: {color_hex};" title="高度 {blk.get("height")} · {blk.get("entry_type")}"></div>'

    st.markdown(f"""
    <div class="glass-card">
        <div style="font-size: 24px; font-weight: 800; color: {st_title_color}; margin-bottom: 6px;">{st_title}</div>
        <div style="font-family: monospace; font-size: 13.5px; color: #8CA0BE; margin-bottom: 12px;">
            高度 {summary['height']} ｜ 链头 &lt;{summary['head_hash']}&gt;
        </div>
        <div class="chain-blocks-row">
            {block_boxes_html if block_boxes_html else '<span style="color:#7D8DB0;font-size:12px;">账本为空</span>'}
            <span style="font-size: 12px; color: #7D8DB0; margin-left: 8px;">区块 × {total_b} · 最右为链头</span>
        </div>
    </div>
    """, unsafe_allow_html=True)

    # 写入检查点按钮 (6.4)
    if st.button("写入检查点（封印当前链头）"):
        cp = svc.write_checkpoint()
        st.success(f"已封印当前链头并写入检查点区块 (高度 {cp['block']['height']})！")
        time.sleep(0.5)
        st.rerun()

    # 授权管理表单与列表
    st.markdown('<div class="section-header">新建授权</div>', unsafe_allow_html=True)
    reg_certs = [b["payload"]["cert_id"] for b in all_blocks if b.get("entry_type") == "登记"]
    if reg_certs:
        with st.form("auth_form"):
            col1, col2 = st.columns(2)
            with col1:
                auth_cert = st.selectbox("选择登记凭证", options=reg_certs)
                grantee = st.text_input("被授权方名称/公钥指纹", value=VERIFIER_SUBJECT)
            with col2:
                days = st.number_input("有效天数", min_value=1, max_value=365, value=30)
                max_u = st.number_input("最多查验次数", min_value=1, max_value=1000, value=10)
            submitted = st.form_submit_button("创建授权")
            if submitted:
                auth_res = svc.create_authorization(auth_cert, grantee, valid_days=days, max_uses=max_u)
                st.success(f"授权创建成功！授权编号: {auth_res['auth_id']}")
                time.sleep(0.5)
                st.rerun()
    else:
        st.info("尚无已登记凭证，请先完成登记后再行授权。")

    st.markdown('<div class="section-header">授权列表</div>', unsafe_allow_html=True)
    auths = svc.ledger.query_authorizations()
    if auths:
        st.dataframe(auths, use_container_width=True)
    else:
        st.markdown("""
        <div class="empty-state-card">
            <div style="font-size: 15px; margin-bottom: 4px;">暂无授权记录</div>
            <div style="font-size: 12.5px;">可在上方表单为合作方创建记名查验授权。</div>
        </div>
        """, unsafe_allow_html=True)

    # 验真回执列表
    st.markdown('<div class="section-header">验真回执</div>', unsafe_allow_html=True)
    receipts = svc.ledger.query_receipts()
    if receipts:
        st.dataframe(receipts, use_container_width=True)
    else:
        st.markdown("""
        <div class="empty-state-card">
            <div style="font-size: 15px; margin-bottom: 4px;">暂无查验回执</div>
            <div style="font-size: 12.5px;">每次在「验真」页执行验真均会自动生成由验真方签名的合规回执入账。</div>
        </div>
        """, unsafe_allow_html=True)

    # 作废与密钥公告区 (6.4)
    st.markdown('<div class="section-header">作废与密钥公告</div>', unsafe_allow_html=True)
    tab_rvk, tab_ann = st.tabs(["选凭证作废", "发布公钥失效/争议公告"])

    with tab_rvk:
        if reg_certs:
            rvk_cert = st.selectbox("选择需作废凭证", options=reg_certs, key="rvk_select")
            rvk_reason = st.text_input("作废原因说明", value="企业项目终止或合同终止", key="rvk_reason")
            confirm_rvk = st.checkbox("二次确认：我已知晓作废操作上账后不可逆", value=False)
            if st.button("作废凭证", type="primary") and confirm_rvk:
                res = svc.revoke_certificate(rvk_cert, rvk_reason)
                st.success(f"凭证 {rvk_cert} 已正式写入作废记录，不可逆生效！")
                time.sleep(0.5)
                st.rerun()
        else:
            st.info("无可作废凭证。")

    with tab_ann:
        with st.form("ann_form"):
            ann_type = st.selectbox("公告类型", ["失效公告", "争议公告"])
            old_fp = st.text_input("旧公钥指纹 (待声明失效或争议的指纹)", value=svc.registrar_km.fingerprint)
            new_fp = st.text_input("新公钥指纹 (失效后新启用的指纹，若争议可留空)", value="")
            ann_reason = st.text_input("公告原因", value="公钥私钥介质例行安全轮换")
            if st.form_submit_button("发布公告"):
                svc.publish_key_announcement(ann_type, old_fp, new_fp, ann_reason)
                st.success(f"已正式发布{ann_type}入账！")
                time.sleep(0.5)
                st.rerun()
