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
# Учётные данные приложения Telegram можно взять из .env другого проекта,
# чтобы не переписывать их руками (значения на экран не выводятся):
#   sudo GH_TOKEN="$(gh auth token)" TG_MCP_API_ENV=/путь/к/.env /opt/telegram-gateway-mcp/install.sh <sha>
# Из файла берутся только API_ID, API_HASH и PHONE_NUMBER (номер нужен для подсказки команды входа).
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

# sudo может оставить HOME и окружение того, кто его вызвал: тогда npm, curl и git прочитали бы
# настройки из папки, куда пишет агент. Дальше всё работает только с настройками root.
export HOME=/var/root
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
unset NODE_OPTIONS NODE_PATH npm_config_prefix npm_config_registry CURL_HOME

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
[ "$(owner_uid "$SELF")" -eq 0 ] || fail "скрипт должен принадлежать root: скопируй его в $PREFIX/install.sh (см. начало файла) и запускай оттуда"
[ "$(owner_uid "$(dirname "$SELF")")" -eq 0 ] || fail "папка скрипта должна принадлежать root"

SHA="${1:-}"
API_ENV="${TG_MCP_API_ENV:-}"
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

# Значение ключа из чужого .env. Файл не исполняется: из него читается одна строка,
# а формат значения проверяется ниже. Кавычки и пробелы вокруг значения убираются.
env_value() {
  awk -F= -v key="$1" '$1 == key { v = substr($0, length(key) + 2) } END { print v }' "$2" | tr -d " \t\r\"'"
}

SEED_ID=""
SEED_HASH=""
SEED_PHONE=""
if [ -n "$API_ENV" ]; then
  [ -f "$API_ENV" ] || fail "TG_MCP_API_ENV: файла $API_ENV нет"
  SEED_ID="$(env_value TG_API_ID "$API_ENV")"
  [ -n "$SEED_ID" ] || SEED_ID="$(env_value API_ID "$API_ENV")"
  SEED_HASH="$(env_value TG_API_HASH "$API_ENV")"
  [ -n "$SEED_HASH" ] || SEED_HASH="$(env_value API_HASH "$API_ENV")"
  SEED_PHONE="$(env_value PHONE_NUMBER "$API_ENV")"
  [[ "$SEED_ID" =~ ^[0-9]{4,12}$ ]] || fail "в $API_ENV нет API_ID (ожидается число)"
  [[ "$SEED_HASH" =~ ^[0-9a-f]{32}$ ]] || fail "в $API_ENV нет API_HASH (ожидается 32 символа 0-9a-f)"
  [[ "$SEED_PHONE" =~ ^\+[0-9]{7,15}$ ]] || SEED_PHONE=""
fi

step "1. Пользователь $SVC_USER"
if id -u "$SVC_USER" >/dev/null 2>&1; then
  echo "уже есть"
else
  # Служебный пользователь без пароля и без входа: команды от его имени идут через sudo -u.
  NEW_UID=""
  # Список занятых UID читается один раз и целиком: проверка через grep -q в конвейере
  # под pipefail могла бы принять занятый UID за свободный.
  USED_UIDS="$(dscl . -list /Users UniqueID | awk '{print $2}')"
  [ -n "$USED_UIDS" ] || fail "не удалось прочитать список пользователей"
  for candidate in $(seq 401 499); do
    if ! printf '%s\n' "$USED_UIDS" | awk -v u="$candidate" '$1 == u { found = 1 } END { exit !found }'; then
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
  # Служба каталогов отдаёт нового пользователя не сразу.
  for _ in $(seq 1 20); do
    id -u "$SVC_USER" >/dev/null 2>&1 && break
    sleep 0.5
  done
  id -u "$SVC_USER" >/dev/null 2>&1 || fail "пользователь $SVC_USER создан, но система его ещё не видит: запусти установку ещё раз"
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
  # -q первым аргументом: curl не читает .curlrc.
  curl -q -fsSL --proto '=https' --tlsv1.2 "https://nodejs.org/dist/v$NODE_VERSION/$NAME.tar.gz" -o "$WORK/$NAME.tar.gz"
  curl -q -fsSL --proto '=https' --tlsv1.2 "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
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
# Токен передаётся git через переменные окружения: его нет ни в аргументах (их видно в ps), ни в конфиге.
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
AUTH="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
git init -q "$WORK/src"
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.extraHeader" GIT_CONFIG_VALUE_0="Authorization: Basic $AUTH" \
  git -C "$WORK/src" fetch -q --depth 1 "https://github.com/$REPO.git" "$SHA"
