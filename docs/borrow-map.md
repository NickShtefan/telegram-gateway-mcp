# Карта заимствований

Какие приёмы шлюза взяты из соседних репозиториев. Файлы указаны путями внутри этих репозиториев, сверялись с их состоянием на 1 октября 2026 (channel-scope `9b8ea34`, helper `a19123a`, canary `ce03d0c`). Код не копировался дословно: брались логика и проверенные на проде решения, зависимости (MongoDB, Express) заменены.

## Что взято

| Часть шлюза | Откуда | Что именно |
|---|---|---|
| `core/clientPool.ts` | channel-scope `services/clientManager.ts` | одно подключение на аккаунт, склейка параллельных попыток, `connect` с таймаутом |
| | helper `telegram/client/gramClient.ts`, `gramStartup.ts` | подключение без интерактива, проверка `getMe`, выход при зависшем старте |
| `core/auth.ts` | channel-scope `clientManager.startAuth` | порядок входа: новый клиент с пустой сессией, `start()` без предварительного `connect()` ради миграции между дата-центрами |
| `core/crypto.ts` | channel-scope `clientManager.ts` | AES-256-GCM для сессий: ключ из секрета, свой iv на запись |
| `core/limiter.ts` | channel-scope `services/rateLimiter.ts` | очередь на аккаунт, 60 запросов в минуту, 500 мс между запросами, пауза на FLOOD_WAIT, повторы |
| | helper `telegram/client/gramGate.ts`, `workers/refreshShared.ts` | одна полоса на сессию, дедлайн внутри полосы, предел на FLOOD_WAIT |
| `core/recovery.ts` | helper `telegram/client/gramFatalRecovery.ts` | зависший вызов не лечится на месте: процесс выходит, супервизор поднимает его заново |
| `core/time.ts`, `core/errors.ts` | helper `workers/refreshShared.ts`, channel-scope `rateLimiter.ts` | дедлайн на промис, разбор FLOOD_WAIT, классификация ошибок Telegram |
| `core/chatId.ts` | helper `telegram/utils/chatId.ts` | перевод id между формой `-100…` и MTProto |
| `core/reactions.ts` | helper `telegram/processors/reactionKey.ts` | единый ключ реакции: эмодзи, `custom:<id>`, `paid` |
| `core/entities.ts` | channel-scope `services/universalSearchService.ts` | accessHash нельзя переносить между аккаунтами: кэш на аккаунт |
| `services/resolve.ts` | channel-scope `services/telegramUtils.ts`, `universalSearchService.ts` | карточка канала: описание, подписчики, группа обсуждений; коллекционные usernames |
| `services/history.ts` | channel-scope `forwardAnalysisService.ts`, `archiveService.ts`, `refreshService.ts` | циклы пагинации: `GetHistory` с `offsetId`, отсечка по дате, `GetMessages` пачками по 100 |
| `services/search.ts`, `mcp/cursor.ts` | channel-scope `services/globalSearchService.ts` | позиция глобального поиска: `offsetRate`, `offsetPeer`, `offsetId` |
| `services/comments.ts`, `services/write.ts` | helper `telegram/workers/commentsRefresher.ts`, `refreshShared.ts` | корень ветки через `GetDiscussionMessage`, страницы `GetReplies`, смысл ошибок; ответ под постом через тот же корень |
| `services/messages.ts`, `services/media.ts` | channel-scope `telegram/processors/processMediaClient.ts` | разбор медиа, повтор при ошибке «файл в другом дата-центре», кэш по наличию файла |
| | helper `commentsRefresher.ts` | автор сообщения: человек, канал или аноним |
| `services/discover.ts` | channel-scope `recommendationsService.ts`, `forwardAnalysisService.ts` | обход рекомендаций по уровням, подсчёт источников репостов по ленте |
| `services/stats.ts` | channel-scope `services/analyzeChannel.ts` | формулы: средние и медианные просмотры, охват, вовлечённость, разброс, тренд |
| `services/export.ts`, `services/localIndex.ts` | channel-scope `services/archiveService.ts` | постраничный проход ленты с отсечкой по дате, пакетная вставка |
| `mcp/tool.ts` | channel-scope `packages/mcp/src/index.ts` | `registerTool`, zod-схемы, `readOnlyHint`, поле `instructions` |

Идеи из сторонних проектов (подробно в [prior-art.md](prior-art.md)): возврат прерванных задач в очередь после рестарта (tgcli), закрытые по умолчанию служебные чаты (fast-mcp-telegram), блокировка одного процесса через сокет вместо PID-файла, формулировки ошибок для модели (chigwell/telegram-mcp).

## Что не переносилось

- **Вызовы клиента мимо лимитера.** В channel-scope часть сервисов (`recommendationsService`, `forwardAnalysisService`, `refreshService`, `viewsSyncService`) берёт клиента напрямую. В шлюзе единственная дверь в Telegram это `core/tg.ts`.
- **Лимитер без дедлайна на вызов.** В channel-scope зависший `invoke` держит очередь аккаунта вечно.
- **`JSON.stringify(results, null, 2)` в ответах инструментов.** Съедает контекст агента. В шлюзе компактный текст и курсоры.
- **MCP как HTTP-прокси с логином по паролю** (MCP channel-scope). В шлюзе ядро внутри процесса, к демону ходят с bearer-токеном.
- **Один прогресс архиватора на процесс.** В шлюзе состояние у каждой задачи своё и лежит в базе.
- **`console.log` в сервисах.** В stdio-режиме любая строка в stdout ломает JSON-RPC.
- **MongoDB как обязательная зависимость.** В шлюзе SQLite.
- **Оценки и «вердикты»** из channel-scope (`scoring.ts`, `detectNiche.ts`, `botDetection.ts`): баллы, ниша, риск накрутки. Это выводы, их делает агент (решение 7).
- **Слежение за постами и авто-реакции** из helper и запуск `claude -p` из channel-scope: шлюз ничего не делает без вызова (решение 25).
- **Bot API** (helper, canary): шлюз работает только через MTProto, ботов у него нет (решение 23).

