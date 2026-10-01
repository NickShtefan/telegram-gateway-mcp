import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestGateway, type TestClient, type TestGateway } from '../../__tests__/helpers/gateway.js';
import { rawChannel, rawMessage, rawUser } from '../../__tests__/helpers/fakeTg.js';
import { buildArgv, runAgent, runRunner, splitCommand } from '../../cli/runner.js';
import { GatewayError } from '../../core/errors.js';
import { createLogger } from '../../core/log.js';
import { sentMessageId } from '../../services/write.js';
import { startHttpServer } from '../../transport/http.js';
import { HttpBotApi } from '../botApi.js';
import { inQuietHours, isAdvertisement, normalizeRuleConfig } from '../rules.js';

const silent = createLogger('test', { level: 'silent' });
const CHANNEL = 500;
const GROUP = 600;
const NICK_TG = '111';
const PARTNER_TG = '222';
const ALL = ['core', 'automate', 'write'];

let gw: TestGateway;
let nick: TestClient;
let clock: number;

const channel = (extra: Record<string, unknown> = {}) => rawChannel(CHANNEL, { username: 'stonksnws', title: 'Stonks', ...extra });
const group = () => rawChannel(GROUP, { broadcast: false, megagroup: true, title: 'Stonks chat' });
const post = (id: number, text = `Пост ${id}`, extra: Record<string, unknown> = {}) => rawMessage(CHANNEL, id, { post: true, message: text, ...extra });

beforeEach(async () => {
  clock = Date.UTC(2026, 9, 1, 12, 0, 0);
  gw = makeTestGateway({ now: () => clock });
  gw.config.toolsets = ALL;
  nick = await gw.client('nick', ALL);
  gw.tg.on('contacts.ResolveUsername', () => ({ peer: { className: 'PeerChannel', channelId: BigInt(CHANNEL) }, chats: [channel()], users: [] }));
  gw.tg.on('messages.GetDiscussionMessage', (req: { msgId: number }) => ({
    messages: [rawMessage(GROUP, 3000 + req.msgId, { fwdFrom: { savedFromMsgId: req.msgId } })],
    chats: [group()],
    users: [],
  }));
  gw.tg.on('messages.SendMessage', () => ({ className: 'Updates', updates: [{ className: 'UpdateMessageID', id: 7777 }] }));
});

afterEach(async () => {
  await nick.close();
  gw.cleanup();
  vi.useRealTimers();
});

const approvals = () => gw.services.automation.approvals;
const store = () => gw.services.automation.store;

