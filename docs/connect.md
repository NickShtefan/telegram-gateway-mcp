# Подключение и конфиги

Шлюз запускается один раз, каждый клиент добавляет его одной записью. Установка на лабораторную машину: [deploy.md](deploy.md). Ниже считается, что демон слушает `http://127.0.0.1:7777/mcp`, а команды лежат в `/opt/telegram-gateway-mcp/bin`.

Что проверено: конфиги Codex и OpenCode (1 октября 2026, [findings.md](findings.md)). Конфиг Claude Code собран по документации и проверен на уровне протокола тем же SDK; полный прогон с моделью ещё не сделан. Hermes записан по памяти.

`npx tg-mcp` не использовать: в npm под этим именем чужой пакет (решение 14).

## Пользователи и аккаунты

Пользователи шлюза, их токены и доступ к аккаунтам лежат в базе демона и управляются командой владельца (решение 16). Файла конфигурации для этого нет.

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin user add nick --telegram-id <твой id> --account agent
```

Команда печатает токен один раз. В базе хранится только его хэш.

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin user list
```

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin account grant agent partner
```

Свой Telegram id можно узнать у бота согласований: открыть его и отправить `/id`.

## Claude Code

Токен кладётся в переменную окружения, в конфиге стоит ссылка на неё.

```bash
claude mcp add --transport http telegram http://127.0.0.1:7777/mcp \
  --header "Authorization: Bearer $TG_MCP_TOKEN"
```

Второй пользователь делает то же в своём профиле (`CLAUDE_CONFIG_DIR=<папка профиля> claude mcp add ...`) со своим токеном.

Файл для запуска без интерфейса (`claude -p --mcp-config`), он же нужен runner:

```json
{
  "mcpServers": {
    "telegram": {
      "type": "http",
      "url": "http://127.0.0.1:7777/mcp",
      "headers": { "Authorization": "Bearer ${TG_MCP_TOKEN}" }
    }
  }
}
```

## Codex

Запись в `~/.codex/config.toml`. Таймаут вызова стоит поднять: выгрузка ждёт до 20 секунд, прежде чем вернуть `job_id`.

```toml
[mcp_servers.telegram]
url = "http://127.0.0.1:7777/mcp"
bearer_token_env_var = "TG_MCP_TOKEN"
tool_timeout_sec = 90
```

Разовый запуск без правки конфига (проверено):

```bash
TG_MCP_TOKEN=... codex exec --skip-git-repo-check \
  -c 'mcp_servers.telegram.url="http://127.0.0.1:7777/mcp"' \
  -c 'mcp_servers.telegram.bearer_token_env_var="TG_MCP_TOKEN"' \
  "Call tg_status and tell me which accounts I have."
```

## OpenCode

Запись в `opencode.json` проекта или в глобальный конфиг (подключение проверено командой `opencode mcp list`).

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "telegram": {
      "type": "remote",
      "url": "http://127.0.0.1:7777/mcp",
      "headers": { "Authorization": "Bearer {env:TG_MCP_TOKEN}" }
    }
  }
}
```

Для `opencode run` на лабораторной машине нужен провайдер моделей: сейчас их нет, а бесплатные модели в неинтерактивном режиме не работают.

## Hermes

Раздел `mcp_servers` в `~/.hermes/config.yaml`.

```yaml
mcp_servers:
  telegram:
    url: "http://127.0.0.1:7777/mcp"
    headers:
      Authorization: "Bearer <токен пользователя>"
```

## Любой клиент со stdio

Прокладка проксирует в демон и сама сессий не открывает. Токен в `TG_MCP_TOKEN`.

```json
{
  "command": "/opt/telegram-gateway-mcp/bin/tg-mcp",
  "args": ["stdio"],
  "env": { "TG_MCP_TOKEN": "<токен пользователя>" }
}
```

## Наборы инструментов и бот согласований

В `.env` демона (`/var/tgmcp/.tg-mcp/.env`):

```
TG_MCP_TOOLSETS=core,automate,write
TG_MCP_APPROVAL_BOT_TOKEN=<токен от BotFather>
```

