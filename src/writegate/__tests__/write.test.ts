import { RPCMessageToError } from 'teleproto/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestGateway, type TestClient, type TestGateway } from '../../__tests__/helpers/gateway.js';
import { rawChannel, rawMessage, rawUser } from '../../__tests__/helpers/fakeTg.js';
import { APPROVAL_TTL_MS } from '../approvals.js';
import { classifyError, GatewayError } from '../../core/errors.js';
import { writePrivateMode } from '../../policy/scopes.js';
import { sentMessageId } from '../../services/write.js';

const CHANNEL = 500;
const GROUP = 600;
const ALL = ['core', 'write'];

let gw: TestGateway;
let nick: TestClient;
let clock: number;

const channel = (extra: Record<string, unknown> = {}) => rawChannel(CHANNEL, { username: 'stonksnws', title: 'Stonks', ...extra });
const group = () => rawChannel(GROUP, { broadcast: false, megagroup: true, title: 'Stonks chat' });

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

const approvals = () => gw.services.writeGate.approvals;
/** Ошибка Telegram в том виде, в каком её отдаёт шлюз после teleproto. */
const telegramError = (message: string, method: string): GatewayError =>
  classifyError(RPCMessageToError({ errorCode: 400, errorMessage: message } as never, { className: method } as never));
const store = () => gw.services.writeGate.store;
const approvalIdOf = (text: string): string => text.match(/approval_id (ap_[0-9a-f]+)/)![1]!;
/** Агент владельца подтверждает запрос после его «да». */
const confirm = (approvalId: string, extra: Record<string, unknown> = {}) => nick.call('tg_confirm', { approval_id: approvalId, ...extra });

