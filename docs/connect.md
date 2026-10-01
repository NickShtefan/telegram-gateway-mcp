# Подключение и конфиги

> Сгенерировано из данных интерактивной схемы (`docs/architecture.html`) 1 октября 2026. Дальше файл правится вручную.

Шлюз запускается один раз, каждый клиент добавляет его одной записью. Синтаксис конфигов клиентов записан по памяти: перед выпуском сверить с текущей документацией каждого клиента. Команды `tg-mcp` пока гипотетические.

## Шлюз

Запускается один раз на лабораторной машине: LaunchDaemon под отдельным пользователем macOS `tgmcp` (решения 12 и 17, имя пользователя предварительное). Ставится из клона приватного репозитория в общую папку; `npx tg-mcp` не использовать: в npm под этим именем чужой пакет (решение 14).

```bash
# один раз: установка в общую папку, появляется команда tg-mcp
git clone git@github.com:NickShtefan/telegram-gateway-mcp.git /opt/telegram-gateway-mcp
cd /opt/telegram-gateway-mcp && npm ci && npm run build && npm link

# вход в аккаунт под пользователем демона (телефон, код, 2FA вводит хозяин аккаунта)
sudo -u tgmcp tg-mcp login --account agent

# демон, который владеет сессиями; в работе его запускает launchd
sudo -u tgmcp tg-mcp serve --host 127.0.0.1 --port 7777 \
  --toolsets core,automate --media-dir /Users/Shared/tg-mcp/media

# проверка: сессии, лимиты, доступность
sudo -u tgmcp tg-mcp doctor
```

## Runner

Запускает агента, когда сработало правило или ответил собеседник в поручении. Работает под пользователем macOS человека (LaunchAgent), у каждого пользователя свой (решение 17).

```bash
# владелец: свой токен, свой профиль Claude Code
TG_MCP_TOKEN=$TG_MCP_TOKEN_NICK tg-mcp runner \
  --agent 'claude -p {prompt} --mcp-config ~/tg-mcp/agent.mcp.json'

# второй пользователь: свой токен и свой профиль
CLAUDE_CONFIG_DIR=<папка второго профиля> TG_MCP_TOKEN=$TG_MCP_TOKEN_PARTNER tg-mcp runner \
  --agent 'claude -p {prompt} --mcp-config ~/tg-mcp/agent-partner.mcp.json'
```

## Пользователи и аккаунты

Кто пользуется шлюзом и у кого к каким аккаунтам доступ (решение 16). Формат предварительный.

```yaml
# ~tgmcp/users.yaml, у пользователя демона
users:
  nick:
    token_sha256: <хэш токена>        # сам токен знает только пользователь, у демона хэш
    telegram_id: <id владельца>        # кому бот согласований шлёт запросы
    default_account: nick
  partner:
    token_sha256: <хэш токена>
    telegram_id: <id второго пользователя>
    default_account: partner

accounts:
  nick:    { users: [nick] }            # личный аккаунт владельца
  partner: { users: [partner] }         # личный аккаунт второго пользователя
  agent:   { users: [nick, partner] }   # общий аккаунт агента (тестовый номер)
```

## Правило

Так выглядит правило для третьего кейса. Его можно записать в файл руками или создать из агента через `tg_rule_set`, тогда оно пройдёт подтверждение.

```yaml
# ~tgmcp/rules.yaml, у пользователя демона
rules:
  - id: reply-new-posts
    owner: nick                # чьё правило: его runner запускает агента, ему идут согласования
    account: agent
    chat: "@channel"
    trigger: new_post
    skip_ads: true
    mode: draft              # draft: черновик в бота, auto: сразу
    limits:
      per_post: 1
      per_day: 5
      quiet_hours: "23:00-09:00"
      delay_sec: [60, 300]   # случайная пауза перед ответом
    agent:
      timeout_sec: 120         # команду запуска задаёт runner владельца правила
    prompt: |
      Прочитай пост {post_link}, картинку к нему и комментарии.
      Напиши короткий ответ по существу и отправь через tg_reply.

approval:
  bot_token_env: TG_MCP_APPROVAL_BOT_TOKEN   # отдельный бот, не бот-мост
  # кому слать: telegram_id владельца правила из users.yaml
```

## Поручение

Так выглядят аргументы `tg_task_start` для четвёртого кейса. Схема плоская: строки, числа и список значений из фиксированного набора.

```json
{
  "peer": "@seller_username",
  "account": "agent",
  "via": "account",
  "goal": "Купить велосипед из объявления t.me/baraholka/123",
  "limits": "До 15 000 ₽. Самовывоз в субботу или воскресенье днём.",
  "ask_me_before": ["over_limits", "money_transfer", "address", "personal_data"],
  "first_message": "Здравствуйте! Пишу как помощник покупателя по объявлению о велосипеде. Он ещё продаётся?",
  "mode": "draft",
  "deadline": "3d",
  "max_messages": 20,
  "reminder_after": "24h"
}
```

С `"via": "business"` переписка идёт от личного аккаунта владельца через Business-бота (решение 13): `account` не нужен, `first_message` владелец отправляет сам по ссылке от бота согласований, `reminder_after` не работает, потому что бот не может написать после суток молчания собеседника.

## Claude Code

Через HTTP к демону. Вариант со stdio подходит, если демон не нужен: прокладка поднимет ядро сама.

```bash
claude mcp add --transport http telegram http://127.0.0.1:7777/mcp \
  --header "Authorization: Bearer $TG_MCP_TOKEN"

# вариант без отдельного демона
claude mcp add telegram -- tg-mcp stdio
```

Второй пользователь делает то же в своём профиле Claude Code (`CLAUDE_CONFIG_DIR=<папка профиля> claude mcp add ...`) со своим токеном.

## Codex

Запись в `~/.codex/config.toml`. Таймаут вызова стоит поднять: выгрузка с фото может идти дольше минуты.

```toml
# ~/.codex/config.toml
[mcp_servers.telegram]
url = "http://127.0.0.1:7777/mcp"
bearer_token_env_var = "TG_MCP_TOKEN"
tool_timeout_sec = 90

# или через stdio-прокладку
# [mcp_servers.telegram]
# command = "tg-mcp"
# args = ["stdio"]
```

## OpenCode

Запись в `opencode.json` проекта или в глобальный конфиг.

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

## Hermes

Раздел `mcp_servers` в `~/.hermes/config.yaml`.

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  telegram:
    url: "http://127.0.0.1:7777/mcp"
    headers:
      Authorization: "Bearer <TG_MCP_TOKEN>"
```

## Любой stdio

Минимальная запись, которую понимает почти любой MCP-клиент.

```json
{
  "command": "tg-mcp",
  "args": ["stdio"]
}
```

