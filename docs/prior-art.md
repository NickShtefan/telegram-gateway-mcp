# Аналоги и готовые решения

> Исследование 1 октября 2026. Звёзды и даты взяты из GitHub API в этот день. Код читался через `gh api` на зафиксированных коммитах, ничего не клонировалось и не запускалось. Пометка «не проверено» значит, что утверждение взято из README или поисковой выдачи, а не из кода или первоисточника.

## Коротко

- **Готового решения под наши кейсы нет.** MCP-серверов для Telegram на user-аккаунте десятки. Ни один не сочетает демон с HTTP и bearer, чтение по умолчанию, запись с подтверждением человеком, комментарии из группы обсуждений, выгрузку в файл и поручения с состоянием. Кейсы 3 и 4 (мониторинг с согласованием в боте, переговоры с памятью) не закрывает никто.
- **Форкать нечего.** Ближайший по стеку `mcp-telegram/mcp-telegram` (TypeScript, GramJS, MIT): 182 инструмента, файл клиента на 6 тысяч строк, около половины вызовов MTProto идут мимо лимитера, FLOOD_WAIT пережидается внутри дедлайна. Форк свёлся бы к переписыванию. Строим по [plan.md](plan.md) и заимствуем решения, список ниже.
- **Для кейса 4 есть путь без userbot: Telegram Business-бот.** С Bot API 10.0 (8 мая 2026) Premium для него не нужен. Бот читает выбранные владельцем личные чаты и отвечает от его имени, но только в чат, где было входящее сообщение за последние 24 часа. Первым написать новому человеку он не может.
- **Имя `tg-mcp` в npm занято:** пакет на mtcute, v1.3.0, опубликован в июне 2026, репозиторий не указан. Команды в [connect.md](connect.md) переведены на установку из клона (решение 14). На GitHub есть ещё `Cr0me1ve/tg-mcp` (Codex-плагин «спросить человека»).
- **Правила Telegram про ИИ** формально запрещают использовать данные платформы для работы ИИ без согласия участников чата. Это касается любого шлюза такого типа, включая наш. Подробно в разделе «Правила Telegram».

## MCP-серверы на user-аккаунте

