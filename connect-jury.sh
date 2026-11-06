#!/usr/bin/env bash
set -e

echo "======================================================"
echo " Настройка ноутбука ЖЮРИ ЗКНП (macOS / Linux)"
echo "======================================================"

PORT=8080
FOUND_IP=""

# Определяем подсеть текущего ноутбука и ищем сервер автоматически
LOCAL_IPS=$(ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" {print $2}' || hostname -I 2>/dev/null)

for lip in $LOCAL_IPS; do
  SUBNET=$(echo "$lip" | awk -F. '{print $1"."$2"."$3}')
  echo "Ищем сервер жюри в сети ${SUBNET}.x ..."
  for i in $(seq 1 254); do
    ip="${SUBNET}.${i}"
    (
      res=$(curl -fsS --max-time 0.35 "http://${ip}:${PORT}/api/ping" 2>/dev/null || true)
      if [[ "$res" == *"jury-zknp"* ]]; then
        echo "$ip" > /tmp/jury_found_ip
      fi
    ) &
    if (( i % 50 == 0 )); then wait; fi
    if [ -f /tmp/jury_found_ip ]; then break; fi
  done
  wait
  if [ -f /tmp/jury_found_ip ]; then
    FOUND_IP=$(cat /tmp/jury_found_ip)
    rm -f /tmp/jury_found_ip
    break
  fi
done

if [ -z "$FOUND_IP" ]; then
  read -r -p "Введите IP-адрес сервера (из окна сервера, например 192.168.1.45): " FOUND_IP
fi

URL="http://${FOUND_IP}:${PORT}"
echo "✓ Сервер найден: $URL"

# Создаём кнопку запуска на Рабочем столе
SHORTCUT="$HOME/Desktop/Оценки_Жюри_ЗКНП.command"
cat <<EOF > "$SHORTCUT"
#!/usr/bin/env bash
open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null
EOF
chmod +x "$SHORTCUT"

echo "✓ Ярлык создан на Рабочем столе: $SHORTCUT"
echo "Открываем экран жюри..."
open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || true
