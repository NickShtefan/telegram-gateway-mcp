import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestGateway, type TestClient, type TestGateway } from '../../__tests__/helpers/gateway.js';
import { rawUser } from '../../__tests__/helpers/fakeTg.js';
import { BotApiError } from '../botApi.js';
import { createLogger } from '../../core/log.js';
import { createMcpServer } from '../../mcp/server.js';

const silent = createLogger('test', { level: 'silent' });
const ALL = ['core', 'automate', 'write'];
const NICK_TG = '111';
const PARTNER_TG = '222';
const SELLER = 42;

let gw: TestGateway;
let nick: TestClient;
let clock: number;
let dialog: Array<Record<string, unknown>>;
let nextMessageId: number;

const tasks = () => gw.services.automation.tasks;
const taskStore = () => gw.services.automation.taskStore;
const approvals = () => gw.services.automation.approvals;
const runner = () => gw.services.automation.runner;

/** Сообщение в личном чате с продавцом. */
function dm(id: number, text: string, out: boolean): Record<string, unknown> {
  return { className: 'Message', id, peerId: { className: 'PeerUser', userId: BigInt(SELLER) }, fromId: out ? undefined : { className: 'PeerUser', userId: BigInt(SELLER) }, date: Math.floor(clock / 1000), message: text, out };
}

