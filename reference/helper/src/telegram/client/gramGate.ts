/**
 * In-process гейт на единственный GramJS-клиент: StatsRefresher и
 * CommentsRefresher не должны слать MTProto-вызовы вперемешку (flood-лимиты
 * глобальны для сессии). Промис-цепочка, никакой новой сессии.
 *
 * ВАЖНО: таймаут вызова (withTimeout) обязан быть ВНУТРИ op — тогда зависший
 * навсегда GramJS-промис (сценарий #81) отваливается по таймауту и цепочка
 * едет дальше; второй воркер не блокируется навечно.
 */
const GATE_WAIT_WARN_MS = 15_000;

let chain: Promise<unknown> = Promise.resolve();
let currentHolder: string | null = null;

export function runExclusive<T>(tag: string, op: () => Promise<T>): Promise<T> {
  const waitStart = Date.now();
  const holderAtEnqueue = currentHolder;

  const run = async (): Promise<T> => {
    const waited = Date.now() - waitStart;
    if (waited >= GATE_WAIT_WARN_MS) {
      console.warn(
        `[gramGate] ${tag} ждал полосу ${Math.round(waited / 1000)}s` +
        (holderAtEnqueue ? ` (в момент постановки её держал: ${holderAtEnqueue})` : '')
      );
    }
    currentHolder = tag;
    try {
      return await op();
    } finally {
      currentHolder = null;
    }
  };

  const next = chain.then(run, run);
  // Отказ одного op не должен отравить цепочку для следующих.
  chain = next.then(() => undefined, () => undefined);
  return next;
}

/** Сброс состояния гейта — для юнит-тестов. */
export function __resetGateForTests(): void {
  chain = Promise.resolve();
  currentHolder = null;
}
