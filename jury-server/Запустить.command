#!/bin/bash
# Двойной щелчок — запуск сервера оценок жюри.
cd "$(dirname "$0")"
# Node.js, поставленный install.sh без sudo
PATH="$HOME/.jury-node/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Установите его с https://nodejs.org (кнопка LTS) и запустите снова."
  read -r -p "Нажмите Enter, чтобы закрыть."
  exit 1
fi

# Если вставлена флешка — копии данных идут и на неё
for v in /Volumes/*; do
  [ "$v" = "/Volumes/Macintosh HD" ] && continue
  if [ -d "$v" ] && [ -w "$v" ]; then
    export BACKUP_DIR="$v/jury-backup"
    break
  fi
done

# caffeinate не даёт Mac уснуть, пока работает сервер
caffeinate -dims node server.js
read -r -p "Сервер остановлен. Нажмите Enter, чтобы закрыть."
