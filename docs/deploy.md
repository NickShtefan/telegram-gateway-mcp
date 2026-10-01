# Установка и обновление

Как поставить шлюз на лабораторную машину (решения 12 и 17) и как запускать его при разработке.

## Что где лежит на лабораторной машине

| Путь | Что там | Кому принадлежит |
|---|---|---|
| `/opt/telegram-gateway-mcp/app` | собранный код и зависимости | root |
| `/opt/telegram-gateway-mcp/node` | своя копия Node 22 с nodejs.org | root |
| `/opt/telegram-gateway-mcp/bin/tg-mcp` | команда для агентов: `stdio`, позже `runner` | root |
| `/opt/telegram-gateway-mcp/bin/tg-mcp-admin` | команда для владельца: `login`, `user`, `account`, `scope`, `doctor` | root |
| `/var/tgmcp/.tg-mcp` | база, ключ шифрования сессий, `.env` | `tgmcp`, права 700 |
| `/Users/Shared/tg-mcp` | выгрузки и картинки, которые читают агенты | `tgmcp`, права 755 |
| `/var/log/tg-mcp/daemon.log` | лог демона | `tgmcp` |
| `/Library/LaunchDaemons/com.tg-mcp.gateway.plist` | запуск под launchd | root |

Почему код и Node принадлежат root. Агенты работают под `nick` с доступом к shell. Homebrew на этой машине тоже принадлежит `nick`, включая `/usr/local/bin/node`. Если бы демон исполнял код или Node, которые `nick` может переписать, агент, которого увели через prompt injection, мог бы подменить их и добраться до сессий в обход решения 17. Поэтому всё, что исполняет демон, лежит в `/opt/telegram-gateway-mcp` и принадлежит root, а Node скачивается с nodejs.org с проверкой контрольной суммы.

Цена этого решения: обновление требует sudo, агент сам обновить шлюз не может.

## Первая установка

Всё, что требует sudo, делает владелец.

```bash
gh repo clone NickShtefan/telegram-gateway-mcp ~/tg-mcp-dev
```

```bash
cd ~/tg-mcp-dev && npm ci && npm run build
```

```bash
sudo bash scripts/lab-install.sh
```

Скрипт создаёт пользователя `tgmcp`, раскладывает файлы, ставит LaunchDaemon и печатает дальнейшие шаги. Их пять.

1. Вписать учётные данные приложения с my.telegram.org:

```bash
sudo -u tgmcp nano /var/tgmcp/.tg-mcp/.env
```

2. Войти в аккаунт Telegram. Код и пароль 2FA вводит хозяин аккаунта:

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin login --account agent
```

3. Завести пользователей шлюза и выдать им аккаунты. Токен печатается один раз, шлюз хранит только его хэш:

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin user add nick --telegram-id <твой id> --account agent
```

4. Проверить установку:

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin doctor
```

5. Перезапустить демон, чтобы он прочитал `.env`:

```bash
sudo launchctl kickstart -k system/com.tg-mcp.gateway
```

Сессия создаётся входом на этой машине и никуда не копируется (решение 12).

## Обновление

```bash
cd ~/tg-mcp-dev && git pull && npm ci && npm run build && npm test
```

```bash
sudo bash scripts/lab-install.sh
```

Повторный запуск скрипта обновляет код и перезапускает демон. Пользователь, база, `.env` и сессии не трогаются. Задачи, которые выполнялись в момент перезапуска, возвращаются в очередь.

## Второй пользователь и общий аккаунт

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin user add partner --telegram-id <id второго пользователя> --account partner
```

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin account grant agent partner
```

Второй пользователь входит в свой личный аккаунт сам: `tg-mcp-admin login --account partner`, код придёт на его телефон.

Открыть пользователю личный чат (по умолчанию личные переписки закрыты):

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin scope allow nick agent @username
```

## Подключение агентов

Адрес `http://127.0.0.1:7777/mcp`, токен пользователя в заголовке `Authorization: Bearer`. Конфиги клиентов: [connect.md](connect.md).

## Запуск при разработке

На основном Mac шлюз запускается из клона, без отдельного пользователя. Состояние лежит в `~/.tg-mcp` (или в `TG_MCP_HOME`).

```bash
npm run build && node dist/cli/index.js doctor
```

```bash
node dist/cli/index.js serve --port 7777
```

Сессия для разработки создаётся отдельным входом на этой машине. Копировать сессию с лабораторной машины нельзя.

## Диагностика

- `tg-mcp-admin doctor` показывает версию Node, права на папку, наличие учётных данных, пользователей, аккаунты и работает ли демон. С `--connect` подключает аккаунты, но только когда демон остановлен: второй процесс на тех же сессиях недопустим.
- `curl http://127.0.0.1:7777/healthz` отвечает `{"ok":true}`, если демон жив.
- Демон вышел с кодом 1 и поднялся заново: в логе строка `fatal MTProto failure`. Это штатная реакция на зависший вызов GramJS (страж зависаний).
- `Another tg-mcp process already owns the Telegram sessions`: демон уже запущен. Блокировка это сокет `daemon.sock` в папке шлюза.
