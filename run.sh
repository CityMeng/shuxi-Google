#!/usr/bin/env bash
# 数玺 · 本地一键启动脚本 (run.sh)
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

export SHUXI_DATA_DIR="${SHUXI_DATA_DIR:-data/}"
export SHUXI_DEMO_PASS="${SHUXI_DEMO_PASS:-shuxi-demo}"

echo "=================================================="
echo "数玺 · 数据可信管理工具 (规范 v1.3 · 套件 SXA1)"
echo "数据目录: $SHUXI_DATA_DIR"
echo "演示口令: $SHUXI_DEMO_PASS (原型演示口令)"
echo "=================================================="

# 1. 检查或创建 Python 虚拟环境
if [ ! -d "venv" ]; then
    echo "[1/3] 正在创建 Python 虚拟环境 (venv)..."
    python3 -m venv venv || python3 -m virtualenv venv || echo "未找到 venv 模块，将尝试使用系统 Python 环境"
fi

if [ -f "venv/bin/activate" ]; then
    source venv/bin/activate
fi

# 2. 检查并安装依赖
echo "[2/3] 检查 Python 依赖..."
if command -v pip >/dev/null 2>&1; then
    pip install -r requirements.txt --quiet || echo "依赖安装略过或已就绪"
fi

# 3. 预先生成基准样例数据
python3 vectors/gen_samples.py || true

# 4. 启动 Streamlit
echo "[3/3] 启动数玺 Streamlit 服务 (端口 8501)..."
streamlit run app.py --server.port 8501 --server.address 0.0.0.0
