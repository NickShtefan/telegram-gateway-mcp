#!/usr/bin/env bash
# Production tg-mcp installation on the lab machine (decisions 12 and 17).
#
# The daemon runs as a dedicated macOS user; agents run as nick. To prevent
# a prompt-injected agent from replacing daemon code, the installer
# never uses directories writable by nick:
# root fetches the specified GitHub commit and builds it in a private directory.
#
# First installation (after reviewing this file):
#   sudo install -d -o root -g wheel /opt/telegram-gateway-mcp
#   sudo install -o root -g wheel -m 755 scripts/lab-install.sh /opt/telegram-gateway-mcp/install.sh
#
# Install and update only from the root-owned copy:
#   sudo GH_TOKEN="$(gh auth token)" /opt/telegram-gateway-mcp/install.sh <full-commit-sha>
#
# Telegram application credentials may be read from another project's .env
# to avoid manual copying; values are never printed:
#   sudo GH_TOKEN="$(gh auth token)" TG_MCP_API_ENV=/path/to/.env /opt/telegram-gateway-mcp/install.sh <sha>
# Read only API_ID, API_HASH, and PHONE_NUMBER (used solely for the login command hint).
#
# Repeated runs update code and restart the daemon safely.
# Preserve the database, .env, and sessions.
set -euo pipefail

REPO="NickShtefan/telegram-gateway-mcp"
SVC_USER="tgmcp"
SVC_HOME="/var/tgmcp"
GATEWAY_HOME="$SVC_HOME/.tg-mcp"
PREFIX="/opt/telegram-gateway-mcp"
# The shared directory lives under root; agents cannot pre-create entries.
FILES_DIR="$PREFIX/files"
LOG_DIR="/var/log/tg-mcp"
LABEL="com.tg-mcp.gateway"
PLIST="/Library/LaunchDaemons/$LABEL.plist"
PORT="${TG_MCP_PORT:-7777}"
NODE_VERSION="${TG_MCP_NODE_VERSION:-22.22.0}"

fail() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }
owner_uid() { stat -f %u "$1"; }

[ "$(id -u)" -eq 0 ] || fail "root required: sudo GH_TOKEN=... $PREFIX/install.sh <sha>"
[ "$(uname -s)" = "Darwin" ] || fail "this installer requires macOS"

# sudo may retain the caller's HOME and environment, allowing npm, curl, and git
# to read agent-writable configuration. Use only root-owned configuration below.
export HOME=/var/root
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
unset NODE_OPTIONS NODE_PATH npm_config_prefix npm_config_registry CURL_HOME

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
[ "$(owner_uid "$SELF")" -eq 0 ] || fail "installer must be owned by root: copy it to $PREFIX/install.sh (see the header) and run it there"
[ "$(owner_uid "$(dirname "$SELF")")" -eq 0 ] || fail "installer directory must be owned by root"

SHA="${1:-}"
API_ENV="${TG_MCP_API_ENV:-}"
echo "$SHA" | grep -Eq '^[0-9a-f]{40}$' || fail "provide the full 40-character commit SHA shown on GitHub"
[ -n "${GH_TOKEN:-}" ] || fail "GH_TOKEN required for the private repository: sudo GH_TOKEN=\"\$(gh auth token)\" $SELF $SHA"

case "$(uname -m)" in
  x86_64) NODE_ARCH="x64" ;;
  arm64) NODE_ARCH="arm64" ;;
  *) fail "unknown architecture $(uname -m)" ;;
esac

umask 022
WORK="$(mktemp -d /var/root/tg-mcp-build.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# Read one key from an external .env without executing the file.
# Validate its format below and remove surrounding quotes and whitespace.
env_value() {
  awk -F= -v key="$1" '$1 == key { v = substr($0, length(key) + 2) } END { print v }' "$2" | tr -d " \t\r\"'"
}

SEED_ID=""
SEED_HASH=""
SEED_PHONE=""
if [ -n "$API_ENV" ]; then
  [ -f "$API_ENV" ] || fail "TG_MCP_API_ENV: missing file $API_ENV"
  SEED_ID="$(env_value TG_API_ID "$API_ENV")"
  [ -n "$SEED_ID" ] || SEED_ID="$(env_value API_ID "$API_ENV")"
  SEED_HASH="$(env_value TG_API_HASH "$API_ENV")"
  [ -n "$SEED_HASH" ] || SEED_HASH="$(env_value API_HASH "$API_ENV")"
  SEED_PHONE="$(env_value PHONE_NUMBER "$API_ENV")"
  [[ "$SEED_ID" =~ ^[0-9]{4,12}$ ]] || fail "missing numeric API_ID in $API_ENV"
  [[ "$SEED_HASH" =~ ^[0-9a-f]{32}$ ]] || fail "missing API_HASH in $API_ENV (expected 32 hexadecimal characters)"
  [[ "$SEED_PHONE" =~ ^\+[0-9]{7,15}$ ]] || SEED_PHONE=""
