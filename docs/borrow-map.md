# Карта заимствований

> Сгенерировано из данных интерактивной схемы (`docs/architecture.html`) 1 октября 2026. Дальше файл правится вручную.

Какие файлы соседних репозиториев в какой компонент идут. Копии лежат в `reference/` (см. `reference/SNAPSHOT.md` с коммитами).

| Файл | Что берём | Компонент | Режим |
|---|---|---|---|
| `canary/src/telegram/telegram.js:9` | сообщение с inline-клавиатурой через Bot API | не используется: бота согласований нет (решение 23) | паттерн |
| `channel-scope/packages/mcp/src/helpers.ts` | чистые функции вынесены ради тестов, тесты на vitest | Реестр инструментов | паттерн |
| `channel-scope/packages/mcp/src/index.ts:101` | `McpServer` с полем `instructions` | Реестр инструментов | паттерн |
| `channel-scope/packages/mcp/src/index.ts:117` | `registerTool`, zod-схемы, `readOnlyHint` | Реестр инструментов | паттерн |
| `channel-scope/packages/mcp/src/index.ts:504` | текстовый отчёт в `getChannelReport` как отправная точка формата | Форматтер ответов | новое |
| `channel-scope/packages/mcp/src/index.ts:725` | StdioServerTransport и порядок старта: сначала connect, логин в фоне, чтобы клиент не ждал | stdio-прокладка | паттерн |
| `channel-scope/packages/server/src/db/export/export.ts:87` | формат выгрузки поста и извлечение ссылок из entities | Выгрузка в файл | адаптация |
| `channel-scope/packages/server/src/db/models/ClientSession.ts` | схема хранения: sessionString + iv | Хранилище сессий | адаптация |
| `channel-scope/packages/server/src/db/models/Post.ts` | схема поста с медиа, реакциями и viewsHistory | Мост к архивам | адаптация |
| `channel-scope/packages/server/src/services/analyzeChannel.ts:43` | `analyzeChannel` | Аналитика | как есть |
| `channel-scope/packages/server/src/services/archiveService.ts:15` | модель `ArchiveProgress`, пауза и продолжение с `minId` | Задачи | адаптация |
| `channel-scope/packages/server/src/services/archiveService.ts:180` | `iterMessages` с отсечкой `since` | Чтение | адаптация |
| `channel-scope/packages/server/src/services/archiveService.ts:180` | постраничный проход по истории с отсечкой по дате | Выгрузка в файл | адаптация |
| `channel-scope/packages/server/src/services/archiveService.ts:180` | пакетная вставка и Set уже сохранённых id | Локальный индекс | адаптация |
| `channel-scope/packages/server/src/services/archiveService.ts:345` | пакетное скачивание в 3 потока с учётом постоянных ошибок | Изображения и медиа | адаптация |
| `channel-scope/packages/server/src/services/autoEmojiService.ts:12` | реакция с задержкой от назначенного аккаунта | Действия | адаптация |
| `channel-scope/packages/server/src/services/botDetection.ts:24` | `detectBotRisk` | Аналитика | как есть |
| `channel-scope/packages/server/src/services/clientManager.ts:124` | `startAuth` с resolver-ами кода и пароля | Вход в аккаунт | как есть |
| `channel-scope/packages/server/src/services/clientManager.ts:31` | `encrypt` / `decrypt` (строка 44) | Хранилище сессий | адаптация |
| `channel-scope/packages/server/src/services/clientManager.ts:67` | `getClient` с `pendingConnections` | Пул клиентов | как есть |
| `channel-scope/packages/server/src/services/clientManager.ts:86` | `connectClient` с `withTimeout` | Пул клиентов | как есть |
| `channel-scope/packages/server/src/services/detectNiche.ts:53` | `detectNiche` | Аналитика | как есть |
| `channel-scope/packages/server/src/services/forwardAnalysisService.ts:21` | `analyzeForwards` | Поиск каналов | как есть |
| `channel-scope/packages/server/src/services/forwardAnalysisService.ts:56` | цикл `GetHistory` с `offsetId` | Чтение | адаптация |
| `channel-scope/packages/server/src/services/globalSearchService.ts:10` | `PaginationState` и цикл пагинации | Курсоры и ошибки | адаптация |
| `channel-scope/packages/server/src/services/globalSearchService.ts:144` | `searchByHashtag` | Поиск сообщений | адаптация |
| `channel-scope/packages/server/src/services/globalSearchService.ts:64` | `searchGlobal` с готовой пагинацией | Поиск сообщений | адаптация |
| `channel-scope/packages/server/src/services/rateLimiter.ts:103` | `pickActiveClientId` | Лимитер | как есть |
| `channel-scope/packages/server/src/services/rateLimiter.ts:148` | `_setClientResolver`: уже развязан с Mongo для тестов | Лимитер | как есть |
| `channel-scope/packages/server/src/services/rateLimiter.ts:287` | `executeRequest`: разбор FLOOD_WAIT и повтор | Лимитер | как есть |
| `channel-scope/packages/server/src/services/rateLimiter.ts:383` | `parseFloodWait` | Курсоры и ошибки | адаптация |
| `channel-scope/packages/server/src/services/rateLimiter.ts:68` | `invoke(request, clientId)` | Лимитер | как есть |
| `channel-scope/packages/server/src/services/recommendationsService.ts:97` | `getRecursiveRecommendationsLight` | Поиск каналов | как есть |
| `channel-scope/packages/server/src/services/refreshService.ts:13` | блокировка на канал | Локальный индекс | адаптация |
| `channel-scope/packages/server/src/services/refreshService.ts:75` | `channels.GetMessages` пачками по 100 | Чтение | адаптация |
| `channel-scope/packages/server/src/services/researchService.ts:90` | автоочередь загрузок `startDownloadAll` | Задачи | адаптация |
| `channel-scope/packages/server/src/services/scoring.ts:104` | `computeScore` | Аналитика | как есть |
| `channel-scope/packages/server/src/services/telegramUtils.ts:13` | `getChannelUsername` учитывает коллекционные usernames | Резолвер | адаптация |
| `channel-scope/packages/server/src/services/telegramUtils.ts:35` | `getChannelFullInfo`: описание, подписчики, `linkedChatId` | Резолвер | адаптация |
| `channel-scope/packages/server/src/services/universalSearchService.ts:264` | `enrichChannelById`: сначала `InputChannel` с accessHash, при отказе `getEntity` | Резолвер | адаптация |
| `channel-scope/packages/server/src/services/universalSearchService.ts:269` | комментарий о том, что accessHash нельзя переносить между клиентами | Кэш сущностей | адаптация |
| `channel-scope/packages/server/src/services/universalSearchService.ts:28` | `collectChannels`: поиск, затем рекомендации, затем хэштеги, с таймаутами | Поиск каналов | как есть |
| `channel-scope/packages/server/src/services/viewsSyncService.ts:6` | корзины hot / warm / cool / cold | Локальный индекс | адаптация |
| `channel-scope/packages/server/src/telegram/client/fetchHistorical.ts:21` | разбор аргументов `--channel` / `--limit` | CLI | адаптация |
| `channel-scope/packages/server/src/telegram/processors/processMediaClient.ts:25` | `isDcRedirectError`, покрыт тестом: файл живёт в другом дата-центре | Изображения и медиа | адаптация |
| `channel-scope/packages/server/src/telegram/processors/processMediaClient.ts:33` | `downloadWithRetry` с повторами | Изображения и медиа | адаптация |
| `channel-scope/packages/server/src/telegram/processors/processMediaClient.ts:63` | `extractMediaMetadata`: тип, размеры, длительность, `media_group_id` для альбомов | Изображения и медиа | адаптация |
| `channel-scope/packages/server/src/telegram/processors/processReactions.ts:8` | нормализация реакций, включая платные | Чтение | адаптация |
| `channel-scope/packages/server/src/web/middleware/auth.ts:16` | идея middleware; JWT из cookie заменяется bearer-токеном | Streamable HTTP | паттерн |
| `channel-scope/packages/server/src/web/routes/research.ts:131` | уже запускает `claude -p` с `--mcp-config`, таймаутом и разбором кода выхода | Запуск агента | адаптация |
| `channel-scope/packages/server/src/web/routes/research.ts:173` | уже запускает `claude -p --mcp-config` для AI-отчётов: готовый шаблон e2e-проверки шлюза | Claude Code | внешнее |
| `channel-scope/packages/server/src/web/server.ts:19` | каркас Express-приложения | Streamable HTTP | паттерн |
| `channel-scope/packages/server/src/web/server.ts:35` | раздача `/media` по HTTP: пригодится, если агент на другой машине | Изображения и медиа | адаптация |
| `helper/src/db/models/Comment.ts` | комментарии: автор, тред, медиа, реакции, `deletedAt` | Мост к архивам | адаптация |
| `helper/src/db/models/CommentReactionActor.ts` | кто и чем отреагировал, флаг `isOwner` | Мост к архивам | адаптация |
| `helper/src/scripts/generateSession.ts:12` | интерактивный вход через `client.start` и `input` | CLI | адаптация |
| `helper/src/scripts/generateSession.ts:34` | консольный вариант того же входа | Вход в аккаунт | как есть |
| `helper/src/telegram/bot/listenerBot.ts:17` | приём обновлений бота через polling | не используется: бота согласований нет (решение 23) | паттерн |
| `helper/src/telegram/bot/listenerBot.ts:49` | быстрый слой через Bot API: посты, комментарии, реакции (бот должен быть админом) | Наблюдатель | адаптация |
| `helper/src/telegram/client/backfillComments.ts:32` | lock-файл против второго процесса на той же сессии, снимается при Ctrl+C | stdio-прокладка | паттерн |
| `helper/src/telegram/client/gramClient.ts:21` | режим `STRING_SESSION` из env | Хранилище сессий | адаптация |
| `helper/src/telegram/client/gramClient.ts:44` | `connect` без интерактива и проверка `getMe` | Пул клиентов | как есть |
| `helper/src/telegram/client/gramClient.ts:6` | `peerCache` | Кэш сущностей | адаптация |
| `helper/src/telegram/client/gramClient.ts:75` | `resolvePeer` с кэшем InputPeer | Резолвер | адаптация |
| `helper/src/telegram/client/gramFatalRecovery.ts:9` | выход для перезапуска вместо попыток лечить сессию на месте | Страж зависаний | как есть |
| `helper/src/telegram/client/gramGate.ts:15` | `runExclusive`: одна полоса на сессию, дедлайн внутри полосы | Лимитер | как есть |
| `helper/src/telegram/client/gramStartup.ts:37` | старт клиента с дедлайном 2 минуты | Страж зависаний | как есть |
| `helper/src/telegram/discussion.ts:210` | `resolveDiscussionPeer`: группа обсуждений с кэшем и перепроверкой раз в час | Комментарии | адаптация |
| `helper/src/telegram/processors/processPost.ts:80` | «сохранить пост, потом действие» с защитой от повтора на edited-постах | Наблюдатель | адаптация |
| `helper/src/telegram/processors/reactionKey.ts:25` | единый ключ реакции: эмодзи, `custom:<id>`, `paid` | Чтение | адаптация |
| `helper/src/telegram/processors/sendRandomReaction.ts:16` | `SendReaction` с отдельной обработкой FLOOD_WAIT | Действия | адаптация |
| `helper/src/telegram/utils/chatId.ts:10` | перевод id между формами `-100…` (Bot API) и MTProto; нужен для ссылок `t.me/c/…` | Резолвер | адаптация |
| `helper/src/telegram/workers/ageTiers.ts:7` | лестница частоты: 15 минут для свежих постов, реже для старых, стоп после 30 дней | Наблюдатель | адаптация |
| `helper/src/telegram/workers/commentsAgeTiers.ts:32` | эффективный возраст: живой тред на старом посте не выпадает из расписания | Наблюдатель | адаптация |
| `helper/src/telegram/workers/commentsRefresher.ts:110` | `authorFromPeer`: человек, канал или аноним | Комментарии | адаптация |
| `helper/src/telegram/workers/commentsRefresher.ts:311` | `resolveRoot`: корень треда; он же нужен для ответа в комментариях | Комментарии | адаптация |
| `helper/src/telegram/workers/commentsRefresher.ts:405` | `refreshPostComments`: страницы `GetReplies` с паузой между ними | Комментарии | адаптация |
| `helper/src/telegram/workers/refreshShared.ts:50` | `runStage`: полоса, дедлайн, перезапуск при зависании | Страж зависаний | как есть |
| `helper/src/telegram/workers/refreshShared.ts:78` | `getFloodWaitSeconds` и кап: паузу дольше 5 минут не пережидаем, пропускаем | Лимитер | как есть |
| `helper/src/telegram/workers/refreshShared.ts:93` | классификация ошибок: `CHANNEL_INVALID`, `MSG_ID_INVALID`, `CHANNEL_PRIVATE` | Комментарии | адаптация |
| `helper/src/telegram/workers/statsRefresher.ts:172` | расхождение `replies.replies` будит перечитку треда | Наблюдатель | адаптация |
| `helper/src/telegram/workers/statsRefresher.ts:229` | watchdog: счёт пропущенных тиков и эскалация в error | Страж зависаний | как есть |

