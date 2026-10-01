# Архитектура tg-mcp

> Сгенерировано из данных интерактивной схемы (`docs/architecture.html`) 1 октября 2026. Дальше файл правится вручную.
>
> После решения 25 шлюз стал чистым MCP: слой «Автоматизация» убран, осталась только запись в два шага. Интерактивная схема (`architecture.html`) показывает прежний замысел и с кодом в этой части не совпадает.

Слои сверху вниз, как запрос агента проходит через шлюз. У каждого компонента указано, откуда брать код (`reference/` содержит снимок исходников) и что поменять. Режимы: **как есть** (переносим почти без правок), **адаптация** (берём логику, меняем зависимости), **паттерн** (берём подход, код новый), **новое** (пишем с нуля).

## Слои

| Слой | Зачем | Связь со слоем выше |
|---|---|---|
| Агенты | кто вызывает инструменты |  |
| Транспорт | как вызов попадает в шлюз | JSON-RPC 2.0: tools/list, tools/call |
| MCP-слой | один реестр на все транспорты | транспорт не знает об инструментах |
| Политики | что агенту можно | check(scope, tool, peer) |
| Запись | всё, что меняет что-то в Telegram | запрос с предпросмотром, выполнение после `tg_confirm` |
| Сервисы | логика поверх MTProto | вызов сервиса с разрешённым peer |
| Ядро tg-core | сессия, очередь, кэш | rateLimiter.invoke(request, accountId) |
| Хранилище | один файл, без внешних сервисов | слева: сессии, кэш, задачи, аудит, индекс · справа: MTProto, одно соединение на аккаунт |
| Telegram | дата-центры |  |

## Агенты

### Claude Code

`claude` · внешнее · внешнее · HTTP или stdio

Твой Claude Code, который висит на Telegram-боте. Бот остаётся каналом разговора с тобой, а шлюз даёт агенту отдельный user-аккаунт для чтения Telegram. Поддерживает stdio и Streamable HTTP, умеет resources и prompts, но опираемся только на tools.

**Откуда берём**

- `channel-scope/packages/server/src/web/routes/research.ts:173` (снимок: `reference/channel-scope/packages/server/src/web/routes/research.ts`): уже запускает `claude -p --mcp-config` для AI-отчётов: готовый шаблон e2e-проверки шлюза

### Codex CLI

`codex` · внешнее · внешнее · ~/.codex/config.toml

Подключается секцией `[mcp_servers.*]`, по stdio или по URL. У вызова инструмента есть таймаут, поэтому всё долгое в шлюзе оформлено задачами.

### OpenCode

`opencode` · внешнее · внешнее · opencode.json

Секция `mcp`: `type: local` с командой или `type: remote` с URL и заголовками. Работает с tools.

### Hermes Agent

`hermes` · внешнее · внешнее · ~/.hermes/config.yaml

Раздел `mcp_servers`, stdio или HTTP, умеет включать и выключать отдельные инструменты. Если MCP почему-то недоступен, может звать CLI `tg-mcp` через shell.

### Любой MCP-клиент

`anyclient` · внешнее · внешнее · Cursor, Gemini CLI, ...

Общий знаменатель всех клиентов: tools, плоские JSON-схемы, stdio или HTTP. Всё сверх этого (resources, prompts, elicitation, outputSchema) шлюз отдаёт как бонус, но ни один сценарий на нём не держится.

## Транспорт

### Streamable HTTP

`http` · пишем заново · паттерн · 127.0.0.1:7777/mcp · Bearer

Основной вход. Демон слушает localhost на лабораторной машине, все агенты подключаются по URL. Авторизация по bearer-токену: у каждого пользователя свой токен, по нему шлюз узнаёт, кто вызывает (решение 16).

**Откуда берём**

- `channel-scope/packages/server/src/web/server.ts:19` (снимок: `reference/channel-scope/packages/server/src/web/server.ts`): каркас Express-приложения
- `channel-scope/packages/server/src/web/middleware/auth.ts:16` (снимок: `reference/channel-scope/packages/server/src/web/middleware/auth.ts`): идея middleware; JWT из cookie заменяется bearer-токеном

**Что поменять.** По умолчанию слушать только 127.0.0.1 и проверять заголовок Origin.

### stdio-прокладка

`stdio` · channel-scope · паттерн · tg-mcp stdio

Для клиентов, которые умеют только запускать процесс. Если демон запущен, прокладка проксирует JSON-RPC в него. Если нет, поднимает ядро у себя, но сначала берёт файловую блокировку, чтобы вторая копия не открыла ту же сессию. На лабораторной машине второй вариант отпадает: сессии доступны только пользователю демона, и прокладка только проксирует (решение 17).

