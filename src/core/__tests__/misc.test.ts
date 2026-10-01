import { describe, expect, it, vi } from 'vitest';
import { randomToken, safeEqualHex, seal, sha256Hex, unseal } from '../crypto.js';
import { createLogger, parseLogLevel, redactFields } from '../log.js';
import { normalizeReactions, reactionKey, totalReactions } from '../reactions.js';
import { DeadlineError, envNumber, withTimeout } from '../time.js';

describe('crypto', () => {
  it('шифрует и расшифровывает сессию', () => {
    const sealed = seal('1BQANOTAREALSESSION==', 'secret-key');
    expect(sealed.data).not.toContain('1BQANOTAREALSESSION');
    expect(unseal(sealed, 'secret-key')).toBe('1BQANOTAREALSESSION==');
  });

  it('у каждой записи свой iv', () => {
    expect(seal('same', 'k').iv).not.toBe(seal('same', 'k').iv);
  });

  it('чужой ключ и порча данных дают ошибку', () => {
    const sealed = seal('payload', 'right');
    expect(() => unseal(sealed, 'wrong')).toThrow();
    expect(() => unseal({ ...sealed, data: 'zz' }, 'right')).toThrow();
  });

  it('хэши токенов сравниваются за постоянное время', () => {
    const token = randomToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(safeEqualHex(sha256Hex(token), sha256Hex(token))).toBe(true);
    expect(safeEqualHex(sha256Hex(token), sha256Hex(token + 'x'))).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
  });
});

describe('log', () => {
  it('пишет строку с уровнем, тегом и полями', () => {
    const lines: string[] = [];
    const log = createLogger('core', { level: 'debug', write: l => lines.push(l), now: () => new Date(0) });
    log.child('limiter').info('queued', { account: 'agent', n: 2 });
    expect(lines).toEqual(['1970-01-01T00:00:00.000Z INFO [core:limiter] queued {"account":"agent","n":2}']);
  });

  it('уважает уровень и прячет секреты', () => {
    const lines: string[] = [];
    const log = createLogger('t', { level: 'warn', write: l => lines.push(l) });
    log.info('skipped');
    log.warn('auth', { token: 'abc', apiHash: 'def', sessionString: 'x', user: 'nick' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('abc');
    expect(lines[0]).not.toContain('def');
    expect(lines[0]).toContain('"user":"nick"');
    expect(redactFields({ Authorization: 'Bearer 1', n: 1n })).toEqual({ Authorization: '[redacted]', n: '1' });
    expect(parseLogLevel('nonsense')).toBe('info');
  });
});

describe('reactions', () => {
  it('даёт единый ключ для GramJS и Bot API', () => {
    expect(reactionKey({ emoticon: '👍' })).toBe('👍');
    expect(reactionKey({ type: 'emoji', emoji: '👍' })).toBe('👍');
    expect(reactionKey({ documentId: 5368324170671202286n })).toBe('custom:5368324170671202286');
    expect(reactionKey({ type: 'custom_emoji', custom_emoji_id: '42' })).toBe('custom:42');
    expect(reactionKey({ className: 'ReactionPaid' })).toBe('paid');
    expect(reactionKey(null)).toBe('null');
  });

  it('нормализует счётчики по убыванию', () => {
    const reactions = normalizeReactions({
      results: [
        { reaction: { emoticon: '🔥' }, count: 2 },
        null,
        { reaction: { emoticon: '👍' }, count: 7 },
        { reaction: { emoticon: '😡' } },
      ],
    });
    expect(reactions).toEqual([
      { reaction: '👍', count: 7 },
      { reaction: '🔥', count: 2 },
    ]);
    expect(totalReactions(reactions)).toBe(9);
    expect(normalizeReactions(undefined)).toEqual([]);
  });
});

describe('time', () => {
  it('withTimeout отдаёт результат и снимает таймер', async () => {
    await expect(withTimeout(Promise.resolve(5), 1000, 'op')).resolves.toBe(5);
  });

  it('withTimeout бросает DeadlineError на зависшем промисе', async () => {
    vi.useFakeTimers();
    try {
      const hung = new Promise<never>(() => undefined);
      const p = withTimeout(hung, 5000, 'messages.GetHistory');
      const assertion = expect(p).rejects.toBeInstanceOf(DeadlineError);
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('envNumber возвращает значение по умолчанию на мусоре', () => {
    process.env.TG_MCP_TEST_NUM = 'abc';
    expect(envNumber('TG_MCP_TEST_NUM', 7)).toBe(7);
    process.env.TG_MCP_TEST_NUM = '12';
    expect(envNumber('TG_MCP_TEST_NUM', 7)).toBe(12);
    expect(envNumber('TG_MCP_TEST_NUM', 7, 0, 10)).toBe(7);
    delete process.env.TG_MCP_TEST_NUM;
  });
});
