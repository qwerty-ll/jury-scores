$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "======================================================" -ForegroundColor Cyan
Write-Host " Автоматическое подключение ноутбука ЖЮРИ ЗКНП (Windows)" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan

$Port = 8080
$FoundIP = $null

$LocalIPs = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | Select-Object -ExpandProperty IPAddress

foreach ($lip in $LocalIPs) {
    $parts = $lip.Split('.')
    $subnet = "$($parts[0]).$($parts[1]).$($parts[2])"
    Write-Host "Поиск сервера жюри в сети $subnet.x ..." -ForegroundColor Yellow

    1..254 | ForEach-Object -Parallel {
        $ip = "$using:subnet.$_"
        try {
            $resp = Invoke-RestMethod -Uri "http://${ip}:$using:Port/api/ping" -TimeoutSec 1 -ErrorAction Stop
            if ($resp.app -eq "jury-zknp") {
                $ip
            }
        } catch {}
    } -ThrottleLimit 64 | ForEach-Object {
        if ($_) { $FoundIP = $_ }
    }
    if ($FoundIP) { break }
}

if (-not $FoundIP) {
    # Fallback для PowerShell 5.1 (без -Parallel)
    foreach ($lip in $LocalIPs) {
        $parts = $lip.Split('.')
        $subnet = "$($parts[0]).$($parts[1]).$($parts[2])"
        # Сначала проверим стандартные IP раздачи (1, 2, 100..150)
        $priority = @(1, 2, 137) + (2..254)
        foreach ($i in ($priority | Select-Object -Unique)) {
            $ip = "$subnet.$i"
            $tcp = New-Object System.Net.Sockets.TcpClient
            try {
                $iar = $tcp.BeginConnect($ip, $Port, $null, $null)
                if ($iar.AsyncWaitHandle.WaitOne(80, $false)) {
                    $tcp.EndConnect($iar)
                    $resp = Invoke-RestMethod -Uri "http://${ip}:${Port}/api/ping" -TimeoutSec 1 -ErrorAction Stop
                    if ($resp.app -eq "jury-zknp") {
                        $FoundIP = $ip
                        $tcp.Close()
                        break
                    }
                }
            } catch {}
            $tcp.Close()
        }
        if ($FoundIP) { break }
    }
}

if (-not $FoundIP) {
    $FoundIP = Read-Host "Введите IP-адрес сервера (из окна сервера, например 192.168.137.1)"
}

$Url = "http://${FoundIP}:${Port}"
Write-Host "✓ Сервер найден: $Url" -ForegroundColor Green

# Создаём ярлык на Рабочем столе ноутбука судьи
$Desktop = [Environment]::GetFolderPath("Desktop")
$ShortcutFile = Join-Path $Desktop "Оценки Жюри ЗКНП.url"
Set-Content -Path $ShortcutFile -Value "[InternetShortcut]`r`nURL=$Url`r`n" -Encoding UTF8

Write-Host "✓ На Рабочем столе создан ярлык: Оценки Жюри ЗКНП" -ForegroundColor Green
Write-Host "Открываем пульт судьи..." -ForegroundColor Cyan
Start-Process $Url