describe('запись только через согласование', () => {
  it('tg_reply ничего не отправляет, пока человек не нажал «Отправить»', async () => {
    const reply = await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'Согласен, рынок перегрет.' });
    expect(reply.isError).toBe(false);
    expect(reply.text).toContain('Nothing has been done in Telegram yet');
    const approvalId = reply.text.match(/approval_id (ap_[0-9a-f]+)/)![1]!;
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);

    const card = gw.bot.lastCard();
    expect(card.chatId).toBe(NICK_TG);
    expect(card.text).toContain(`Согласование ${approvalId}`);
    expect(card.text).toContain('Ответ в комментариях к посту https://t.me/stonksnws/10');
    expect(card.text).toContain('Аккаунт: agent (@agent_acc)');
    expect(card.text).toContain('Согласен, рынок перегрет.');
    expect(card.buttons.flat().map(b => b.text)).toEqual(['✅ Отправить', '✏️ Изменить', '🚫 Пропустить']);

    await approvals().handleUpdate(gw.bot.press(card, 'Отправить', NICK_TG));
    const sent = gw.tg.last('messages.SendMessage').request;
    expect(sent.message).toBe('Согласен, рынок перегрет.');
    expect(sent.peer.className).toBe('InputPeerChannel');
    expect(String(sent.peer.channelId)).toBe(String(GROUP));
    expect(sent.replyTo.replyToMsgId).toBe(3010);
    expect(gw.tg.last('messages.SendMessage').options).toMatchObject({ write: true });
    expect(gw.bot.edits.at(-1)!.text).toContain('✅ Отправлено: https://t.me/stonksnws/10?comment=7777');

    const inbox = await nick.call('tg_inbox');
    expect(inbox.text).toContain(`approval | ${approvalId} | reply executed | in @stonksnws | Отправлено: https://t.me/stonksnws/10?comment=7777`);
  });

  it('чужое нажатие ничего не меняет', async () => {
    await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'текст' });
    const card = gw.bot.lastCard();
    await approvals().handleUpdate(gw.bot.press(card, 'Отправить', PARTNER_TG));
    await approvals().handleUpdate(gw.bot.press(card, 'Отправить', '999999'));
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect(gw.bot.answers.at(-1)!.text).toBe('Это согласование не для вас.');
  });

  it('двойное нажатие отправляет один раз', async () => {
    await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'текст' });
    const card = gw.bot.lastCard();
    await Promise.all([approvals().handleUpdate(gw.bot.press(card, 'Отправить', NICK_TG)), approvals().handleUpdate(gw.bot.press(card, 'Отправить', NICK_TG))]);
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(1);
    await approvals().handleUpdate(gw.bot.press(card, 'Пропустить', NICK_TG));
    expect(gw.bot.answers.at(-1)!.text).toBe('Уже решено: выполнено.');
  });

  it('«Изменить» принимает текст человека и отправляет его', async () => {
    await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'черновик агента' });
    const card = gw.bot.lastCard();
    await approvals().handleUpdate(gw.bot.press(card, 'Изменить', NICK_TG));
    const prompt = gw.bot.sent.at(-1)!;
    expect(prompt.text).toContain('Ответь на это сообщение новым текстом');
    expect(prompt.options.forceReply).toBe(true);
    // текст от другого человека не подходит
    await approvals().handleUpdate(gw.bot.text(PARTNER_TG, 'чужой текст', prompt.messageId));
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    // сообщение не в ответ на просьбу никуда не уходит: человек мог писать боту по другому поводу
    await approvals().handleUpdate(gw.bot.text(NICK_TG, 'пароль от вайфая 12345'));
    await approvals().handleUpdate(gw.bot.text(NICK_TG, 'ответ на другое сообщение', card.messageId));
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect(gw.bot.sent.at(-1)!.text).toContain('никуда не отправлено');
    await approvals().handleUpdate(gw.bot.text(NICK_TG, 'мой текст', prompt.messageId));
    expect(gw.tg.last('messages.SendMessage').request.message).toBe('мой текст');
  });

  it('«Пропустить» закрывает запрос без отправки', async () => {
    await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'текст' });
    await approvals().handleUpdate(gw.bot.press(gw.bot.lastCard(), 'Пропустить', NICK_TG));
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect(gw.bot.edits.at(-1)!.text).toContain('🚫 Пропущено');
    expect((await nick.call('tg_inbox')).text).toContain('reply rejected');
  });

  it('один ответ на пост с аккаунта: ни второй черновик, ни второй пользователь', async () => {
    await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'первый' });
    const again = await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'второй' });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('already waiting for the owner');

    await approvals().handleUpdate(gw.bot.press(gw.bot.lastCard(), 'Отправить', NICK_TG));
    // общий аккаунт: второй пользователь на тот же пост уже не ответит
    const partner = await gw.client('partner', ALL);
    const second = await partner.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'я тоже', account: 'agent' });
    expect(second.isError).toBe(true);
    expect(second.text).toContain('Error: LIMIT_REACHED');
    expect(second.text).toContain('already replied to this post');
    await partner.close();
  });

  it('ошибка Telegram при отправке видна и человеку, и агенту', async () => {
    gw.tg.on('messages.SendMessage', () => {
      throw new GatewayError('WRITE_FORBIDDEN', 'The account is not allowed to write here.');
    });
    await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'текст' });
    await approvals().handleUpdate(gw.bot.press(gw.bot.lastCard(), 'Отправить', NICK_TG));
    expect(gw.bot.edits.at(-1)!.text).toContain('⚠️ Не выполнено: WRITE_FORBIDDEN');
    expect((await nick.call('tg_inbox')).text).toContain('reply failed');
    // неудачная отправка не занимает «один ответ на пост»
    expect(store().hasReply('agent', '-1000000000500', 10)).toBe(false);
  });

  it('человек одобряет ровно то, что уйдёт: длинный и «невидимый» текст', async () => {
    const tooLong = await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'я'.repeat(2801) });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.text).toContain('limited to 2800');

    const hidden = 'Хорошая новость' + String.fromCharCode(0x202e) + String.fromCharCode(0x200b) + ' спрятанный хвост';
    await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: hidden });
    const card = gw.bot.lastCard();
    expect(card.text).toContain('Хорошая новость спрятанный хвост');
    await approvals().handleUpdate(gw.bot.press(card, 'Отправить', NICK_TG));
    // в Telegram ушло то же, что было на карточке
    expect(gw.tg.last('messages.SendMessage').request.message).toBe('Хорошая новость спрятанный хвост');
  });

  it('нажатие после срока не выполняет действие, даже если уборка ещё не прошла', async () => {
    await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'текст' });
    clock += 7 * 60 * 60 * 1000;
    await approvals().handleUpdate(gw.bot.press(gw.bot.lastCard(), 'Отправить', NICK_TG));
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect(gw.bot.answers.at(-1)!.text).toBe('Срок согласования истёк.');
  });

  it('согласование истекает без решения', async () => {
    await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'текст' });
    clock += 7 * 60 * 60 * 1000;
    expect(await approvals().sweep()).toBe(1);
    expect(gw.bot.edits.at(-1)!.text).toContain('⌛ Истекло');
    await approvals().handleUpdate(gw.bot.press(gw.bot.lastCard(), 'Отправить', NICK_TG));
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
  });

  it('без бота и без Telegram id запись недоступна с понятной причиной', async () => {
    gw.storage.users.update('nick', { telegramId: null });
    const noId = await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'текст' });
    expect(noId.text).toContain('tg-mcp user telegram nick');

    gw.storage.users.update('nick', { telegramId: NICK_TG });
    gw.bot.failNextSend = 403;
    const notStarted = await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'текст' });
    expect(notStarted.text).toContain('press Start');

    const bare = makeTestGateway({ bot: false });
    bare.config.toolsets = ALL;
    bare.tg.on('contacts.ResolveUsername', () => ({ peer: { className: 'PeerChannel', channelId: BigInt(CHANNEL) }, chats: [channel()], users: [] }));
    const client = await bare.client('nick', ALL);
    expect((await client.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'текст' })).text).toContain('TG_MCP_APPROVAL_BOT_TOKEN');
    await client.close();
    bare.cleanup();
  });

  it('/start сообщает Telegram id для привязки', async () => {
    await approvals().handleUpdate(gw.bot.text('555', '/start'));
    expect(gw.bot.sent.at(-1)!.text).toContain('Ваш Telegram id: 555');
    await approvals().handleUpdate(gw.bot.text(NICK_TG, '/start'));
    expect(gw.bot.sent.at(-1)!.text).toContain('пользователь шлюза «nick»');
  });

  it('tg_join просит согласия и не трогает чат, где аккаунт уже состоит', async () => {
    gw.tg.on('channels.GetFullChannel', () => ({ fullChat: { participantsCount: 900 }, chats: [channel({ left: true })] }));
    gw.tg.on('channels.JoinChannel', () => ({ className: 'Updates', updates: [] }));
    const reply = await nick.call('tg_join', { ref: '@stonksnws' });
    expect(reply.text).toContain('Joining is requested');
    const card = gw.bot.lastCard();
    expect(card.text).toContain('Вступить в @stonksnws (channel, участников: 900)');
    expect(card.buttons.flat().map(b => b.text)).toEqual(['✅ Вступить', '🚫 Отклонить']);
    expect(gw.tg.callsOf('channels.JoinChannel')).toHaveLength(0);
    await approvals().handleUpdate(gw.bot.press(card, 'Вступить', NICK_TG));
    expect(gw.tg.callsOf('channels.JoinChannel')).toHaveLength(1);

    gw.tg.on('channels.GetFullChannel', () => ({ fullChat: {}, chats: [channel({ left: false })] }));
    expect((await nick.call('tg_join', { ref: '@stonksnws' })).text).toContain('already a member');
  });
});

