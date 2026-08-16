#!/bin/bash
# 隧道分享工具 · 一键启动（全自动环境自检）
# 流程：检测 Node → 没有则自动下载便携版到 runtime/（不动系统）→ 启动工具并打开浏览器
cd "$(dirname "$0")"
echo "================ 隧道分享工具 ================"

# 1) 环境自检：找可用的 Node（系统 → 文件夹自带 runtime/）
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ] && [ -x "runtime/bin/node" ]; then NODE_BIN="runtime/bin/node"; fi

if [ -z "$NODE_BIN" ]; then
  echo "[自检] 未检测到 Node.js，正在自动下载便携版（约 25MB，仅一次，装进本文件夹不动系统）..."
  ARCH=$(uname -m)
  if [ "$ARCH" = "arm64" ]; then
    NODE_TAR="node-v22.14.0-darwin-arm64.tar.xz"
  else
    NODE_TAR="node-v22.14.0-darwin-x64.tar.xz"
  fi
  URL="https://registry.npmmirror.com/-/binary/node/v22.14.0/$NODE_TAR"
  if curl -fL --retry 2 --connect-timeout 15 -o "/tmp/$NODE_TAR" "$URL"; then
    mkdir -p runtime
    if tar -xJf "/tmp/$NODE_TAR" -C runtime --strip-components=1; then
      NODE_BIN="runtime/bin/node"
      chmod +x runtime/bin/node
      echo "[自检] 便携 Node 就绪：$("$NODE_BIN" --version)"
    else
      echo "[自检] 解压失败：请手动安装 Node.js（https://nodejs.org 下载 LTS 版）后重新双击"
      read -n 1 -s -r -p "按任意键退出..."
      exit 1
    fi
  else
    echo "[自检] 下载失败：请检查网络，或手动安装 Node.js（https://nodejs.org）后重新双击"
    read -n 1 -s -r -p "按任意键退出..."
    exit 1
  fi
else
  echo "[自检] Node 环境就绪：$("$NODE_BIN" --version 2>/dev/null || echo 内置)"
fi

# 2) 隧道组件：启动时由程序自动检测（优先文件夹自带组件/，缺失则在线下载）
echo "[自检] 隧道组件将自动检测，无需手动安装"
echo ""
echo "正在启动，浏览器将自动打开工具页面..."
"$NODE_BIN" server.mjs --open

echo ""
echo "工具已停止，本窗口可直接关闭。"
