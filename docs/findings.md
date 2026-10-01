# Находки из кода и что проверить

Заметки по изучению соседних репозиториев 1 октября 2026, после их обновления. Коммиты снимка: [../reference/SNAPSHOT.md](../reference/SNAPSHOT.md).

## Контекст владельца

- Владелец общается со своим Claude Code через Telegram-бота (дальше «бот-мост»). Это официальный Telegram-плагин channels на лабораторной машине, см. ниже. На основном Mac Hermes тоже установлен, но к Bot API здесь ничего не подключено.
- Свой канал: @stonksnws. Его архивирует helper, утренние сводки туда публикует canary.

## Лабораторная машина

Проверено 1 октября 2026 по SSH, только чтение.

- `nick@macbook-pro-lab.local`: macOS 15.7.9, Intel x86_64, Node 22.22.0. Установлены `claude`, `codex`, `opencode`, `hermes`, Docker, `gh`. Здесь будет работать демон (решение 12).
- `node:sqlite` с FTS5 работает.
- Бот-мост: официальный Telegram-плагин channels Claude Code v0.0.7 (Bun + grammY, Bot API), два экземпляра для двух профилей Claude Code. Hermes держит свой Telegram-шлюз (его процессы Python подключены к серверам Telegram).
- В Docker работают контейнеры других проектов; контейнеров helper нет.
- `opencode` есть только здесь, на основном Mac его нет: прогоны сценариев в трёх клиентах делать на лабораторной машине.

## channel-scope (ветка `feat/mcp-server`, впереди `main`)

- Монорепо: `shared`, `server` (Express, Mongo), `web` (React), `mcp`.
- **Существующий MCP** (`packages/mcp/src/index.ts`): stdio, тонкий прокси к REST channel-scope с логином по паролю и cookie. 14 инструментов CRM-пайплайна исследования каналов: `searchChannels`, `getChannelDetails`, `getRecommendations`, `analyzeForwards`, `getPipeline`, `addToPipeline`, `startDataCollection`, `getChannelAnalytics`, `getChannelPosts`, `filterPipeline`, `getChannelReport`, `compareChannels`, `saveChannelReport`, `setChannelStatus`. Остаётся отдельным инструментом; из него берём каркас (`registerTool`, zod, `readOnlyHint`, `instructions`) и подход «лёгкие результаты, потом обогащение».
- **`clientManager.ts`:** несколько аккаунтов, сессии в Mongo зашифрованы AES-256-GCM (`SESSION_ENCRYPTION_KEY`), вход через веб с ожиданием кода и 2FA, склейка параллельных подключений, таймаут `connect` 30 секунд.
- **`rateLimiter.ts`:** воркер на аккаунт, общая очередь, 60 запросов в минуту, 500 мс между запросами, FLOOD_WAIT ставит аккаунт на паузу, до 3 повторов, `pickActiveClientId`. Для тестов есть инъекция (`_setClientResolver`, `_setActiveIdsLoader`). **Нет дедлайна на сам вызов.**
- **Поиск:** `globalSearchService.searchGlobal` делает `messages.SearchGlobal` с пагинацией, но выбрасывает сообщения и оставляет только каналы; `searchByHashtag` через `channels.SearchPosts`; `contacts.Search` с лимитом 10; рекомендации обходом в ширину до 3 уровней; источники репостов через `GetHistory`.
- **accessHash привязан к сессии:** `enrichChannelById` сначала пробует `InputChannel` с accessHash, при `CHANNEL_INVALID` идёт через `getEntity`. Кэш сущностей должен быть на аккаунт.
- **Вызовы мимо лимитера:** `recommendationsService`, `forwardAnalysisService`, `refreshService`, `viewsSyncService` берут клиента напрямую.
- **`autoEmojiService.handleNewPost`** нигде не вызывается: слушателя новых постов в channel-scope нет.
- **Харнесс отчётов** (`web/routes/research.ts:131`): запускает `claude -p` с `--mcp-config`, `--dangerously-skip-permissions`, моделью sonnet и таймаутом 120 секунд. Готовый образец запуска агента из кода.
- Прод channel-scope: VPS, systemd, деплой через GitHub Actions (детали в `channel-scope/AGENTS.md`).

## helper (ветка `main`)

