@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================ 隧道分享工具 ================

rem ---- 1) 找可用的 Node：系统 → 文件夹自带 runtime\ ----
where node >nul 2>nul
if %errorlevel%==0 (
  echo [自检] Node 环境就绪
  node server.mjs --open
  goto :end
)
if exist "runtime\node.exe" (
  echo [自检] 使用自带 Node
  runtime\node.exe server.mjs --open
  goto :end
)

rem ---- 2) 没有则自动下载便携版（仅一次，装进本文件夹不动系统）----
echo [自检] 未检测到 Node.js，正在自动下载便携版（约 30MB，仅一次）...
curl -fL --retry 2 --connect-timeout 15 -o node.zip "https://registry.npmmirror.com/-/binary/node/v22.14.0/node-v22.14.0-win-x64.zip"
if %errorlevel% neq 0 (
  echo [自检] 下载失败：请检查网络，或到 https://nodejs.org 手动安装 Node 后重新双击
  pause
  exit /b 1
)
echo [自检] 正在解压...
powershell -NoProfile -Command "Expand-Archive -Force node.zip ."
if %errorlevel% neq 0 (
  echo [自检] 解压失败，请手动安装 Node.js 后重试
  pause
  exit /b 1
)
for /d %%D in (node-v*-win-*) do (
  if not exist runtime mkdir runtime
  move "%%D\*" "runtime\" >nul 2>nul
  rmdir "%%D" /s /q >nul 2>nul
)
del node.zip >nul 2>nul
if not exist "runtime\node.exe" (
  echo [自检] 解压异常：未找到 runtime\node.exe，请手动安装 Node.js
  pause
  exit /b 1
)
echo [自检] 便携 Node 就绪
runtime\node.exe server.mjs --open

:end
echo.
echo 工具已停止，本窗口可直接关闭。
pause >nul
