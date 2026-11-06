$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "======================================================" -ForegroundColor Cyan
Write-Host " Установка и запуск Сервера Оценок Жюри ЗКНП (Windows)" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js не найден. Устанавливаем Node.js..." -ForegroundColor Yellow
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    } else {
        $msi = "$env:TEMP\node-lts.msi"
        Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi" -OutFile $msi
        Start-Process msiexec.exe -Wait -ArgumentList "/i `"$msi`" /qn"
        $env:Path += ";C:\Program Files\nodejs"
    }
}

$Desktop = [Environment]::GetFolderPath("Desktop")
$TargetDir = Join-Path $Desktop "jury-scores"
$ZipPath = "$env:TEMP\jury-scores.zip"
$ExtractPath = "$env:TEMP\jury-scores-extract"

Write-Host "Скачиваем проект в $TargetDir ..." -ForegroundColor Green
Invoke-WebRequest -Uri "https://github.com/qwerty-ll/jury-scores/archive/refs/heads/main.zip" -OutFile $ZipPath
if (Test-Path $ExtractPath) { Remove-Item $ExtractPath -Recurse -Force }
Expand-Archive -Path $ZipPath -DestinationPath $ExtractPath -Force
if (-not (Test-Path $TargetDir)) { New-Item -ItemType Directory -Path $TargetDir | Out-Null }
Copy-Item -Path "$ExtractPath\jury-scores-main\*" -Destination $TargetDir -Recurse -Force

# Разрешаем порт 8080 в Брандмауэре Windows (если запущено от админа)
try {
    New-NetFirewallRule -DisplayName "Jury Scores ZKNP Server" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null
} catch {}

Set-Location (Join-Path $TargetDir "jury-server")
Start-Job -ScriptBlock { Start-Sleep -Seconds 2; Start-Process "http://localhost:8080/admin" } | Out-Null
node server.js
