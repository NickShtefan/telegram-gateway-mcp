import { requestGramProcessRestart, type ExitProcess } from './gramFatalRecovery.js';
import { StageTimeoutError, withTimeout } from '../workers/refreshShared.js';

const TIMEOUT_ENV = 'GRAM_STARTUP_TIMEOUT_MS';

// 120 сек, а не 60: getMe() внутри промиса пережидает FLOOD_WAIT до floodSleepThreshold (GramJS default 60 сек) + бюджет на connect.
export const DEFAULT_GRAM_STARTUP_TIMEOUT_MS = 120_000;
export const MIN_GRAM_STARTUP_TIMEOUT_MS = 5_000;
// Больше 2^31-1 Node молча урезает setTimeout до 1 мс: старт падал бы сразу.
export const MAX_GRAM_STARTUP_TIMEOUT_MS = 2_147_483_647;

const STARTUP_STAGE = 'GramClient startup (connect/getMe)';

/**
 * Дедлайн старта из env. Своя валидация, а не envNumber: допустимо только
 * десятичное целое в [MIN, MAX]; иначе один warn и дефолт. Не задано => дефолт молча.
 */
export function gramStartupTimeoutMs(): number {
  const raw = process.env[TIMEOUT_ENV];
  if (raw === undefined) return DEFAULT_GRAM_STARTUP_TIMEOUT_MS;
  const trimmed = raw.trim();
  const n = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (n >= MIN_GRAM_STARTUP_TIMEOUT_MS && n <= MAX_GRAM_STARTUP_TIMEOUT_MS) return n;
  console.warn(
    `[GramClient] ${TIMEOUT_ENV}=${JSON.stringify(raw)} is not a plain decimal integer in ` +
      `[${MIN_GRAM_STARTUP_TIMEOUT_MS}, ${MAX_GRAM_STARTUP_TIMEOUT_MS}]; using default ${DEFAULT_GRAM_STARTUP_TIMEOUT_MS}ms`
  );
  return DEFAULT_GRAM_STARTUP_TIMEOUT_MS;
}

/**
 * Старт GramJS-клиента с дедлайном (#91). Без сети connect()/getMe() могут не
 * сеттлиться вообще: процесс жив, но ничего не делает, и Docker его не
 * перезапускает. Дедлайн => fail closed тем же путём, что и #90. Второй клиент
 * in-process не создаём (AUTH_KEY_DUPLICATED). Успех до дедлайна снимает таймер.
 */
export async function initGramClientOrExit(
  init: () => Promise<void>,
  exitProcess: ExitProcess = code => process.exit(code)
): Promise<void> {
  const timeoutMs = gramStartupTimeoutMs();
  try {
    await withTimeout(init(), timeoutMs, STARTUP_STAGE);
  } catch (error) {
    if (error instanceof StageTimeoutError) {
      return requestGramProcessRestart(error.message, exitProcess);
    }
    console.error('Ошибка инициализации GramJS-клиента:', (error as Error).message);
    return exitProcess(1);
  }
}
