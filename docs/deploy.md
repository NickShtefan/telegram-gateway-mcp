# Установка и обновление

Как поставить шлюз на лабораторную машину (решения 12 и 17) и как запускать его при разработке.

## Что где лежит на лабораторной машине

| Путь | Что там | Кому принадлежит |
|---|---|---|
| `/opt/telegram-gateway-mcp/app` | собранный код и зависимости | root |
| `/opt/telegram-gateway-mcp/node` | своя копия Node 22 с nodejs.org | root |
| `/opt/telegram-gateway-mcp/install.sh` | копия установщика, запускается только отсюда | root |
| `/opt/telegram-gateway-mcp/bin/tg-mcp` | команда для агентов: `stdio`, позже `runner` | root |
| `/opt/telegram-gateway-mcp/bin/tg-mcp-admin` | команда для владельца: `login`, `user`, `account`, `scope`, `doctor` | root |
| `/var/tgmcp/.tg-mcp` | база, ключ шифрования сессий, `.env` | `tgmcp`, права 700 |
| `/opt/telegram-gateway-mcp/files` | выгрузки и картинки, которые читают агенты | `tgmcp`, права 755 |
| `/var/log/tg-mcp/daemon.log` | лог демона | `tgmcp` |
| `/Library/LaunchDaemons/com.tg-mcp.gateway.plist` | запуск под launchd | root |

Почему код и Node принадлежат root. Агенты работают под `nick` с доступом к shell. Homebrew на этой машине тоже принадлежит `nick`, включая `/usr/local/bin/node`. Если бы демон исполнял код или Node, которые `nick` может переписать, агент, которого увели через prompt injection, мог бы подменить их и добраться до сессий в обход решения 17. Поэтому всё, что исполняет демон, лежит в `/opt/telegram-gateway-mcp` и принадлежит root, а Node скачивается с nodejs.org с проверкой контрольной суммы.

По той же причине установщик ничего не берёт из папок, куда может писать `nick`: ни клон репозитория, ни собранный там `dist`, ни `node_modules`. Root сам забирает с GitHub указанный коммит, собирает его во временной папке под `/var/root` и раскладывает результат. Что именно ставится, определяет sha коммита, который ты видишь на GitHub, а не то, что лежит на диске лабораторной машины.

Общая папка для выгрузок тоже лежит внутри `/opt/telegram-gateway-mcp`: в `/Users/Shared` агент мог бы заранее положить ссылку, и демон записал бы файл не туда.

Цена этого решения: обновление требует sudo, агент сам обновить шлюз не может.

## Первая установка

Всё, что требует sudo, делает владелец. Сначала прочитай [scripts/lab-install.sh](../scripts/lab-install.sh): он выполняется под root.

1. Копия установщика под root. Это единственный раз, когда файл берётся из клона, поэтому перед этим шагом его и нужно прочитать:

```bash
sudo install -d -o root -g wheel /opt/telegram-gateway-mcp
```

```bash
sudo install -o root -g wheel -m 755 ~/tg-mcp-dev/scripts/lab-install.sh /opt/telegram-gateway-mcp/install.sh
```

2. Sha коммита, который ставим. Возьми его со страницы репозитория на GitHub (или с основного Mac: `git rev-parse origin/main`), а не из клона на лабораторной машине.

3. Установка:

```bash
sudo GH_TOKEN="$(gh auth token)" /opt/telegram-gateway-mcp/install.sh <полный sha коммита>
```

Токен GitHub нужен, пока репозиторий приватный. Он передаётся git через окружение и никуда не записывается.

Скрипт создаёт пользователя `tgmcp`, ставит свою копию Node, собирает код, ставит LaunchDaemon, ждёт ответа демона и печатает дальнейшие шаги. Их пять.

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

## Бот согласований и запись

Без бота шлюз только читает. Чтобы включить наблюдение, правила, ответы и поручения:

1. Создай нового бота у @BotFather. Старые не подойдут: у токена может быть только один получатель обновлений.
2. Открой бота в Telegram и нажми Start. Команда `/id` покажет твой Telegram id.
3. Впиши в `/var/tgmcp/.tg-mcp/.env`:

```
TG_MCP_TOOLSETS=core,automate,write
TG_MCP_APPROVAL_BOT_TOKEN=<токен от BotFather>
```

4. Привяжи свой Telegram id к пользователю шлюза, если не указал его при создании:

```bash
sudo /opt/telegram-gateway-mcp/bin/tg-mcp-admin user telegram nick <твой id>
```

5. Перезапусти демон:

```bash
sudo launchctl kickstart -k system/com.tg-mcp.gateway
```

## Runner под своим пользователем

Runner запускает твоего агента, когда срабатывает правило или отвечает собеседник. Ему не нужен sudo: он работает под `nick` и ходит в демон по HTTP ([connect.md](connect.md)).

Чтобы он работал постоянно, положи plist в `~/Library/LaunchAgents/com.tg-mcp.runner.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.tg-mcp.runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/telegram-gateway-mcp/bin/tg-mcp</string>
    <string>runner</string>
    <string>--agent</string>
    <string>claude -p {prompt} --mcp-config /Users/nick/tg-mcp/agent.mcp.json --strict-mcp-config --allowedTools "mcp__telegram__*"</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TG_MCP_TOKEN</key><string>ТОКЕН_ПОЛЬЗОВАТЕЛЯ</string>
    <key>PATH</key><string>/Users/nick/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/Users/nick/Library/Logs/tg-mcp-runner.log</string>
</dict>
</plist>
```

```bash
chmod 600 ~/Library/LaunchAgents/com.tg-mcp.runner.plist && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tg-mcp.runner.plist
```

LaunchAgent работает в графической сессии пользователя, поэтому `claude -p` видит связку ключей и авторизуется. По SSH это не работает ([findings.md](findings.md)).

## Обновление

```bash
sudo GH_TOKEN="$(gh auth token)" /opt/telegram-gateway-mcp/install.sh <полный sha нового коммита>
```

Повторный запуск обновляет код и перезапускает демон. Пользователь, база, `.env` и сессии не трогаются. Что стоит сейчас, записано в `/opt/telegram-gateway-mcp/app/COMMIT`.

- Задачи выгрузки, которые выполнялись в момент перезапуска, возвращаются в очередь. Задача, которую рестарт прерывает третий раз подряд, закрывается с ошибкой.
- Действие, которое выполнялось в момент перезапуска (человек нажал кнопку, Telegram ещё не ответил), не повторяется: карточка в боте получает пометку «исход неизвестен», проверь в Telegram.
- Если поменялся сам установщик, сначала обнови его копию командой `sudo install ...` из первой установки, перед этим прочитав изменения.
- Лог `/var/log/tg-mcp/daemon.log` больше 10 МБ при обновлении переносится в `daemon.log.1` (хранятся три старых). Между обновлениями лог не ротируется: launchd держит файл открытым.

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
- `tg_status` показывает паузы Telegram: общую паузу аккаунта и отдельные методы, закрытые долгим FLOOD_WAIT (например, `contacts.ResolveUsername` на сутки). Остальные запросы при этом работают.
- События входящих хранятся 30 дней, аудит вызовов 90 дней. Чистка идёт в демоне раз в 6 часов.
- Демон вышел с кодом 1 и поднялся заново: в логе строка `fatal MTProto failure`. Это штатная реакция на зависший вызов GramJS (страж зависаний).
- `Another tg-mcp process already owns the Telegram sessions`: демон уже запущен. Блокировка это сокет `daemon.sock` в папке шлюза.
