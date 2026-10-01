import { RPCMessageToError } from 'telegram/errors/index.js';
import { describe, expect, it } from 'vitest';
import { classifyError, floodInfo, GatewayError, getFloodWaitSeconds, telegramErrorCode } from '../errors.js';
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

/** Ошибка ровно в том виде, в каком её создаёт GramJS из ответа Telegram. */
function realTelegramError(code: number, message: string, method = 'messages.Search'): Error {
  return RPCMessageToError({ errorCode: code, errorMessage: message } as never, { className: method } as never) as Error;
}

describe('ошибки в том виде, в каком их создаёт GramJS', () => {
  it('FLOOD_WAIT: у настоящей ошибки errorMessage «FLOOD», а секунды в поле seconds', () => {
    const err = realTelegramError(420, 'FLOOD_WAIT_42');
    expect((err as { errorMessage?: string }).errorMessage).toBe('FLOOD');
    expect(floodInfo(err)).toEqual({ seconds: 42, scope: 'account' });
    expect(classifyError(err)).toMatchObject({ code: 'FLOOD_WAIT', retryAfter: 42 });
    expect(floodInfo(realTelegramError(420, 'FLOOD_PREMIUM_WAIT_7'))).toEqual({ seconds: 7, scope: 'account' });
  });

  it('медленный режим это пауза одного чата, а не аккаунта', () => {
    const err = realTelegramError(420, 'SLOWMODE_WAIT_30', 'messages.SendMessage');
    expect(floodInfo(err)).toEqual({ seconds: 30, scope: 'chat' });
    const classified = classifyError(err);
    expect(classified).toMatchObject({ code: 'FLOOD_WAIT', retryAfter: 30 });
    expect(classified.message).toContain('Slow mode in this chat');
  });

  it('MSG_WAIT_FAILED не считается паузой', () => {
    const err = realTelegramError(420, 'MSG_WAIT_FAILED');
    expect(floodInfo(err)).toBeNull();
    expect(classifyError(err).code).toBe('TELEGRAM_ERROR');
  });

  it('удалённый собеседник не выглядит как потеря сессии', () => {
    expect(classifyError(realTelegramError(400, 'INPUT_USER_DEACTIVATED')).code).toBe('CHAT_NOT_FOUND');
    expect(classifyError(realTelegramError(401, 'USER_DEACTIVATED')).code).toBe('ACCOUNT_UNAUTHORIZED');
    expect(classifyError(realTelegramError(401, 'AUTH_KEY_UNREGISTERED')).code).toBe('ACCOUNT_UNAUTHORIZED');
  });

  it('код Telegram сохраняется для тех, кто разбирает исход записи', () => {
    expect(classifyError(realTelegramError(400, 'USER_ALREADY_PARTICIPANT')).telegramCode).toBe('USER_ALREADY_PARTICIPANT');
    expect(classifyError(realTelegramError(400, 'INVITE_REQUEST_SENT')).telegramCode).toBe('INVITE_REQUEST_SENT');
    expect(classifyError(realTelegramError(400, 'CHANNEL_PRIVATE')).code).toBe('CHAT_PRIVATE');
  });
});
