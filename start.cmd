@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "BUNDLED=C:\Users\kazur\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

where node >nul 2>nul
if %errorlevel%==0 (
  node server.mjs
  goto :end
)

if exist "%BUNDLED%" (
  "%BUNDLED%" server.mjs
  goto :end
)

echo.
echo   没找到 Node.js。
echo   请先安装 Node.js，或把 BUNDLED 变量改成你的 node.exe 路径。
echo.

:end
echo.
pause