describe('запись в два шага: предпросмотр и tg_confirm', () => {
  it('tg_reply ничего не отправляет, пока агент владельца не подтвердил', async () => {
    const reply = await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'Согласен, рынок перегрет.' });
    expect(reply.isError).toBe(false);
    const approvalId = approvalIdOf(reply.text);
    // предпросмотр: что, от кого и точный текст
    expect(reply.text).toContain('Nothing has been done in Telegram yet');
    expect(reply.text).toContain('Reply in the comments of post https://t.me/stonksnws/10');
    expect(reply.text).toContain('Account: agent (@agent_acc)');
    expect(reply.text).toContain('Text, exactly as it will be sent:\nСогласен, рынок перегрет.');
    expect(reply.text).toContain(`Only after the owner clearly agrees, call tg_confirm with approval_id ${approvalId}`);
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);

    const done = await confirm(approvalId);
    expect(done.isError).toBe(false);
    expect(done.text).toBe('Done: Sent: https://t.me/stonksnws/10?comment=7777');
    const sent = gw.tg.last('messages.SendMessage').request;
    expect(sent.message).toBe('Согласен, рынок перегрет.');
    expect(sent.peer.className).toBe('InputPeerChannel');
    expect(String(sent.peer.channelId)).toBe(String(GROUP));
    expect(sent.replyTo.replyToMsgId).toBe(3010);
    expect(gw.tg.last('messages.SendMessage').options).toMatchObject({ write: true });
    expect(store().getApproval(approvalId)).toMatchObject({ state: 'executed', result: { summary: 'Sent: https://t.me/stonksnws/10?comment=7777', message_id: 7777 } });
  });

  it('чужой запрос подтвердить нельзя: для другого пользователя его не существует', async () => {
    const approvalId = approvalIdOf((await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'текст' })).text);
    const partner = await gw.client('partner', ALL);
    const denied = await partner.call('tg_confirm', { approval_id: approvalId });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('Error: NOT_FOUND');
    expect((await partner.call('tg_confirm', { action: 'reject', approval_id: approvalId })).text).toContain('Error: NOT_FOUND');
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect(store().getApproval(approvalId)!.state).toBe('pending');
    await partner.close();
  });

  it('повторное подтверждение отправляет один раз', async () => {
    const approvalId = approvalIdOf((await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'текст' })).text);
    await Promise.all([confirm(approvalId), confirm(approvalId)]);
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(1);
    const again = await confirm(approvalId);
    expect(again.text).toContain(`Request ${approvalId} is already executed: Sent:`);
    expect(again.text).toContain('Nothing was done by this call');
    expect((await confirm(approvalId, { action: 'reject' })).text).toContain('already executed');
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(1);
  });

  it('владелец меняет формулировку при подтверждении', async () => {
    const approvalId = approvalIdOf((await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'черновик агента' })).text);
    const done = await confirm(approvalId, { text: 'мой текст' });
    expect(done.isError).toBe(false);
    expect(gw.tg.last('messages.SendMessage').request.message).toBe('мой текст');
    expect(store().getApproval(approvalId)!.payload).toMatchObject({ text: 'мой текст', editedByOwner: true });

    // у вступления в чат текста нет: заменить нечего
    gw.tg.on('channels.GetFullChannel', () => ({ fullChat: { participantsCount: 900 }, chats: [channel({ left: true })] }));
    const joinId = approvalIdOf((await nick.call('tg_join', { ref: '@stonksnws' })).text);
    const wrong = await confirm(joinId, { text: 'привет' });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain('no text to replace');
    expect(store().getApproval(joinId)!.state).toBe('pending');
  });

  it('reject закрывает запрос без отправки, после него можно подготовить новый', async () => {
    const approvalId = approvalIdOf((await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'текст' })).text);
    const rejected = await confirm(approvalId, { action: 'reject' });
    expect(rejected.text).toContain(`Request ${approvalId} is rejected. Nothing was done in Telegram.`);
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect(store().getApproval(approvalId)!.state).toBe('rejected');
    expect((await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'другой текст' })).isError).toBe(false);
  });

  it('под одним постом можно ответить несколько раз; второй черновик не создаётся, пока первый ждёт решения', async () => {
    const approvalId = approvalIdOf((await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'первый' })).text);
    const again = await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'второй' });
    expect(again.isError).toBe(true);
    expect(again.text).toContain(`A reply to this post is already prepared (${approvalId})`);

    expect((await confirm(approvalId)).isError).toBe(false);
    // первый ответ отправлен: теперь тот же пользователь может ответить ещё раз
    const second = await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'второй' });
    expect(second.isError, second.text).toBe(false);
    expect((await confirm(approvalIdOf(second.text))).isError).toBe(false);
    // и второй пользователь общего аккаунта тоже
    const partner = await gw.client('partner', ALL);
    const third = await partner.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'я тоже', account: 'agent' });
    expect(third.isError, third.text).toBe(false);
    await partner.close();

    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(2);
    expect(store().writesSince('agent', 'reply', 0)).toBe(2);
  });

  it('дневной предел ответов действует и под одним постом', async () => {
    for (let i = 1; i <= 20; i++) store().recordWrite({ ts: clock, userId: 'nick', accountId: 'agent', kind: 'reply', chatKey: '-1000000000500', postId: 10, sentMessageId: i });
    const over = await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'двадцать первый' });
    expect(over.isError).toBe(true);
    expect(over.text).toContain('Daily limit of 20 replies');
  });

  it('ошибка Telegram при отправке приходит агенту с кодом', async () => {
    gw.tg.on('messages.SendMessage', () => {
      throw new GatewayError('WRITE_FORBIDDEN', 'The account is not allowed to write here.');
    });
    const approvalId = approvalIdOf((await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'текст' })).text);
    const failed = await confirm(approvalId);
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('Error: WRITE_FORBIDDEN');
    expect(failed.text).toContain('The action was confirmed but failed: The account is not allowed to write here.');
    // неудачная отправка в журнал не попадает и дневной предел не тратит
    expect(store().writesSince('agent', 'reply', 0)).toBe(0);
  });

  it('подтверждается ровно то, что уйдёт: длинный и «невидимый» текст', async () => {
    const tooLong = await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'я'.repeat(4097) });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.text).toContain('the Telegram limit is 4096');

    const hidden = 'Хорошая новость' + String.fromCharCode(0x202e) + String.fromCharCode(0x200b) + ' спрятанный хвост';
    const reply = await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: hidden });
    expect(reply.text).toContain('Text, exactly as it will be sent:\nХорошая новость спрятанный хвост');
    await confirm(approvalIdOf(reply.text));
    // в Telegram ушло то же, что было в предпросмотре
    expect(gw.tg.last('messages.SendMessage').request.message).toBe('Хорошая новость спрятанный хвост');
    // и замена текста чистится так же
    const second = await nick.call('tg_reply', { link: 'https://t.me/stonksnws/11', text: 'черновик' });
    await confirm(approvalIdOf(second.text), { text: 'свой' + String.fromCharCode(0x200b) + ' текст' });
    expect(gw.tg.last('messages.SendMessage').request.message).toBe('свой текст');
  });

  it('подтверждение после срока не выполняет действие, даже если уборка ещё не прошла', async () => {
    const approvalId = approvalIdOf((await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'текст' })).text);
    clock += APPROVAL_TTL_MS + 1000;
    const late = await confirm(approvalId);
    expect(late.isError).toBe(true);
    expect(late.text).toContain('has expired');
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect(store().getApproval(approvalId)!.state).toBe('expired');
  });

  it('запрос истекает без решения', async () => {
    const approvalId = approvalIdOf((await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'текст' })).text);
    clock += APPROVAL_TTL_MS + 1000;
    expect(approvals().sweep()).toBe(1);
    expect((await confirm(approvalId)).text).toContain('already expired');
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
  });

  it('запрос живёт полчаса; истёкший не мешает подготовить действие заново; старые решённые удаляются', async () => {
    const first = await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'первый' });
    expect(first.text).toContain('The request expires at 2026-10-01 12:30 UTC');
    clock += APPROVAL_TTL_MS + 1000;
    // уборка ещё не прошла, но истёкший запрос уже не считается ожидающим
    const second = await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'второй' });
    expect(second.isError, second.text).toBe(false);
    expect((await confirm(approvalIdOf(second.text))).text).toContain('Done: Sent');
    expect(gw.tg.last('messages.SendMessage').request.message).toBe('второй');

    const count = () => Number((gw.storage.db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }).n);
    expect(count()).toBe(2);
    clock += 8 * 24 * 60 * 60 * 1000;
    approvals().sweep();
    // тексты старых запросов в базе не копятся
    expect(count()).toBe(0);
    expect((await nick.call('tg_confirm', {})).isError).toBe(true);
  });

  it('tg_confirm есть только в наборе записи', async () => {
    const names = async (toolsets: string[]) => {
      const client = await gw.client('nick', toolsets);
      const list = (await client.tools()).map(t => t.name);
      await client.close();
      return list;
    };
    expect(await names(['core'])).not.toContain('tg_confirm');
    expect(await names(['core', 'write'])).toContain('tg_confirm');
    expect(await names(['core', 'discover', 'analytics', 'index'])).not.toContain('tg_confirm');
    expect(nick.instructions()).toContain('call tg_confirm only after the owner clearly agrees');
  });

  it('tg_join готовит вступление и не трогает чат, где аккаунт уже состоит', async () => {
    gw.tg.on('channels.GetFullChannel', () => ({ fullChat: { participantsCount: 900 }, chats: [channel({ left: true })] }));
    gw.tg.on('channels.JoinChannel', () => ({ className: 'Updates', updates: [] }));
    const reply = await nick.call('tg_join', { ref: '@stonksnws' });
    expect(reply.text).toContain('Joining is prepared');
    expect(reply.text).toContain('Join @stonksnws (channel, 900 members)');
    expect(gw.tg.callsOf('channels.JoinChannel')).toHaveLength(0);
    const done = await confirm(approvalIdOf(reply.text));
    expect(done.text).toContain('Done: The account joined @stonksnws');
    expect(gw.tg.callsOf('channels.JoinChannel')).toHaveLength(1);

    gw.tg.on('channels.GetFullChannel', () => ({ fullChat: {}, chats: [channel({ left: false })] }));
    expect((await nick.call('tg_join', { ref: '@stonksnws' })).text).toContain('already a member');
  });
});