**Откуда берём**

- `channel-scope/packages/mcp/src/index.ts:725` (снимок: `reference/channel-scope/packages/mcp/src/index.ts`): StdioServerTransport и порядок старта: сначала connect, логин в фоне, чтобы клиент не ждал
- `helper/src/telegram/client/backfillComments.ts:32` (снимок: `reference/helper/src/telegram/client/backfillComments.ts`): lock-файл против второго процесса на той же сессии, снимается при Ctrl+C

**Что поменять.** Все логи только в stderr, включая логгер GramJS. Прокладка передаёт демону токен пользователя из `TG_MCP_TOKEN`.

**Риск.** Любой `console.log` в stdout ломает протокол.

### CLI

`cli` · helper · адаптация · login · serve · doctor · install

Команды для человека и для агентов без MCP. `login` проводит интерактивный вход (телефон, код, 2FA) и сохраняет зашифрованную сессию. `install` печатает конфиг под выбранный клиент. `search` и `read` повторяют инструменты для shell.

**Откуда берём**

- `helper/src/scripts/generateSession.ts:12` (снимок: `reference/helper/src/scripts/generateSession.ts`): интерактивный вход через `client.start` и `input`
- `channel-scope/packages/server/src/telegram/client/fetchHistorical.ts:21` (снимок: `reference/channel-scope/packages/server/src/telegram/client/fetchHistorical.ts`): разбор аргументов `--channel` / `--limit`

## MCP-слой

### Реестр инструментов

`registry` · channel-scope · паттерн · registerTool + zod

Инструменты объявлены один раз и не знают о транспорте. Схемы плоские, чтобы их одинаково понимали все клиенты. Аннотации `readOnlyHint` и `destructiveHint`, наборы включаются через `TG_MCP_TOOLSETS`.

**Откуда берём**

- `channel-scope/packages/mcp/src/index.ts:101` (снимок: `reference/channel-scope/packages/mcp/src/index.ts`): `McpServer` с полем `instructions`
- `channel-scope/packages/mcp/src/index.ts:117` (снимок: `reference/channel-scope/packages/mcp/src/index.ts`): `registerTool`, zod-схемы, `readOnlyHint`
- `channel-scope/packages/mcp/src/helpers.ts` (снимок: `reference/channel-scope/packages/mcp/src/helpers.ts`): чистые функции вынесены ради тестов, тесты на vitest

**Что поменять.** Имена `tg_*` в snake_case. В core не больше 10-12 инструментов.

### Форматтер ответов

`formatter` · пишем заново · новое · текст + structuredContent

Компактная выдача: одна строка заголовка на сообщение (чат, автор, дата, просмотры, ответы, ссылка t.me), текст обрезан до лимита, в конце `next_cursor`. Клиентам с outputSchema тот же ответ отдаётся ещё и структурой.

**Откуда берём**

- `channel-scope/packages/mcp/src/index.ts:504` (снимок: `reference/channel-scope/packages/mcp/src/index.ts`): текстовый отчёт в `getChannelReport` как отправная точка формата

**Что поменять.** Не повторять `JSON.stringify(results, null, 2)`. У ленты два режима: `brief` (1-2 строки на пост и счётчики) для сводок и `full` для чтения.

### Рецепты

`recipes` · пишем заново · новое · MCP prompts + skill

Готовые сценарии под твои кейсы: цены в барахолке, сводка по каналу, ответы в комментариях. Отдаются как MCP prompts (в Claude Code это слеш-команды) и как markdown-файл для AGENTS.md или skills, чтобы работать и там, где prompts не поддерживаются. В рецепте записано, в каком порядке звать инструменты и когда переходить на выгрузку в файл.

### Курсоры и ошибки

`paging` · channel-scope · адаптация · cursor · retry_after

Курсор упаковывает `offsetRate`, `offsetPeer` и `offsetId` в непрозрачную строку, агент просто передаёт её обратно. `FLOOD_WAIT`, `CHANNEL_PRIVATE` и похожие ошибки превращаются в `isError` с понятным текстом: что случилось и когда повторить.

**Откуда берём**

- `channel-scope/packages/server/src/services/globalSearchService.ts:10` (снимок: `reference/channel-scope/packages/server/src/services/globalSearchService.ts`): `PaginationState` и цикл пагинации
- `channel-scope/packages/server/src/services/rateLimiter.ts:383` (снимок: `reference/channel-scope/packages/server/src/services/rateLimiter.ts`): `parseFloodWait`

### Задачи

`jobs` · channel-scope · адаптация · job_id · tg_job_status