unset GH_TOKEN AUTH
git -C "$WORK/src" checkout -q --detach FETCH_HEAD
[ "$(git -C "$WORK/src" rev-parse HEAD)" = "$SHA" ] || fail "получен не тот коммит"

# Скрипты установки пакетов не выполняются: сборке они не нужны. Настройки и кэш npm свои,
# чужой .npmrc (другой реестр, свои скрипты) на сборку не влияет.
export npm_config_userconfig=/dev/null npm_config_cache="$WORK/npm-cache" npm_config_update_notifier=false
(cd "$WORK/src" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && npm run build >/dev/null && npm prune --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
[ -f "$WORK/src/dist/cli/index.js" ] || fail "сборка не удалась"

# Ссылок в установленном коде быть не должно: демону они не нужны, а ссылка наружу
# дала бы подменить исполняемый код. Каталоги .bin состоят только из ссылок.
find "$WORK/src/node_modules" -type d -name .bin -prune -exec rm -rf {} +
LINKS="$(find "$WORK/src/dist" "$WORK/src/node_modules" -type l -print -quit)"
[ -z "$LINKS" ] || fail "в сборке есть символические ссылки, установка остановлена: $LINKS"

mkdir -p "$PREFIX/app" "$PREFIX/bin"
rsync -rt --delete "$WORK/src/dist" "$WORK/src/node_modules" "$WORK/src/package.json" "$PREFIX/app/"
chown -R root:wheel "$PREFIX/app"
chmod -R go-w "$PREFIX/app"
[ -z "$(find "$PREFIX/app" -type l -print -quit)" ] || fail "в $PREFIX/app оказалась символическая ссылка"
echo "$SHA" > "$PREFIX/app/COMMIT"
echo "собран и установлен"

step "4. Команды в $PREFIX/bin"
# Для агентов: stdio-прокладка. Работает под тем, кто её запустил.
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
ENV_FILE="$GATEWAY_HOME/.env"
# Папка принадлежит пользователю демона: по ссылке root писать не станет.
[ ! -L "$ENV_FILE" ] || fail "$ENV_FILE это ссылка: удали её и запусти установку заново"
# Новое содержимое собирается у root и кладётся на место заменой файла, с правами только для демона.
put_env() {
  install -S -o "$SVC_USER" -g staff -m 600 "$1" "$ENV_FILE"
}
if [ -f "$ENV_FILE" ]; then
  echo "уже есть"
  if grep -q '^TG_MCP_FILES_DIR=/Users/Shared' "$ENV_FILE"; then
    echo "ВНИМАНИЕ: в .env старая общая папка в /Users/Shared. Замени строку на TG_MCP_FILES_DIR=$FILES_DIR"
  fi
  HAVE_ID="$(env_value TG_API_ID "$ENV_FILE")"
  HAVE_HASH="$(env_value TG_API_HASH "$ENV_FILE")"
  if [ -n "$SEED_ID" ] && { [ -z "$HAVE_ID" ] || [ -z "$HAVE_HASH" ]; }; then
    # Заполняются только пустые учётные данные, остальные строки остаются как были.
    grep -v -E '^(TG_API_ID|TG_API_HASH)=' "$ENV_FILE" > "$WORK/env.new" || true
    printf 'TG_API_ID=%s\nTG_API_HASH=%s\n' "$SEED_ID" "$SEED_HASH" >> "$WORK/env.new"
    put_env "$WORK/env.new"
    echo "TG_API_ID и TG_API_HASH взяты из $API_ENV"
  elif [ -n "$SEED_ID" ]; then
    echo "TG_API_ID и TG_API_HASH уже заданы, не трогаю"
  fi
else
  cat > "$WORK/env.new" <<EOF
# Учётные данные приложения с my.telegram.org.
TG_API_ID=$SEED_ID
TG_API_HASH=$SEED_HASH
TG_MCP_FILES_DIR=$FILES_DIR
TG_MCP_PORT=$PORT
# Наборы инструментов: core (чтение), discover (поиск каналов), analytics (статистика),
# index (локальный индекс), write (запись в два шага: предпросмотр и tg_confirm).
TG_MCP_TOOLSETS=core
EOF
  put_env "$WORK/env.new"
  if [ -n "$SEED_ID" ]; then
    echo "создан, TG_API_ID и TG_API_HASH взяты из $API_ENV"
  else
    echo "создан шаблон: впиши TG_API_ID и TG_API_HASH"
  fi
fi
rm -f "$WORK/env.new"
HAVE_CREDS=0
[ -n "$(env_value TG_API_ID "$ENV_FILE")" ] && [ -n "$(env_value TG_API_HASH "$ENV_FILE")" ] && HAVE_CREDS=1

# Порт для проверки берётся из действующего .env: владелец мог его поменять.
ENV_PORT="$(awk -F= '$1 == "TG_MCP_PORT" { v = $2 } END { print v }' "$GATEWAY_HOME/.env" | tr -d '[:space:]')"
case "$ENV_PORT" in
  ''|*[!0-9]*) ;;
  *) PORT="$ENV_PORT" ;;
