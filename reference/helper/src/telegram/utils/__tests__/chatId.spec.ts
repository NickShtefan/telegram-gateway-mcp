import { describe, it, expect } from 'vitest';
import { toBotApiChatId, toMtprotoChannelId, isBotApiChannelId } from '../chatId.js';

describe('chatId conversions', () => {
  it('converts MTProto channel id to Bot API form', () => {
    expect(toBotApiChatId(1782171896)).toBe(-1001782171896);
  });

  it('accepts string and bigint inputs', () => {
    expect(toBotApiChatId('1782171896')).toBe(-1001782171896);
    expect(toBotApiChatId(BigInt(1782171896))).toBe(-1001782171896);
  });

  it('round-trips both directions', () => {
    const mtproto = 1188822563;
    expect(toMtprotoChannelId(toBotApiChatId(mtproto))).toBe(mtproto);
  });

  it('throws on non-positive MTProto id', () => {
    expect(() => toBotApiChatId(-1001782171896)).toThrow();
    expect(() => toBotApiChatId(0)).toThrow();
    expect(() => toBotApiChatId('garbage')).toThrow();
  });

  it('throws when Bot API form is expected but not given', () => {
    expect(() => toMtprotoChannelId(1782171896)).toThrow();
    expect(() => toMtprotoChannelId(-42)).toThrow();
  });

  it('isBotApiChannelId distinguishes forms', () => {
    expect(isBotApiChannelId(-1001782171896)).toBe(true);
    expect(isBotApiChannelId(1782171896)).toBe(false);
    expect(isBotApiChannelId(-42)).toBe(false);
  });
});