Всё, что дольше примерно 30 секунд (выгрузка истории за месяцы, индексация, глубокий обход рекомендаций), запускается задачей: инструмент сразу возвращает `job_id`, прогресс читается отдельным вызовом.

**Откуда берём**

- `channel-scope/packages/server/src/services/archiveService.ts:15` (снимок: `reference/channel-scope/packages/server/src/services/archiveService.ts`): модель `ArchiveProgress`, пауза и продолжение с `minId`
- `channel-scope/packages/server/src/services/researchService.ts:90` (снимок: `reference/channel-scope/packages/server/src/services/researchService.ts`): автоочередь загрузок `startDownloadAll`

**Что поменять.** Сейчас архиватор хранит один прогресс на процесс. Нужен менеджер задач с состоянием на каждую задачу.

## Политики

### Пользователи и доступ

`users` · пишем заново · новое · токен → пользователь → аккаунты

Добавлен вручную 2026-10-01 (решение 16), в `architecture.html` этого компонента нет. Шлюзом пользуются несколько человек. Bearer-токен определяет пользователя, пользователь видит только свои и общие аккаунты, а его запросы на запись, скоупы и аудит отделены от чужих. У инструментов, которые ходят в Telegram, необязательный параметр `account`. Запрос на запись подтверждает через своего агента тот пользователь, чьё это действие (решение 23). С одного аккаунта не больше одного ответа на пост, кто бы из пользователей ни просил (решение 18).

**Риск.** Пока оба пользователя работают под одним пользователем macOS, разделение защищает от ошибок, но не от агента, которого увели через prompt injection.

### Скоупы доступа

`scopes` · пишем заново · новое · public · joined · dm-allowlist

Что агенту можно читать. По умолчанию публичные каналы и группы плюс чаты, где аккаунт состоит. Личные переписки закрыты и открываются только списком. Поручение открывает ровно один диалог, с его собеседником, и только на время поручения. Есть denylist.

**Риск.** Агент видит всё, что видит аккаунт. Для агента нужен отдельный номер.

### Шлюз записи

`writegate` · пишем заново · новое · предпросмотр и tg_confirm

Инструменты записи выключены по умолчанию. Когда включены, сами ничего не отправляют: создают запрос, возвращают предпросмотр и `approval_id`. Действие выполняет шлюз после `tg_confirm`, который агент владельца вызывает после его согласия (решения 4 и 23; бота согласований нет). Агенту, запущенному без человека, `tg_confirm` недоступен. Здесь же лимиты: один ответ на пост с аккаунта, ответов и новых диалогов в день.

### Недоверенный контент

`envelope` · пишем заново · новое · untrusted envelope

Текст из чатов может содержать инструкции для агента. Каждый фрагмент в выдаче обёрнут в явные границы с указанием источника, а в `instructions` сервера сказано не выполнять команды из выдачи.

### Аудит

`audit` · пишем заново · новое · JSONL / SQLite

Каждый вызов: время, клиент, инструмент, аргументы, чат, сколько сообщений отдано, длительность, FLOOD_WAIT. Нужен и для настройки лимитов, и чтобы видеть, что агент читал.

## Запись

### Подтверждение записи

`writegate` · пишем заново · новое · tg_confirm · без бота и без очереди

Запрос на запись хранится в шлюзе полчаса: что сделать, с какого аккаунта, точный текст. Агент показывает предпросмотр владельцу и после согласия вызывает `tg_confirm`; текст можно заменить словами владельца, запрос можно отменить. Двойное подтверждение действие дважды не выполняет, чужой запрос подтвердить нельзя, прерванное рестартом действие не повторяется. Код: `src/writegate/`.

**Риск.** Шлюз не видит, спросил ли агент владельца перед `tg_confirm`. Защита: разрешение на `tg_confirm` в самом клиенте и лимиты шлюза. Подробно в решении 23.

### Убрано решением 25

Раньше в этом слое были Наблюдатель, Правила, Поручения, Запуск агента (runner), Входящие и Business-бот. Всё это делало шлюз агентом: он сам следил за чатами, сам будил модель и писал для неё задание. Теперь постоянные задачи ведёт агент владельца своими средствами, шлюз даёт ему инструменты чтения и записи. Код этих компонентов есть в истории репозитория до коммита `7e646d6`.

## Сервисы

### Резолвер

`resolve` · channel-scope · адаптация · @name · t.me/... · инвайты

Превращает всё, что даёт агент, в сущность: `@username`, `t.me/name/123`, `t.me/c/123/456`, `t.me/name/123?comment=45`, инвайт-ссылки. Отдаёт карточку: тип, участники, описание, группа обсуждений, состоит ли аккаунт.

