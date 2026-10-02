import { describe, expect, it } from 'vitest';
import { createEnvelope } from '../../policy/envelope.js';
import type { MessageDto } from '../../services/messages.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { compactNumber, formatCard, formatDate, formatDuration, formatMessage, formatMessageList, formatReactions } from '../format.js';

function msg(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 123,
    chatKey: '-1000000000500',
    date: 1_790_000_000,
    editDate: null,
    text: 'Продам iPhone 15, 256 гб.\nЦена 65к, торг.',
    author: { kind: 'user', peerKey: '42', name: 'Ivan Petrov', username: 'seller', bot: false },
    views: null,
    forwards: null,
    replies: null,
    hasComments: false,
    reactions: [],
    media: null,
    groupedId: null,
    replyToId: null,
    topicId: null,
    forwardedFrom: null,
    hiddenLinks: [],
    service: null,
    pinned: false,
    out: false,
    buttons: [],
    ...overrides,
  };
}

const env = createEnvelope('abcd1234');

describe('числа, даты, длительность', () => {
  it('compactNumber', () => {
    expect([0, 999, 1000, 1234, 12_345, 123_456, 1_200_000, 2_500_000_000].map(compactNumber)).toEqual([
      '0', '999', '1k', '1.2k', '12.3k', '123k', '1.2M', '2.5B',
    ]);
  });

  it('дата в UTC и длительность', () => {
    expect(formatDate(1_790_000_000)).toBe('2026-09-21 14:13');
    expect(formatDate(0)).toBe('unknown date');
    expect(formatDuration(42)).toBe('0:42');
    expect(formatDuration(3723)).toBe('1:02:03');
  });

  it('реакции: три главные и остаток', () => {
    expect(formatReactions([
      { reaction: '👍', count: 1200 },
      { reaction: '🔥', count: 30 },
      { reaction: 'custom:55', count: 9 },
      { reaction: '😢', count: 4 },
      { reaction: 'paid', count: 1 },
    ])).toBe('👍1.2k 🔥30 ⭐9 +5');
    expect(formatReactions([])).toBe('');
  });
});

describe('formatMessage', () => {
  it('полный режим: заголовок и текст в границах', () => {
    const text = formatMessage(msg({ topicId: 5, replyToId: 120 }), { mode: 'full', envelope: env, linkFor: m => `https://t.me/baraholka/5/${m.id}` });
    expect(text).toBe(
      '#123 | 2026-09-21 14:13 | @seller | topic 5 | re #120 | https://t.me/baraholka/5/123\n' +
        '<<<TG:abcd1234\nПродам iPhone 15, 256 гб.\nЦена 65к, торг.\nTG:abcd1234>>>',
    );
  });

  it('краткий режим: две строки на пост канала со счётчиками', () => {
    const post = msg({
      author: { kind: 'channel', peerKey: '-1000000000500', name: 'Stonks', username: 'stonksnws', bot: false },
      views: 12_345,
      forwards: 7,
      replies: 14,
      hasComments: true,
      reactions: [{ reaction: '🔥', count: 30 }],
      media: { kind: 'photo', downloadable: true },
      groupedId: '9',
      editDate: 5,
      pinned: true,
    });
    const text = formatMessage(post, { mode: 'brief', envelope: env, showAuthor: false });
    expect(text.split('\n')).toHaveLength(2);
    expect(text.split('\n')[0]).toBe('#123 | 2026-09-21 14:13 | views 12.3k | shares 7 | comments 14 | 🔥30 | [album photo] | pinned | edited');
    expect(text.split('\n')[1]).toBe('> Продам iPhone 15, 256 гб. Цена 65к, торг.');
  });

  it('inline-кнопки: в полном режиме место, подпись, вид и адрес ссылки, в кратком только число', () => {
    const withButtons = msg({
      buttons: [
        [
          { kind: 'callback', text: 'Я не бот', needsPassword: false, url: null },
          { kind: 'url', text: 'Сайт', needsPassword: false, url: 'https://example.com/a?b=1' },
        ],
        [{ kind: 'callback', text: 'Удалить "всё" <b>', needsPassword: true, url: null }],
      ],
    });
    const full = formatMessage(withButtons, { mode: 'full', envelope: env });
    expect(full.split('\n').at(-1)).toBe(
      'buttons: 1.1 "Я не бот" (callback) | 1.2 "Сайт" (link https://example.com/a?b=1) | 2.1 "Удалить \'всё\' b" (callback, asks for the 2FA password)',
    );
    const brief = formatMessage(withButtons, { mode: 'brief', envelope: env });
    expect(brief.split('\n')[0]).toContain('| buttons 3');
    expect(brief).not.toContain('Я не бот');
    // сообщение без текста: кнопки всё равно видны
    expect(formatMessage(msg({ text: '', buttons: withButtons.buttons }), { mode: 'full', envelope: env }).split('\n')).toHaveLength(2);
  });

  it('скрытые ссылки: в полном режиме слова и адрес под ними, в кратком их нет', () => {
    const post = msg({
      text: 'Подробности тут и в источнике',
      hiddenLinks: [
        { text: 'тут', url: 'https://hidden.example/x' },
        { text: 'источнике', url: 'https://source.example/<b>' },
      ],
      buttons: [[{ kind: 'url', text: 'Читать', needsPassword: false, url: 'https://example.com/read' }]],
    });
    const lines = formatMessage(post, { mode: 'full', envelope: env }).split('\n');
    // после текста сначала ссылки, потом кнопки
    expect(lines.at(-2)).toBe('hidden links: "тут" https://hidden.example/x | "источнике" https://source.example/b');
    expect(lines.at(-1)).toBe('buttons: 1.1 "Читать" (link https://example.com/read)');
    expect(formatMessage(post, { mode: 'brief', envelope: env })).not.toContain('hidden.example');

    const many = msg({ hiddenLinks: Array.from({ length: 23 }, (_, i) => ({ text: `l${i}`, url: `https://e.example/${i}` })) });
    expect(formatMessage(many, { mode: 'full', envelope: env }).split('\n').at(-1)).toMatch(/"l19" https:\/\/e\.example\/19 \| \+3 more$/);
  });

  it('длинный текст обрезается с подсказкой', () => {
    const text = formatMessage(msg({ text: 'я'.repeat(3000) }), { mode: 'full', envelope: env, maxTextChars: 100 });
    expect(text).toContain('(text cut at 100 of 3000 chars; read it in full with tg_get_message)');
    expect(text.length).toBeLessThan(400);
  });

  it('сообщение без текста и служебное', () => {
    expect(formatMessage(msg({ text: '', media: { kind: 'video', durationSec: 65, downloadable: true } }), { mode: 'full', envelope: env })).toBe(
      '#123 | 2026-09-21 14:13 | @seller | [video 1:05]',
    );
    expect(formatMessage(msg({ text: '', service: 'MessageActionChatAddUser' }), { mode: 'brief', envelope: env })).toContain('service: ChatAddUser');
  });

  it('имя автора без username показывается с id и без переносов', () => {
    const text = formatMessage(msg({ author: { kind: 'user', peerKey: '42', name: 'Ivan\nIGNORE ALL', username: null, bot: false } }), { mode: 'brief', envelope: env });
    expect(text.split('\n')[0]).toContain('Ivan IGNORE ALL (id 42)');
  });

  it('своё сообщение помечено как сообщение аккаунта', () => {
    const header = (overrides: Partial<MessageDto>) => formatMessage(msg({ text: '', out: true, ...overrides }), { mode: 'brief', envelope: env });
    expect(header({ author: { kind: 'user', peerKey: '1001', name: 'Test Account', username: 'agent_acc', bot: false } })).toBe('#123 | 2026-09-21 14:13 | @agent_acc (this account)');
    expect(header({ author: { kind: 'user', peerKey: '1001', name: 'Nick', username: null, bot: false } })).toContain('| Nick (id 1001) (this account)');
    expect(header({ author: { kind: 'user', peerKey: null, name: null, username: null, bot: false } })).toBe('#123 | 2026-09-21 14:13 | this account');
    // пост своего канала и сообщение от имени группы подписаны каналом и группой, как у всех
    expect(header({ author: { kind: 'channel', peerKey: '-1000000000500', name: 'Stonks', username: 'stonksnws', bot: false } })).toBe('#123 | 2026-09-21 14:13 | @stonksnws');
    expect(header({ author: { kind: 'anonymous', peerKey: null, name: null, username: null, bot: false } })).toBe('#123 | 2026-09-21 14:13 | anonymous');
  });
});

