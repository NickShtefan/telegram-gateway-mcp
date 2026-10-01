#!/usr/bin/env bash
# Боевая установка tg-mcp на лабораторной машине (решения 12 и 17).
#
# Запускает владелец из собранного клона репозитория:
#   npm ci && npm run build && sudo bash scripts/lab-install.sh
#
# Что делает:
#   1. создаёт скрытого пользователя macOS tgmcp: под ним работает демон,
#      а сессии Telegram, ключ шифрования и токены лежат в его домашней папке;
#   2. копирует код и собственную копию Node в /opt/telegram-gateway-mcp,
#      владелец root: агенты под nick не могут подменить то, что исполняет демон;
#   3. создаёт общую папку для выгрузок и картинок, которую агенты читают;
#   4. ставит LaunchDaemon: launchd поднимает демон при загрузке и после выхода.
#
# Повторный запуск безопасен: обновляет код и перезапускает демон.
set -euo pipefail

SVC_USER="tgmcp"
SVC_HOME="/var/tgmcp"
GATEWAY_HOME="$SVC_HOME/.tg-mcp"
PREFIX="/opt/telegram-gateway-mcp"
FILES_DIR="/Users/Shared/tg-mcp"
LOG_DIR="/var/log/tg-mcp"
LABEL="com.tg-mcp.gateway"
PLIST="/Library/LaunchDaemons/$LABEL.plist"
PORT="${TG_MCP_PORT:-7777}"
NODE_VERSION="${TG_MCP_NODE_VERSION:-22.22.0}"

SRC="$(cd "$(dirname "$0")/.." && pwd)"

fail() { echo "ошибка: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

[ "$(id -u)" -eq 0 ] || fail "нужен root: sudo bash scripts/lab-install.sh"
[ "$(uname -s)" = "Darwin" ] || fail "скрипт рассчитан на macOS"
[ -f "$SRC/dist/cli/index.js" ] || fail "нет сборки: сначала npm ci && npm run build в $SRC"
[ -d "$SRC/node_modules/telegram" ] || fail "нет зависимостей: сначала npm ci в $SRC"

case "$(uname -m)" in
  x86_64) NODE_ARCH="x64" ;;
  arm64) NODE_ARCH="arm64" ;;
  *) fail "неизвестная архитектура $(uname -m)" ;;
esac

step "1. Пользователь $SVC_USER"
if id -u "$SVC_USER" >/dev/null 2>&1; then
  echo "уже есть"
else
  # Пароль случайный и нигде не сохраняется: под этим пользователем не входят,
  # команды от его имени запускаются через sudo -u.
  sysadminctl -addUser "$SVC_USER" -fullName "tg-mcp gateway" -home "$SVC_HOME" \
    -shell /usr/bin/false -password "$(openssl rand -base64 30)" >/dev/null
  dscl . -create "/Users/$SVC_USER" IsHidden 1
  echo "создан"
fi
mkdir -p "$GATEWAY_HOME"
chown -R "$SVC_USER":staff "$SVC_HOME"
chmod 700 "$SVC_HOME" "$GATEWAY_HOME"

step "2. Код в $PREFIX/app (владелец root)"
mkdir -p "$PREFIX/app" "$PREFIX/bin"
rsync -a --delete "$SRC/dist" "$SRC/node_modules" "$SRC/package.json" "$PREFIX/app/"
chown -R root:wheel "$PREFIX/app"
chmod -R go-w "$PREFIX/app"

step "3. Node $NODE_VERSION в $PREFIX/node (владелец root)"
if [ -x "$PREFIX/node/bin/node" ] && [ "$("$PREFIX/node/bin/node" --version)" = "v$NODE_VERSION" ]; then
  echo "уже установлен"
else
  TMP="$(mktemp -d)"
  NAME="node-v$NODE_VERSION-darwin-$NODE_ARCH"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$NAME.tar.gz" -o "$TMP/$NAME.tar.gz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  EXPECTED="$(grep " $NAME.tar.gz\$" "$TMP/SHASUMS256.txt" | awk '{print $1}')"
  ACTUAL="$(shasum -a 256 "$TMP/$NAME.tar.gz" | awk '{print $1}')"
  [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || fail "контрольная сумма Node не совпала"
  rm -rf "$PREFIX/node"
  mkdir -p "$PREFIX/node"
  tar -xzf "$TMP/$NAME.tar.gz" -C "$PREFIX/node" --strip-components 1
  chown -R root:wheel "$PREFIX/node"
  chmod -R go-w "$PREFIX/node"
  rm -rf "$TMP"
  echo "установлен $("$PREFIX/node/bin/node" --version)"
fi

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
chown root:wheel "$PREFIX/bin/tg-mcp" "$PREFIX/bin/tg-mcp-admin"
chmod 755 "$PREFIX/bin/tg-mcp" "$PREFIX/bin/tg-mcp-admin"
chown root:wheel "$PREFIX" "$PREFIX/bin"
chmod 755 "$PREFIX" "$PREFIX/bin"

step "5. Общая папка $FILES_DIR и логи"
mkdir -p "$FILES_DIR" "$LOG_DIR"
chown "$SVC_USER":staff "$FILES_DIR" "$LOG_DIR"
chmod 755 "$FILES_DIR"
chmod 750 "$LOG_DIR"

step "6. Настройки $GATEWAY_HOME/.env"
if [ -f "$GATEWAY_HOME/.env" ]; then
  echo "уже есть, не трогаю"
else
  cat > "$GATEWAY_HOME/.env" <<EOF
# Учётные данные приложения с my.telegram.org. Заполняет владелец.
TG_API_ID=
TG_API_HASH=
TG_MCP_FILES_DIR=$FILES_DIR
TG_MCP_PORT=$PORT
# Наборы инструментов: core (чтение), automate (наблюдение, правила), write (ответы через согласование).
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
# logfilename                 [owner:group]  mode count size(KB) when flags
$LOG_DIR/daemon.log           $SVC_USER:staff 640  5     10240    *    J
EOF

launchctl bootout "system/$LABEL" 2>/dev/null || true
launchctl bootstrap system "$PLIST"
launchctl enable "system/$LABEL"

step "Готово"
cat <<EOF
Демон запущен: http://127.0.0.1:$PORT/mcp (лог: $LOG_DIR/daemon.log)

Дальше, по порядку:
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

Агенты подключаются по адресу http://127.0.0.1:$PORT/mcp с токеном пользователя.
Для клиентов, которым нужен stdio: $PREFIX/bin/tg-mcp stdio (токен в TG_MCP_TOKEN).
EOF