**Откуда берём**

- `channel-scope/packages/server/src/services/telegramUtils.ts:13` (снимок: `reference/channel-scope/packages/server/src/services/telegramUtils.ts`): `getChannelUsername` учитывает коллекционные usernames
- `channel-scope/packages/server/src/services/telegramUtils.ts:35` (снимок: `reference/channel-scope/packages/server/src/services/telegramUtils.ts`): `getChannelFullInfo`: описание, подписчики, `linkedChatId`
- `channel-scope/packages/server/src/services/universalSearchService.ts:264` (снимок: `reference/channel-scope/packages/server/src/services/universalSearchService.ts`): `enrichChannelById`: сначала `InputChannel` с accessHash, при отказе `getEntity`
- `helper/src/telegram/client/gramClient.ts:75` (снимок: `reference/helper/src/telegram/client/gramClient.ts`): `resolvePeer` с кэшем InputPeer
- `helper/src/telegram/utils/chatId.ts:10` (снимок: `reference/helper/src/telegram/utils/chatId.ts`): перевод id между формами `-100…` (Bot API) и MTProto; нужен для ссылок `t.me/c/…`

**Что поменять.** Добавить разбор всех форм t.me-ссылок и `messages.checkChatInvite`.

### Поиск сообщений

`search` · channel-scope · адаптация · searchGlobal · search · searchPosts

Три режима: по всем чатам аккаунта (`messages.searchGlobal` с флагами каналов и групп), внутри одного чата (`messages.search` с фильтром по автору и датам), по хэштегу в публичных постах (`channels.searchPosts`).

**Откуда берём**

- `channel-scope/packages/server/src/services/globalSearchService.ts:64` (снимок: `reference/channel-scope/packages/server/src/services/globalSearchService.ts`): `searchGlobal` с готовой пагинацией
- `channel-scope/packages/server/src/services/globalSearchService.ts:144` (снимок: `reference/channel-scope/packages/server/src/services/globalSearchService.ts`): `searchByHashtag`

**Что поменять.** Сейчас обе функции выбрасывают сами сообщения и оставляют только каналы. Для агента нужны сообщения.

**Риск.** `searchGlobal` ищет только по чатам, где состоит аккаунт, а не по всему Telegram.

### Чтение

`history` · channel-scope · адаптация · getHistory · getMessages

Лента чата с курсором, окно по датам, фильтр по теме форума, сообщение по ссылке с контекстом до и после, пакетная дочитка по id (до 100 за вызов). Для сводок есть краткий режим: 1-2 строки на пост плюс просмотры, реакции и число комментариев.

**Откуда берём**

- `channel-scope/packages/server/src/services/forwardAnalysisService.ts:56` (снимок: `reference/channel-scope/packages/server/src/services/forwardAnalysisService.ts`): цикл `GetHistory` с `offsetId`
- `channel-scope/packages/server/src/services/archiveService.ts:180` (снимок: `reference/channel-scope/packages/server/src/services/archiveService.ts`): `iterMessages` с отсечкой `since`
- `channel-scope/packages/server/src/services/refreshService.ts:75` (снимок: `reference/channel-scope/packages/server/src/services/refreshService.ts`): `channels.GetMessages` пачками по 100
- `channel-scope/packages/server/src/telegram/processors/processReactions.ts:8` (снимок: `reference/channel-scope/packages/server/src/telegram/processors/processReactions.ts`): нормализация реакций, включая платные
- `helper/src/telegram/processors/reactionKey.ts:25` (снимок: `reference/helper/src/telegram/processors/reactionKey.ts`): единый ключ реакции: эмодзи, `custom:<id>`, `paid`

### Комментарии

`comments` · helper · адаптация · GetDiscussionMessage · GetReplies

Комментарии к посту живут в связанной группе обсуждений. В helper это уже сделано и работает на @stonksnws: группа находится через `GetFullChannel`, корень треда через `GetDiscussionMessage` (копия поста с `savedFromMsgId`), ветка читается страницами по 100 через `GetReplies`. Авторы различаются на людей, каналы и анонимов, у медиа комментариев сохраняется `groupedId` альбома, ошибки разложены по смыслу: комментарии выключены, аккаунт не состоит в закрытой группе, канал недоступен.

**Откуда берём**

