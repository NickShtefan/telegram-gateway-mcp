#!/usr/bin/env bash
# Обновляет снимок исходников в reference/ по списку из reference/MANIFEST.txt
# и записывает в reference/SNAPSHOT.md ветку и коммит каждого репозитория.
# Исходные репозитории не меняет: только читает файлы.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$(cd "$ROOT/.." && pwd)"          # ~/Projects/CODE/Chanel
REF="$ROOT/reference"
MANIFEST="$REF/MANIFEST.txt"

missing=0
copied=0
while IFS= read -r line; do
  path="${line%%#*}"
  path="$(echo "$path" | xargs)"
  [ -z "$path" ] && continue
  if [ ! -f "$SRC/$path" ]; then
    echo "нет файла: $path" >&2
    missing=$((missing + 1))
    continue
  fi
  mkdir -p "$REF/$(dirname "$path")"
  cp "$SRC/$path" "$REF/$path"
  copied=$((copied + 1))
done < "$MANIFEST"

{
  echo "# Снимок исходников"
  echo
  echo "Скопировано скриптом \`scripts/sync-reference.sh\` $(date '+%Y-%m-%d %H:%M')."
  echo "Файлы только для чтения: правки вносятся в исходные репозитории или в новый код tg-mcp."
  echo
  echo "| Репозиторий | Ветка | Коммит | Дата коммита |"
  echo "|---|---|---|---|"
  for repo in $(grep -v '^\s*#' "$MANIFEST" | grep -v '^\s*$' | cut -d/ -f1 | sort -u); do
    if git -C "$SRC/$repo" rev-parse --git-dir >/dev/null 2>&1; then
      br="$(git -C "$SRC/$repo" rev-parse --abbrev-ref HEAD)"
      sha="$(git -C "$SRC/$repo" log -1 --format=%h)"
      dt="$(git -C "$SRC/$repo" log -1 --format=%ad --date=short)"
      echo "| $repo | $br | $sha | $dt |"
    fi
  done
  echo
  echo "Файлов: $copied, не найдено: $missing."
} > "$REF/SNAPSHOT.md"

echo "Скопировано файлов: $copied, не найдено: $missing"
