@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ============ 组装绿色包：桌面\简历投递工具 ============
set "SRC=C:\Users\Delia\resume-auto-apply"
set "PKG=%USERPROFILE%\Desktop\简历投递工具"

if exist "%PKG%" rmdir /s /q "%PKG%"
mkdir "%PKG%"
mkdir "%PKG%\static"
mkdir "%PKG%\logs"
mkdir "%PKG%\cookies"
mkdir "%PKG%\node-automation"
mkdir "%PKG%\node-automation\ext"

rem 1) 可执行文件 & 启动器
copy /y "%SRC%\web-ui\build\启动.bat" "%PKG%\启动.bat" >nul
copy /y "C:\Users\Delia\target\debug\resume-web-ui.exe" "%PKG%\resume-web-ui.exe" >nul
copy /y "D:\develop\nodejs\node.exe" "%PKG%\node.exe" >nul
if not exist "%PKG%\node.exe" echo   [警告] node.exe 复制失败

rem 2) 前端静态页
copy /y "%SRC%\web-ui\static\index.html" "%PKG%\static\index.html" >nul

rem 3) 投递脚本 + 依赖（排除登录态 profile 与本机测试产物）
xcopy /e /i /y "%SRC%\node-automation\*.mjs" "%PKG%\node-automation\" >nul
copy /y "%SRC%\node-automation\package.json" "%PKG%\node-automation\package.json" >nul
if exist "%SRC%\node-automation\package-lock.json" copy /y "%SRC%\node-automation\package-lock.json" "%PKG%\node-automation\" >nul
xcopy /e /i /y "%SRC%\node-automation\ext" "%PKG%\node-automation\ext\" >nul
if not exist "%SRC%\node-automation\node_modules" (
  echo   [错误] 源目录缺少 node_modules，请先在 %SRC%\node-automation npm install
  pause
  exit /b 1
)
xcopy /e /i /y "%SRC%\node-automation\node_modules" "%PKG%\node-automation\node_modules\" >nul

rem 4) 投递记录（新机沿用去重，避免重复投递），不带 cookie
if exist "%SRC%\logs\deliver_log.json" copy /y "%SRC%\logs\deliver_log.json" "%PKG%\logs\deliver_log.json" >nul

rem 5) 清理不需要的目录
rmdir /s /q "%PKG%\node-automation\logs" >nul 2>nul
rmdir /s /q "%PKG%\node-automation\chrome-profile-boss" >nul 2>nul
rmdir /s /q "%PKG%\node-automation\chrome-profile-zhaopin" >nul 2>nul

echo.
echo   ==========================================
echo   打包完成：%PKG%
echo   ==========================================
echo.
echo   共 %~z0 字节脚本执行完毕
echo   交付内容：
echo     - %PKG%\启动.bat        （双击一键启动）
echo     - resume-web-ui.exe     （编译好的服务）
echo     - node.exe              （便携 Node 运行时）
echo     - node-automation\      （投递脚本 + 依赖，无登录态）
echo     - logs\deliver_log.json （投递历史，用于去重）
echo     - cookies\              （空，新机需重新扫码登录）
echo.
echo   使用说明：把整个"简历投递工具"文件夹拷到任意 Windows 电脑，
echo   双击 启动.bat 即可。首次使用请在界面先"登录" Boss / 智联。
echo.
pause