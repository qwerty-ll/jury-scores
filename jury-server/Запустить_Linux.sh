#!/usr/bin/env bash
# Запуск сервера оценок жюри на Linux: ./Запустить_Linux.sh
cd "$(dirname "$0")"
# Node.js, поставленный install.sh без sudo
PATH="$HOME/.jury-node/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Установите его: sudo apt install nodejs (Ubuntu/Debian) или с https://nodejs.org"
  read -r -p "Нажмите Enter, чтобы закрыть."
  exit 1
fi

# Если включён брандмауэр ufw, планшетам и ноутбукам жюри нужен порт 8080:
#   sudo ufw allow 8080/tcp
node server.js
read -r -p "Сервер остановлен. Нажмите Enter, чтобы закрыть."