async function scoped(token: string): Promise<TestClient> {
  const principal = gw.services.access.authenticate(token);
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

const START = {
  peer: '@seller',
  goal: 'Купить велосипед из объявления t.me/baraholka/123',
  limits: 'До 15 000 ₽. Самовывоз в субботу или воскресенье днём.',
  first_message: 'Здравствуйте! Пишу как помощник покупателя по объявлению о велосипеде. Он ещё продаётся?',
};

async function startTask(extra: Record<string, unknown> = {}): Promise<string> {
  const reply = await nick.call('tg_task_start', { ...START, ...extra });
  expect(reply.isError, reply.text).toBe(false);
  const taskId = reply.text.match(/Task (t_[0-9a-f]+)/)![1]!;
  await approvals().handleUpdate(gw.bot.press(gw.bot.lastCard(), 'Начать', NICK_TG));
  return taskId;
}

beforeEach(async () => {
  clock = Date.UTC(2026, 9, 1, 12, 0, 0);
  dialog = [];
  nextMessageId = 100;
  gw = makeTestGateway({ now: () => clock });
  gw.config.toolsets = ALL;
  nick = await gw.client('nick', ALL);
  gw.tg.on('contacts.ResolveUsername', (req: { username: string }) => {
    if (req.username.toLowerCase() === 'seller') return { peer: { className: 'PeerUser', userId: BigInt(SELLER) }, chats: [], users: [rawUser(SELLER, { username: 'seller', firstName: 'Ivan' })] };
    if (req.username.toLowerCase() === 'some_bot') return { peer: { className: 'PeerUser', userId: 77n }, chats: [], users: [rawUser(77, { username: 'some_bot', bot: true })] };
    return { peer: { className: 'PeerUser', userId: 43n }, chats: [], users: [rawUser(43, { username: req.username })] };
  });
  gw.tg.on('messages.SendMessage', (req: { message: string }) => {
    const id = nextMessageId++;
    dialog.unshift(dm(id, req.message, true));
    return { className: 'Updates', updates: [{ className: 'UpdateMessageID', id }] };
  });
  gw.tg.on('messages.GetHistory', () => ({ messages: dialog, users: [rawUser(SELLER, { username: 'seller' })], chats: [] }));
});

afterEach(async () => {
  await nick.close();
  gw.cleanup();
});

describe('кейс 4: договорённость о велосипеде', () => {
  it('весь путь: согласие, ответ продавца, вопрос владельцу, новое предложение, отчёт', async () => {
    // 1-2. Агент предлагает поручение, владелец видит цель, рамки и первое сообщение.
    const reply = await nick.call('tg_task_start', START);
    expect(reply.text).toContain('prepared but NOT started');
    const taskId = reply.text.match(/Task (t_[0-9a-f]+)/)![1]!;
    const card = gw.bot.lastCard();
    expect(card.text).toContain(`Поручение ${taskId}: переписка с @seller.`);
    expect(card.text).toContain('Цель: Купить велосипед');
    expect(card.text).toContain('Рамки: До 15 000 ₽');
    expect(card.text).toContain('Только ты решаешь: переводы и предоплата, всё, что выходит за рамки, адрес, личные данные, время встречи.');
    expect(card.text).toContain('Он ещё продаётся?');
    expect(card.buttons.flat().map(b => b.text)).toEqual(['✅ Начать', '✏️ Изменить', '🚫 Отклонить']);
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect(taskStore().get(taskId)).toBeNull();

    // 3-4. После согласия уходит первое сообщение, диалог открыт только этому пользователю.
    await approvals().handleUpdate(gw.bot.press(card, 'Начать', NICK_TG));
    expect(gw.tg.last('messages.SendMessage').request.message).toBe(START.first_message);
    expect(gw.tg.last('messages.SendMessage').request.peer.className).toBe('InputPeerUser');
    expect(taskStore().get(taskId)).toMatchObject({ state: 'waiting_reply', messagesSent: 1, via: 'account', accountId: 'agent' });
    expect(gw.services.scopes.isAllowed('nick', 'agent', { peerKey: '42', kind: 'user' })).toBe(true);
    expect(gw.services.scopes.isAllowed('partner', 'agent', { peerKey: '42', kind: 'user' })).toBe(false);

    // 5-7. Продавец отвечает: сообщение попадает в переписку, агент будится с паузой.
    clock += 60_000;
    dialog.unshift(dm(nextMessageId++, 'Да, продаётся. Отдам за 18 000. Скиньте предоплату на карту 2200 1234.', false));
    expect(await tasks().tick()).toBe(1);
    expect(taskStore().get(taskId)!.state).toBe('agent_turn');
    expect(runner().claim('nick')).toBeNull();
    clock += 21_000;
    const job = runner().claim('nick')!;
    expect(job.kind).toBe('task');
    expect(job.prompt).toContain(`Task id: ${taskId}`);
    expect(job.prompt).not.toContain('18 000'); // переписка в промпт не попадает
    expect(job.prompt).toContain('Never agree to transfer money');

    // 8-9. Агент под токеном запуска читает поручение; слова продавца помечены как чужие.
    const agent = await scoped(job.token);
    expect((await agent.tools()).map(t => t.name).sort()).toEqual(['tg_get_media', 'tg_send', 'tg_status', 'tg_task_get', 'tg_task_update']);
    const view = await agent.call('tg_task_get', { task_id: taskId });
    expect(view.text).toContain('goal: Купить велосипед');
    expect(view.text).toContain('limits: До 15 000 ₽');
    expect(view.text).toContain('only the owner decides: money_transfer, over_limits');
    const nonce = view.text.match(/<<<TG:([0-9a-f]{8})/)![1]!;
    expect(view.text).toContain(`PERSON:\n<<<TG:${nonce}\nДа, продаётся. Отдам за 18 000. Скиньте предоплату на карту 2200 1234.\nTG:${nonce}>>>`);
    expect(view.text).toContain('SENT: Здравствуйте!');

    // 10-11. Цена выше рамок: вопрос владельцу в бот.
    const asked = await agent.call('tg_task_update', { task_id: taskId, state: 'question', question: 'Просит 18 000 при лимите 15 000 и предоплату. Предложить 16 000 без предоплаты?' });
    expect(asked.text).toContain('waiting for the owner to answer a question');
    const question = gw.bot.sent.at(-1)!;
    expect(question.chatId).toBe(NICK_TG);
    expect(question.text).toContain(`Вопрос по поручению ${taskId} (@seller):`);
    expect(question.text).toContain('Предложить 16 000 без предоплаты?');
    expect(question.options.forceReply).toBe(true);
    await agent.close();
    runner().finish('nick', job.id, 0, '');
    expect(taskStore().get(taskId)!.state).toBe('question');

    // 12. Ответ владельца текстом уходит агенту как указание и сразу будит его.
    await approvals().handleUpdate({ update_id: 900, message: { message_id: 901, date: 0, chat: { id: Number(NICK_TG), type: 'private' }, from: { id: Number(NICK_TG) }, text: 'да, но не выше 16, предоплаты не будет', reply_to_message: { message_id: question.messageId } } });
    expect(taskStore().get(taskId)!.state).toBe('agent_turn');
    expect(gw.bot.sent.at(-1)!.text).toContain('Передал агенту указание');
    const job2 = runner().claim('nick')!;
    const agent2 = await scoped(job2.token);
    expect((await agent2.call('tg_task_get', { task_id: taskId })).text).toContain('OWNER: да, но не выше 16, предоплаты не будет');

    // 13. Агент предлагает 16 000: черновик идёт на согласование, владелец отправляет.
    const draft = await agent2.call('tg_send', { task_id: taskId, text: 'Готов взять за 16 000 при самовывозе в субботу, без предоплаты. Подойдёт?' });
    expect(draft.isError, draft.text).toBe(false);
    const sendCard = gw.bot.lastCard();
    expect(sendCard.text).toContain(`Сообщение @seller по поручению ${taskId} (2 из 20)`);
    expect(sendCard.text).toContain(`Источник: task:${taskId}`);
    expect((await agent2.call('tg_send', { task_id: taskId, text: 'ещё одно' })).text).toContain('already waiting');
    await approvals().handleUpdate(gw.bot.press(sendCard, 'Отправить', NICK_TG));
    expect(gw.tg.last('messages.SendMessage').request.message).toContain('16 000');
    expect(taskStore().get(taskId)).toMatchObject({ state: 'waiting_reply', messagesSent: 2 });
    await agent2.close();
    runner().finish('nick', job2.id, 0, '');

    // 14-15. Продавец согласен: агент закрывает поручение, владелец получает отчёт.
    clock += 60_000;
    dialog.unshift(dm(nextMessageId++, 'Хорошо, 16 000. В субботу в 14:00 подойдёт.', false));
    await tasks().tick();
    clock += 21_000;
    const job3 = runner().claim('nick')!;
    const agent3 = await scoped(job3.token);
    const done = await agent3.call('tg_task_update', { task_id: taskId, state: 'done', summary: 'Договорились: 16 000 ₽, самовывоз в субботу в 14:00. Осталось подтвердить адрес продавца.' });
    expect(done.text).toContain('done');
    expect(gw.bot.sent.at(-1)!.text).toContain(`Поручение ${taskId} (@seller) завершено.`);
    expect(gw.bot.sent.at(-1)!.text).toContain('16 000 ₽, самовывоз в субботу');
    await agent3.close();

    // Диалог снова закрыт, продолжать поручение нельзя.
    expect(gw.services.scopes.isAllowed('nick', 'agent', { peerKey: '42', kind: 'user' })).toBe(false);
    expect((await nick.call('tg_send', { task_id: taskId, text: 'ещё вопрос' })).text).toContain('already done');
    expect((await nick.call('tg_inbox')).text).toContain('task');
    expect((await nick.call('tg_tasks')).text).toContain(`task ${taskId} | @seller | account agent | done | messages 2/20`);
  });

  it('владелец может переписать первое сообщение перед отправкой', async () => {
    await nick.call('tg_task_start', START);
    const card = gw.bot.lastCard();
    await approvals().handleUpdate(gw.bot.press(card, 'Изменить', NICK_TG));
    await approvals().handleUpdate(gw.bot.text(NICK_TG, 'Добрый день! Велосипед ещё продаётся?'));
    expect(gw.tg.last('messages.SendMessage').request.message).toBe('Добрый день! Велосипед ещё продаётся?');
  });

  it('отклонённое поручение не создаётся и ничего не пишет', async () => {
    const reply = await nick.call('tg_task_start', START);
    const taskId = reply.text.match(/Task (t_[0-9a-f]+)/)![1]!;
    await approvals().handleUpdate(gw.bot.press(gw.bot.lastCard(), 'Отклонить', NICK_TG));
    expect(taskStore().get(taskId)).toBeNull();
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
  });
});

describe('рамки поручений', () => {
  it('токен запуска не даёт писать мимо своего поручения', async () => {
    const taskId = await startTask();
    clock += 60_000;
    dialog.unshift(dm(nextMessageId++, 'Да', false));
    await tasks().tick();
    clock += 21_000;
    const job = runner().claim('nick')!;
    const agent = await scoped(job.token);
    expect((await agent.call('tg_send', { chat: '@other_person', text: 'привет' })).text).toContain('only inside its task');
    expect((await agent.call('tg_send', { task_id: 't_deadbeef', text: 'привет' })).text).toContain('only to the person of its own task');
    expect((await agent.call('tg_task_update', { task_id: 't_deadbeef', state: 'done', summary: 'x' })).text).toContain('only the task it was started for');
    expect((await agent.call('tg_task_get', { task_id: 't_deadbeef' })).text).toContain('not found');
    expect((await agent.call('tg_task_get', { task_id: taskId })).isError).toBe(false);
    await agent.close();
  });

  it('предел сообщений, одно поручение на человека, бот и чат не подходят', async () => {
    const taskId = await startTask({ max_messages: 1 });
    expect((await nick.call('tg_send', { task_id: taskId, text: 'второе' })).text).toContain('reached its limit of 1 messages');
    expect((await nick.call('tg_task_start', START)).text).toContain('already an active task with this person');
    expect((await nick.call('tg_task_start', { ...START, peer: '@some_bot' })).text).toContain('cannot be started with a bot');
    expect((await nick.call('tg_task_start', { ...START, peer: '@fresh_user', goal: '  ' })).text).toContain('Task goal is empty');
    expect((await nick.call('tg_task_start', { ...START, peer: '@fresh_user', deadline: '90d' })).text).toContain('Invalid "deadline"');
  });

  it('второй пользователь видит поручение на общем аккаунте, но не меняет его', async () => {
    const taskId = await startTask();
    const partner = await gw.client('partner', ALL);
    expect((await partner.call('tg_tasks')).text).toContain(`task ${taskId} | @seller | account agent | waiting for the person to reply | messages 1/20`);
    expect((await partner.call('tg_tasks')).text).toContain('by nick (read only)');
    expect((await partner.call('tg_task_get', { task_id: taskId })).isError).toBe(false);
    expect((await partner.call('tg_send', { task_id: taskId, text: 'вмешаюсь' })).text).toContain('belongs to another user');
    expect((await partner.call('tg_tasks', { action: 'stop', task_id: taskId })).text).toContain('not found or belongs to another user');
    // вопрос чужого поручения второму человеку не приходит, и ответить на него он не может
    await tasks().ask(taskId, 'nick', 'Что делать?');
    await approvals().handleUpdate(gw.bot.text(PARTNER_TG, 'я отвечу'));
    expect(taskStore().get(taskId)!.state).toBe('question');
    await partner.close();
  });

  it('поручение на личном аккаунте второму пользователю не видно', async () => {
    const taskId = await startTask({ account: 'nick' });
    const partner = await gw.client('partner', ALL);
    expect((await partner.call('tg_tasks')).text).toContain('Tasks: 0');
    expect((await partner.call('tg_task_get', { task_id: taskId })).text).toContain('not found');
    await partner.close();
  });

  it('остановка закрывает диалог сразу и без согласования', async () => {
    const taskId = await startTask();
    const cards = gw.bot.sent.length;
    const stopped = await nick.call('tg_tasks', { action: 'stop', task_id: taskId });
    expect(stopped.text).toContain('The task is stopped');
    expect(gw.bot.sent.length).toBe(cards);
    expect(taskStore().get(taskId)!.state).toBe('closed');
    expect(gw.services.scopes.isAllowed('nick', 'agent', { peerKey: '42', kind: 'user' })).toBe(false);
    // новые сообщения продавца агента больше не будят
    dialog.unshift(dm(nextMessageId++, 'Алло?', false));
    clock += 60_000;
    expect(await tasks().tick()).toBe(0);
  });

  it('срок истёк: поручение закрывается, владелец получает сообщение', async () => {
    const taskId = await startTask({ deadline: '12h' });
    clock += 13 * 3_600_000;
    await tasks().sweep();
    expect(taskStore().get(taskId)!.state).toBe('closed');
    expect(gw.bot.sent.at(-1)!.text).toContain(`Поручение ${taskId} (@seller) закрыто: вышел срок.`);
  });

  it('одно напоминание после молчания собеседника', async () => {
    const taskId = await startTask({ reminder_after: '24h' });
    clock += 25 * 3_600_000;
    await tasks().sweep();
    expect(taskStore().get(taskId)).toMatchObject({ state: 'agent_turn', reminderSent: true });
    const job = runner().claim('nick')!;
    const agent = await scoped(job.token);
    expect((await agent.call('tg_task_get', { task_id: taskId })).text).toContain('ONE short polite reminder');
    expect((await agent.call('tg_task_update', { task_id: taskId, state: 'waiting' })).text).toContain('waiting for the person to reply');
    await agent.close();
    runner().finish('nick', job.id, 0, '');
    // второго напоминания не будет
    clock += 25 * 3_600_000;
    await tasks().sweep();
    expect(runner().claim('nick')).toBeNull();
  });

  it('ответ без Reply принимается, только когда открытый вопрос один', async () => {
    const first = await startTask();
    const secondReply = await nick.call('tg_task_start', { ...START, peer: '@fresh_user' });
    const second = secondReply.text.match(/Task (t_[0-9a-f]+)/)![1]!;
    await approvals().handleUpdate(gw.bot.press(gw.bot.lastCard(), 'Начать', NICK_TG));
    await tasks().ask(first, 'nick', 'Вопрос один?');
    await tasks().ask(second, 'nick', 'Вопрос два?');
    const secondQuestionMessage = gw.bot.sent.at(-1)!.messageId;

    await approvals().handleUpdate(gw.bot.text(NICK_TG, 'непонятно кому'));
    expect(taskStore().get(first)!.state).toBe('question');
    expect(taskStore().get(second)!.state).toBe('question');

    await approvals().handleUpdate({ update_id: 1, message: { message_id: 5, date: 0, chat: { id: Number(NICK_TG), type: 'private' }, from: { id: Number(NICK_TG) }, text: 'это второму', reply_to_message: { message_id: secondQuestionMessage } } });
    expect(taskStore().get(second)!.state).toBe('agent_turn');
    await approvals().handleUpdate(gw.bot.text(NICK_TG, 'а это оставшемуся'));
    expect(taskStore().get(first)!.state).toBe('agent_turn');
  });

  it('обычное сообщение в чат тоже идёт через согласование, личка закрыта', async () => {
    const closed = await nick.call('tg_send', { chat: '@fresh_user', text: 'привет' });
    expect(closed.text).toContain('Private chats are closed by default');
    gw.storage.scopes.put({ userId: 'nick', accountId: 'agent', target: 'fresh_user', effect: 'allow', source: 'owner' });
    const drafted = await nick.call('tg_send', { chat: '@fresh_user', text: 'привет' });
    expect(drafted.text).toContain('Nothing is sent until the owner taps Send');
    expect(gw.bot.lastCard().text).toContain('Сообщение в @fresh_user');
    await approvals().handleUpdate(gw.bot.press(gw.bot.lastCard(), 'Отправить', NICK_TG));
    expect(gw.tg.last('messages.SendMessage').request.message).toBe('привет');
  });
});

describe('поручение через Business-бота', () => {
  const CONNECTION = 'bc_nick_1';

  function connect(): Promise<void> {
    return approvals().handleUpdate({ update_id: 1, business_connection: { id: CONNECTION, user: { id: Number(NICK_TG) }, is_enabled: true } });
  }

  const business = (messageId: number, fromId: number, text: string, chatId = SELLER) => ({
    update_id: 500 + messageId,
    business_message: { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' }, from: { id: fromId }, text, business_connection_id: CONNECTION },
  });

  it('без подключения бота режим business недоступен', async () => {
    const reply = await nick.call('tg_task_start', { ...START, via: 'business' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain('Business, Chatbots');
    // подключение от незнакомого человека не принимается
    await approvals().handleUpdate({ update_id: 2, business_connection: { id: 'bc_x', user: { id: 31337 }, is_enabled: true } });
    expect(tasks().businessConnection('nick')).toBeNull();
  });

  it('первое сообщение отправляет владелец, дальше бот отвечает от его имени', async () => {
    await connect();
    expect(tasks().businessConnection('nick')).toBe(CONNECTION);

    const reply = await nick.call('tg_task_start', { ...START, via: 'business' });
    const taskId = reply.text.match(/Task (t_[0-9a-f]+)/)![1]!;
    expect(gw.bot.lastCard().text).toContain('Способ: от твоего имени через Business-бота. Первое сообщение отправляешь ты сам.');
    await approvals().handleUpdate(gw.bot.press(gw.bot.lastCard(), 'Начать', NICK_TG));

    // шлюз сам ничего не отправил: владелец получил готовый текст и ссылку на чат
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    const handoff = gw.bot.sent.at(-1)!;
    expect(handoff.text).toContain('отправь первое сообщение сам');
    expect(handoff.text).toContain('https://t.me/seller?text=' + encodeURIComponent(START.first_message));
    expect(taskStore().get(taskId)).toMatchObject({ via: 'business', accountId: null, state: 'waiting_reply', reminderAfterMs: null });

    // владелец написал сам, продавец ответил: оба сообщения в переписке, агент разбужен
    await approvals().handleUpdate(business(10, Number(NICK_TG), START.first_message));
    await approvals().handleUpdate(business(11, SELLER, 'Да, продаётся, 14 000'));
    expect(taskStore().get(taskId)!.state).toBe('agent_turn');
    clock += 21_000;
    const job = runner().claim('nick')!;
    const agent = await scoped(job.token);
    const view = await agent.call('tg_task_get', { task_id: taskId });
    expect(view.text).toContain('via business bot');
    expect(view.text).toContain('Да, продаётся, 14 000');
    expect(view.text).toContain(`SENT: ${START.first_message}`);

    // ответ агента после согласования уходит через бота с business_connection_id
    await agent.call('tg_send', { task_id: taskId, text: 'Отлично, беру за 14 000. Суббота, 14:00?' });
    await approvals().handleUpdate(gw.bot.press(gw.bot.lastCard(), 'Отправить', NICK_TG));
    const sent = gw.bot.sent.at(-1)!;
    expect(sent.chatId).toBe(String(SELLER));
    expect(sent.options.businessConnectionId).toBe(CONNECTION);
    expect(gw.tg.callsOf('messages.SendMessage')).toHaveLength(0);
    expect(taskStore().get(taskId)).toMatchObject({ state: 'waiting_reply', messagesSent: 1 });
    await agent.close();
  });

  it('сообщения из чатов без поручения шлюз не хранит', async () => {
    await connect();
    await approvals().handleUpdate(business(20, 5555, 'личное сообщение от друга', 5555));
    const raw = JSON.stringify(gw.storage.db.prepare('SELECT * FROM task_messages').all()) + JSON.stringify(gw.storage.db.prepare('SELECT * FROM inbox').all());
    expect(raw).not.toContain('личное сообщение от друга');
  });

  it('окно 24 часа: отказ бота объясняется владельцу', async () => {
    await connect();
    const reply = await nick.call('tg_task_start', { ...START, via: 'business' });
    const taskId = reply.text.match(/Task (t_[0-9a-f]+)/)![1]!;
    await approvals().handleUpdate(gw.bot.press(gw.bot.lastCard(), 'Начать', NICK_TG));
    await nick.call('tg_send', { task_id: taskId, text: 'Вы ещё тут?' });
    const card = gw.bot.lastCard();
    const original = gw.bot.sendMessage.bind(gw.bot);
    gw.bot.sendMessage = async (chatId, text, options) => {
      if (options?.businessConnectionId) throw new BotApiError('sendMessage', 400, 'Bad Request: BUSINESS_PEER_USAGE_MISSING');
      return original(chatId, text, options);
    };
    await approvals().handleUpdate(gw.bot.press(card, 'Отправить', NICK_TG));
    expect(gw.bot.edits.at(-1)!.text).toContain('only within 24 hours');
  });

  it('отключение бота владельцем убирает подключение', async () => {
    await connect();
    await approvals().handleUpdate({ update_id: 3, business_connection: { id: CONNECTION, user: { id: Number(NICK_TG) }, is_enabled: false } });
    expect(tasks().businessConnection('nick')).toBeNull();
  });
});