- `helper/src/telegram/discussion.ts:210` (снимок: `reference/helper/src/telegram/discussion.ts`): `resolveDiscussionPeer`: группа обсуждений с кэшем и перепроверкой раз в час
- `helper/src/telegram/workers/commentsRefresher.ts:311` (снимок: `reference/helper/src/telegram/workers/commentsRefresher.ts`): `resolveRoot`: корень треда; он же нужен для ответа в комментариях
- `helper/src/telegram/workers/commentsRefresher.ts:405` (снимок: `reference/helper/src/telegram/workers/commentsRefresher.ts`): `refreshPostComments`: страницы `GetReplies` с паузой между ними
- `helper/src/telegram/workers/commentsRefresher.ts:110` (снимок: `reference/helper/src/telegram/workers/commentsRefresher.ts`): `authorFromPeer`: человек, канал или аноним
- `helper/src/telegram/workers/refreshShared.ts:93` (снимок: `reference/helper/src/telegram/workers/refreshShared.ts`): классификация ошибок: `CHANNEL_INVALID`, `MSG_ID_INVALID`, `CHANNEL_PRIVATE`

**Что поменять.** Сейчас код заточен под один канал из env и пишет в Mongo. Для шлюза нужна функция «прочитать тред любого канала», без записи в базу. Поиск по слову внутри обсуждения добавить через `messages.search` с `top_msg_id`.

### Темы форумов

`topics` · пишем заново · новое · getForumTopics · top_msg_id

Многие барахолки устроены как форум: темы «Продам», «Куплю», «Обмен». Сервис отдаёт список тем, а поиск, лента и выгрузка принимают параметр `topic`, чтобы не смешивать продажу с покупкой.

### Выгрузка в файл

`export` · channel-scope · адаптация · JSONL · CSV

Для аналитики по сотням сообщений: инструмент пишет файл на диск и возвращает путь, число строк, колонки и 5 примеров. Текст отдаётся как есть: цены и прочий смысл достаёт агент своим кодом (решение 25). Авторы хэшируются, телефоны маскируются. Долгая выгрузка идёт задачей и возвращает `job_id`.

**Откуда берём**

- `channel-scope/packages/server/src/db/export/export.ts:87` (снимок: `reference/channel-scope/packages/server/src/db/export/export.ts`): формат выгрузки поста и извлечение ссылок из entities
- `channel-scope/packages/server/src/services/archiveService.ts:180` (снимок: `reference/channel-scope/packages/server/src/services/archiveService.ts`): постраничный проход по истории с отсечкой по дате

**Что поменять.** Файл должен лежать там, где его видит агент. Если шлюз и агент на одной машине, это просто путь; иначе нужна общая папка.

### Поиск каналов

`discover` · channel-scope · как есть · contacts.search · рекомендации

Находит каналы по теме: поиск по имени, граф рекомендаций Telegram (обход в ширину до 3 уровней), хэштеги, источники репостов.

**Откуда берём**

- `channel-scope/packages/server/src/services/universalSearchService.ts:28` (снимок: `reference/channel-scope/packages/server/src/services/universalSearchService.ts`): `collectChannels`: поиск, затем рекомендации, затем хэштеги, с таймаутами
- `channel-scope/packages/server/src/services/recommendationsService.ts:97` (снимок: `reference/channel-scope/packages/server/src/services/recommendationsService.ts`): `getRecursiveRecommendationsLight`
- `channel-scope/packages/server/src/services/forwardAnalysisService.ts:21` (снимок: `reference/channel-scope/packages/server/src/services/forwardAnalysisService.ts`): `analyzeForwards`

**Что поменять.** Эти функции берут клиента напрямую. Перевести все вызовы на `rateLimiter.invoke`.

### Изображения и медиа

`media` · channel-scope · адаптация · фото · альбомы · размеры · превью видео

Скачивает картинки для анализа: фото объявлений, графики и скриншоты из постов. Умеет брать альбом целиком (объявление в барахолке обычно из 3-10 фото), выбирать размер (превью около 320 px для быстрого просмотра или полный для деталей) и для видео отдавать только кадр-превью. Файлы кладутся в `media/<чат>/<id>/`, в ответе пути. Клиентам, которые принимают картинки в ответе инструмента, их можно отдать сразу как image-контент, остальные открывают файл сами. Повторное скачивание берётся из кэша по id фото.

**Откуда берём**

- `channel-scope/packages/server/src/telegram/processors/processMediaClient.ts:63` (снимок: `reference/channel-scope/packages/server/src/telegram/processors/processMediaClient.ts`): `extractMediaMetadata`: тип, размеры, длительность, `media_group_id` для альбомов
- `channel-scope/packages/server/src/telegram/processors/processMediaClient.ts:33` (снимок: `reference/channel-scope/packages/server/src/telegram/processors/processMediaClient.ts`): `downloadWithRetry` с повторами
- `channel-scope/packages/server/src/telegram/processors/processMediaClient.ts:25` (снимок: `reference/channel-scope/packages/server/src/telegram/processors/processMediaClient.ts`): `isDcRedirectError`, покрыт тестом: файл живёт в другом дата-центре
- `channel-scope/packages/server/src/services/archiveService.ts:345` (снимок: `reference/channel-scope/packages/server/src/services/archiveService.ts`): пакетное скачивание в 3 потока с учётом постоянных ошибок
- `channel-scope/packages/server/src/web/server.ts:35` (снимок: `reference/channel-scope/packages/server/src/web/server.ts`): раздача `/media` по HTTP: пригодится, если агент на другой машине