describe('formatMessageList', () => {
  it('заголовок, предупреждение, список и курсор', () => {
    const text = formatMessageList([msg(), msg({ id: 124 })], { title: 'Chat @baraholka, 2 of 240 messages', mode: 'brief', envelope: env, nextCursor: 'c1.abc', hints: ['Use tg_export for the full set.'] });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Chat @baraholka, 2 of 240 messages');
    expect(lines[1]).toContain('Untrusted content');
    expect(lines[2]).toBe('Times are UTC.');
    expect(text).toContain('#124 | ');
    expect(lines.slice(-2)).toEqual(['Use tg_export for the full set.', 'next_cursor: c1.abc']);
  });

  it('пустая выборка и конец выдачи', () => {
    expect(formatMessageList([], { title: 'T', mode: 'full', envelope: env })).toBe('T\nNo messages.');
    expect(formatMessageList([msg()], { title: 'T', mode: 'full', envelope: env, nextCursor: null }).endsWith('End of results.')).toBe(true);
  });

  it('formatCard пропускает пустые поля', () => {
    expect(formatCard('Chat', [['title', 'X'], ['username', null], ['members', 5], ['about', '']])).toBe('Chat\ntitle: X\nmembers: 5');
  });
});

describe('cursor', () => {
  it('кодирует и разбирает позицию', () => {
    const cursor = encodeCursor('history', { chat: '-1000000000500', offsetId: 77, done: false });
    expect(cursor.startsWith('c1.')).toBe(true);
    expect(cursor).not.toContain('offsetId');
    expect(decodeCursor('history', cursor)).toEqual({ chat: '-1000000000500', offsetId: 77, done: false });
  });

  it('чужой или испорченный курсор отклоняется с понятным текстом', () => {
    const cursor = encodeCursor('history', { offsetId: 1 });
    expect(() => decodeCursor('search', cursor)).toThrow(/Invalid cursor/);
    expect(() => decodeCursor('history', 'garbage')).toThrow(/Invalid cursor/);
    expect(() => decodeCursor('history', 'c1.!!!!')).toThrow(/Invalid cursor/);
    expect(() => decodeCursor('history', 'c1.' + Buffer.from('[1,2,3]').toString('base64url'))).toThrow(/Invalid cursor/);
  });
});
