@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo Не найден Node.js. Установите LTS-версию с https://nodejs.org и запустите снова.
  pause
  exit /b 1
)
node server.js
pause