| Репозиторий | ★ | Push | Стек | Транспорт | Чем интересен |
|---|---|---|---|---|---|
| [chigwell/telegram-mcp](https://github.com/chigwell/telegram-mcp) | 1732 | 2026-09-30 | Python, Telethon | stdio, HTTP без авторизации | Самый популярный. 131 инструмент, режим read-only, allowlist чатов, очистка текста, дедлайн 55 с на вызов, блокировка сессии через flock. Комментариев из группы обсуждений нет. В PyPI под именем `telegram-mcp` лежит чужой пакет. |
| [chaindead/telegram-mcp](https://github.com/chaindead/telegram-mcp) | 349 | 2026-05-28 | Go, gotd | stdio | 5 инструментов `tg_*`, «отправка» сохраняет черновик. Новое соединение на каждый вызов. |
| [dryeab/mcp-telegram](https://github.com/dryeab/mcp-telegram) | 252 | 2025-06-15 | Python, Telethon | stdio | Заброшен. |
| [sparfenyuk/mcp-telegram](https://github.com/sparfenyuk/mcp-telegram) | 189 | 2025-03-14 | Python, Telethon | stdio | Заброшен, только чтение. |
| [leshchenko1979/fast-mcp-telegram](https://github.com/leshchenko1979/fast-mcp-telegram) | 48 | 2026-09-26 | Python, Telethon | HTTP, bearer на аккаунт | 8 инструментов, лучшая семантика тредов (`thread_scope`), ACL с `blocked_peers`. Телеметрия включена по умолчанию; у `invoke_mtproto` флаг `allow_dangerous`, который ставит сама модель. |
| [mcp-telegram/mcp-telegram](https://github.com/mcp-telegram/mcp-telegram) | 43 | 2026-09-30 | TypeScript, GramJS | stdio, демон через unix-сокет | Наш стек. Комментарии и темы форумов есть, демон с блокировкой, около 60 файлов тестов. Нет HTTP, режима read-only, подтверждений, пометки чужого текста. |
| [kfastov/tgcli](https://github.com/kfastov/tgcli) | 42 | 2026-09-20 | JS, mtcute | HTTP, `/mcp` без авторизации | Фоновая синхронизация в SQLite FTS5, очередь задач синхронизации, параметр `source=archive\|live\|both`. |
| [beautyfree/mcp-telegram](https://github.com/beautyfree/mcp-telegram) | 30 | 2026-05-18 | TypeScript, GramJS | stdio | 102 инструмента, несколько аккаунтов, тестов нет. |
| [tolboy/telegram-mcp-tdlib](https://github.com/tolboy/telegram-mcp-tdlib) | 9 | 2026-09-29 | Kotlin, TDLib | stdio, HTTP с API-ключами | Лучшая модель безопасности: запись по умолчанию скрыта, одобрение человеком вне хода модели, ключи идемпотентности, пометка чужого текста, возобновляемый экспорт. Создан в июле 2026. |
| [matskevich/tg-mcp-guarded](https://github.com/matskevich/tg-mcp-guarded) | 9 | 2026-09-29 | Python, Telethon | два stdio-сервера | Двухшаговая запись с `approval_code`, дневные квоты, circuit breaker. По умолчанию два процесса на одной сессии (`TG_SESSION_LOCK_MODE=shared`). |
| [lexfrei/mcp-tg](https://github.com/lexfrei/mcp-tg) | 8 | 2026-09-30 | Go, gotd | stdio, HTTP | Вход через elicitation, сессия в keychain, подписка на новые сообщения через resources. |
| [safra36/telegram-mcp-server](https://github.com/safra36/telegram-mcp-server) | 2 | 2026-05-22 | TypeScript, mtcute | stdio, HTTP с обязательным bearer | На бумаге конфиг ближе всех к нашему, но 6 коммитов и нет тестов. |

Рядом, но не MCP-серверы: [popstas/telegram-download-chat](https://github.com/popstas/telegram-download-chat) (218 ★, выгрузка чата с комментариями и разбивкой по темам), [iyear/tdl](https://github.com/iyear/tdl) и [groupultra/telegram-search](https://github.com/groupultra/telegram-search) (оба AGPL, код не копировать).

Официального MCP-сервера у Telegram нет. У Anthropic есть только Telegram-плагин для channels в Claude Code, он на Bot API (раздел «Мосты»). Хостинговые сервисы с userbot (облачная версия mcp-telegram, демо fast-mcp-telegram и другие) держат сессию на своих серверах, нам это не подходит.

## Сверка с нашим дизайном

Шесть проектов, прочитанных по коду. C: chigwell, G: chaindead, M: mcp-telegram, F: fast-mcp-telegram, T: tgcli, Q: tg-mcp-guarded. «lib» значит, что работа отдана библиотеке.

| Пункт дизайна | C | G | M | F | T | Q | Мы |
|---|---|---|---|---|---|---|---|
| Один процесс на сессию | да (flock) | нет | да (PID-файл) | нет | частично | нет | да |
| Демон + HTTP с bearer | HTTP без авторизации | нет | демон без HTTP | да | HTTP без авторизации | нет | да |
| Лимитер на все вызовы MTProto | нет | нет | частично | нет | lib | частично | да |
| Дедлайн на вызов | 55 с | нет | 28 с | не нашли | не нашли | 30 с | да |
| FLOOD_WAIT выше порога: ошибка с `retry_after` | текстом | нет | нет, спит | lib | lib | нет, спит | да |
| Зависание: выход и перезапуск | нет | нет | пересоздаёт клиента | нет | нет | нет | да |
| Не больше 10-12 инструментов в основном наборе | 131 | 5 | 182 | 8 | 38 | 61 | да |
| Компактный текст вместо JSON | частично | нет | да | нет | нет | нет | да |
| Пометка чужого текста | частично | нет | нет | нет | нет | нет | да |
| Запись выключена по умолчанию | нет | только черновики | нет | нет | нет | да | да |
| Подтверждение записи | нет | нет | частично | флаг от модели | нет | да, но подтверждает сам агент | да, через человека |
| Комментарии из группы обсуждений | нет | нет | да | да | нет | нет | да |
| Темы форумов | с ошибкой | нет | да | да | да | нет | да |
| Выгрузка JSONL/CSV | JSON | нет | нет | нет | в SQLite | частично | да |
| Долгое как задачи | частично | нет | нет | нет | да | частично | да |
| Тесты и CI | да | нет | да | да | частично | да | да |

## Что взять

1. **Жизненный цикл GramJS** из mcp-telegram:
   - перенаправить `console.log` в stderr до импортов ([index.ts#L3-L7](https://github.com/mcp-telegram/mcp-telegram/blob/2edac09/src/index.ts#L3-L7));
   - проверять `client.connected === false`, а не свой флаг ([telegram-client.ts#L444-L491](https://github.com/mcp-telegram/mcp-telegram/blob/2edac09/src/telegram-client.ts#L444-L491));
   - закрывать клиента через `destroy()`, а не `disconnect()`, иначе остаётся зомби-цикл обновлений ([#L536-L552](https://github.com/mcp-telegram/mcp-telegram/blob/2edac09/src/telegram-client.ts#L536-L552));
   - разбирать обе формы FloodWaitError ([rate-limiter.ts#L150-L167](https://github.com/mcp-telegram/mcp-telegram/blob/2edac09/src/rate-limiter.ts#L150-L167));
   - проверку пути `isSafeAbsolutePath` и длины сообщения `checkMessageLength` ([tools/shared.ts#L50-L121](https://github.com/mcp-telegram/mcp-telegram/blob/2edac09/src/tools/shared.ts#L50-L121));
   - named pipe для stdio-прокладки на Windows ([lock.ts#L30-L42](https://github.com/mcp-telegram/mcp-telegram/blob/2edac09/src/lock.ts#L30-L42)).
2. **Блокировку сессии** из chigwell: ключ от хэша самой сессии, а не от имени аккаунта, grace-период, PID владельца в тексте ошибки ([singleton.py#L99-L208](https://github.com/chigwell/telegram-mcp/blob/81ad14b/telegram_mcp/singleton.py#L99-L208)). В Node нет встроенного flock, PID-файл уязвим к переиспользованию PID. Вариант: эксклюзивный bind unix-сокета как мьютекс, тот же сокет сразу служит каналом для stdio-прокладки.
3. **Формулировки ошибок для модели** из chigwell: при FLOOD_WAIT «не повторяй», при таймауте «запись могла уже пройти» ([runtime.py#L165-L227](https://github.com/chigwell/telegram-mcp/blob/81ad14b/telegram_mcp/runtime.py#L165-L227)). Оттуда же: падать на старте, если в списке инструментов опечатка, а не молча сужать набор.
4. **Код подтверждения** из tg-mcp-guarded: привязан к sha256 канонических аргументов, живёт ограниченное время, одноразовый, исполняется не раньше минимальной паузы ([mcp_server_actions.py#L569-L650](https://github.com/matskevich/tg-mcp-guarded/blob/9f8141d/tganalytics/mcp_server_actions.py#L569-L650)). Отличие у нас: подтверждает человек через бота, а не сам агент.
5. **Защиту записи на уровне TL-методов**, но в обратной логике: allowlist методов чтения. В guarded классификация идёт по префиксам, и `messages.readHistory` (ставит отметку о прочтении) считается чтением. У нас `readHistory`, нажатие inline-кнопок и `joinChannel` считаются записью.
6. **Из tolboy:** инструменты записи скрыты, а не просто запрещены; ключ идемпотентности и исход `UNKNOWN`, если непонятно, ушло ли сообщение; возобновляемый экспорт с контрольными точками.
7. **Из fast-mcp-telegram:** служебные чаты закрыты по умолчанию (777000 с кодами входа, @BotFather, @SpamBot), разбор тредов через `GetDiscussionMessage` и `thread_scope` ([utils/discussion.py](https://github.com/leshchenko1979/fast-mcp-telegram/blob/c3779a2/src/utils/discussion.py#L11-L61)).
8. **Из tgcli:** очередь задач в SQLite с возвратом задачи в очередь при остановке ([message-sync-service.js#L2760-L2790](https://github.com/kfastov/tgcli/blob/1df3e67/message-sync-service.js#L2760-L2790)) и выбор источника `archive|live|both` для локального индекса.
9. **Из chaindead:** черновик вместо отправки как самый безопасный режим записи.

Все перечисленные проекты под MIT, Apache-2.0 или BSD. Код из AGPL и GPL проектов не копируем.

## Чего не повторять

- Новое MTProto-соединение на каждый вызов (G).
- Ожидание FLOOD_WAIT внутри дедлайна вызова: долгая пауза выглядит как мёртвое соединение (M, Q).
- Вызовы MTProto мимо лимитера (M).
- Выбор чата по частичному совпадению названия, особенно для записи (M).
- Запись файлов по произвольному пути от агента (M).
- Фильтр темы форума и `minDate` на клиенте после `limit` (C, M).
- HTTP без авторизации (C, T).
- Одна сессия на два процесса (Q, опционально C).
- Телеметрия по умолчанию (F), секреты и части токенов в логах (G, F).
- «Опасный» флаг, который выставляет сама модель (F).

## Мосты агент ↔ Telegram

**Channels в Claude Code** ([документация](https://code.claude.com/docs/en/channels)) это механизм, которым MCP-сервер присылает события в открытую сессию Claude Code. Сервер объявляет возможность `claude/channel` и шлёт уведомления, ответы идут обычным инструментом. Ограничения:

- research preview, нужна авторизация через claude.ai или Console;
- сервер должен быть stdio-подпроцессом Claude Code;
- без флага разрешены только плагины из allowlist Anthropic, свой канал запускается через `--dangerously-load-development-channels`;
- события приходят только в открытую сессию, подтверждения доставки нет;
- у Codex и OpenCode такого механизма нет.

Есть relay разрешений, но он одобряет только собственные инструменты Claude Code (Bash, Edit и так далее), не наши черновики.

Для нас это необязательный адаптер к интерактивному Claude Code (тонкая stdio-прокладка к демону), а не основной путь. Основной путь остаётся запуск агента из правила.

**Официальный Telegram-плагин** ([claude-plugins-official/external_plugins/telegram](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram), Apache-2.0) работает на Bot API (grammY). Он пересылает личные сообщения боту в сессию и умеет `reply`, `react`, `edit_message`, `download_attachment`. Истории и поиска нет. Доступ через код привязки и allowlist, разрешения подтверждаются inline-кнопками.

**Остальные мосты** тоже на Bot API и произвольные каналы не читают: [OpenClaw](https://github.com/openclaw/openclaw) (391 тыс. ★), [Hermes Agent](https://github.com/NousResearch/hermes-agent) (250 тыс. ★), [cc-connect](https://github.com/chenhg5/cc-connect) (15,7 тыс. ★, Claude Code, Codex, OpenCode и другие), [opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot), [takopi](https://github.com/banteg/takopi). Userbot-плагины к OpenClaw на GramJS есть, но по 2-3 звезды. Общий мост «поговорить с агентом из Telegram» строить не нужно.

**Бот-мост владельца.** На лабораторной машине, где будет работать шлюз, Claude Code подключён к Telegram официальным плагином channels (v0.0.7, два экземпляра для двух профилей), у Hermes свой Telegram-шлюз. Доставлять события в живую сессию Claude Code через channels технически можно, но свой канал шлюза потребует флага `--dangerously-load-development-channels` (вопрос 2 в [open-questions.md](open-questions.md)).

**Полезное для запуска агента без интерфейса** (из справки CLI, не проверено руками):

- `claude -p --permission-prompt-tool <инструмент>` отдаёт запросы разрешений нашему MCP-инструменту;
- `--max-budget-usd`, `--max-turns` и `--strict-mcp-config` ограничивают запуск;
- `--json-schema` даёт черновик в заданной структуре;
- у Codex `codex exec` по умолчанию работает в read-only песочнице, есть `--output-schema` и `--json`.

## Согласование через бота: готовые паттерны

Все зрелые проекты делают одинаково: inline-кнопка с id запроса, проверка `from.id` отправителя по allowlist, правка карточки после ответа. Что взять:

- официальный плагин: проверка по `from.id`, а не по `chat.id`; «See more» для длинного превью; защита от второго поллера;
- [AndyShaman/telegram-business-bridge](https://github.com/AndyShaman/telegram-business-bridge): кнопки Send и Edit, редактор черновика в Mini App, старый черновик помечается «Superseded», когда появился новый;
- [Cr0me1ve/tg-mcp](https://github.com/Cr0me1ve/tg-mcp): вопросы переживают рестарт, единственный поллер выбирается через файловую аренду, при нескольких открытых вопросах ответ должен быть Reply на нужный;
- OpenClaw: список тех, кто может одобрять, и истечение запроса через 30 минут;
- Hermes: если кнопки не отправились, вопрос уходит текстом.

У бот-токена может быть только один получатель обновлений (ошибка 409 при втором `getUpdates`). Боту согласований нужен свой токен, отдельный от бот-моста и от прод-бота helper.

## Telegram Business для кейса 4

Владелец в настройках Telegram (Business, Chatbots) подключает бота и выбирает, какие личные чаты ему доступны ([Bot API](https://core.telegram.org/bots/api#businessbotrights)). Бот получает новые, изменённые и удалённые сообщения этих чатов и отвечает от имени владельца. С Bot API 10.0 (8 мая 2026) Premium не нужен, там же появился `getUserPersonalChatMessages`.

Ограничения:

- только личные чаты: группы, каналы и комментарии недоступны;
- истории до подключения нет, переписку надо копить самим (`getUserPersonalChatMessages` может это смягчить, не проверено);
- ответ возможен только в чат, где было входящее сообщение за последние 24 часа, поэтому первым написать продавцу или напомнить о себе после суток молчания бот не может;
- по правилам для Business-ботов нельзя передавать содержимое сообщений в сторонние API без разрешения пользователя.

Плюс: нет риска для аккаунта, как у userbot, и владелец отключает бота одним переключателем. Готовый образец: telegram-business-bridge (демон на aiogram, SQLite с FTS5, отдельный MCP-сервер с черновиками, у MCP-процесса нет токена бота, чужой текст обёрнут маркерами).

Возможная схема для кейса 4: первое сообщение уходит с личного аккаунта владельца (он отправляет его сам или подтверждает черновик), дальше переписку ведёт Business-бот от его имени. Бот видит только личные чаты владельца, поэтому писать первым с отдельного аккаунта агента в этой схеме нельзя: ответ продавца придёт на тот аккаунт, а не владельцу. Это вопрос к владельцу, см. [open-questions.md](open-questions.md).

## Источники данных без своей сессии

| Источник | Что даёт | Ограничения |
|---|---|---|
| [TGStat API](https://api.tgstat.ru/docs/ru/start/intro.html) | статистика каналов, поиск постов и упоминаний, вебхуки на новые посты и слова | платный; тарифы не проверены; есть ли комментарии, не проверено |
| [Telemetr API](https://api.tlmtr.io/docs/intro/overview) | индекс каналов и постов | поиск постов только на дорогих тарифах (не проверено) |
| `t.me/s/<канал>` | 20 постов на страницу, `?before=<id>`, поиск `?q=`, просмотры и реакции | только публичные каналы, без комментариев |
| виджет обсуждения `t.me/<канал>/<id>?embed=1&discussion=1` | комментарии в HTML без входа | проверено на одном канале; пагинация и лимиты не проверены |
| Apify | скраперы постов без входа, дёшево | скрапер комментариев требует строку сессии, нам нельзя |
| `channels.searchPosts` | поиск по всем публичным постам Telegram | дневная квота только с Premium, дальше поиск за Stars (`allow_paid_stars`) |

Для мониторинга чужих публичных каналов TGStat Callback может заменить опрос через сессию. `t.me/s` и виджет годятся как запасной путь, когда сессия на паузе FLOOD_WAIT.

## Правила Telegram

- **Content Licensing and AI Scraping** ([telegram.org/tos/content-licensing](https://telegram.org/tos/content-licensing)) запрещает сбор и использование данных платформы для обучения и работы ИИ. Исключение: явное согласие всех участников, ограниченное конкретным чатом. Дословно: «consent obtained in one context is non-transferable». Даты на странице нет. Под это формально попадает любой шлюз, который отдаёт чужие каналы модели, включая наш и все аналоги выше.
- **API Terms** ([core.telegram.org/api/terms](https://core.telegram.org/api/terms)): нельзя действовать от имени пользователя без его ведома и согласия.
- **Bot Developer Terms**: запрещён сбор публичных групп и каналов для датасетов и ИИ-продуктов. Для Business-ботов отдельно запрещена передача сообщений в сторонние API без разрешения пользователя.
- **Спам-санкции**: после жалоб аккаунт может писать только своим контактам. Есть заморозка аккаунта (только чтение, апелляция через @SpamBot), её видно через `help.getAppConfig` в полях `freeze_since_date`, `freeze_until_date`, `freeze_appeal_url` ([core.telegram.org/api/config](https://core.telegram.org/api/config)).
- **Платные сообщения**: Premium-пользователи могут брать Stars за сообщения от незнакомых (`ALLOW_PAYMENT_REQUIRED`, параметр `allow_paid_stars`). Глобальный поиск по публичным постам сверх квоты тоже стоит Stars.
- **«Нейрокомментинг»** (коммерческие ИИ-комментарии под чужими постами с фермами аккаунтов, прогревом и имитацией набора) это ровно то, что Telegram считает спамом. Их «анти-бан» приёмы не переносим.

## Что это меняет у нас

Предложения; решает владелец.

1. **Имя пакета.** `tg-mcp` в npm занят. Решено: приватный репозиторий `telegram-gateway-mcp`, без публикации (решение 14).
2. **Кейс 4 через Business-бота.** Решено: на выбор в каждом поручении (решение 13).
3. **Статус заморозки** в `tg_status` и `tg-mcp doctor`: читать `freeze_*` из `help.getAppConfig` и сообщать владельцу.
4. **Stars никогда не тратятся автоматически:** `allow_paid_stars` шлюз не выставляет, `ALLOW_PAYMENT_REQUIRED` переводит поручение в «вопрос тебе».
5. **Служебные чаты закрыты по умолчанию:** 777000, @BotFather, @SpamBot в denylist скоупов.
6. **Блокировка сессии в Node:** эксклюзивный unix-сокет вместо PID-файла (пункт 2 в «Что взять»).
7. **Запуск агента:** одобрения из `claude -p` через `--permission-prompt-tool` в шлюз, бюджет через `--max-budget-usd`.
8. **Channels** как необязательный адаптер для интерактивного Claude Code в фазе 4.
9. **Риск по правилам Telegram про ИИ** добавлен в [risks.md](risks.md).

## Не проверено

- Безопасно ли держать одну сессию в двух процессах с одного IP (допущение chigwell для режима `shared`).
- Пороги встроенного ожидания FLOOD_WAIT в mtcute.
- Доля вызовов мимо лимитера в mcp-telegram (оценка эвристикой по коду).
- Флаги CLI Claude Code для запуска без интерфейса, кроме `--permission-prompt-tool`.
- Тарифы TGStat и Telemetr, наличие комментариев в TGStat.
- Пагинация виджета обсуждения на `t.me`.
- Актуальность `PEER_FLOOD`: в текущем списке ошибок `messages.sendMessage` его не нашли, библиотеки его по-прежнему ловят.
- Даёт ли `getUserPersonalChatMessages` историю личного чата до подключения Business-бота.
