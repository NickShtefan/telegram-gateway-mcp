#!/usr/bin/env bash
# Боевая установка tg-mcp на лабораторной машине (решения 12 и 17).
#
# Демон работает под отдельным пользователем macOS, а агенты под nick. Чтобы
# агент, которого увели через prompt injection, не мог подменить то, что
# исполняет демон, установка не берёт ничего из папок, куда nick может писать:
# root сам забирает указанный коммит с GitHub и собирает его у себя.
#
# Первый раз (после того как прочитал этот файл):
#   sudo install -d -o root -g wheel /opt/telegram-gateway-mcp
#   sudo install -o root -g wheel -m 755 scripts/lab-install.sh /opt/telegram-gateway-mcp/install.sh
#
# Установка и обновление, всегда из копии под root:
#   sudo GH_TOKEN="$(gh auth token)" /opt/telegram-gateway-mcp/install.sh <полный sha коммита>
#
# Повторный запуск безопасен: обновляет код и перезапускает демон.
# База, .env и сессии не трогаются.
set -euo pipefail

REPO="NickShtefan/telegram-gateway-mcp"
SVC_USER="tgmcp"
SVC_HOME="/var/tgmcp"
GATEWAY_HOME="$SVC_HOME/.tg-mcp"
PREFIX="/opt/telegram-gateway-mcp"
# Общая папка лежит под root: создать в ней что-то заранее агент не может.
FILES_DIR="$PREFIX/files"
LOG_DIR="/var/log/tg-mcp"
LABEL="com.tg-mcp.gateway"
PLIST="/Library/LaunchDaemons/$LABEL.plist"
PORT="${TG_MCP_PORT:-7777}"
NODE_VERSION="${TG_MCP_NODE_VERSION:-22.22.0}"

fail() { echo "ошибка: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }
owner_uid() { stat -f %u "$1"; }

[ "$(id -u)" -eq 0 ] || fail "нужен root: sudo GH_TOKEN=... $PREFIX/install.sh <sha>"
[ "$(uname -s)" = "Darwin" ] || fail "скрипт рассчитан на macOS"

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
[ "$(owner_uid "$SELF")" -eq 0 ] || fail "скрипт должен принадлежать root: скопируй его в $PREFIX/install.sh (см. начало файла) и запускай оттуда"
[ "$(owner_uid "$(dirname "$SELF")")" -eq 0 ] || fail "папка скрипта должна принадлежать root"

SHA="${1:-}"
echo "$SHA" | grep -Eq '^[0-9a-f]{40}$' || fail "укажи полный sha коммита (40 символов), который ты видишь на GitHub"
[ -n "${GH_TOKEN:-}" ] || fail "нужен GH_TOKEN для приватного репозитория: sudo GH_TOKEN=\"\$(gh auth token)\" $SELF $SHA"

case "$(uname -m)" in
  x86_64) NODE_ARCH="x64" ;;
  arm64) NODE_ARCH="arm64" ;;
  *) fail "неизвестная архитектура $(uname -m)" ;;
esac

umask 022
WORK="$(mktemp -d /var/root/tg-mcp-build.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

step "1. Пользователь $SVC_USER"
if id -u "$SVC_USER" >/dev/null 2>&1; then
  echo "уже есть"
else
  # Служебный пользователь без пароля и без входа: команды от его имени идут через sudo -u.
  NEW_UID=""
  for candidate in $(seq 401 499); do
    if ! dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$candidate"; then
      NEW_UID="$candidate"
      break
    fi
  done
  [ -n "$NEW_UID" ] || fail "не нашёл свободный UID в диапазоне 401-499"
  dscl . -create "/Users/$SVC_USER"
  dscl . -create "/Users/$SVC_USER" UniqueID "$NEW_UID"
  dscl . -create "/Users/$SVC_USER" PrimaryGroupID 20
  dscl . -create "/Users/$SVC_USER" RealName "tg-mcp gateway"
  dscl . -create "/Users/$SVC_USER" NFSHomeDirectory "$SVC_HOME"
  dscl . -create "/Users/$SVC_USER" UserShell /usr/bin/false
  dscl . -create "/Users/$SVC_USER" Password '*'
  dscl . -create "/Users/$SVC_USER" IsHidden 1
  echo "создан, UID $NEW_UID"
fi
mkdir -p "$GATEWAY_HOME"
chown -R "$SVC_USER":staff "$SVC_HOME"
chmod 700 "$SVC_HOME" "$GATEWAY_HOME"