describe('реакции', () => {
  const HEART = String.fromCharCode(0x2764);
  const SELECTOR = String.fromCharCode(0xfe0f);

  beforeEach(() => {
    gw.tg.on('messages.SendReaction', () => ({ className: 'Updates', updates: [] }));
  });

  it('реакция ставится только после подтверждения', async () => {
    const reply = await nick.call('tg_react', { link: 'https://t.me/stonksnws/10', emoji: '👍' });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toContain('Set the reaction 👍 on https://t.me/stonksnws/10');
    expect(reply.text).toContain('Account: agent (@agent_acc)');
    // у реакции нет текста: замену формулировки предпросмотр не предлагает
    expect(reply.text).not.toContain('other wording');
    expect(reply.text).toContain('To cancel: tg_confirm with action=reject.');
    expect(gw.tg.callsOf('messages.SendReaction')).toHaveLength(0);

    const done = await confirm(approvalIdOf(reply.text));
    expect(done.text).toBe('Done: Reaction 👍 is set on https://t.me/stonksnws/10');
    const call = gw.tg.last('messages.SendReaction');
    expect(call.request.peer.className).toBe('InputPeerChannel');
    expect(String(call.request.peer.channelId)).toBe(String(CHANNEL));
    expect(call.request.msgId).toBe(10);
    expect(call.request.reaction.map((r: { emoticon: string }) => r.emoticon)).toEqual(['👍']);
    expect(call.options).toMatchObject({ write: true });
    // запрос собран настоящими классами teleproto и сериализуется
    expect(() => call.request.getBytes()).not.toThrow();
    expect(store().writesSince('agent', 'react', 0)).toBe(1);
  });

  it('сердце с клавиатуры приводится к виду, который принимает Telegram', async () => {
    const reply = await nick.call('tg_react', { chat: '@stonksnws', id: 10, emoji: HEART + SELECTOR });
    await confirm(approvalIdOf(reply.text));
    const sent = gw.tg.last('messages.SendReaction').request.reaction[0].emoticon as string;
    expect(sent).toBe(HEART);
    expect(sent).toHaveLength(1);
  });

  it('реакцией может быть только один эмодзи', async () => {
    for (const emoji of ['ok', '', '👍 привет', '+1']) {
      const reply = await nick.call('tg_react', { link: 'https://t.me/stonksnws/10', emoji });
      expect(reply.isError, emoji).toBe(true);
      expect(reply.text).toContain('A reaction is one emoji');
    }
    expect((await nick.call('tg_react', { link: 'https://t.me/stonksnws/10' })).text).toContain('A reaction is one emoji');
    expect(store().listApprovals('nick', ['pending'])).toHaveLength(0);
  });

  it('remove снимает реакцию и не тратит дневной лимит; второй запрос на то же сообщение не создаётся', async () => {
    const reply = await nick.call('tg_react', { link: 'https://t.me/stonksnws/10', remove: true });
    expect(reply.text).toContain("Remove the account's reaction from https://t.me/stonksnws/10");
    expect((await nick.call('tg_react', { link: 'https://t.me/stonksnws/10', emoji: '🔥' })).text).toContain('already prepared');
    expect((await confirm(approvalIdOf(reply.text))).text).toBe('Done: The reaction is removed from https://t.me/stonksnws/10');
    expect(gw.tg.last('messages.SendReaction').request.reaction).toEqual([]);
    expect(store().writesSince('agent', 'react', 0)).toBe(0);
  });

  it('дневной лимит реакций и отказ Telegram по набору разрешённых эмодзи', async () => {
    gw.tg.on('messages.SendReaction', () => {
      throw telegramError('REACTION_INVALID', 'messages.SendReaction');
    });
    const failed = await confirm(approvalIdOf((await nick.call('tg_react', { link: 'https://t.me/stonksnws/10', emoji: '🤡' })).text));
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('Error: INVALID_ARGUMENT');
    expect(failed.text).toContain('This reaction is not allowed here');
    expect(store().writesSince('agent', 'react', 0)).toBe(0);

    for (let i = 1; i <= 30; i++) store().recordWrite({ ts: clock, userId: 'nick', accountId: 'agent', kind: 'react', chatKey: '-1000000000500', postId: i, sentMessageId: null });
    const limited = await nick.call('tg_react', { link: 'https://t.me/stonksnws/11', emoji: '👍' });
    expect(limited.isError).toBe(true);
    expect(limited.text).toContain('Daily limit of 30 reactions');
  });

});

