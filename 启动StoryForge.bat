@echo off
setlocal
chcp 65001 >nul
set "APP=%~dp0app"
if not exist "%APP%\src-tauri\tauri.conf.json" (
  echo 未找到 app 目录，请把本文件放在项目根目录。
  pause
  exit /b 1
)

set "EXE=%APP%\src-tauri\target\release\storyforge.exe"
if not exist "%EXE%" set "EXE=%APP%\src-tauri\target\debug\storyforge.exe"
if not exist "%EXE%" (
  echo 还没有构建好的 StoryForge。
  echo.
  echo 首次运行请在命令行执行：
  echo   cd /d "%APP%"
  echo   pnpm install
  echo   pnpm tauri dev
  echo.
  echo 或构建后运行：
  echo   pnpm tauri build
  pause
  exit /b 1
)

start "" "%EXE%"
