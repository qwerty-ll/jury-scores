#!/usr/bin/env bash
set -e

echo "======================================================"
echo " Установка и запуск Сервера Оценок Жюри ЗКНП (macOS/Linux)"
echo "======================================================"

if ! command -v node >/dev/null 2>&1; then
  echo "Устанавливаем Node.js..."
  if command -v brew >/dev/null 2>&1; then
    brew install node
  else
    echo "Скачиваем установщик Node.js..."
    curl -fsSL https://nodejs.org/dist/v20.18.0/node-v20.18.0.pkg -o /tmp/node.pkg
    sudo installer -pkg /tmp/node.pkg -target /
  fi
fi

TARGET_DIR="$HOME/Desktop/jury-scores"
echo "Скачиваем сервер в $TARGET_DIR..."
rm -rf /tmp/jury-scores.zip /tmp/jury-scores-main
curl -fsSL https://github.com/qwerty-ll/jury-scores/archive/refs/heads/main.zip -o /tmp/jury-scores.zip
unzip -q -o /tmp/jury-scores.zip -d /tmp
mkdir -p "$TARGET_DIR"
cp -R /tmp/jury-scores-main/* "$TARGET_DIR/"
chmod +x "$TARGET_DIR/jury-server/Запустить.command"

# Создаём ярлык на Рабочем столе
ln -sf "$TARGET_DIR/jury-server/Запустить.command" "$HOME/Desktop/Запустить_Сервер_Жюри.command" 2>/dev/null || true

cd "$TARGET_DIR/jury-server"
(sleep 2 && (open "http://localhost:8080/admin" 2>/dev/null || xdg-open "http://localhost:8080/admin" 2>/dev/null || true)) &

if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -dims node server.js
else
  node server.js
fi