esac

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
  <!-- Демон выходит с кодом 1 при зависшем вызове MTProto: launchd поднимает его заново. -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/daemon.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/daemon.log</string>
</dict>
</plist>
EOF
chown root:wheel "$PLIST"
chmod 644 "$PLIST"

# Останов старого демона. bootout возвращается раньше, чем процесс вышел: ждём, иначе
# bootstrap упадёт с «Input/output error», а новый процесс не получит блокировку сессий.
launchctl bootout "system/$LABEL" 2>/dev/null || true
for _ in $(seq 1 60); do
  launchctl print "system/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl print "system/$LABEL" >/dev/null 2>&1 && fail "старый демон не остановился за 30 секунд: sudo launchctl bootout system/$LABEL и запусти установку ещё раз"

# Лог ротируется здесь, пока демон остановлен. newsyslog не подходит: launchd держит файл
# открытым и после ротации писал бы в уже удалённый файл.
rm -f /etc/newsyslog.d/tg-mcp.conf
LOG_FILE="$LOG_DIR/daemon.log"
if [ -f "$LOG_FILE" ] && [ ! -L "$LOG_FILE" ] && [ "$(stat -f %z "$LOG_FILE")" -gt 10485760 ]; then
  rm -f "$LOG_FILE.3"
  [ -f "$LOG_FILE.2" ] && mv "$LOG_FILE.2" "$LOG_FILE.3"
  [ -f "$LOG_FILE.1" ] && mv "$LOG_FILE.1" "$LOG_FILE.2"
  mv "$LOG_FILE" "$LOG_FILE.1"
  echo "лог перенесён в $LOG_FILE.1"
fi

# enable до bootstrap: если службу когда-то отключали, bootstrap иначе не запустит её.
launchctl enable "system/$LABEL"
launchctl bootstrap system "$PLIST"

# Демон должен ответить сам: иначе «Готово» ничего бы не значило.
STARTED=0
for _ in $(seq 1 30); do
  if curl -q -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    STARTED=1
    break
  fi
  sleep 1
done

step "Готово"
if [ "$STARTED" -eq 1 ]; then
  echo "Демон отвечает: http://127.0.0.1:$PORT/mcp"
else
  echo "ВНИМАНИЕ: демон не ответил на http://127.0.0.1:$PORT/healthz за 30 секунд. Посмотри лог ниже."
fi
echo "Лог: sudo tail -f $LOG_DIR/daemon.log"
echo "Выгрузки и картинки для агентов: $FILES_DIR"
echo
echo "Если это первая установка, дальше по порядку:"
N=1
if [ "$HAVE_CREDS" -eq 0 ]; then
  echo "  $N. Впиши TG_API_ID и TG_API_HASH и перезапусти демон:"
  echo "       sudo -u $SVC_USER nano $ENV_FILE"
  echo "       sudo launchctl kickstart -k system/$LABEL"
  N=$((N + 1))
fi
echo "  $N. Войди в аккаунт Telegram (код и пароль 2FA вводишь сам):"
if [ -n "$SEED_PHONE" ]; then
  echo "       sudo $PREFIX/bin/tg-mcp-admin login --account agent --phone $SEED_PHONE"
else
  echo "       sudo $PREFIX/bin/tg-mcp-admin login --account agent"
fi
N=$((N + 1))
echo "  $N. Заведи пользователя и выдай доступ (токен печатается один раз):"
echo "       sudo $PREFIX/bin/tg-mcp-admin user add nick --account agent"
N=$((N + 1))
echo "  $N. Проверь:"
echo "       sudo $PREFIX/bin/tg-mcp-admin doctor"