- Локальная копия стояла на старой ветке `claude/intelligent-franklin` (апрель). 1 октября 2026 переключена на `main` (fast-forward, локальные файлы не тронуты).
- **Что делает:** Bot API слушает посты канала, комментарии и реакции в группе обсуждений (бот должен быть админом группы); GramJS ставит авто-реакцию на новые посты, `StatsRefresher` обновляет просмотры и реакции, `CommentsRefresher` перечитывает треды комментариев и досылает пропущенное; экспорт в JSON.
- **Надёжность:** `gramGate` (одна полоса MTProto-вызовов на процесс, дедлайн внутри полосы), `runStage` и `withTimeout`, кап FLOOD_WAIT 5 минут, watchdog залипших тиков, дедлайн старта 2 минуты, выход с кодом 1 при зависшем вызове и перезапуск Docker (PR #81, #82, #90, #91). Инцидент: `StatsRefresher` простоял с 3 по 12 августа 2026 из-за вызова GramJS, который так и не вернулся.
- **Комментарии:** группа обсуждений через `GetFullChannel.linkedChatId`, корень треда через `GetDiscussionMessage` (сообщение с `fwdFrom.savedFromMsgId` равным id поста), ветка через `GetReplies` страницами по 100. `MSG_ID_INVALID`: комментарии выключены или корень удалён; `CHANNEL_PRIVATE`: аккаунт не состоит в закрытой группе обсуждений.
- **Двухслойное слежение:** быстрый слой за секунды плюс сверка по расписанию; расхождение `replies.replies` в ответе `GetMessages` будит перечитку треда.
- **Данные:** MongoDB `telegram_public` (коллекции `posts`, `comments`, `commentreactionactors`). Кто поставил реакцию, известно только с 13 августа 2026 и не для анонимных реакций; итоговые счётчики брать из `comments.reactions`.
- **Правила прода** (`helper/AGENTS.md`): не запускать второй поллер на прод-токене бота, не запускать второй клиент GramJS на прод-сессии, бэкфилл комментариев только при остановленном сервисе.
- **Прод по документации:** локальный Docker (`helper-bot`, `helper-mongo` на `127.0.0.1:27018`). 1 октября 2026 на этом Mac контейнеров helper не было ни запущенных, ни остановленных. На лабораторной машине контейнеров helper тоже нет. Где работает прод, уточнить у владельца.

## canary и tgbot

- Один и тот же код (оба `master` на `ce03d0c`): ежедневная сводка по крипте в @stonksnws через Bot API.
- Для tg-mcp пригодится только отправка сообщения с inline-клавиатурой (`src/telegram/telegram.js`) как образец отправки с кнопками (в шлюзе не используется: бота согласований нет, решение 23).

## blog и helper_old

- blog: контент блога, к проекту не относится.
- helper_old: старый архив. `git fetch` падает на битой ссылке `refs/heads/main 2` (похоже на дубликат файла от Finder или iCloud). Не трогали.

## Проверено при реализации (1 октября 2026)

По установленному GramJS 2.26.22 (слой 198) и прогонам клиентов.

- **Темы форумов:** `channels.GetForumTopics`, чтение темы через `messages.GetReplies` с id темы.
- **`channels.SearchPosts`** в этом слое принимает только `hashtag`. Поиска по тексту публичных постов в GramJS 2.26.22 нет; `CheckSearchPostsFlood` тоже нет.
- **`thumb` у `downloadMedia`** принимает индекс, букву типа размера (`m` это около 320 px) или объект размера. Шлюз передаёт букву.
- **`channels.GetSendAs`** есть, у `messages.SendMessage` есть `sendAs`.
- **`node:sqlite`** работает под vitest без обходных путей, FTS5 есть на обеих машинах.
- **Codex 0.144:** `codex exec -c 'mcp_servers.telegram.url="..."' -c 'mcp_servers.telegram.bearer_token_env_var="TG_MCP_TOKEN"'` подключается по Streamable HTTP и вызывает инструмент. Проверено на лабораторной машине.
- **OpenCode 1.3.6:** `opencode.json` с `"type": "remote"`, `url` и `headers` подключается (`opencode mcp list` показывает `connected`). `opencode run` на лабораторной машине не работает: провайдеров моделей нет, а бесплатные модели в неинтерактивном режиме запрещены.
- **Claude Code 2.1.286:** `claude -p --mcp-config ... --strict-mcp-config --allowedTools` принимает конфиг с `"type": "http"` и `headers`. По SSH на лабораторной машине `claude -p` не авторизуется: OAuth-токен лежит в связке ключей, недоступной SSH-сессии. Полный прогон ещё не сделан (упёрлись в лимит сессии подписки).
- В `~/.claude/settings.json` на лабораторной машине Claude Code предупреждает о двух правилах разрешений, которые не срабатывают: `Bash(cp /Users/nick/.claude/channels/telegram/inbox/*:*)` и `Write(//Users/nick/.claude/busy.flag)`. К шлюзу это не относится, но бот-мост может работать не так, как задумано.

## Факты про Telegram, которые надо проверить

- `messages.searchGlobal` ищет только по чатам аккаунта.
- `messages.search` и `messages.getReplies` работают в публичных каналах и группах без вступления; где нужно вступать.
- Полнотекстовый поиск по публичным постам (Premium, квота) и его поддержка в текущем GramJS.
- `send_as` для ответа от имени канала в группе обсуждений: метод есть, поведение надо проверить вживую.
- Порог и поведение `PEER_FLOOD` для сообщений незнакомым людям.

## Факты про клиенты, которые надо проверить

Синтаксис из [connect.md](connect.md) записан по памяти.

- Claude Code: `claude mcp add --transport http ... --header`, лимит ответа `MAX_MCP_OUTPUT_TOKENS`, картинки в ответах инструментов, механизм channels.
- Codex: `url`, `bearer_token_env_var`, `tool_timeout_sec`, `startup_timeout_sec` в `[mcp_servers.*]`.
- OpenCode: `type: remote`, `headers` с подстановкой `{env:...}`.
- Hermes: `mcp_servers` с `url` и `headers` в `~/.hermes/config.yaml`, подстановка переменных окружения.
- Путь unix-сокета ограничен 104 байтами на macOS. Блокировка демона это сокет `daemon.sock` в папке шлюза, поэтому слишком длинный `TG_MCP_HOME` даёт ошибку с подсказкой выбрать путь короче. Боевой путь `/var/tgmcp/.tg-mcp` короткий.
- 2 октября 2026: шлюз переведён с GramJS на teleproto 1.229.1 (решение 26). Упоминания GramJS выше относятся к соседним репозиториям (helper, channel-scope) и к коду, из которого брались приёмы. У teleproto ошибки несут код сервера в `errorMessage`, логгер по умолчанию пишет через `console.log`, формат строки сессии совпадает с GramJS.