**Что поменять.** Добавить выбор размера (параметр `thumb` у `downloadMedia` в GramJS), скачивание альбома по `grouped_id`, лимит размера файла и квоту на папку с очисткой старого.

**Риск.** Картинки дорогие для модели: каждая стоит сотни или тысячи токенов. По умолчанию превью, полный размер только по запросу.

### Локальный индекс

`index` · channel-scope · адаптация · по вызову → SQLite FTS5

Чат складывается в локальную базу по вызову `tg_index`: первая выгрузка задачей, повторный вызов дочитывает новое и перечитывает счётчики свежих сообщений. Сам шлюз индекс не обновляет. Поиск по индексу (`tg_local_search`, триграммы FTS5) мгновенный и не тратит лимиты Telegram.

**Откуда берём**

- `channel-scope/packages/server/src/services/archiveService.ts:180` (снимок: `reference/channel-scope/packages/server/src/services/archiveService.ts`): пакетная вставка и Set уже сохранённых id
- `channel-scope/packages/server/src/services/viewsSyncService.ts:6` (снимок: `reference/channel-scope/packages/server/src/services/viewsSyncService.ts`): корзины hot / warm / cool / cold
- `channel-scope/packages/server/src/services/refreshService.ts:13` (снимок: `reference/channel-scope/packages/server/src/services/refreshService.ts`): блокировка на канал

### Аналитика

`analytics` · channel-scope · только числа · охват · ERR · тренд

Числа по открытым счётчикам канала: подписчики и их изменение по снимкам, посты в неделю, средние и медианные просмотры, охват, вовлечённость, тренд, разбивка по неделям. Формулы взяты из channel-scope `analyzeChannel.ts`. Баллы, ниша, риск накрутки и оценка цены рекламы не перенесены: это выводы, их делает агент (решения 7 и 25).

**Откуда берём**

- `channel-scope/packages/server/src/services/analyzeChannel.ts:43` (снимок: `reference/channel-scope/packages/server/src/services/analyzeChannel.ts`): `analyzeChannel`
- `channel-scope/packages/server/src/services/scoring.ts:104` (снимок: `reference/channel-scope/packages/server/src/services/scoring.ts`): `computeScore`
- `channel-scope/packages/server/src/services/botDetection.ts:24` (снимок: `reference/channel-scope/packages/server/src/services/botDetection.ts`): `detectBotRisk`
- `channel-scope/packages/server/src/services/detectNiche.ts:53` (снимок: `reference/channel-scope/packages/server/src/services/detectNiche.ts`): `detectNiche`

### Действия

`write` · helper · адаптация · join · react · reply · send

Вступить в чат, поставить реакцию, ответить в комментариях, отправить сообщение. Для ответа под постом `messages.getDiscussionMessage` находит копию поста в группе обсуждений, дальше `sendMessage` ответом на неё. Пишет тот аккаунт, который подключён к шлюзу: отдельный аккаунт агента или твой личный, если ты подключил его сам. В канале, где аккаунт админ, можно писать от имени канала (`send_as`). В правиле и поручении аккаунт и режим отправителя указываются явно. Все вызовы проходят через шлюз записи и пишутся в аудит.

**Откуда берём**

- `helper/src/telegram/processors/sendRandomReaction.ts:16` (снимок: `reference/helper/src/telegram/processors/sendRandomReaction.ts`): `SendReaction` с отдельной обработкой FLOOD_WAIT
- `channel-scope/packages/server/src/services/autoEmojiService.ts:12` (снимок: `reference/channel-scope/packages/server/src/services/autoEmojiService.ts`): реакция с задержкой от назначенного аккаунта

**Риск.** Сообщения незнакомым людям самое опасное действие для аккаунта: после жалоб Telegram разрешает писать только взаимным контактам (`PEER_FLOOD`). Лимит новых диалогов в день и никаких рассылок.

## Ядро tg-core

### Хранилище сессий

`session` · channel-scope · адаптация · AES-256-GCM

StringSession хранится зашифрованной, ключ из `SESSION_ENCRYPTION_KEY`. Для самого простого режима сессию можно передать через `STRING_SESSION`, как в helper.

