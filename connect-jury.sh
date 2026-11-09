#!/usr/bin/env bash
# Находит сервер жюри в текущей сети и открывает экран судьи (macOS / Linux).
# JURY_DRY_RUN=1 — только найти и напечатать адрес, без ярлыка и браузера.
set -e

echo "======================================================"
echo " Настройка ноутбука ЖЮРИ ЗКНП (macOS / Linux)"
echo "======================================================"

PORTS="${PORT:-8080 8081 8082}"   # сервер уходит на 8081+, если 8080 занят
FOUND_IP=""
FOUND_PORT=""
FOUND_FILE="$(mktemp)"
if command -v curl >/dev/null 2>&1; then ping_url() { curl -fsS --max-time 1 "$1" 2>/dev/null || true; }
else ping_url() { wget -qO- -T 1 -t 1 "$1" 2>/dev/null || true; }; fi
trap 'rm -f "$FOUND_FILE"' EXIT

# Адреса этого ноутбука: на новых Linux часто нет ifconfig, поэтому пробуем все способы
LOCAL_IPS=$(
  {
    ip -4 -o addr show 2>/dev/null | awk '{split($4, a, "/"); print a[1]}'
    ifconfig 2>/dev/null | awk '/inet / {sub("addr:", "", $2); print $2}'
    hostname -I 2>/dev/null | tr ' ' '\n'
  } | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -vE '^(127\.|169\.254\.)' | sort -u
)

for lip in $LOCAL_IPS; do
  SUBNET=$(echo "$lip" | awk -F. '{print $1"."$2"."$3}')
  echo "Ищем сервер жюри в сети ${SUBNET}.x ..."
  for i in $(seq 1 254); do
    for p in $PORTS; do
      (
        res=$(ping_url "http://${SUBNET}.${i}:${p}/api/ping")
        if [[ "$res" == *"jury-zknp"* ]]; then echo "${SUBNET}.${i} ${p}" > "$FOUND_FILE"; fi
      ) &
    done
    if (( i % 64 == 0 )); then wait; fi
    if [ -s "$FOUND_FILE" ]; then break; fi
  done
  wait
  if [ -s "$FOUND_FILE" ]; then read -r FOUND_IP FOUND_PORT < "$FOUND_FILE"; break; fi
done

if [ -z "$FOUND_IP" ]; then
  echo "Сервер не найден автоматически."
  read -r -p "Введите адрес сервера из его окна (например 192.168.1.45:8080): " FOUND_IP < /dev/tty
  FOUND_PORT="${FOUND_IP##*:}"; FOUND_IP="${FOUND_IP%%:*}"
  [ "$FOUND_PORT" = "$FOUND_IP" ] && FOUND_PORT=8080
fi

URL="http://${FOUND_IP}:${FOUND_PORT}"
echo "✓ Сервер: $URL"
[ -n "$JURY_DRY_RUN" ] && exit 0

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
