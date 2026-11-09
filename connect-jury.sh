#!/usr/bin/env bash
# Находит сервер жюри в текущей сети и открывает экран судьи (macOS / Linux).
#   bash connect-jury.sh                  — искать сервер автоматически
#   bash connect-jury.sh 10.42.0.1:8081   — адрес известен, не искать
# JURY_DRY_RUN=1 — только найти и напечатать адрес, без ярлыка и браузера.
set -e

echo "======================================================"
echo " Настройка ноутбука ЖЮРИ ЗКНП (macOS / Linux)"
echo "======================================================"

PORTS="${PORT:-8080 8081 8082}"   # сервер уходит на 8081+, если 8080 занят
FOUND_IP=""
FOUND_PORT=""
FOUND_FILE="$(mktemp)"
# Жёсткий лимит на каждую попытку, чтобы ни один «молчащий» компьютер не подвесил поиск
LIMIT=""; command -v timeout >/dev/null 2>&1 && LIMIT="timeout 3"
if command -v curl >/dev/null 2>&1; then ping_url() { $LIMIT curl -fsS --connect-timeout 1 --max-time 2 "$1" 2>/dev/null || true; }
else ping_url() { $LIMIT wget -qO- -T 1 -t 1 "$1" 2>/dev/null || true; }; fi
probe() {  # probe IP PORT — записывает находку в FOUND_FILE
  local res; res=$(ping_url "http://$1:$2/api/ping")
  if [[ "$res" == *"jury-zknp"* ]]; then echo "$1 $2" > "$FOUND_FILE"; fi
}
trap 'rm -f "$FOUND_FILE"' EXIT

# Адреса этого ноутбука: на новых Linux часто нет ifconfig, поэтому пробуем все способы
LOCAL_IPS=$(
  {
    ip -4 -o addr show 2>/dev/null | awk '{split($4, a, "/"); print a[1]}'
    ifconfig 2>/dev/null | awk '/inet / {sub("addr:", "", $2); print $2}'
    hostname -I 2>/dev/null | tr ' ' '\n'
  } | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -vE '^(127\.|169\.254\.|198\.18\.)' | sort -u
)

if [ -n "${1:-}" ]; then
  FOUND_IP="${1%%:*}"; FOUND_PORT="${1##*:}"
  [ "$FOUND_PORT" = "$1" ] && FOUND_PORT=8080
fi

[ -z "$FOUND_IP" ] && [ -z "$LOCAL_IPS" ] && echo "Этот ноутбук не подключён ни к какой сети. Подключитесь к Wi‑Fi сервера."

# Сначала самые вероятные адреса: раздача с ноутбука (x.1) и этот же ноутбук
if [ -z "$FOUND_IP" ]; then
  for lip in $LOCAL_IPS; do
    for p in $PORTS; do probe "${lip%.*}.1" "$p" & probe "$lip" "$p" & done
  done
  wait
  [ -s "$FOUND_FILE" ] && read -r FOUND_IP FOUND_PORT < "$FOUND_FILE"
fi

if [ -z "$FOUND_IP" ]; then
  for lip in $LOCAL_IPS; do
    SUBNET="${lip%.*}"
    printf 'Ищем сервер жюри в сети %s.x ' "$SUBNET"
    for i in $(seq 2 254); do
      for p in $PORTS; do probe "${SUBNET}.${i}" "$p" & done
      if (( i % 32 == 0 )); then wait; printf '.'; [ -s "$FOUND_FILE" ] && break; fi
    done
    wait
    echo
    if [ -s "$FOUND_FILE" ]; then read -r FOUND_IP FOUND_PORT < "$FOUND_FILE"; break; fi
  done
fi

if [ -z "$FOUND_IP" ]; then
  echo "Сервер не найден автоматически. Проверьте, что сервер запущен и этот ноутбук в ТОЙ ЖЕ Wi‑Fi сети."
  echo "Адрес сервера написан в его окне и в пульте (вкладка «Судьи»)."
  if ! { exec 3</dev/tty; } 2>/dev/null; then echo "Откройте этот адрес в браузере вручную."; exit 1; fi
  read -r -p "Введите адрес сервера (например 10.42.0.1:8081): " FOUND_IP <&3
  FOUND_PORT="${FOUND_IP##*:}"; FOUND_IP="${FOUND_IP%%:*}"
  [ "$FOUND_PORT" = "$FOUND_IP" ] && FOUND_PORT=8080
fi

URL="http://${FOUND_IP}:${FOUND_PORT}"
echo "✓ Сервер: $URL"
[ -n "${JURY_DRY_RUN:-}" ] && exit 0

DESKTOP="$HOME/Desktop"
[ -d "$DESKTOP" ] || DESKTOP="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME")"

if [ "$(uname)" = "Darwin" ]; then
  SHORTCUT="$DESKTOP/Оценки_Жюри_ЗКНП.command"
  printf '#!/usr/bin/env bash\nopen "%s"\n' "$URL" > "$SHORTCUT"
  chmod +x "$SHORTCUT"
else
  SHORTCUT="$DESKTOP/Оценки_Жюри_ЗКНП.desktop"
  printf '[Desktop Entry]\nType=Link\nName=Оценки жюри ЗКНП\nURL=%s\nIcon=web-browser\n' "$URL" > "$SHORTCUT"
  chmod +x "$SHORTCUT"
  gio set "$SHORTCUT" metadata::trusted true 2>/dev/null || true
fi

echo "✓ Ярлык на Рабочем столе: $SHORTCUT"
echo "Открываем экран жюри..."
open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || true