describe('исходы записи, которые Telegram сообщает ошибкой', () => {
  const join = async () => {
    gw.tg.on('channels.GetFullChannel', () => ({ fullChat: { participantsCount: 900 }, chats: [channel({ left: true })] }));
    return confirm(approvalIdOf((await nick.call('tg_join', { ref: '@stonksnws' })).text));
  };

  it('заявка на вступление это исход, а не сбой: она идёт в дневной лимит', async () => {
    gw.tg.on('channels.JoinChannel', () => {
      throw telegramError('INVITE_REQUEST_SENT', 'channels.JoinChannel');
    });
    const done = await join();
    expect(done.isError).toBe(false);
    expect(done.text).toMatch(/Done: A join request to @stonksnws .* is sent: an admin of the chat has to accept it/);
    expect(store().writesSince('agent', 'join', 0)).toBe(1);
  });

  it('аккаунт уже в чате: запрос закрывается успехом, лимит не тратится', async () => {
    gw.tg.on('channels.JoinChannel', () => {
      throw telegramError('USER_ALREADY_PARTICIPANT', 'channels.JoinChannel');
    });
    expect((await join()).text).toContain('Done: The account is already a member of @stonksnws');
    expect(store().writesSince('agent', 'join', 0)).toBe(0);
  });

  it('настоящая ошибка вступления остаётся ошибкой', async () => {
    gw.tg.on('channels.JoinChannel', () => {
      throw telegramError('CHANNELS_TOO_MUCH', 'channels.JoinChannel');
    });
    const failed = await join();
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('CHANNELS_TOO_MUCH');
    expect(store().writesSince('agent', 'join', 0)).toBe(0);
  });

  it('RANDOM_ID_DUPLICATE значит, что сообщение уже доставлено: второй раз оно не уходит', async () => {
    gw.tg.on('messages.SendMessage', () => {
      throw telegramError('RANDOM_ID_DUPLICATE', 'messages.SendMessage');
    });
    const done = await confirm(approvalIdOf((await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'текст' })).text));
    expect(done.text).toBe('Done: Sent');
    // доставленное сообщение записано в журнал один раз
    expect(store().writesSince('agent', 'reply', 0)).toBe(1);
  });

  it('сбой журнала после отправки не превращает отправленное в ошибку', async () => {
    const record = vi.spyOn(store(), 'recordWrite').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    const done = await confirm(approvalIdOf((await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'текст' })).text));
    expect(record).toHaveBeenCalledTimes(1);
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(1);
    expect(done.text).toBe('Done: Sent: https://t.me/stonksnws/10?comment=7777');
  });

  it('действие, прерванное рестартом, не повторяется: исход неизвестен', async () => {
    const approvalId = approvalIdOf((await nick.call('tg_reply', { link: 'https://t.me/stonksnws/10', text: 'текст' })).text);
    // шлюз упал между «подтверждено» и «Telegram ответил»
    expect(store().transitionApproval(approvalId, ['pending'], 'executing')).toBe(true);

    expect(approvals().recover()).toBe(1);
    expect(store().getApproval(approvalId)!.state).toBe('failed');
    const again = await confirm(approvalId);
    expect(again.text).toContain('already failed');
    expect(again.text).toContain('The outcome is unknown: check in Telegram before repeating it');
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect(approvals().recover()).toBe(0);
  });
});