**Откуда берём**

- `channel-scope/packages/server/src/services/clientManager.ts:31` (снимок: `reference/channel-scope/packages/server/src/services/clientManager.ts`): `encrypt` / `decrypt` (строка 44)
- `channel-scope/packages/server/src/db/models/ClientSession.ts` (снимок: `reference/channel-scope/packages/server/src/db/models/ClientSession.ts`): схема хранения: sessionString + iv
- `helper/src/telegram/client/gramClient.ts:21` (снимок: `reference/helper/src/telegram/client/gramClient.ts`): режим `STRING_SESSION` из env

**Что поменять.** Mongoose заменить портом хранилища (SQLite или файл).

**Риск.** У шлюза должна быть своя сессия. `helper/AGENTS.md` прямо запрещает второй клиент на прод-`STRING_SESSION` helper. Файлы сессий и ключ шифрования лежат у отдельного пользователя macOS, агентам они недоступны (решение 17).

### Вход в аккаунт

`auth` · channel-scope · как есть · код · 2FA · миграция DC

Сценарий входа с ожиданием кода и пароля (таймаут 5 минут) и правильным порядком для миграции между DC: `client.start` без предварительного `connect`. Вызывается из `tg-mcp login`, а не из инструментов: агент не видит код подтверждения.

**Откуда берём**

- `channel-scope/packages/server/src/services/clientManager.ts:124` (снимок: `reference/channel-scope/packages/server/src/services/clientManager.ts`): `startAuth` с resolver-ами кода и пароля
- `helper/src/scripts/generateSession.ts:34` (снимок: `reference/helper/src/scripts/generateSession.ts`): консольный вариант того же входа

### Пул клиентов

`pool` · channel-scope · как есть · getClient · dedup · timeout

Одно подключение на аккаунт, параллельные попытки подключиться склеиваются в одну, `connect` ограничен 30 секундами. При старте проверка `getMe`, как в helper.

**Откуда берём**

- `channel-scope/packages/server/src/services/clientManager.ts:67` (снимок: `reference/channel-scope/packages/server/src/services/clientManager.ts`): `getClient` с `pendingConnections`
- `channel-scope/packages/server/src/services/clientManager.ts:86` (снимок: `reference/channel-scope/packages/server/src/services/clientManager.ts`): `connectClient` с `withTimeout`
- `helper/src/telegram/client/gramClient.ts:44` (снимок: `reference/helper/src/telegram/client/gramClient.ts`): `connect` без интерактива и проверка `getMe`

**Что поменять.** Логгер GramJS выключить или увести в stderr.

### Лимитер

`limiter` · channel-scope · как есть · очередь · FLOOD_WAIT · 60/мин

Самая ценная часть. Воркер на каждый аккаунт, общая очередь, 60 запросов в минуту и 500 мс между запросами. `FLOOD_WAIT` ставит аккаунт на паузу, запрос без привязки забирает другой аккаунт, до 3 повторов. `pickActiveClientId` выбирает наименее загруженный аккаунт.

**Откуда берём**

- `channel-scope/packages/server/src/services/rateLimiter.ts:68` (снимок: `reference/channel-scope/packages/server/src/services/rateLimiter.ts`): `invoke(request, clientId)`
- `channel-scope/packages/server/src/services/rateLimiter.ts:103` (снимок: `reference/channel-scope/packages/server/src/services/rateLimiter.ts`): `pickActiveClientId`
- `channel-scope/packages/server/src/services/rateLimiter.ts:287` (снимок: `reference/channel-scope/packages/server/src/services/rateLimiter.ts`): `executeRequest`: разбор FLOOD_WAIT и повтор
- `channel-scope/packages/server/src/services/rateLimiter.ts:148` (снимок: `reference/channel-scope/packages/server/src/services/rateLimiter.ts`): `_setClientResolver`: уже развязан с Mongo для тестов
- `helper/src/telegram/client/gramGate.ts:15` (снимок: `reference/helper/src/telegram/client/gramGate.ts`): `runExclusive`: одна полоса на сессию, дедлайн внутри полосы
- `helper/src/telegram/workers/refreshShared.ts:78` (снимок: `reference/helper/src/telegram/workers/refreshShared.ts`): `getFloodWaitSeconds` и кап: паузу дольше 5 минут не пережидаем, пропускаем

**Что поменять.** В лимитере channel-scope нет дедлайна на сам вызов: зависший `invoke` держит воркер аккаунта вечно. helper на этом простоял с 3 по 12 августа, поэтому дедлайн и кап FLOOD_WAIT берём оттуда. Ещё нужен бюджет ожидания (если пауза длиннее таймаута клиента, сразу ошибка с `retry_after`) и приоритет вызовов агента над фоновыми.