- `core`: чтение и поиск. Включён по умолчанию.
- `automate`: наблюдение, входящие, правила, поручения.
- `write`: ответы, сообщения, вступление. Всё через согласование в боте.

Бот нужен новый: токены бота Claude Code и бота Hermes заняты, у токена может быть только один получатель обновлений. После создания бота открой его в Telegram и нажми Start, иначе он не сможет тебе написать.

## Runner: запуск агента по правилам и поручениям

Когда срабатывает правило или отвечает собеседник в поручении, агента запускает `tg-mcp runner`. Он работает под твоим пользователем macOS, у каждого пользователя шлюза свой (решение 17).

```bash
TG_MCP_TOKEN=<токен пользователя> /opt/telegram-gateway-mcp/bin/tg-mcp runner \
  --agent 'claude -p {prompt} --mcp-config ~/tg-mcp/agent.mcp.json --strict-mcp-config --allowedTools "mcp__telegram__*"'
```

Как это устроено:

- runner спрашивает у демона задание раз в 5 секунд, запускает команду и сообщает исход. По одному заданию за раз, таймаут 3 минуты.
- `{prompt}` подставляется одним аргументом, без оболочки.
- Агент получает в `TG_MCP_TOKEN` не твой токен, а токен запуска. По нему шлюз даёт только один пост и один ответ (правило) или один диалог (поручение). Поэтому в `agent.mcp.json` должен стоять `${TG_MCP_TOKEN}`, как в примере выше.
- Для Codex команда такая: `codex exec --skip-git-repo-check -c 'mcp_servers.telegram.url="http://127.0.0.1:7777/mcp"' -c 'mcp_servers.telegram.bearer_token_env_var="TG_MCP_TOKEN"' {prompt}`.
- Второй пользователь запускает свой runner со своим токеном и `CLAUDE_CONFIG_DIR` своего профиля.

Чтобы runner работал постоянно, его ставят как LaunchAgent пользователя: [deploy.md](deploy.md).

## Правило (кейс 3)

Правило создаёт агент через `tg_rule_set`. Оно включается только после твоего согласия в боте. Аргументы плоские:

```json
{
  "id": "reply-new-posts",
  "chat": "@channel",
  "prompt": "Прочитай пост, картинку к нему и комментарии. Напиши короткий ответ по существу.",
  "keywords": ["ставка", "рынок"],
  "skip_ads": true,
  "per_day": 5,
  "quiet_hours": "20:00-06:00",
  "send_as": "account"
}
```

- Время тихих часов в UTC.
- Перед запуском агента случайная пауза 60-300 секунд.
- Один ответ на пост с аккаунта, чьё бы правило ни сработало (решение 18).
- Режим только `draft`: каждый ответ приходит тебе в бота с кнопками «Отправить», «Изменить», «Пропустить».
- Выключить правило: `tg_rule_set` с `enabled: false`, согласие не нужно.

## Поручение (кейс 4)

Аргументы `tg_task_start`:

```json
{
  "peer": "@seller_username",
  "goal": "Купить велосипед из объявления t.me/baraholka/123",
  "limits": "До 15 000 ₽. Самовывоз в субботу или воскресенье днём.",
  "ask_me_before": ["over_limits", "money_transfer", "address", "personal_data", "meeting_time"],
  "first_message": "Здравствуйте! Пишу как помощник покупателя по объявлению о велосипеде. Он ещё продаётся?",
  "deadline": "3d",
  "max_messages": 20,
  "reminder_after": "24h",
  "via": "account"
}
```

- Поручение и первое сообщение приходят тебе в бота. Первое сообщение можно переписать.
- `money_transfer` добавляется всегда: деньги решаешь только ты.
- С `"via": "business"` переписка идёт от твоего имени через Business-бота (решение 13). Сначала подключи бота согласований в Telegram: Настройки, Telegram Business, Чат-боты. Первое сообщение отправляешь ты сам по ссылке, которую пришлёт бот. Напоминаний в этом режиме нет: бот может писать только в течение суток после сообщения собеседника.
