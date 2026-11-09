#!/usr/bin/env bash
# Старое имя установщика. Всё делает install.sh (без sudo).
exec bash "$(dirname "$0")/install.sh" "$@"