describe('наблюдение и входящие', () => {
  it('агент сам добавляет канал; старые посты не приходят, новые приходят один раз', async () => {
    const added = await nick.call('tg_watch', { action: 'add', chat: '@stonksnws' });
    expect(added.text).toContain('Now watching @stonksnws with account agent');
    expect(gw.bot.sent).toHaveLength(0); // наблюдение не требует согласования

    gw.tg.on('messages.GetHistory', () => ({ messages: [post(30), post(29)], chats: [channel()] }));
    const watcher = gw.services.automation.watcher;
    expect(await watcher.tick()).toBe(0); // первый опрос только запоминает конец ленты
    expect((await nick.call('tg_inbox')).text).toContain('Nothing new.');

    clock += 61_000;
    gw.tg.on('messages.GetHistory', () => ({ messages: [post(32, 'Свежий пост про ставку'), post(31), post(30)], chats: [channel()] }));
    expect(await watcher.tick()).toBe(2);
    const inbox = await nick.call('tg_inbox');
    expect(inbox.text).toContain('new_post | in @stonksnws | #31 | https://t.me/stonksnws/31');
    expect(inbox.text).toContain('> Свежий пост про ставку');
    expect(gw.tg.last('messages.GetHistory').options).toMatchObject({ priority: 'background' });

    // повторный опрос тех же постов событий не создаёт
    clock += 61_000;
    expect(await watcher.tick()).toBe(0);
    const cursor = inbox.text.match(/next_cursor: (\S+)/)![1]!;
    expect((await nick.call('tg_inbox', { cursor })).text).toContain('Nothing new.');
  });

  it('альбом это одно событие, служебные сообщения не считаются', async () => {
    await nick.call('tg_watch', { action: 'add', chat: '@stonksnws' });
    gw.tg.on('messages.GetHistory', () => ({ messages: [post(10)], chats: [channel()] }));
    await gw.services.automation.watcher.tick();
    clock += 61_000;
    gw.tg.on('messages.GetHistory', () => ({
      messages: [
        { className: 'MessageService', id: 14, peerId: { className: 'PeerChannel', channelId: BigInt(CHANNEL) }, date: 1, action: { className: 'MessageActionPinMessage' } },
        post(13, '', { groupedId: 77n }),
        post(12, 'Подпись альбома', { groupedId: 77n }),
        post(11, '', { groupedId: 77n }),
        post(10),
      ],
      chats: [channel()],
    }));
    expect(await gw.services.automation.watcher.tick()).toBe(1);
    const inbox = await nick.call('tg_inbox');
    expect(inbox.text).toContain('#11');
    expect(inbox.text).toContain('> Подпись альбома');
    expect(inbox.text).not.toContain('#13');
  });

  it('общий аккаунт: один опрос, событие каждому наблюдающему; чужой список не виден', async () => {
    const partner = await gw.client('partner', ALL);
    await nick.call('tg_watch', { action: 'add', chat: '@stonksnws' });
    await partner.call('tg_watch', { action: 'add', chat: '@stonksnws', account: 'agent' });
    gw.tg.on('messages.GetHistory', () => ({ messages: [post(10)], chats: [channel()] }));
    await gw.services.automation.watcher.tick();
    clock += 61_000;
    gw.tg.on('messages.GetHistory', () => ({ messages: [post(11), post(10)], chats: [channel()] }));
    const before = gw.tg.callsOf('messages.GetHistory').length;
    await gw.services.automation.watcher.tick();
    expect(gw.tg.callsOf('messages.GetHistory').length - before).toBe(1);
    expect((await nick.call('tg_inbox')).text).toContain('#11');
    expect((await partner.call('tg_inbox')).text).toContain('#11');

    expect((await partner.call('tg_watch', { action: 'remove', chat: '@stonksnws', account: 'agent' })).text).toContain('Stopped watching');
    expect((await partner.call('tg_watch', { action: 'list' })).text).toContain('Watched chats: 0');
    expect((await nick.call('tg_watch', { action: 'list' })).text).toContain('@stonksnws | account agent');
    await partner.close();
  });

  it('наблюдать можно только каналы и группы; закрытый владельцем чат выпадает из наблюдения', async () => {
    gw.tg.on('contacts.ResolveUsername', (req: { username: string }) =>
      req.username === 'seller'
        ? { peer: { className: 'PeerUser', userId: 42n }, chats: [], users: [rawUser(42, { username: 'seller' })] }
        : { peer: { className: 'PeerChannel', channelId: BigInt(CHANNEL) }, chats: [channel()], users: [] },
    );
    gw.storage.scopes.put({ userId: 'nick', accountId: 'agent', target: 'seller', effect: 'allow', source: 'owner' });
    const person = await nick.call('tg_watch', { action: 'add', chat: '@seller' });
    expect(person.isError).toBe(true);
    expect(person.text).toContain('Only channels and groups can be watched');

    await nick.call('tg_watch', { action: 'add', chat: '@stonksnws' });
    gw.tg.on('messages.GetHistory', () => ({ messages: [post(10)], chats: [channel()] }));
    await gw.services.automation.watcher.tick();
    clock += 61_000;
    gw.tg.on('messages.GetHistory', () => ({ messages: [post(11, 'пост до запрета'), post(10)], chats: [channel()] }));
    await gw.services.automation.watcher.tick();
    // владелец закрыл канал: старое событие больше не показывается, наблюдение снимается
    gw.storage.scopes.put({ userId: 'nick', accountId: 'agent', target: '-1000000000500', effect: 'deny', source: 'owner' });
    expect((await nick.call('tg_inbox')).text).not.toContain('пост до запрета');
    clock += 61_000;
    const before = gw.tg.callsOf('messages.GetHistory').length;
    await gw.services.automation.watcher.tick();
    expect(gw.tg.callsOf('messages.GetHistory').length).toBe(before);
    expect(store().listWatches('nick')).toHaveLength(0);
  });

  it('предел числа наблюдаемых чатов на аккаунт', async () => {
    for (let i = 0; i < 30; i++) store().addWatch('nick', 'agent', `-100${1000 + i}`);
    const reply = await nick.call('tg_watch', { action: 'add', chat: '@stonksnws' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain('already watches 30 chats');
  });

  it('FLOOD_WAIT откладывает опрос на время паузы, закрытый чат на час', async () => {
    await nick.call('tg_watch', { action: 'add', chat: '@stonksnws' });
    gw.tg.on('messages.GetHistory', () => {
      throw new GatewayError('FLOOD_WAIT', 'wait', { retryAfter: 300 });
    });
    await gw.services.automation.watcher.tick();
    const state = store().watchState('agent', '-1000000000500')!;
    expect(state.nextPollAt - clock).toBe(305_000);
    expect(state.lastError).toBe('wait');
    expect((await nick.call('tg_watch', { action: 'list' })).text).toContain('PROBLEM: wait');
  });
});

describe('правила', () => {
  async function createRule(extra: Record<string, unknown> = {}) {
    const reply = await nick.call('tg_rule_set', { id: 'reply-posts', chat: '@stonksnws', prompt: 'Коротко ответь по существу.', per_day: 2, ...extra });
    return reply;
  }

  it('правило включается только после согласия человека', async () => {
    const reply = await createRule({ keywords: ['Ставка'], quiet_hours: '23:00-09:00' });
    expect(reply.text).toContain('NOT active yet');
    const card = gw.bot.lastCard();
    expect(card.text).toContain('Правило «reply-posts»: следить за @stonksnws');
    expect(card.text).toContain('Не больше 2 в день, один ответ на пост');
    expect(card.text).toContain('Только посты со словами: ставка');
    expect(card.text).toContain('Тихие часы (UTC): 23:00-09:00');
    expect(card.text).toContain('Коротко ответь по существу.');
    expect(store().getRule('nick:reply-posts')).toBeNull();

    await approvals().handleUpdate(gw.bot.press(card, 'Включить', NICK_TG));
    expect(store().getRule('nick:reply-posts')).toMatchObject({ enabled: true, accountId: 'agent', chatKey: '-1000000000500' });
    // чат правила сам попал в наблюдение
    expect(store().listWatches('nick')).toHaveLength(1);
    expect((await nick.call('tg_rules')).text).toContain('rule reply-posts | @stonksnws | account agent | ON | yours | runs today 0/2');
  });

  it('выключить можно сразу, чужое правило менять нельзя, но видно', async () => {
    await createRule();
    await approvals().handleUpdate(gw.bot.press(gw.bot.lastCard(), 'Включить', NICK_TG));
    const partner = await gw.client('partner', ALL);
    expect((await partner.call('tg_rules')).text).toContain('rule reply-posts | @stonksnws | account agent | ON | by nick (read only)');
    // чужое правило с тем же именем неотличимо от несуществующего
    const denied = await partner.call('tg_rule_set', { id: 'reply-posts', enabled: false });
    expect(denied.text).toContain('You have no rule "reply-posts"');
    expect(store().getRule('nick:reply-posts')!.enabled).toBe(true);
    await partner.close();

    const off = await nick.call('tg_rule_set', { id: 'reply-posts', enabled: false });
    expect(off.text).toContain('switched off');
    expect(store().getRule('nick:reply-posts')!.enabled).toBe(false);
  });

  it('правило без лимитов и без задания не создаётся', async () => {
    expect((await nick.call('tg_rule_set', { id: 'r1', chat: '@stonksnws' })).text).toContain('Rule prompt is empty');
    expect((await nick.call('tg_rule_set', { id: 'r1', chat: '@stonksnws', prompt: 'x', per_day: 500 })).text).toContain('per_day must be between 1 and 20');
    expect((await nick.call('tg_rule_set', { id: 'Bad Id', chat: '@stonksnws', prompt: 'x' })).text).toContain('Rule id');
    expect(() => normalizeRuleConfig({ prompt: 'x', quietHours: 'ночью' })).toThrow(/quiet_hours/);
  });

  it('новый пост: запуск агента ставится в очередь с паузой, реклама и лимит пропускаются', async () => {
    await createRule();
    await approvals().handleUpdate(gw.bot.press(gw.bot.lastCard(), 'Включить', NICK_TG));
    const watcher = gw.services.automation.watcher;
    gw.tg.on('messages.GetHistory', () => ({ messages: [post(10)], chats: [channel()] }));
    await watcher.tick();

    clock += 61_000;
    gw.tg.on('messages.GetHistory', () => ({ messages: [post(13, 'Третий пост'), post(12, 'Реклама. Купите курс erid: 2Vtzq'), post(11, 'Первый пост'), post(10)], chats: [channel()] }));
    await watcher.tick();
    expect(store().lastFires('nick:reply-posts', 5).map(f => [f.messageId, f.outcome])).toEqual([[13, 'queued'], [12, 'skipped:ad'], [11, 'queued']]);

    // пауза перед запуском: сразу заданий нет
    const runner = gw.services.automation.runner;
    expect(runner.claim('nick')).toBeNull();
    clock += 301_000;
    const job = runner.claim('nick')!;
    expect(job.kind).toBe('rule');
    expect(job.prompt).toContain('A new post appeared in @stonksnws: post id 11, https://t.me/stonksnws/11');
    expect(job.prompt).toContain('Коротко ответь по существу.');
    expect(job.prompt).not.toContain('Первый пост'); // текст поста в промпт не попадает
    expect(runner.claim('partner')).toBeNull();

    // дневной лимит: третий пост за день уже не запускает агента
    clock += 61_000;
    gw.tg.on('messages.GetHistory', () => ({ messages: [post(14), post(13)], chats: [channel()] }));
    await watcher.tick();
    expect(store().lastFires('nick:reply-posts', 1)[0]).toMatchObject({ messageId: 14, outcome: 'skipped:daily_limit' });
  });

  it('тихие часы, ключевые слова и признаки рекламы', () => {
    const night = Date.UTC(2026, 9, 1, 23, 30);
    const day = Date.UTC(2026, 9, 1, 12, 0);
    expect(inQuietHours('23:00-09:00', night)).toBe(true);
    expect(inQuietHours('23:00-09:00', Date.UTC(2026, 9, 1, 8, 59))).toBe(true);
    expect(inQuietHours('23:00-09:00', day)).toBe(false);
    expect(inQuietHours('09:00-18:00', day)).toBe(true);
    expect(inQuietHours(null, day)).toBe(false);
    expect(isAdvertisement('#реклама Лучший курс')).toBe(true);
    expect(isAdvertisement('Партнёрский пост. erid:LjN8K')).toBe(true);
    expect(isAdvertisement('На правах рекламы')).toBe(true);
    expect(isAdvertisement('Рекламный рынок вырос на 10%')).toBe(false);
    expect(isAdvertisement('Сегодня реклама в Telegram подорожала')).toBe(false);
    expect(isAdvertisement('Реклама. ООО «Ромашка»')).toBe(true);
  });
});

describe('запуск агента по правилу', () => {
  async function ruleJob() {
    await nick.call('tg_rule_set', { id: 'reply-posts', chat: '@stonksnws', prompt: 'Ответь.' });
    await approvals().handleUpdate(gw.bot.press(gw.bot.lastCard(), 'Включить', NICK_TG));
    const watcher = gw.services.automation.watcher;
    gw.tg.on('messages.GetHistory', () => ({ messages: [post(10)], chats: [channel()] }));
    await watcher.tick();
    clock += 61_000;
    gw.tg.on('messages.GetHistory', () => ({ messages: [post(11, 'Новый пост'), post(10)], chats: [channel()] }));
    await watcher.tick();
    clock += 301_000;
    return gw.services.automation.runner.claim('nick')!;
  }

  async function scopedClient(token: string): Promise<TestClient> {
    const principal = gw.services.access.authenticate(token);
    // клиент с правами токена запуска
    const { createMcpServer } = await import('../../mcp/server.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { server } = createMcpServer({ services: gw.services, principal, toolsets: ALL, version: 'test', log: silent, now: () => clock });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'scoped', version: '1' });
    await server.connect(b);
    await client.connect(a);
    return {
      call: async (name, args = {}) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
        return { text: r.content.map(c => c.text ?? '').join('\n'), isError: r.isError === true, images: 0 };
      },
      tools: async () => (await client.listTools()).tools as never,
      instructions: () => client.getInstructions(),
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  it('токен запуска: один пост, один ответ, только нужные инструменты', async () => {
    const job = await ruleJob();
    const agent = await scopedClient(job.token);
    expect((await agent.tools()).map(t => t.name).sort()).toEqual(['tg_get_comments', 'tg_get_media', 'tg_get_message', 'tg_read_history', 'tg_reply', 'tg_status']);

    // чужой чат и чужой пост недоступны
    gw.tg.on('contacts.ResolveUsername', (req: { username: string }) =>
      req.username === 'other_chan'
        ? { peer: { className: 'PeerChannel', channelId: 900n }, chats: [rawChannel(900, { username: 'other_chan' })], users: [] }
        : { peer: { className: 'PeerChannel', channelId: BigInt(CHANNEL) }, chats: [channel()], users: [] },
    );
    const elsewhere = await agent.call('tg_read_history', { chat: '@other_chan' });
    expect(elsewhere.text).toContain('may only work with the chat it was started for');
    const wrongPost = await agent.call('tg_reply', { link: 'https://t.me/stonksnws/5', text: 'не туда' });
    expect(wrongPost.text).toContain('may reply only to the post it was started for');

    // способ ответа задаёт правило, а не агент
    const ok = await agent.call('tg_reply', { link: 'https://t.me/stonksnws/11', text: 'Ответ агента', send_as: 'channel' });
    expect(ok.isError).toBe(false);
    const card = gw.bot.lastCard();
    expect(card.text).toContain('Источник: rule:nick:reply-posts');
    expect(card.text).not.toContain('от имени канала');
    const second = await agent.call('tg_reply', { link: 'https://t.me/stonksnws/11', text: 'ещё раз' });
    expect(second.text).toContain('already waiting');
    await agent.close();

    // после отчёта runner токен перестаёт действовать
    expect(gw.services.automation.runner.finish('nick', job.id, 0, 'done')).toBe(true);
    expect(() => gw.services.access.authenticate(job.token)).toThrow('Missing or invalid gateway token.');
    expect(store().lastFires('nick:reply-posts', 1)[0]!.outcome).toBe('agent_done');
    expect((await nick.call('tg_inbox')).text).toContain('agent_run | rule reply-posts | in @stonksnws | exit code 0');
  });

  it('HTTP: runner забирает задание своим токеном, токен запуска очередь не видит', async () => {
    const http = await startHttpServer({ services: gw.services, host: '127.0.0.1', port: 0, toolsets: ALL, version: 'test', log: silent });
    try {
      await nick.call('tg_rule_set', { id: 'reply-posts', chat: '@stonksnws', prompt: 'Ответь.' });
      await approvals().handleUpdate(gw.bot.press(gw.bot.lastCard(), 'Включить', NICK_TG));
      store().enqueueRunnerJob({ id: 'run_test', userId: 'nick', kind: 'rule', runAfter: 0, payload: { ruleId: 'nick:reply-posts', accountId: 'agent', chatKey: '-1000000000500', chatLabel: '@stonksnws', postId: 11, link: 'https://t.me/stonksnws/11', prompt: 'Ответь.' } });
      const base = `http://127.0.0.1:${http.port}`;
      const call = (path: string, token: string, body: unknown) =>
        fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

      expect(((await (await call('/runner/claim', gw.tokens.partner, {})).json()) as { job: unknown }).job).toBeNull();
      const claimed = ((await (await call('/runner/claim', gw.tokens.nick, {})).json()) as { job: { id: string; token: string } }).job;
      expect(claimed.id).toBe('run_test');
      expect((await call('/runner/claim', claimed.token, {})).status).toBe(403);
      expect((await call('/runner/finish', gw.tokens.partner, { id: 'run_test', exit_code: 0 })).status).toBe(200);
      expect(store().getRunnerJob('run_test')!.state).toBe('claimed'); // чужой отчёт не засчитан
      expect(((await (await call('/runner/finish', gw.tokens.nick, { id: 'run_test', exit_code: 3, output: 'boom' })).json()) as { ok: boolean }).ok).toBe(true);
      expect(store().getRunnerJob('run_test')).toMatchObject({ state: 'failed', exitCode: 3, output: 'boom' });
      expect((await call('/runner/finish', gw.tokens.nick, { id: 5 })).status).toBe(400);
    } finally {
      await http.close();
    }
  });

  it('брошенные задания закрываются уборкой', async () => {
    const job = await ruleJob();
    clock += 20 * 60_000;
    expect(gw.services.automation.runner.sweep()).toBe(1);
    expect(store().getRunnerJob(job.id)!.state).toBe('failed');
    expect(() => gw.services.access.authenticate(job.token)).toThrow();
  });
});

describe('команда runner', () => {
  it('делит команду как оболочка и подставляет промпт одним аргументом', () => {
    expect(splitCommand(`claude -p {prompt} --mcp-config "/Users/me/tg mcp/agent.json" --flag='a b'`)).toEqual([
      'claude', '-p', '{prompt}', '--mcp-config', '/Users/me/tg mcp/agent.json', '--flag=a b',
    ]);
    expect(splitCommand('a\\ b "c \\" d" \'\'')).toEqual(['a b', 'c " d', '']);
    expect(() => splitCommand('claude "unclosed')).toThrow(/Unclosed quote/);
    const nasty = 'post"; rm -rf ~ $(whoami) `id`';
    expect(buildArgv('claude -p {prompt} --x', nasty)).toEqual(['claude', '-p', nasty, '--x']);
    expect(buildArgv('codex exec', 'do it')).toEqual(['codex', 'exec', 'do it']);
    expect(() => buildArgv('   ', 'x')).toThrow(/empty/);
  });

  it('запускает агента с токеном запуска в окружении и возвращает код выхода', async () => {
    const job = { id: 'run_1', kind: 'rule', prompt: 'hello prompt', token: 'scoped-token', timeoutSec: 10 };
    const base = { baseUrl: 'http://127.0.0.1:7777', token: 'user-token', log: silent };
    const ok = await runAgent({ ...base, agent: `node -e "console.log(process.argv[1], process.env.TG_MCP_TOKEN, process.env.TG_MCP_URL)" {prompt}` }, job);
    expect(ok.exitCode).toBe(0);
    expect(ok.output.trim()).toBe('hello prompt scoped-token http://127.0.0.1:7777/mcp');
    const failed = await runAgent({ ...base, agent: 'node -e "process.exit(3)"' }, job);
    expect(failed.exitCode).toBe(3);
    const missing = await runAgent({ ...base, agent: 'definitely-not-a-command-xyz' }, job);
    expect(missing.exitCode).toBe(127);
    const slow = await runAgent({ ...base, agent: 'node -e "setTimeout(()=>{},60000)"' }, { ...job, timeoutSec: 0.2 });
    expect(slow.exitCode).toBe(124);
    expect(slow.output).toContain('timed out');
  });

  it('цикл: забирает задание, запускает агента, сообщает исход', async () => {
    const http = await startHttpServer({ services: gw.services, host: '127.0.0.1', port: 0, toolsets: ALL, version: 'test', log: silent });
    const controller = new AbortController();
    try {
      await nick.call('tg_rule_set', { id: 'reply-posts', chat: '@stonksnws', prompt: 'Ответь.' });
      await approvals().handleUpdate(gw.bot.press(gw.bot.lastCard(), 'Включить', NICK_TG));
      store().enqueueRunnerJob({ id: 'run_loop', userId: 'nick', kind: 'rule', runAfter: 0, payload: { ruleId: 'nick:reply-posts', accountId: 'agent', chatKey: '-1000000000500', chatLabel: '@stonksnws', postId: 11, link: null, prompt: 'Ответь.' } });
      const loop = runRunner({
        baseUrl: `http://127.0.0.1:${http.port}`,
        token: gw.tokens.nick,
        agent: 'node -e "console.log(process.argv[1].length > 50 ? \'got prompt\' : \'no prompt\')" {prompt}',
        pollMs: 20,
        signal: controller.signal,
        log: silent,
      });
      await vi.waitFor(() => expect(store().getRunnerJob('run_loop')!.state).toBe('done'), { timeout: 5_000 });
      expect(store().getRunnerJob('run_loop')!.output).toContain('got prompt');
      controller.abort();
      await loop;
    } finally {
      controller.abort();
      await http.close();
    }
  });

  it('неверный токен останавливает runner сразу', async () => {
    const http = await startHttpServer({ services: gw.services, host: '127.0.0.1', port: 0, toolsets: ALL, version: 'test', log: silent });
    try {
      await expect(runRunner({ baseUrl: `http://127.0.0.1:${http.port}`, token: 'wrong-token-wrong-token', agent: 'node -e ""', pollMs: 10, log: silent })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    } finally {
      await http.close();
    }
  });
});

describe('мелочи', () => {
  it('id отправленного сообщения достаётся из разных форм ответа', () => {
    expect(sentMessageId({ className: 'UpdateShortSentMessage', id: 5 })).toBe(5);
    expect(sentMessageId({ updates: [{ className: 'UpdateNewChannelMessage', message: { id: 9 } }] })).toBe(9);
    expect(sentMessageId({ updates: [{ className: 'UpdateNewChannelMessage', message: { id: 9 } }, { className: 'UpdateMessageID', id: 8 }] })).toBe(8);
    expect(sentMessageId(null)).toBeNull();
  });

  it('клиент Bot API не принимает мусор вместо токена и не светит токен в ошибках', async () => {
    expect(() => new HttpBotApi('not-a-token')).toThrow(/unexpected format/);
    const token = '123456:' + 'A'.repeat(35);
    const api = new HttpBotApi(token, (async () => new Response(JSON.stringify({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }), { status: 409 })) as never);
    const err = (await api.getUpdates(0, 1).catch((e: unknown) => e)) as Error & { isConflict?: boolean };
    expect(err.message).toContain('409');
    expect(err.message).not.toContain(token);
    expect(err.isConflict).toBe(true);
  });

  it('личные сообщения незнакомым: лимит новых диалогов в день', () => {
    const write = gw.services.automation.write;
    const person = (id: number) => ({ accountId: 'agent', peerKey: String(id), kind: 'user' as const, accessHash: '1', username: null, title: null, meta: {}, updatedAt: 0 });
    for (let i = 1; i <= 5; i++) store().recordWrite({ ts: clock, userId: 'nick', accountId: 'agent', kind: 'send', chatKey: String(i), postId: null, sentMessageId: i, source: 'task:t' });
    expect(() => write.assertCanMessage('agent', person(99))).toThrow(/Daily limit of 5 new dialogs/);
    // продолжить начатый диалог можно
    expect(() => write.assertCanMessage('agent', person(3))).not.toThrow();
    // на другом аккаунте лимит свой
    expect(() => write.assertCanMessage('nick', person(99))).not.toThrow();
    void rawUser;
  });
});