fi

step "1. Service user $SVC_USER"
if id -u "$SVC_USER" >/dev/null 2>&1; then
  echo "already exists"
else
  # Service user without password or interactive login; commands run through sudo -u.
  NEW_UID=""
  # Read all allocated UIDs once. Under pipefail, grep -q in a pipeline
  # could incorrectly classify an allocated UID as available.
  USED_UIDS="$(dscl . -list /Users UniqueID | awk '{print $2}')"
  [ -n "$USED_UIDS" ] || fail "could not read the user list"
  for candidate in $(seq 401 499); do
    if ! printf '%s\n' "$USED_UIDS" | awk -v u="$candidate" '$1 == u { found = 1 } END { exit !found }'; then
      NEW_UID="$candidate"
      break
    fi
  done
  [ -n "$NEW_UID" ] || fail "no available UID in the range 401-499"
  dscl . -create "/Users/$SVC_USER"
  dscl . -create "/Users/$SVC_USER" UniqueID "$NEW_UID"
  dscl . -create "/Users/$SVC_USER" PrimaryGroupID 20
  dscl . -create "/Users/$SVC_USER" RealName "tg-mcp gateway"
  dscl . -create "/Users/$SVC_USER" NFSHomeDirectory "$SVC_HOME"
  dscl . -create "/Users/$SVC_USER" UserShell /usr/bin/false
  dscl . -create "/Users/$SVC_USER" Password '*'
  dscl . -create "/Users/$SVC_USER" IsHidden 1
  # Directory services may not expose a newly created user immediately.
  for _ in $(seq 1 20); do
    id -u "$SVC_USER" >/dev/null 2>&1 && break
    sleep 0.5
  done
  id -u "$SVC_USER" >/dev/null 2>&1 || fail "user $SVC_USER was created but is not visible yet; rerun the installer"
  echo "created, UID $NEW_UID"
fi
mkdir -p "$GATEWAY_HOME"
chown -R "$SVC_USER":staff "$SVC_HOME"
chmod 700 "$SVC_HOME" "$GATEWAY_HOME"

step "2. Node $NODE_VERSION in $PREFIX/node (owned by root)"
mkdir -p "$PREFIX"
chown root:wheel "$PREFIX"
chmod 755 "$PREFIX"
NODE_OK=0
if [ -x "$PREFIX/node/bin/node" ] && [ ! -L "$PREFIX/node" ] && [ ! -L "$PREFIX/node/bin/node" ] && [ "$(owner_uid "$PREFIX/node/bin/node")" -eq 0 ]; then
  [ "$("$PREFIX/node/bin/node" --version)" = "v$NODE_VERSION" ] && NODE_OK=1
fi
if [ "$NODE_OK" -eq 1 ]; then
  echo "already installed"
