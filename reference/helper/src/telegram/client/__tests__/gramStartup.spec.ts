import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ExitProcess } from '../gramFatalRecovery.js';
import {
  DEFAULT_GRAM_STARTUP_TIMEOUT_MS,
  gramStartupTimeoutMs,
  initGramClientOrExit,
} from '../gramStartup.js';

const ENV_KEY = 'GRAM_STARTUP_TIMEOUT_MS';

function recoveryLine(timeoutMs: number): string {
  return `[GramRecovery] fatal MTProto timeout: GramClient startup (connect/getMe) timed out after ${timeoutMs}ms; exiting for Docker restart`;
}

function recoveryLogged(spy: MockInstance): boolean {
  return spy.mock.calls.some(args => String(args[0]).startsWith('[GramRecovery]'));
}

describe('initGramClientOrExit', () => {
  let errorSpy: MockInstance;
  let warnSpy: MockInstance;
  // Настоящий process.exit не возвращается; мок возвращается, чтобы поймать
  // проваливание во вторую ветку (двойной exit / лишний лог).
  let exit: ReturnType<typeof vi.fn<ExitProcess>>;
  let savedEnv: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    exit = vi.fn<ExitProcess>();
  });

  afterEach(() => {
    vi.useRealTimers();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  it('exits via GramRecovery when startup never settles within the default deadline', async () => {
    expect(DEFAULT_GRAM_STARTUP_TIMEOUT_MS).toBe(120_000);
    const init = vi.fn(() => new Promise<void>(() => {}));

    const done = initGramClientOrExit(init, exit);

    await vi.advanceTimersByTimeAsync(119_999);
    expect(exit).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(recoveryLine(120_000));
    expect(warnSpy).not.toHaveBeenCalled();

    await done;
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('clears the deadline on success so a healthy process is never killed later', async () => {
    const init = vi.fn(
      () => new Promise<void>(resolve => setTimeout(resolve, 1_000))
    );

    const done = initGramClientOrExit(init, exit);
    await vi.advanceTimersByTimeAsync(1_000);
    await done;

    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(DEFAULT_GRAM_STARTUP_TIMEOUT_MS * 10);
    expect(exit).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('keeps the existing init error path when startup rejects before the deadline', async () => {
    const message = '[GramClient] Failed to authorise with STRING_SESSION.';
    const init = vi.fn(
      () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error(message)), 2_000))
    );

    const done = initGramClientOrExit(init, exit);
    await vi.advanceTimersByTimeAsync(2_000);
    await done;

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('Ошибка инициализации GramJS-клиента:', message);
    expect(recoveryLogged(errorSpy)).toBe(false);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(DEFAULT_GRAM_STARTUP_TIMEOUT_MS * 10);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(recoveryLogged(errorSpy)).toBe(false);
  });

  it('honours GRAM_STARTUP_TIMEOUT_MS override', async () => {
    process.env[ENV_KEY] = '5000';
    const init = vi.fn(() => new Promise<void>(() => {}));

    const done = initGramClientOrExit(init, exit);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(recoveryLine(5_000));
    expect(warnSpy).not.toHaveBeenCalled();

    await done;
  });

  it('uses the maximum override without Node clamping it to 1ms', async () => {
    process.env[ENV_KEY] = '2147483647';
    const init = vi.fn(() => new Promise<void>(() => {}));

    const done = initGramClientOrExit(init, exit);

    await vi.advanceTimersByTimeAsync(2_147_483_646);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(errorSpy).toHaveBeenCalledWith(recoveryLine(2_147_483_647));
    expect(warnSpy).not.toHaveBeenCalled();

    await done;
  });

  it('falls back to the default deadline, not a clamped 1ms one, when the override overflows', async () => {
    process.env[ENV_KEY] = '2147483648';
    const init = vi.fn(() => new Promise<void>(() => {}));

    const done = initGramClientOrExit(init, exit);

    await vi.advanceTimersByTimeAsync(119_999);
    expect(exit).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(errorSpy).toHaveBeenCalledWith(recoveryLine(120_000));

    await done;
  });
});

describe('gramStartupTimeoutMs', () => {
  let warnSpy: MockInstance;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  it('uses the default silently when the variable is not set', () => {
    expect(gramStartupTimeoutMs()).toBe(120_000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['5000', 5_000],
    ['120000', 120_000],
    ['2147483647', 2_147_483_647],
    [' 60000 ', 60_000],
  ])('accepts %j as %i ms without a warning', (raw, expected) => {
    process.env[ENV_KEY] = raw;
    expect(gramStartupTimeoutMs()).toBe(expected);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    '4999',
    '2147483648',
    '99999999999',
    '9e15',
    '0.5',
    '5000.5',
    '0',
    '-1',
    '',
    'abc',
    '0x10',
    '1e5',
    // Численно целые в диапазоне, но не простая десятичная запись.
    '+5000',
    '5000.0',
    '0x1388',
  ])('rejects %j with one warning and the default', raw => {
    process.env[ENV_KEY] = raw;
    expect(gramStartupTimeoutMs()).toBe(120_000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      `[GramClient] GRAM_STARTUP_TIMEOUT_MS=${JSON.stringify(raw)} is not a plain decimal integer in [5000, 2147483647]; using default 120000ms`
    );
  });
});
