import { describe, expect, it } from 'vitest';
import { classifyError, GatewayError, getFloodWaitSeconds, telegramErrorCode } from '../errors.js';
import { DeadlineError } from '../time.js';

describe('getFloodWaitSeconds', () => {
  it('берёт seconds из FloodWaitError GramJS', () => {
    expect(getFloodWaitSeconds({ seconds: 42, errorMessage: 'FLOOD_WAIT_42', message: 'A wait of 42 seconds is required' })).toBe(42);
  });

  it('разбирает число из текста', () => {
    expect(getFloodWaitSeconds(new Error('420: FLOOD_WAIT_17 (caused by messages.Search)'))).toBe(17);
    expect(getFloodWaitSeconds(new Error('FLOOD_PREMIUM_WAIT_5'))).toBe(5);
    expect(getFloodWaitSeconds(new Error('SLOWMODE_WAIT_30'))).toBe(30);
  });

  it('возвращает 0, если FLOOD_WAIT без числа', () => {
    expect(getFloodWaitSeconds(new Error('FLOOD_WAIT'))).toBe(0);
  });

  it('не считает ожиданием чужие ошибки с полем seconds', () => {
    expect(getFloodWaitSeconds({ seconds: 3, errorMessage: 'PHONE_MIGRATE_2', message: 'migrate' })).toBeNull();
    expect(getFloodWaitSeconds(new Error('CHANNEL_PRIVATE'))).toBeNull();
    expect(getFloodWaitSeconds(null)).toBeNull();
  });
});

describe('classifyError', () => {
  it('FLOOD_WAIT отдаёт retryAfter и запрет повтора', () => {
    const e = classifyError({ seconds: 300, errorMessage: 'FLOOD_WAIT_300', message: 'wait' });
    expect(e.code).toBe('FLOOD_WAIT');
    expect(e.retryAfter).toBe(300);
    expect(e.message).toContain('Do NOT retry');
  });

  it('раскладывает ошибки Telegram по смыслу', () => {
    expect(classifyError(new Error('CHANNEL_PRIVATE')).code).toBe('CHAT_PRIVATE');
    expect(classifyError(new Error('USERNAME_NOT_OCCUPIED')).code).toBe('CHAT_NOT_FOUND');
    expect(classifyError(new Error('MSG_ID_INVALID')).code).toBe('MESSAGE_NOT_FOUND');
    expect(classifyError(new Error('INVITE_HASH_EXPIRED')).code).toBe('INVITE_INVALID');
    expect(classifyError(new Error('PEER_FLOOD')).code).toBe('PEER_FLOOD');
    expect(classifyError(new Error('ALLOW_PAYMENT_REQUIRED')).code).toBe('PAYMENT_REQUIRED');
    expect(classifyError(new Error('CHAT_WRITE_FORBIDDEN')).code).toBe('WRITE_FORBIDDEN');
    expect(classifyError(new Error('AUTH_KEY_DUPLICATED')).code).toBe('ACCOUNT_UNAUTHORIZED');
  });

  it('таймаут записи помечает исход как неизвестный', () => {
    const read = classifyError(new DeadlineError('messages.GetHistory', 1000));
    expect(read.code).toBe('TIMEOUT');
    expect(read.outcomeUnknown).toBe(false);
    const write = classifyError(new DeadlineError('messages.SendMessage', 1000), { write: true });
    expect(write.outcomeUnknown).toBe(true);
    expect(write.message).toContain('UNKNOWN');
  });

  it('неизвестная ошибка сохраняет код Telegram', () => {
    const e = classifyError({ errorMessage: 'SOMETHING_NEW_HAPPENED', message: '400: SOMETHING_NEW_HAPPENED' });
    expect(e.code).toBe('TELEGRAM_ERROR');
    expect(e.telegramCode).toBe('SOMETHING_NEW_HAPPENED');
  });

  it('GatewayError возвращается как есть', () => {
    const original = new GatewayError('ACCESS_DENIED', 'nope');
    expect(classifyError(original)).toBe(original);
  });

  it('telegramErrorCode достаёт код из текста', () => {
    expect(telegramErrorCode(new Error('400: CHANNEL_INVALID (caused by channels.GetFullChannel)'))).toBe('CHANNEL_INVALID');
    expect(telegramErrorCode(new Error('socket hang up'))).toBeUndefined();
  });
});