### Страж зависаний

`recovery` · helper · как есть · дедлайны · watchdog · перезапуск

GramJS при сбоях сети может повиснуть так, что промис не завершится никогда, а отменить такой запрос безопасно нельзя. В helper на это три ответа: дедлайн на каждый вызов, watchdog, который замечает залипшие тики, и выход процесса с кодом 1, после которого Docker поднимает его с чистого листа. Второй клиент внутри процесса не создаётся, чтобы не получить `AUTH_KEY_DUPLICATED`.

**Откуда берём**

- `helper/src/telegram/workers/refreshShared.ts:50` (снимок: `reference/helper/src/telegram/workers/refreshShared.ts`): `runStage`: полоса, дедлайн, перезапуск при зависании
- `helper/src/telegram/client/gramStartup.ts:37` (снимок: `reference/helper/src/telegram/client/gramStartup.ts`): старт клиента с дедлайном 2 минуты
- `helper/src/telegram/client/gramFatalRecovery.ts:9` (снимок: `reference/helper/src/telegram/client/gramFatalRecovery.ts`): выход для перезапуска вместо попыток лечить сессию на месте
- `helper/src/telegram/workers/statsRefresher.ts:229` (снимок: `reference/helper/src/telegram/workers/statsRefresher.ts`): watchdog: счёт пропущенных тиков и эскалация в error

**Что поменять.** Шлюз обязан жить под супервизором (Docker `restart: unless-stopped` или systemd `Restart=always`). Агенты при этом видят короткий обрыв: stdio-прокладка и HTTP-клиенты должны переподключаться.

### Кэш сущностей

`entities` · helper · адаптация · accessHash на аккаунт

accessHash привязан к сессии, поэтому кэш хранится отдельно для каждого аккаунта и переживает рестарт. Экономит `contacts.resolveUsername`, у которого жёсткие лимиты.

**Откуда берём**

- `helper/src/telegram/client/gramClient.ts:6` (снимок: `reference/helper/src/telegram/client/gramClient.ts`): `peerCache`
- `channel-scope/packages/server/src/services/universalSearchService.ts:269` (снимок: `reference/channel-scope/packages/server/src/services/universalSearchService.ts`): комментарий о том, что accessHash нельзя переносить между клиентами

**Что поменять.** Сделать кэш постоянным (SQLite) и ключевать по аккаунту.

### Кэш ответов

`rcache` · пишем заново · новое · TTL, минуты

Короткий кэш на результаты поиска и карточки каналов, чтобы агент, повторяющий тот же запрос, не тратил лимит.

## Хранилище

### SQLite

`sqlite` · пишем заново · новое · sessions · entities · jobs · audit · fts

Один файл без внешних сервисов, поэтому шлюз ставится одной командой. Таблицы: сессии, кэш сущностей, задачи, аудит, сообщения с FTS5.

**Что поменять.** channel-scope сейчас целиком на MongoDB; для шлюза Mongo остаётся только как опциональный мост.

### Мост к архивам

`bridge` · helper · адаптация · Mongo telegram_public

Опционально: читать то, что уже собрано, без запросов в Telegram. helper хранит по @stonksnws посты со статистикой, комментарии с авторами и удалениями и реакции конкретных людей на комментарии, включая твои. channel-scope хранит выкачанные каналы из исследований.

**Откуда берём**

- `helper/src/db/models/Comment.ts` (снимок: `reference/helper/src/db/models/Comment.ts`): комментарии: автор, тред, медиа, реакции, `deletedAt`
- `helper/src/db/models/CommentReactionActor.ts` (снимок: `reference/helper/src/db/models/CommentReactionActor.ts`): кто и чем отреагировал, флаг `isOwner`
- `channel-scope/packages/server/src/db/models/Post.ts` (снимок: `reference/channel-scope/packages/server/src/db/models/Post.ts`): схема поста с медиа, реакциями и viewsHistory

**Риск.** Данные о том, кто поставил реакцию, неполные: сбор начат 13 августа 2026, анонимные реакции без автора. Итоговые счётчики брать только из `Comment.reactions`.

## Telegram

### Telegram MTProto

`mtproto` · внешнее · внешнее · GramJS · DC

Все запросы уходят одним соединением на аккаунт. Основные методы: `messages.searchGlobal`, `messages.search`, `messages.getHistory`, `messages.getReplies`, `channels.getFullChannel`, `channels.searchPosts`, `channels.getChannelRecommendations`, `contacts.resolveUsername`, `contacts.search`.