## Что не переносим

- **MCP как HTTP-прокси с логином по паролю.** `channel-scope/packages/mcp/src/index.ts:22` логинится в REST через `/api/auth/login` и держит cookie. В шлюзе ядро внутри процесса, к демону ходят с bearer-токеном.
- **`JSON.stringify(results, null, 2)` в каждом ответе.** Съедает контекст агента. Нужен компактный текстовый формат и курсоры.
- **Загрузка всего пайплайна ради одного канала.** `getChannelReport`, `compareChannels`, `saveChannelReport` в том же MCP тянут весь список и ищут канал на клиенте.
- **Вызовы клиента мимо лимитера.** `recommendationsService`, `forwardAnalysisService`, `refreshService`, `viewsSyncService` в channel-scope берут клиента напрямую: весь трафик идёт через первый аккаунт и без учёта FLOOD_WAIT.
- **Лимитер без дедлайна на вызов.** В `rateLimiter.ts` channel-scope зависший `invoke` держит воркер аккаунта вечно. Дедлайн, кап FLOOD_WAIT и перезапуск берём из helper.
- **Глобальный синглтон архиватора.** `archiveService` держит один прогресс на процесс.
- **`console.log` в сервисах.** В stdio-режиме любая строка в stdout ломает JSON-RPC.
- **`--dangerously-skip-permissions` в харнессе отчётов** (`routes/research.ts:173`). С инструментами записи так запускать нельзя; агента ограничивает токен шлюза.
- **Mongo как обязательная зависимость.** Для шлюза, который ставится одной командой, по умолчанию SQLite.
