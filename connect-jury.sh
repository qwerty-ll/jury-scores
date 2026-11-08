#!/usr/bin/env bash
# Находит сервер жюри в текущей сети и открывает экран судьи (macOS / Linux).
# JURY_DRY_RUN=1 — только найти и напечатать адрес, без ярлыка и браузера.
set -e

echo "======================================================"
echo " Настройка ноутбука ЖЮРИ ЗКНП (macOS / Linux)"
echo "======================================================"

PORT="${PORT:-8080}"
FOUND_IP=""
FOUND_FILE="$(mktemp)"
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
    (
      res=$(curl -fsS --max-time 1 "http://${SUBNET}.${i}:${PORT}/api/ping" 2>/dev/null || true)
      if [[ "$res" == *"jury-zknp"* ]]; then echo "${SUBNET}.${i}" > "$FOUND_FILE"; fi
    ) &
    if (( i % 64 == 0 )); then wait; fi
    if [ -s "$FOUND_FILE" ]; then break; fi
  done
  wait
  if [ -s "$FOUND_FILE" ]; then FOUND_IP=$(head -n1 "$FOUND_FILE"); break; fi
done

if [ -z "$FOUND_IP" ]; then
  echo "Сервер не найден автоматически."
  read -r -p "Введите IP-адрес сервера (из окна сервера, например 192.168.1.45): " FOUND_IP
fi

URL="http://${FOUND_IP}:${PORT}"
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
