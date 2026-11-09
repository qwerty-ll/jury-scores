#!/usr/bin/env bash
# Установка и запуск сервера оценок жюри одной командой. Права администратора (sudo) НЕ нужны.
# Работает на Linux (в том числе учебный профиль без sudo) и macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/qwerty-ll/jury-scores/main/install.sh | bash
#   wget -qO- https://raw.githubusercontent.com/qwerty-ll/jury-scores/main/install.sh | bash
#
# Повторный запуск обновляет программу; оценки, пароль и PIN (папка jury-server/data) не трогаются.
# Настройки: JURY_DIR — куда ставить (~/jury-scores), JURY_NODE_DIR — куда ставить Node.js (~/.jury-node),
# JURY_NO_START=1 — только установить, JURY_NO_TEST=1 — без проверки, JURY_FORCE_NODE=1 — свой Node.js даже если есть системный.

set -euo pipefail

main() {
  local NODE_VERSION="v20.18.0"
  local REPO_TARBALL="https://github.com/qwerty-ll/jury-scores/archive/refs/heads/main.tar.gz"
  local DIR="${JURY_DIR:-$HOME/jury-scores}"
  local NODE_DIR="${JURY_NODE_DIR:-$HOME/.jury-node}"

  say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
  die() { printf '\n\033[31mОШИБКА: %s\033[0m\n' "$*" >&2; exit 1; }

  # curl или wget — что есть
  fetch() {
    if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
    elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"
    else die "нет ни curl, ни wget — скачать файлы нечем"; fi
  }

  say "Оценки жюри ЗКНП — установка (без sudo)"

  # ---- 1. Node.js ----
  local NODE=""
  local sys_node major
  sys_node="$(command -v node || true)"
  if [ -z "${JURY_FORCE_NODE:-}" ] && [ -n "$sys_node" ]; then
    major="$("$sys_node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$major" -ge 18 ] 2>/dev/null; then NODE="$sys_node"; fi
  fi
  if [ -z "$NODE" ] && [ -x "$NODE_DIR/bin/node" ]; then NODE="$NODE_DIR/bin/node"; fi

  if [ -z "$NODE" ]; then
    local os arch
    case "$(uname -s)" in
      Linux) os=linux ;;
      Darwin) os=darwin ;;
      *) die "эта система не поддерживается скриптом ($(uname -s)). На Windows — см. ГАЙД.md" ;;
    esac
    case "$(uname -m)" in
      x86_64|amd64) arch=x64 ;;
      aarch64|arm64) arch=arm64 ;;
      armv7l) arch=armv7l ;;
      *) die "неизвестный процессор: $(uname -m)" ;;
    esac
    say "1/4  Скачиваю Node.js $NODE_VERSION ($os-$arch) в $NODE_DIR"
    local tmp_node
    tmp_node="$(mktemp -d)"
    fetch "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$os-$arch.tar.gz" | tar -xz -C "$tmp_node" \
      || die "не удалось скачать Node.js. Есть ли интернет?"
    rm -rf "$NODE_DIR"
    mkdir -p "$(dirname "$NODE_DIR")"
    mv "$tmp_node/node-$NODE_VERSION-$os-$arch" "$NODE_DIR"
    rm -rf "$tmp_node"
    NODE="$NODE_DIR/bin/node"
  else
    say "1/4  Node.js уже есть: $NODE ($("$NODE" -v))"
  fi
  "$NODE" -v >/dev/null 2>&1 || die "Node.js не запускается: $NODE"

  # ---- 2. Программа ----
  say "2/4  Скачиваю программу в $DIR"
  local tmp_src
  tmp_src="$(mktemp -d)"
  fetch "$REPO_TARBALL" | tar -xz -C "$tmp_src" || die "не удалось скачать программу с GitHub"
  mkdir -p "$DIR"
  # копируем поверх: папки data в архиве нет, поэтому оценки и PIN сохраняются
  (cd "$tmp_src"/jury-scores-* && tar -cf - .) | (cd "$DIR" && tar -xf -)
  rm -rf "$tmp_src"
  chmod +x "$DIR"/*.sh "$DIR"/jury-server/*.sh "$DIR"/jury-server/*.command 2>/dev/null || true

  # ---- 3. Ярлык запуска ----
  say "3/4  Создаю ярлык запуска"
  local RUN="$DIR/start-server.sh"
  cat > "$RUN" <<EOF
#!/usr/bin/env bash
# Запуск сервера оценок жюри (создан install.sh)
cd "$DIR"
"$NODE" jury-server/server.js
echo
read -r -p "Сервер остановлен. Нажмите Enter, чтобы закрыть." _
EOF
  chmod +x "$RUN"

  local DESKTOP="$HOME/Desktop"
  if command -v xdg-user-dir >/dev/null 2>&1; then DESKTOP="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$DESKTOP")"; fi
  if [ -d "$DESKTOP" ]; then
    if [ "$(uname -s)" = "Darwin" ]; then
      ln -sf "$RUN" "$DESKTOP/Сервер жюри.command"
    else
      local LNK="$DESKTOP/Сервер жюри.desktop"
      printf '[Desktop Entry]\nType=Application\nName=Сервер жюри ЗКНП\nExec=bash "%s"\nTerminal=true\nIcon=utilities-terminal\n' "$RUN" > "$LNK"
      chmod +x "$LNK"
      gio set "$LNK" metadata::trusted true 2>/dev/null || true
    fi
    echo "     Ярлык на Рабочем столе: «Сервер жюри»"
  fi
  echo "     Запуск вручную: bash $RUN"

  # ---- 4. Проверка ----
  if [ -z "${JURY_NO_TEST:-}" ]; then
    say "4/4  Проверяю, что всё работает (секунд 10)…"
    if (cd "$DIR" && "$NODE" tests/run.mjs) > "$DIR/.install-test.log" 2>&1; then
      tail -n 2 "$DIR/.install-test.log" | grep -m1 'проверок' || true
    else
      tail -n 25 "$DIR/.install-test.log"
      die "проверка не прошла — пришлите текст выше организатору"
    fi
  fi

  say "Готово."
  if [ -n "${JURY_NO_START:-}" ]; then
    echo "Запуск сервера: bash $RUN"
    return
  fi
  say "Запускаю сервер. Окно не закрывайте до конца конкурса (остановить — Ctrl+C)."
  cd "$DIR"
  exec "$NODE" jury-server/server.js < /dev/null
}

# Всё в функции: при запуске через «curl … | bash» скрипт сначала читается целиком
main "$@"