step "2. Node $NODE_VERSION в $PREFIX/node (владелец root)"
mkdir -p "$PREFIX"
chown root:wheel "$PREFIX"
chmod 755 "$PREFIX"
NODE_OK=0
if [ -x "$PREFIX/node/bin/node" ] && [ ! -L "$PREFIX/node" ] && [ ! -L "$PREFIX/node/bin/node" ] && [ "$(owner_uid "$PREFIX/node/bin/node")" -eq 0 ]; then
  [ "$("$PREFIX/node/bin/node" --version)" = "v$NODE_VERSION" ] && NODE_OK=1
fi
if [ "$NODE_OK" -eq 1 ]; then
  echo "уже установлен"
else
  NAME="node-v$NODE_VERSION-darwin-$NODE_ARCH"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$NAME.tar.gz" -o "$WORK/$NAME.tar.gz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
  EXPECTED="$(grep " $NAME.tar.gz\$" "$WORK/SHASUMS256.txt" | awk '{print $1}')"
  ACTUAL="$(shasum -a 256 "$WORK/$NAME.tar.gz" | awk '{print $1}')"
  [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || fail "контрольная сумма Node не совпала"
  rm -rf "$PREFIX/node"
  mkdir -p "$PREFIX/node"
  tar -xzf "$WORK/$NAME.tar.gz" -C "$PREFIX/node" --strip-components 1
  chown -R root:wheel "$PREFIX/node"
  chmod -R go-w "$PREFIX/node"
  echo "установлен $("$PREFIX/node/bin/node" --version)"
fi
export PATH="$PREFIX/node/bin:/usr/bin:/bin:/usr/sbin:/sbin"

step "3. Код коммита $SHA"
# Токен передаётся git через переменные окружения и не попадает ни в аргументы, ни в конфиг.
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
AUTH="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
git init -q "$WORK/src"
git -C "$WORK/src" -c "http.extraHeader=Authorization: Basic $AUTH" fetch -q --depth 1 "https://github.com/$REPO.git" "$SHA"
git -C "$WORK/src" checkout -q --detach FETCH_HEAD
[ "$(git -C "$WORK/src" rev-parse HEAD)" = "$SHA" ] || fail "получен не тот коммит"
unset GH_TOKEN AUTH

# Скрипты установки пакетов не выполняются: сборке они не нужны.
(cd "$WORK/src" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && npm run build >/dev/null && npm prune --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
[ -f "$WORK/src/dist/cli/index.js" ] || fail "сборка не удалась"

mkdir -p "$PREFIX/app" "$PREFIX/bin"
rsync -rt --delete --safe-links "$WORK/src/dist" "$WORK/src/node_modules" "$WORK/src/package.json" "$PREFIX/app/"
chown -R root:wheel "$PREFIX/app"
chmod -R go-w "$PREFIX/app"
# Ни одна ссылка в коде не должна вести за пределы папки установки.
while IFS= read -r link; do
  target="$(cd "$(dirname "$link")" && realpath "$(readlink "$link")" 2>/dev/null || true)"
  case "$target" in
    "$PREFIX"/*) ;;
    *) fail "ссылка $link ведёт за пределы $PREFIX" ;;
  esac
done < <(find "$PREFIX/app" -type l)
echo "$SHA" > "$PREFIX/app/COMMIT"
echo "собран и установлен"

step "4. Команды в $PREFIX/bin"
# Для агентов: stdio-прокладка и runner. Работает под тем, кто её запустил.
cat > "$PREFIX/bin/tg-mcp" <<EOF
#!/bin/sh
exec "$PREFIX/node/bin/node" --no-warnings "$PREFIX/app/dist/cli/index.js" "\$@"
EOF
# Для владельца: вход в аккаунт, пользователи, doctor. Выполняется под $SVC_USER.
cat > "$PREFIX/bin/tg-mcp-admin" <<EOF
#!/bin/sh
# Запуск: sudo $PREFIX/bin/tg-mcp-admin <команда>
if [ "\$(id -u)" -ne 0 ]; then
  echo "нужен root: sudo $PREFIX/bin/tg-mcp-admin \$*" >&2
  exit 1
fi
cd "$SVC_HOME"
exec sudo -u "$SVC_USER" env HOME="$SVC_HOME" TG_MCP_HOME="$GATEWAY_HOME" \\
  "$PREFIX/node/bin/node" --no-warnings "$PREFIX/app/dist/cli/index.js" "\$@"
EOF
chown root:wheel "$PREFIX/bin" "$PREFIX/bin/tg-mcp" "$PREFIX/bin/tg-mcp-admin"
chmod 755 "$PREFIX/bin" "$PREFIX/bin/tg-mcp" "$PREFIX/bin/tg-mcp-admin"

step "5. Общая папка $FILES_DIR и логи"
if [ -e "$FILES_DIR" ] || [ -L "$FILES_DIR" ]; then
  [ ! -L "$FILES_DIR" ] || fail "$FILES_DIR это ссылка: удали её и запусти установку заново"
  [ "$(owner_uid "$FILES_DIR")" -eq "$(id -u "$SVC_USER")" ] || fail "$FILES_DIR принадлежит не $SVC_USER: проверь, откуда она взялась"
else
  mkdir "$FILES_DIR"
  chown "$SVC_USER":staff "$FILES_DIR"
fi
chmod 755 "$FILES_DIR"
mkdir -p "$LOG_DIR"
chown "$SVC_USER":wheel "$LOG_DIR"
chmod 750 "$LOG_DIR"

step "6. Настройки $GATEWAY_HOME/.env"
if [ -f "$GATEWAY_HOME/.env" ]; then
  echo "уже есть, не трогаю"
  if grep -q '^TG_MCP_FILES_DIR=/Users/Shared' "$GATEWAY_HOME/.env"; then
    echo "ВНИМАНИЕ: в .env старая общая папка в /Users/Shared. Замени строку на TG_MCP_FILES_DIR=$FILES_DIR"
  fi
else
  cat > "$GATEWAY_HOME/.env" <<EOF
# Учётные данные приложения с my.telegram.org. Заполняет владелец.
TG_API_ID=
TG_API_HASH=
TG_MCP_FILES_DIR=$FILES_DIR
TG_MCP_PORT=$PORT
# Наборы инструментов: core (чтение), automate (наблюдение, правила, поручения), write (запись через согласование).
TG_MCP_TOOLSETS=core
# Токен бота согласований от BotFather. Нужен отдельный бот: токены бота Claude Code и бота Hermes заняты.
# TG_MCP_APPROVAL_BOT_TOKEN=
EOF
  chown "$SVC_USER":staff "$GATEWAY_HOME/.env"
  chmod 600 "$GATEWAY_HOME/.env"
  echo "создан шаблон: впиши TG_API_ID и TG_API_HASH"
fi

step "7. LaunchDaemon $LABEL"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>UserName</key><string>$SVC_USER</string>
  <key>WorkingDirectory</key><string>$SVC_HOME</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PREFIX/node/bin/node</string>
    <string>--no-warnings</string>
    <string>$PREFIX/app/dist/cli/index.js</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$SVC_HOME</string>
    <key>TG_MCP_HOME</key><string>$GATEWAY_HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Демон выходит с кодом 1 при зависшем вызове GramJS: launchd поднимает его заново. -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/daemon.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/daemon.log</string>
</dict>
</plist>
EOF
chown root:wheel "$PLIST"
chmod 644 "$PLIST"

cat > /etc/newsyslog.d/tg-mcp.conf <<EOF
# logfilename                 [owner:group]   mode count size(KB) when flags
$LOG_DIR/daemon.log           $SVC_USER:wheel 640  5     10240    *    J
EOF

launchctl bootout "system/$LABEL" 2>/dev/null || true
launchctl bootstrap system "$PLIST"
launchctl enable "system/$LABEL"

step "Готово"
cat <<EOF
Демон запущен: http://127.0.0.1:$PORT/mcp
Лог: sudo tail -f $LOG_DIR/daemon.log
Выгрузки и картинки для агентов: $FILES_DIR

Если это первая установка, дальше по порядку:
  1. Впиши TG_API_ID и TG_API_HASH:
       sudo -u $SVC_USER nano $GATEWAY_HOME/.env
  2. Войди в аккаунт Telegram (код и пароль 2FA вводишь сам):
       sudo $PREFIX/bin/tg-mcp-admin login --account agent
  3. Заведи пользователей и выдай доступ (токен печатается один раз):
       sudo $PREFIX/bin/tg-mcp-admin user add nick --telegram-id <твой id> --account agent
  4. Проверь:
       sudo $PREFIX/bin/tg-mcp-admin doctor
  5. Перезапусти демон, чтобы он увидел .env:
       sudo launchctl kickstart -k system/$LABEL
EOF
