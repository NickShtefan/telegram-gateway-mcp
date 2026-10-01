/**
 * Маскировка телефонов в тексте выгрузки: остаются первые две и последние две
 * цифры. Нужна, чтобы номера продавцов не уходили в файлы и в контекст агента,
 * пока владелец явно не попросил их оставить.
 */
// ---------------------------------------------------------------------------
// Телефоны
// ---------------------------------------------------------------------------

/**
 * Разделитель между группами цифр телефона: пробел, дефис или дефис в пробелах.
 * Дефисом считаются и его типографские двойники: неразрывный дефис (U+2011),
 * цифровое тире (U+2012), короткое тире (U+2013), минус (U+2212).
 */
const PHONE_GAP = String.raw`(?:[ \u00A0\u202F]?[\-\u2011\u2012\u2013\u2212]?[ \u00A0\u202F]?)`;

/**
 * Телефон. Две формы:
 * 1. Международная: `+` и от 10 до 15 цифр, между цифрами допустимы пробел,
 *    дефис и скобки (`+7 999 123-45-67`, `+1 (415) 555-2671`).
 * 2. Без плюса: ровно 11 цифр, первая 7 или 8, код из трёх цифр подряд
 *    (можно в скобках) начинается на 0, 3, 4, 7, 8 или 9: `8 (999) 123-45-67`,
 *    `89991234567`, белорусское `8 029 ...`. Остальные семь цифр идут группами
 *    3-2-2, 3-4, 2-2-3 или 4-3 (или слитно). Ограничения на код и на группы
 *    отсекают цены вида `8 500 000` и `7 800 000 4 000 000`.
 * Слева не должно быть буквы, цифры, `_`, `+`, `#` (это id и хэштеги), справа
 * не должно быть цифры (так отпадают карты из 16 цифр и длинные id).
 */
const PHONE_SRC =
  String.raw`(?<![\p{L}\p{N}_+#])(?:(\+\d(?:${PHONE_GAP}\(?\d\)?){9,14})` +
  String.raw`|[78]${PHONE_GAP}\(?[034789]\d{2}\)?${PHONE_GAP}` +
  String.raw`(?:\d{3}${PHONE_GAP}\d{2}${PHONE_GAP}\d{2}|\d{3}${PHONE_GAP}\d{4}|\d{2}${PHONE_GAP}\d{2}${PHONE_GAP}\d{3}|\d{4}${PHONE_GAP}\d{3}))(?!\d)`;

/**
 * Длина номера вместе с кодом страны. Нужна, чтобы международный номер не
 * захватил число после себя: `+7 999 123-45-67 25 000 руб`.
 */
const PHONE_LENGTHS: ReadonlyArray<readonly [string, number]> = [
  ['380', 12],
  ['375', 12],
  ['374', 11],
  ['373', 11],
  ['995', 12],
  ['994', 12],
  ['996', 12],
  ['998', 12],
  ['992', 12],
  ['993', 11],
  ['971', 12],
  ['972', 12],
  ['90', 12],
  ['44', 12],
  ['48', 11],
  ['7', 11],
  ['1', 11],
];

interface Span {
  start: number;
  end: number;
}

/** Сколько символов совпадения оставить, если за номером прилипло чужое число. */
function internationalPhoneLength(match: string): number {
  const digits = match.replace(/\D/g, '');
  const known = PHONE_LENGTHS.find(([code]) => digits.startsWith(code));
  if (!known || digits.length <= known[1]) return match.length;
  let seen = 0;
  for (let i = 0; i < match.length; i++) {
    if (!/\d/.test(match[i]!)) continue;
    seen++;
    if (seen === known[1]) {
      // Цифры идут подряд дальше: это не номер этой страны, оставляем как нашли.
      return /\d/.test(match[i + 1] ?? '') ? match.length : i + 1;
    }
  }
  return match.length;
}

function findPhoneSpans(text: string): Span[] {
  const spans: Span[] = [];
  const re = new RegExp(PHONE_SRC, 'gu');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const length = m[1] !== undefined ? internationalPhoneLength(m[1]) : m[0].length;
    const end = m.index + length;
    spans.push({ start: m.index, end });
    re.lastIndex = end;
  }
  return spans;
}

function maskDigits(phone: string): string {
  const total = phone.replace(/\D/g, '').length;
  let seen = 0;
  return phone.replace(/\d/g, digit => {
    seen++;
    return seen <= 2 || seen > total - 2 ? digit : '*';
  });
}

/**
 * Заменяет телефоны маской: остаются первые две и последние две цифры,
 * пунктуация не меняется. `+7 999 123-45-67` -> `+7 9** ***-**-67`.
 */
export function maskPhones(text: string): string {
  if (!text) return text;
  const spans = findPhoneSpans(text);
  if (spans.length === 0) return text;
  let out = '';
  let pos = 0;
  for (const span of spans) {
    out += text.slice(pos, span.start) + maskDigits(text.slice(span.start, span.end));
    pos = span.end;
  }
  return out + text.slice(pos);
}