describe('мелочи', () => {
  it('id отправленного сообщения достаётся из разных форм ответа', () => {
    expect(sentMessageId({ className: 'UpdateShortSentMessage', id: 5 })).toBe(5);
    expect(sentMessageId({ updates: [{ className: 'UpdateNewChannelMessage', message: { id: 9 } }] })).toBe(9);
    expect(sentMessageId({ updates: [{ className: 'UpdateNewChannelMessage', message: { id: 9 } }, { className: 'UpdateMessageID', id: 8 }] })).toBe(8);
    expect(sentMessageId(null)).toBeNull();
  });

  it('tg_send: сообщение в открытый чат в два шага, личка закрыта по умолчанию', async () => {
    gw.tg.on('contacts.ResolveUsername', (req: { username: string }) =>
      req.username === 'friend'
        ? { peer: { className: 'PeerUser', userId: 42n }, chats: [], users: [rawUser(42, { username: 'friend', firstName: 'Друг' })] }
        : { peer: { className: 'PeerChannel', channelId: BigInt(GROUP) }, chats: [group()], users: [] },
    );
    const closed = await nick.call('tg_send', { chat: '@friend', text: 'привет' });
    expect(closed.isError).toBe(true);
    expect(closed.text).toContain('Private chats are closed by default');

    gw.storage.scopes.put({ userId: 'nick', accountId: 'agent', target: 'friend', effect: 'allow' });
    const drafted = await nick.call('tg_send', { chat: '@friend', text: 'привет' });
    expect(drafted.text).toContain('Message to @friend is prepared');
    expect(drafted.text).toContain('Nothing has been done in Telegram yet');
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect((await confirm(approvalIdOf(drafted.text))).text).toBe('Done: Sent');
    const sent = gw.tg.last('messages.SendMessage').request;
    expect(sent.message).toBe('привет');
    expect(sent.peer.className).toBe('InputPeerUser');

    const toGroup = await nick.call('tg_send', { chat: '@stonks_chat', text: 'сообщение в группу' });
    expect((await confirm(approvalIdOf(toGroup.text), { text: 'другой текст' })).isError).toBe(false);
    expect(gw.tg.last('messages.SendMessage').request.message).toBe('другой текст');
  });

  it('режим send: агент пишет любому человеку, но переписку не читает', async () => {
    gw.tg.on('contacts.ResolveUsername', () => ({ peer: { className: 'PeerUser', userId: 42n }, chats: [], users: [rawUser(42, { username: 'friend', firstName: 'Друг' })] }));
    writePrivateMode(gw.storage, 'nick', 'agent', 'send');

    const drafted = await nick.call('tg_send', { chat: '@friend', text: 'привет' });
    expect(drafted.isError, drafted.text).toBe(false);
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect((await confirm(approvalIdOf(drafted.text))).text).toBe('Done: Sent');
    expect(gw.tg.last('messages.SendMessage').request.peer.className).toBe('InputPeerUser');

    const read = await nick.call('tg_read_history', { chat: '@friend' });
    expect(read.isError).toBe(true);
    expect(read.text).toContain('Error: ACCESS_DENIED');
    expect(read.text).toContain('open for sending only');
    expect(gw.tg.callsOf('messages.GetHistory')).toHaveLength(0);

    gw.tg.on('users.GetFullUser', () => ({ fullUser: { about: null }, users: [rawUser(42, { username: 'friend' })] }));
    const card = await nick.call('tg_resolve', { ref: '@friend' });
    expect(card.text).toContain('private chat is open for sending only');
    expect((await nick.call('tg_status')).text).toContain('private chats: send only');

    // у второго пользователя того же аккаунта режим свой
    const partner = await gw.client('partner', ALL);
    expect((await partner.call('tg_send', { chat: '@friend', text: 'привет', account: 'agent' })).text).toContain('Private chats are closed by default');
    await partner.close();
  });

  it('режим open: переписку можно и читать', async () => {
    gw.tg.on('contacts.ResolveUsername', () => ({ peer: { className: 'PeerUser', userId: 42n }, chats: [], users: [rawUser(42, { username: 'friend', firstName: 'Друг' })] }));
    gw.tg.on('messages.GetHistory', () => ({ messages: [], chats: [], users: [] }));
    writePrivateMode(gw.storage, 'nick', 'agent', 'open');
    expect((await nick.call('tg_read_history', { chat: '@friend' })).isError).toBe(false);
    expect((await nick.call('tg_send', { chat: '@friend', text: 'привет' })).isError).toBe(false);
    expect((await nick.call('tg_status')).text).toContain('private chats: open (read and send)');
  });

  it('режим закрыт после предпросмотра: подтверждение ничего не отправляет', async () => {
    gw.tg.on('contacts.ResolveUsername', () => ({ peer: { className: 'PeerUser', userId: 42n }, chats: [], users: [rawUser(42, { username: 'friend', firstName: 'Друг' })] }));
    writePrivateMode(gw.storage, 'nick', 'agent', 'send');
    const drafted = await nick.call('tg_send', { chat: '@friend', text: 'привет' });
    writePrivateMode(gw.storage, 'nick', 'agent', 'closed');
    const failed = await confirm(approvalIdOf(drafted.text));
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('Error: ACCESS_DENIED');
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
  });

  it('дневные пределы берутся из настроек, 0 снимает предел', () => {
    const person = (id: number) => ({ accountId: 'agent', peerKey: String(id), kind: 'user' as const, accessHash: '1', username: null, title: null, meta: {}, updatedAt: 0 });
    const record = (g: TestGateway, n: number): void => {
      for (let i = 1; i <= n; i++) g.services.writeGate.store.recordWrite({ ts: clock, userId: 'nick', accountId: 'agent', kind: 'send', chatKey: String(i), postId: null, sentMessageId: i });
    };

    const tight = makeTestGateway({ now: () => clock, writeLimits: { newDialogsPerDay: 2 } });
    record(tight, 2);
    expect(() => tight.services.writeGate.write.assertCanMessage('agent', person(99))).toThrow(/Daily limit of 2 new dialogs.*TG_MCP_LIMIT_NEW_DIALOGS/);
    // остальные пределы остались по умолчанию
    expect(tight.services.writeGate.write.dailyLimits).toEqual({ repliesPerDay: 20, newDialogsPerDay: 2, joinsPerDay: 5, reactionsPerDay: 30 });
    tight.cleanup();

    const free = makeTestGateway({ now: () => clock, writeLimits: { newDialogsPerDay: 0, reactionsPerDay: 0 } });
    record(free, 40);
    for (let i = 0; i < 40; i++) free.services.writeGate.store.recordWrite({ ts: clock, userId: 'nick', accountId: 'agent', kind: 'react', chatKey: '-1000000000500', postId: i, sentMessageId: null });
    expect(() => free.services.writeGate.write.assertCanMessage('agent', person(99))).not.toThrow();
    expect(() => free.services.writeGate.write.assertCanReact('agent')).not.toThrow();
    free.cleanup();
  });

  it('tg_status показывает дневные пределы записи', async () => {
    const text = (await nick.call('tg_status')).text;
    expect(text).toContain('Write limits per account per day: replies 20, new dialogs 5, joins 5, reactions 30.');
    expect(text).toContain('private chats: closed, except the ones the owner opened');
  });

  it('личные сообщения незнакомым: лимит новых диалогов в день', () => {
    const write = gw.services.writeGate.write;
    const person = (id: number) => ({ accountId: 'agent', peerKey: String(id), kind: 'user' as const, accessHash: '1', username: null, title: null, meta: {}, updatedAt: 0 });
    for (let i = 1; i <= 5; i++) store().recordWrite({ ts: clock, userId: 'nick', accountId: 'agent', kind: 'send', chatKey: String(i), postId: null, sentMessageId: i });
    expect(() => write.assertCanMessage('agent', person(99))).toThrow(/Daily limit of 5 new dialogs/);
    // продолжить начатый диалог можно
    expect(() => write.assertCanMessage('agent', person(3))).not.toThrow();
    // на другом аккаунте лимит свой
    expect(() => write.assertCanMessage('nick', person(99))).not.toThrow();
  });
});
