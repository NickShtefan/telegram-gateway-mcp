/** Числовой env с fallback: NaN/0/отрицательные игнорируются (стиль statsRefresher). */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Булевый env: 'false'/'0'/'no'/'off' -> false, 'true'/'1'/'yes'/'on' -> true, иначе fallback. */
export function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = raw.trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  return fallback;
}
