@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo Не найден Node.js. Установите LTS-версию с https://nodejs.org и запустите снова.
  pause
  exit /b 1
)

rem Открываем порт 8080 для ноутбуков жюри. Получится, только если запустить от имени администратора.
netsh advfirewall firewall show rule name="Jury Scores 8080" >nul 2>nul
if %errorlevel% neq 0 (
  netsh advfirewall firewall add rule name="Jury Scores 8080" dir=in action=allow protocol=TCP localport=8080 >nul 2>nul
  if errorlevel 1 (
    echo.
    echo  ВНИМАНИЕ: если Windows спросит про доступ для Node.js, отметьте ОБЕ галочки
    echo  ^(частные и общественные сети^) и нажмите "Разрешить".
    echo  Или один раз запустите этот файл правой кнопкой - "Запуск от имени администратора".
    echo.
  )
)

node server.js
pause