else
  NAME="node-v$NODE_VERSION-darwin-$NODE_ARCH"
  # -q must be the first argument so curl ignores .curlrc.
  curl -q -fsSL --proto '=https' --tlsv1.2 "https://nodejs.org/dist/v$NODE_VERSION/$NAME.tar.gz" -o "$WORK/$NAME.tar.gz"
  curl -q -fsSL --proto '=https' --tlsv1.2 "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
  EXPECTED="$(grep " $NAME.tar.gz\$" "$WORK/SHASUMS256.txt" | awk '{print $1}')"
  ACTUAL="$(shasum -a 256 "$WORK/$NAME.tar.gz" | awk '{print $1}')"
  [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || fail "Node checksum mismatch"
  rm -rf "$PREFIX/node"
  mkdir -p "$PREFIX/node"
  tar -xzf "$WORK/$NAME.tar.gz" -C "$PREFIX/node" --strip-components 1
  chown -R root:wheel "$PREFIX/node"
  chmod -R go-w "$PREFIX/node"
  echo "installed $("$PREFIX/node/bin/node" --version)"
fi
export PATH="$PREFIX/node/bin:/usr/bin:/bin:/usr/sbin:/sbin"

step "3. Commit $SHA"
# Pass the Git token through environment variables, avoiding process arguments and config.
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
AUTH="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
git init -q "$WORK/src"
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.extraHeader" GIT_CONFIG_VALUE_0="Authorization: Basic $AUTH" \
  git -C "$WORK/src" fetch -q --depth 1 "https://github.com/$REPO.git" "$SHA"
unset GH_TOKEN AUTH
git -C "$WORK/src" checkout -q --detach FETCH_HEAD
[ "$(git -C "$WORK/src" rev-parse HEAD)" = "$SHA" ] || fail "fetched commit does not match the requested SHA"

# Package install scripts are unnecessary for this build and remain disabled.
# Use private npm configuration and cache, unaffected by external .npmrc files.
export npm_config_userconfig=/dev/null npm_config_cache="$WORK/npm-cache" npm_config_update_notifier=false
(cd "$WORK/src" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && npm run build >/dev/null && npm prune --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
[ -f "$WORK/src/dist/cli/index.js" ] || fail "build failed"

# Installed code must contain no symlinks; external targets could let agents
# replace executable code. Remove .bin directories, which contain symlinks.
find "$WORK/src/node_modules" -type d -name .bin -prune -exec rm -rf {} +
LINKS="$(find "$WORK/src/dist" "$WORK/src/node_modules" -type l -print -quit)"
[ -z "$LINKS" ] || fail "build contains symlinks; installation stopped: $LINKS"

mkdir -p "$PREFIX/app" "$PREFIX/bin"
rsync -rt --delete "$WORK/src/dist" "$WORK/src/node_modules" "$WORK/src/package.json" "$PREFIX/app/"
chown -R root:wheel "$PREFIX/app"
chmod -R go-w "$PREFIX/app"
[ -z "$(find "$PREFIX/app" -type l -print -quit)" ] || fail "symlink found in $PREFIX/app"
echo "$SHA" > "$PREFIX/app/COMMIT"
echo "built and installed"

step "4. Commands in $PREFIX/bin"
# Agent stdio proxy runs as its caller.
cat > "$PREFIX/bin/tg-mcp" <<EOF
#!/bin/sh
exec "$PREFIX/node/bin/node" --no-warnings "$PREFIX/app/dist/cli/index.js" "\$@"
EOF
# Owner administration (login, users, doctor) runs as $SVC_USER.
cat > "$PREFIX/bin/tg-mcp-admin" <<EOF
#!/bin/sh
# Usage: sudo $PREFIX/bin/tg-mcp-admin <command>
if [ "\$(id -u)" -ne 0 ]; then
  echo "root required: sudo $PREFIX/bin/tg-mcp-admin \$*" >&2
  exit 1
fi
cd "$SVC_HOME"
exec sudo -u "$SVC_USER" env HOME="$SVC_HOME" TG_MCP_HOME="$GATEWAY_HOME" \\
  "$PREFIX/node/bin/node" --no-warnings "$PREFIX/app/dist/cli/index.js" "\$@"
EOF
chown root:wheel "$PREFIX/bin" "$PREFIX/bin/tg-mcp" "$PREFIX/bin/tg-mcp-admin"
chmod 755 "$PREFIX/bin" "$PREFIX/bin/tg-mcp" "$PREFIX/bin/tg-mcp-admin"

step "5. Shared directory $FILES_DIR and logs"
if [ -e "$FILES_DIR" ] || [ -L "$FILES_DIR" ]; then
  [ ! -L "$FILES_DIR" ] || fail "$FILES_DIR is a symlink; remove it and rerun the installer"
  [ "$(owner_uid "$FILES_DIR")" -eq "$(id -u "$SVC_USER")" ] || fail "$FILES_DIR is not owned by $SVC_USER; inspect its origin"
else
  mkdir "$FILES_DIR"
  chown "$SVC_USER":staff "$FILES_DIR"
fi
chmod 755 "$FILES_DIR"
mkdir -p "$LOG_DIR"
chown "$SVC_USER":wheel "$LOG_DIR"
chmod 750 "$LOG_DIR"

step "6. Configuration $GATEWAY_HOME/.env"
ENV_FILE="$GATEWAY_HOME/.env"
# This directory belongs to the service user; root must not write through a symlink.
[ ! -L "$ENV_FILE" ] || fail "$ENV_FILE is a symlink; remove it and rerun the installer"
# Build content in root's directory and replace the file with service-user-only permissions.
put_env() {
  install -S -o "$SVC_USER" -g staff -m 600 "$1" "$ENV_FILE"
}
if [ -f "$ENV_FILE" ]; then
  echo "already exists"
  if grep -q '^TG_MCP_FILES_DIR=/Users/Shared' "$ENV_FILE"; then
    echo "WARNING: .env uses the old /Users/Shared directory. Set TG_MCP_FILES_DIR=$FILES_DIR"
  fi
  HAVE_ID="$(env_value TG_API_ID "$ENV_FILE")"
  HAVE_HASH="$(env_value TG_API_HASH "$ENV_FILE")"
  if [ -n "$SEED_ID" ] && { [ -z "$HAVE_ID" ] || [ -z "$HAVE_HASH" ]; }; then
    # Replace both API credentials if either is empty; preserve other configuration lines.
    grep -v -E '^(TG_API_ID|TG_API_HASH)=' "$ENV_FILE" > "$WORK/env.new" || true
    printf 'TG_API_ID=%s\nTG_API_HASH=%s\n' "$SEED_ID" "$SEED_HASH" >> "$WORK/env.new"
    put_env "$WORK/env.new"
    echo "TG_API_ID and TG_API_HASH imported from $API_ENV"
  elif [ -n "$SEED_ID" ]; then
    echo "TG_API_ID and TG_API_HASH already set; preserved"
  fi
else
  cat > "$WORK/env.new" <<EOF
# Application credentials from my.telegram.org.
TG_API_ID=$SEED_ID
TG_API_HASH=$SEED_HASH
TG_MCP_FILES_DIR=$FILES_DIR
TG_MCP_PORT=$PORT
# Toolsets: core (reading), discover (channel discovery), analytics (statistics),
# index (local index), write (two-step writes: preview and tg_confirm).
TG_MCP_TOOLSETS=core
EOF
  put_env "$WORK/env.new"
  if [ -n "$SEED_ID" ]; then
    echo "created; TG_API_ID and TG_API_HASH imported from $API_ENV"
  else
    echo "template created; enter TG_API_ID and TG_API_HASH"
  fi
fi
rm -f "$WORK/env.new"
HAVE_CREDS=0
[ -n "$(env_value TG_API_ID "$ENV_FILE")" ] && [ -n "$(env_value TG_API_HASH "$ENV_FILE")" ] && HAVE_CREDS=1

# Read the actual .env port for health checks; the owner may have changed it.
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
  <!-- Exit code 1 on hanging MTProto calls causes launchd to restart the daemon. -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/daemon.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/daemon.log</string>
</dict>
</plist>
EOF
chown root:wheel "$PLIST"
chmod 644 "$PLIST"

# Stop the previous daemon. bootout may return before exit; wait to prevent
# bootstrap Input/output errors and session-lock contention.
launchctl bootout "system/$LABEL" 2>/dev/null || true
for _ in $(seq 1 60); do
  launchctl print "system/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl print "system/$LABEL" >/dev/null 2>&1 && fail "old daemon did not stop within 30 seconds; run sudo launchctl bootout system/$LABEL and retry installation"

# Rotate logs while stopped. newsyslog is unsuitable because launchd keeps
# the file open and would continue writing to the removed file after rotation.
rm -f /etc/newsyslog.d/tg-mcp.conf
LOG_FILE="$LOG_DIR/daemon.log"
if [ -f "$LOG_FILE" ] && [ ! -L "$LOG_FILE" ] && [ "$(stat -f %z "$LOG_FILE")" -gt 10485760 ]; then
  rm -f "$LOG_FILE.3"
  [ -f "$LOG_FILE.2" ] && mv "$LOG_FILE.2" "$LOG_FILE.3"
  [ -f "$LOG_FILE.1" ] && mv "$LOG_FILE.1" "$LOG_FILE.2"
  mv "$LOG_FILE" "$LOG_FILE.1"
  echo "log moved to $LOG_FILE.1"
fi

# Enable before bootstrap so previously disabled services can start.
launchctl enable "system/$LABEL"
launchctl bootstrap system "$PLIST"

# Verify an actual daemon response before reporting completion.
STARTED=0
for _ in $(seq 1 30); do
  if curl -q -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    STARTED=1
    break
  fi
  sleep 1
done

step "Done"
if [ "$STARTED" -eq 1 ]; then
  echo "Daemon responding: http://127.0.0.1:$PORT/mcp"
else
  echo "WARNING: no response from http://127.0.0.1:$PORT/healthz within 30 seconds. Inspect the log below."
fi
echo "Log: sudo tail -f $LOG_DIR/daemon.log"
echo "Agent exports and images: $FILES_DIR"
echo
echo "For a first installation, continue in order:"
N=1
if [ "$HAVE_CREDS" -eq 0 ]; then
  echo "  $N. Enter TG_API_ID and TG_API_HASH, then restart the daemon:"
  echo "       sudo -u $SVC_USER nano $ENV_FILE"
  echo "       sudo launchctl kickstart -k system/$LABEL"
  N=$((N + 1))
fi
echo "  $N. Log into Telegram yourself, entering the code and 2FA password:"
if [ -n "$SEED_PHONE" ]; then
  echo "       sudo $PREFIX/bin/tg-mcp-admin login --account agent --phone $SEED_PHONE"
else
  echo "       sudo $PREFIX/bin/tg-mcp-admin login --account agent"
fi
N=$((N + 1))
echo "  $N. Create a user and grant access (the token is printed once):"
echo "       sudo $PREFIX/bin/tg-mcp-admin user add nick --account agent"
N=$((N + 1))
echo "  $N. Verify:"
echo "       sudo $PREFIX/bin/tg-mcp-admin doctor"
