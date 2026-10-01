/**
 * Разбор объявлений барахолок: цена, валюта, тип объявления, торг и маскировка
 * телефонов. Нужен экспорту сообщений в JSONL/CSV: агент потом сам считает
 * медианы, поэтому точность важнее полноты (неверная цена хуже пропущенной).
 *
 * Устройство: текст не разбирается одной большой регуляркой. Сначала находятся
 * все числа (NUMBER_RE), потом для каждого числа отдельными маленькими
 * регулярками смотрится, что стоит справа (множитель, валюта, единица
 * измерения) и слева (знак валюты, слово "цена", "пробег", "покупал").
 * Только чистые функции, без ввода-вывода.
 */

export type Currency = 'RUB' | 'USD' | 'EUR' | 'USDT' | 'KZT' | 'UAH' | 'BYN' | 'GEL' | 'AMD' | 'TRY' | 'AED';

export interface PriceMatch {
  /** Сумма в единицах валюты, например 25000. */
  amount: number;
  currency: Currency;
  /** Совпавший кусок текста. У диапазона обе границы несут весь диапазон. */
  raw: string;
  /** true, если валюта не написана и подставлена валюта по умолчанию. */
  assumedCurrency: boolean;
}

export type ListingKind = 'sell' | 'buy' | 'swap' | 'giveaway' | 'service' | 'unknown';

export interface ListingInfo {
  kind: ListingKind;
  /** Главная цена объявления (правила в analyzeListing); null, если не нашлась. */
  price: PriceMatch | null;
  /** Все найденные цены в порядке текста. */
  prices: PriceMatch[];
  /** Упомянут торг, и он не отменён словами "без торга". */
  negotiable: boolean;
}

/** Суммы больше этой считаются мусором (как и ноль). */
const MAX_AMOUNT = 1e12;

/** Пробелы между разрядами: обычный, неразрывный (U+00A0), узкий (U+202F), тонкий (U+2009). */
const SP = String.raw` \u00A0\u202F\u2009`;
/** Тире диапазона: дефис, короткое тире и длинное (только кодом: сам символ в проекте запрещён). */
const DASH = String.raw`\-\u2013\u2014`;
/** Границы слова. `\b` в JS не понимает кириллицу, поэтому свои. */
const WB = String.raw`(?<![\p{L}\p{N}_])`;
const WE = String.raw`(?![\p{L}\p{N}_])`;

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

// ---------------------------------------------------------------------------
// Числа
// ---------------------------------------------------------------------------

/**
 * Число в тексте. Две ветки:
 * 1. Разряды через один пробел: `25 000`, `1 500 000`, с копейками `1 500,50`.
 *    Первая группа из 1-3 цифр, остальные ровно по три.
 * 2. Цифры, склеенные точкой, запятой, двоеточием или косой чертой: `25000`,
 *    `25.000`, `1,5`, но также `12.05.2026`, `18:30`, `8/256`. Вторая ветка
 *    нарочно забирает дату, время и дробь целиком, чтобы их куски не стали
 *    отдельными числами; годится ли кусок в цены, решает parseNumber.
 */
const NUMBER_SRC = String.raw`(?<!\d)(?:\d{1,3}(?:[${SP}]\d{3})+(?!\d)(?:[.,]\d{2}(?!\d))?|\d+(?:[.,:/]\d+)*)`;

/** После числа сразу идёт `.5`, `:30` и подобное: число обрезано, в цены не годится. */
const BROKEN_TAIL_RE = /^[.,:/]\d/;

/** Пробелы-разделители разрядов внутри числа. */
const GROUP_SPACE_RE = new RegExp(`[${SP}]`, 'gu');

type NumberForm = 'int' | 'grouped' | 'decimal';

interface ParsedNumber {
  value: number;
  /** grouped: разряды через точку или запятую (`25.000`); decimal: дробь (`1,5`). */
  form: NumberForm;
  decimals: number;
}

function parseNumber(raw: string): ParsedNumber | null {
  const s = raw.replace(GROUP_SPACE_RE, '');
  const spaced = s.length !== raw.length;

  if (/^\d+$/.test(s)) {
    // `007`, `05`: коды и куски дат, а не суммы.
    if (s.length > 1 && s.startsWith('0')) return null;
    return { value: Number(s), form: 'int', decimals: 0 };
  }
  if (spaced) {
    // `1 500,50`: копейки после разрядов через пробел.
    const m = /^([1-9]\d*)[.,](\d{2})$/.exec(s);
    return m ? { value: Number(`${m[1]}.${m[2]}`), form: 'decimal', decimals: 2 } : null;
  }
  // `25.000`, `1.500.000`, `25,000`: один и тот же разделитель, группы по три цифры.
  // Три группы через запятую с трёхзначной первой (`500,600,700`) это перечисление, а не сотни миллионов.
  if (/^[1-9]\d{0,2}(?:\.\d{3})+$/.test(s) || /^[1-9]\d{0,2}(?:,\d{3})+$/.test(s)) {
    if (/^\d{3},\d{3},/.test(s)) return null;
    return { value: Number(s.replace(/[.,]/g, '')), form: 'grouped', decimals: 0 };
  }
  // `1,5`, `2.5`, `999.90`: дробь с одной или двумя цифрами после разделителя.
  const m = /^(\d+)[.,](\d{1,2})$/.exec(s);
  if (m) return { value: Number(`${m[1]}.${m[2]}`), form: 'decimal', decimals: m[2]!.length };
  return null;
}

/** Объёмы памяти: в `256 100 000 руб` первая группа это гигабайты, а не миллионы. */
const STORAGE_SIZES = new Set(['64', '128', '256', '512']);

/**
 * Слово перед числом, после которого одна-две цифры это номер модели:
 * `iPhone 15 100 000 руб` читается как 100 000, а не 15 100 000. Здесь только
 * слова, за которыми обычно идёт номер (Pro, Max, MacBook сюда не входят:
 * после них сразу пишут цену).
 */
const GADGET_BEFORE_RE = new RegExp(
  String.raw`${WB}(?:iphone|айфон\p{L}*|ipad|айпад\p{L}*|galaxy|note|redmi|poco|pixel|xiaomi|honor|realme|oneplus|huawei|series|watch|playstation|ps|xbox)[${SP}]$`,
  'iu',
);

/** Число с разрядами через пробел: первая группа, вторая группа, есть ли третья. */
const SPACED_GROUPS_RE = new RegExp(String.raw`^(\d{1,3})[${SP}](\d{3})([${SP}]\d{3})?`, 'u');

/**
 * Первая группа числа с пробелами может быть номером модели (`iPhone 15`) или
 * объёмом памяти (`256`), приклеившимся к цене.
 * - Групп три и больше: первая группа отрезается, `skip` это её длина с пробелом.
 * - Групп две (`iPhone 12 500$`, `256 500$`): понять, где цена, нельзя, число
 *   помечается как неоднозначное и ценой не считается. Круглые `128 000`
 *   остаются ценой.
 */
function modelPrefix(raw: string, before: string): { skip: number; ambiguous: boolean } {
  const m = SPACED_GROUPS_RE.exec(raw);
  if (!m) return { skip: 0, ambiguous: false };
  const first = m[1]!;
  const model = first.length <= 2 && GADGET_BEFORE_RE.test(before);
  const storage = STORAGE_SIZES.has(first);
  if (m[3] !== undefined) return { skip: model || storage ? first.length + 1 : 0, ambiguous: false };
  return { skip: 0, ambiguous: model || (storage && m[2] !== '000') };
}

// ---------------------------------------------------------------------------
// Множители и валюты (то, что стоит справа от числа)
// ---------------------------------------------------------------------------

/**
 * "Тысяч рублей" одной аббревиатурой: `25т.р.`, `25 т.р`, `25 тр`, `25 т. руб`.
 * Буква "р" здесь знак рубля, поэтому валюта считается написанной явно.
 * Одинокое `25 т` множителем не считается (это тонны).
 */
const THOUSAND_RUB_RE = new RegExp(String.raw`^[${SP}]?т\.?[${SP}]?(?:руб(?:лей|ля)?\.?|р\.?)${WE}`, 'iu');

/**
 * Множитель после числа, перед ним допустим один пробел. Группы:
 * 2: миллион (`млн`, `миллион`, `миллионов`, `лям`, `кк`, `kk`),
 * 3: тысяча словом (`тыс`, `тысяч`, `тысячи`, `тыщ`),
 * 4: тысяча буквой (`к`, `k`). За множителем не должно быть буквы или цифры,
 * иначе `25кг`, `25км`, `256kb` превратились бы в цены.
 */
const MULTIPLIER_RE = new RegExp(
  String.raw`^([${SP}]?)(?:(млн|миллион(?:а|ов)?|лям(?:а|ов)?|кк|kk)|(тыс(?:яч[аи]?)?|тыщ[аи]?)|(к|k))${WE}`,
  'iu',
);

interface CurrencyForm {
  currency: Currency;
  /** Знаки валюты: после них не должно быть цифры (иначе это префикс следующего числа). */
  symbols?: string;
  /** Слова и коды: после них не должно быть буквы или цифры. */
  words: string;
}

/**
 * Валюты после числа. Порядок важен: USDT раньше USD, BYN ("бел. руб") раньше RUB.
 * Оговорки:
 * - "р" не считается рублём перед дефисом с буквой (`42 р-р`, `р-н`);
 * - "тг" не считается тенге перед двоеточием и собакой (`тг: @user` это Telegram);
 * - `amd` не считается драмом перед Ryzen, Radeon и прочими процессорами.
 */
const CURRENCY_FORMS: readonly CurrencyForm[] = [
  { currency: 'USDT', words: String.raw`usdt|юсдт` },
  { currency: 'USD', symbols: String.raw`\$`, words: String.raw`usd|доллар(?:ов|а|ы)?|бакс(?:ов|а)?` },
  { currency: 'EUR', symbols: '€', words: String.raw`eur|евро` },
  { currency: 'BYN', words: String.raw`byn|бел(?:\.|орусских)?[${SP}]?руб(?:лей|ля)?\.?` },
  { currency: 'RUB', symbols: '₽', words: String.raw`rub|rur|руб(?:лей|ля|ль|ли)?\.?|р\.?(?!-\p{L})` },
  { currency: 'KZT', symbols: '₸', words: String.raw`kzt|тенге|тг\.?(?![${SP}]?[:@])` },
  { currency: 'UAH', symbols: '₴', words: String.raw`uah|грн\.?|грив(?:ен|ень|ны|ня|на)` },
  { currency: 'GEL', symbols: '₾', words: String.raw`gel|лари` },
  {
    currency: 'AMD',
    symbols: '֏',
    words: String.raw`amd(?![${SP}]?(?:ryzen|radeon|athlon|epyc|fx|rx))|драм(?:ов|а)?`,
  },
  { currency: 'TRY', symbols: '₺', words: String.raw`try|лир(?:а|ы|у)?` },
  { currency: 'AED', words: String.raw`aed|дирх[ае]м(?:ов|а)?` },
];

/** Собранные регулярки валют: до двух пробелов, потом знак или слово. Группа 1: сама валюта. */
const CURRENCY_RES: ReadonlyArray<readonly [Currency, RegExp]> = CURRENCY_FORMS.map(form => {
  const symbols = form.symbols ? String.raw`(?:${form.symbols})(?!\d)|` : '';
  return [form.currency, new RegExp(String.raw`^[${SP}]{0,2}(${symbols}(?:${form.words})${WE})`, 'iu')] as const;
});

/** Знак валюты перед числом: `$300`, `€250`, `₽ 500`. */
const PREFIX_SYMBOL_RE = new RegExp(`([$€₽₸₴₾֏₺])[${SP}]?$`, 'u');
const PREFIX_CURRENCIES: Readonly<Record<string, Currency>> = {
  $: 'USD',
  '€': 'EUR',
  '₽': 'RUB',
  '₸': 'KZT',
  '₴': 'UAH',
  '₾': 'GEL',
  '֏': 'AMD',
  '₺': 'TRY',
};

type MultiplierStyle = 'word' | 'letter' | 'letter-spaced';

interface Suffix {
  end: number;
  mult: number | null;
  style: MultiplierStyle | null;
  currency: Currency | null;
  /** Валюта записана одной буквой "р": такая запись бывает размером одежды. */
  rubLetter: boolean;
  /** Множитель записан латинской буквой `k`: так чаще пишут разрешение экрана. */
  latinLetter: boolean;
}

function parseSuffix(text: string, pos: number): Suffix {
  const rest = text.slice(pos, pos + 64);

  const thousandRub = THOUSAND_RUB_RE.exec(rest);
  if (thousandRub) {
    return {
      end: pos + thousandRub[0].length,
      mult: 1000,
      style: 'word',
      currency: 'RUB',
      rubLetter: false,
      latinLetter: false,
    };
  }

  let offset = 0;
  let mult: number | null = null;
  let style: MultiplierStyle | null = null;
  let latinLetter = false;
  const mm = MULTIPLIER_RE.exec(rest);
  if (mm) {
    offset = mm[0].length;
    if (mm[2] !== undefined) {
      mult = 1e6;
      style = 'word';
    } else if (mm[3] !== undefined) {
      mult = 1e3;
      style = 'word';
    } else {
      mult = 1e3;
      style = mm[1] === '' ? 'letter' : 'letter-spaced';
      latinLetter = mm[4]!.toLowerCase() === 'k';
    }
    // Точка сокращения входит в множитель: `25 тыс.`, `1.5 млн.`
    if (/^(?:тыс|млн)$/iu.test(mm[2] ?? mm[3] ?? '') && rest[offset] === '.') offset += 1;
  }

  const afterMult = rest.slice(offset);
  for (const [currency, re] of CURRENCY_RES) {
    const cm = re.exec(afterMult);
    if (!cm) continue;
    const rubLetter = currency === 'RUB' && /^р\.?$/iu.test(cm[1]!);
    return { end: pos + offset + cm[0].length, mult, style, currency, rubLetter, latinLetter };
  }
  return { end: pos + offset, mult, style, currency: null, rubLetter: false, latinLetter };
}

// ---------------------------------------------------------------------------
// Контекст: что запрещает считать число ценой и что разрешает
// ---------------------------------------------------------------------------

/**
 * Единица измерения сразу после числа (или после множителя): километры,
 * гигабайты, штуки, месяцы, годы, вес, длина, время, подписчики, пробег,
 * а также хвосты названий моделей (`15 pro`). `25к км`, `за 2 шт`, `за 15 минут`
 * ценами не становятся. Проверяется, только когда валюты после числа нет.
 * Буква "т" не считается тоннами в сокращениях "т.к.", "т.е.".
 */
const UNIT_RE = new RegExp(
  String.raw`^[${SP}]?-?(?:(?:` +
    String.raw`км|km|миль|мил[яи]|гб|gb|тб|tb|мб|mb|кб|kb|гиг\p{L}*` +
    String.raw`|шт|штук\p{L}*|мес|месяц\p{L}*|лет|год\p{L}*|г|гр|грам\p{L}*|кг|килограм\p{L}*|т(?!\.\p{L})|тонн\p{L}*` +
    String.raw`|л|литр\p{L}*|мл|м|м2|м²|кв|метр\p{L}*|см|мм|сантиметр\p{L}*|дюйм\p{L}*` +
    String.raw`|мин|минут\p{L}*|ч|час\p{L}*|сек|секунд\p{L}*|дн\p{L}{1,2}|день|недел\p{L}*|сут\p{L}*` +
    String.raw`|раз|раза|чел|человек\p{L}*` +
    String.raw`|мач|mah|вт|квт|w|гц|hz|мп|mp|fps|dpi|rpm` +
    String.raw`|подписчик\p{L}*|просмотр\p{L}*|пробег\p{L}*|оборот\p{L}*|цикл\p{L}*|кадр\p{L}*|моточас\p{L}*` +
    String.raw`|этаж\p{L}*|комнат\p{L}*|сот\p{L}{2}|pro|max|plus|ultra|mini|серии|поколени\p{L}` +
    String.raw`)${WE}|%|"|″|”|[xх×][${SP}]?\d)`,
  'iu',
);

/**
 * Слово перед числом, после которого число точно не цена: пробег, артикул,
 * код, id, номер, телефон, ИНН, IMEI, модель, лот, знак номера.
 */
const NOT_PRICE_BEFORE_RE = new RegExp(
  String.raw`(?:${WB}(?:пробег\p{L}*|артикул\p{L}*|арт|код|id|ид|номер|тел|телефон|инн|imei|модел\p{L}|лот)|№)[\s:.#№${DASH}]*$`,
  'iu',
);

/**
 * Слово перед числом, после которого маленькое число (меньше 1000) это
 * характеристика, а не цена: размер, рост, вес, память, объём. `размер 46р`
 * не цена, а `42 размер 2500 руб` цена.
 */
const MEASURE_BEFORE_RE = new RegExp(
  String.raw`${WB}(?:размер\p{L}*|рост|вес|памят\p{L}|объ[её]м\p{L}*)[\s:.${DASH}]*$`,
  'iu',
);

/**
 * После числа через пробел идёт слово: для голого числа меньше 10 это
 * количество, а не цена. Слово "до" перед числом не в счёт: это диапазон.
 */
const COUNT_FOLLOW_RE = /^[ \t]+(?!до\s+\d)\p{L}/iu;

/** Число приклеено к букве, цифре, `_`, `#`, `@`, косой черте: `M2`, `A52`, `#123`, ссылка. */
const GLUED_BEFORE_RE = /(?:[\p{L}\p{N}_#@/\\×]|\d[.,:])$/u;

/** Между словом цены и числом: пробелы, двоеточие, тире, знак равенства, тильда, эмодзи. */
const KEYWORD_GAP = String.raw`(?:[\s:=~≈>${DASH}]|\p{Extended_Pictographic}|\uFE0F){0,8}`;
/** Необязательное слово между словом цены и числом: "цена всего 500", "цена от 500". */
const KEYWORD_FILLER = String.raw`(?:(?:всего|вс[её]|от|около|примерно)\s+)?`;

/**
 * Сильное слово цены прямо перед числом: цена (цене, цену, цены), "цена
 * вопроса", "цена за всё/комплект/пару/штуку", ценник, стоимость, прошу, price,
 * а также "отдам за", "отдаю за", "продам за", "продаю за", "уступлю за".
 * После него голое число считается ценой: `цена 25000`, `цена: 25 000`.
 */
const STRONG_KEYWORD_RE = new RegExp(
  String.raw`${WB}(?:цен[аеуы](?:\s+вопроса|\s+за\s+(?:вс[её]|комплект|набор|пару|штуку|шт\.?))?|ценник|стоимость|прошу|price` +
    String.raw`|(?:отда[мю]|прода[мю]|уступлю)\s+за)${KEYWORD_GAP}${KEYWORD_FILLER}[~≈]?\s*$`,
  'iu',
);

/**
 * Слабое слово цены: отдельный предлог "за". После него голое число считается
 * ценой, только если оно не меньше 100 и не похоже на год: "за 15 минут",
 * "за 2023" отпадают.
 */
const WEAK_KEYWORD_RE = new RegExp(String.raw`${WB}за\s+${KEYWORD_FILLER}[~≈]?\s*$`, 'iu');

/** Предлог "по" перед числом: "по 50р" это цена за штуку, а не размер. */
const EACH_BEFORE_RE = new RegExp(String.raw`${WB}по\s$`, 'iu');

/**
 * Что должно идти после `25 к` с пробелом, чтобы это был множитель, а не
 * предлог ("приеду в 5 к вам") или корпус дома ("д. 25 к. 2"): конец текста,
 * знак препинания, эмодзи, слово "торг" или точка и новое предложение с
 * заглавной буквы. Строчная буква или цифра не годятся.
 */
const SPACED_K_FOLLOW_RE = /^\.?[ \t]*(?:$|[^\p{L}\p{N} \t.]|[Тт][Оо][Рр][Гг])|^\.[ \t]+\p{Lu}/u;

/**
 * Слова в той же строке рядом с `4к`, `2к`, `4K`, по которым это разрешение
 * экрана, а не цена. Широкая проверка: действует для 2 и 4 и для латинской `K`.
 */
const RESOLUTION_CONTEXT_RE = new RegExp(
  String.raw`${WB}(?:uhd|hdr|hd|tv|тв|fps|гц|hz|ips|oled|qled)${WE}` +
    String.raw`|${WB}(?:телевизор|монитор|видео|video|разрешени|экран|диспле|камер|съ[её]мк|снима|запис|смарт|smart|проектор|retina)`,
  'iu',
);
/**
 * То же самое вплотную после числа: `8к видео`, `5к монитор`, `2к 144 гц`.
 * Узкая проверка: действует для любого числа из RESOLUTION_K, в том числе для
 * 5к, 6к и 8к, которые без такого соседа чаще цена, чем разрешение.
 */
const RESOLUTION_FOLLOW_RE = new RegExp(
  String.raw`^[ \t]?(?:(?:uhd|hdr|hd|tv|тв|ips|oled|qled)${WE}` +
    String.raw`|телевизор|монитор|видео|video|разрешени|экран|диспле|камер|съ[её]мк|смарт|smart|retina` +
    String.raw`|\d{2,3}[ ]?(?:fps|гц|hz|дюйм|"))`,
  'iu',
);
/** Предлог "в" перед числом: "снимает в 4к". */
const IN_BEFORE_RE = new RegExp(String.raw`${WB}в\s$`, 'iu');
/** Числа, которые с буквой "к" бывают разрешением: 2к, 4к, 5к, 6к, 8к. */
const RESOLUTION_K = new Set([2, 4, 5, 6, 8]);
/** Числа, которые с приклеенной "р" бывают разрешением: 1080р, 720р. */
const RESOLUTION_P = new Set([480, 720, 1080, 1440, 2160]);

/** `2к квартира`, `1к.кв`, `2к студия`: число комнат, а не тысячи. */
const FLAT_FOLLOW_RE = /^[.-]?\s?(?:кв|комн|студи)/iu;
/** `квартира 2к`: то же, слово стоит перед числом. */
const FLAT_BEFORE_RE = new RegExp(String.raw`${WB}(?:квартир\p{L}*|комнат\p{L}*)\s$`, 'iu');

/** "от" перед нижней границей диапазона: `от 20 до 25 тыс`. */
const FROM_BEFORE_RE = new RegExp(String.raw`${WB}от\s+$`, 'iu');
/** "до" между границами диапазона. */
const TO_BETWEEN_RE = /^\s+до\s+$/iu;
/** Диапазон вплотную: `20-25к`, `20–25 тыс`. */
const TIGHT_DASH_RE = new RegExp(`^[${DASH}]$`, 'u');
/** Диапазон через тире с пробелами: `20 - 25к`. Принимается только после слова цены. */
const SPACED_DASH_RE = new RegExp(`^\\s?[${DASH}]\\s?$`, 'u');
/**
 * Слово перед `14-45к`, из-за которого это модель и цена, а не диапазон:
 * любое слово латиницей (iPhone, Note, Redmi) и названия техники кириллицей.
 */
const MODEL_WORD_BEFORE_RE = new RegExp(
  String.raw`${WB}(?:[a-z][a-z0-9+]*|айфон\p{L}*|айпад\p{L}*|самсунг\p{L}*|сяоми|редми|хонор|пиксель|галакси)\s$`,
  'iu',
);

/**
 * Слова, после которых цена не является ценой объявления: цена покупки
 * ("покупал за 60к", "брала", "куплен"), цена в магазине ("новый стоит",
 * "в магазине", "на сайте", "старая цена"), доставка, скидка, залог,
 * предоплата. Между таким словом и числом допускается до четырёх слов
 * (группа 1), и среди них не должно быть продающего глагола: в "купил не
 * подошёл продаю за 3000" цена своя (SELL_VERB_RE).
 */
const REFERENCE_RE = new RegExp(
  String.raw`${WB}(?:покупал\p{L}*|куплен\p{L}*|купил\p{L}*|брал\p{L}*|взял\p{L}*|приобр\p{L}+|обош[её]л\p{L}*|стоил\p{L}*` +
    String.raw`|нов\p{L}{1,3}\s+сто[ия]т|в\s+магазин\p{L}*|на\s+сайте|стар\p{L}{2,3}\s+цен\p{L}|розничн\p{L}+\s+цен\p{L}|рыночн\p{L}+\s+цен\p{L}` +
    String.raw`|доставк[аи]|пересылк[аи]|отправк[аи]|скидк[ауи]|залог|предоплат[аы]|задаток)` +
    String.raw`((?:[^\p{L}\p{N}]+[\p{L}\p{N}]+){0,4})[^\p{L}\p{N}]*$`,
  'iu',
);

/** Продающий глагол между словом покупки и числом: продам, продаю, отдам, отдаю, уступлю, прошу. */
const SELL_VERB_RE = new RegExp(String.raw`${WB}(?:прода[мю]|отда[мю]|уступлю|прошу)${WE}`, 'iu');

/** Граница фразы: `!`, `?`, `;`, перевод строки, запятая с пробелом, точка перед заглавной буквой. */
const PHRASE_BREAK_RE = /[!?;\n]|,\s|\.\s+(?=\p{Lu})/gu;

type Keyword = 'strong' | 'weak' | null;

/** Число-кандидат со всем, что о нём известно. */
interface Atom {
  /** Начало (с учётом знака валюты перед числом). */
  start: number;
  /** Конец (с учётом множителя и валюты). */
  end: number;
  value: number;
  form: NumberForm;
  decimals: number;
  mult: number | null;
  currency: Currency | null;
  /** У числа есть свой множитель или своя валюта справа. */
  suffixed: boolean;
  keyword: Keyword;
  /** Число точно не цена: единица измерения, приклеено к букве, слева "пробег". */
  blocked: boolean;
  /** Блокировка из-за слова слева: в диапазоне переходит на верхнюю границу. */
  blockedByWord: boolean;
  /** Множитель сомнительный (`25 к` с пробелом, `4к`, `2к квартира`): нужно слово цены. */
  shakyMult: boolean;
  /** Валюта сомнительная (`46р` размер, `1080р` разрешение): нужно слово цены. */
  shakyCurrency: boolean;
  /** Верхняя граница диапазона, если это нижняя. */
  upper: Atom | null;
  /** Нижняя граница диапазона, если это верхняя. */
  lower: Atom | null;
  /** Начало всего диапазона в тексте (с "от"). */
  rangeStart: number;
  /** Конец всего диапазона в тексте. */
  rangeEnd: number;
}

function buildAtoms(text: string): Atom[] {
  const phones = findPhoneSpans(text);
  const atoms: Atom[] = [];
  const re = new RegExp(NUMBER_SRC, 'gu');
  /** Конец последнего разобранного числа вместе с его валютой: знак правее уже занят. */
  let consumed = 0;
  /** Конец строки, в которой уже встретилось число комнат (`2к квартира`). */
  let flatLineEnd = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    let numStart = m.index;
    let raw = m[0];
    const numEnd = numStart + raw.length;
    if (phones.some(p => numStart < p.end && numEnd > p.start)) {
      consumed = Math.max(consumed, numEnd);
      continue;
    }

    // До двух проходов: `iPhone 15 256 100 000 руб` теряет сначала модель, потом память.
    let model = modelPrefix(raw, text.slice(Math.max(0, numStart - 24), numStart));
    for (let pass = 0; pass < 2 && model.skip > 0; pass++) {
      numStart += model.skip;
      raw = raw.slice(model.skip);
      model = modelPrefix(raw, text.slice(Math.max(0, numStart - 24), numStart));
    }

    const parsed = BROKEN_TAIL_RE.test(text.slice(numEnd, numEnd + 2)) ? null : parseNumber(raw);
    if (!parsed) {
      consumed = Math.max(consumed, numEnd);
      continue;
    }

    const suffix = parseSuffix(text, numEnd);
    const prefix = PREFIX_SYMBOL_RE.exec(text.slice(Math.min(consumed, numStart), numStart));
    const start = prefix ? numStart - prefix[0].length : numStart;
    const before = text.slice(Math.max(0, start - 64), start);
    const after = text.slice(suffix.end, suffix.end + 32);

    const keyword: Keyword = STRONG_KEYWORD_RE.test(before) ? 'strong' : WEAK_KEYWORD_RE.test(before) ? 'weak' : null;
    const blockedByWord =
      NOT_PRICE_BEFORE_RE.test(before) ||
      (parsed.value * (suffix.mult ?? 1) < 1000 && MEASURE_BEFORE_RE.test(before));
    const glued = !prefix && GLUED_BEFORE_RE.test(before);
    const unitAfter = suffix.currency === null && !prefix && UNIT_RE.test(after);
    // "отдам за 1 шоколадку", "цена 3 пачки": маленькое голое число перед словом это количество.
    const countAfter =
      suffix.mult === null && suffix.currency === null && !prefix && parsed.value < 10 && COUNT_FOLLOW_RE.test(after);
    // `15 000 т.р.`, `25000к`: тысячи тысяч и тысячи миллионов так не пишут, смысл неясен.
    const oddMult = suffix.mult !== null && parsed.value >= (suffix.mult === 1e6 ? 1000 : 10000);

    let shakyMult = false;
    if (suffix.mult !== null && suffix.style !== 'word') {
      if (suffix.style === 'letter-spaced' && !SPACED_K_FOLLOW_RE.test(after)) shakyMult = true;

      if (RESOLUTION_K.has(parsed.value)) {
        const lineBefore = before.slice(before.lastIndexOf('\n') + 1).slice(-32);
        const lineAfter = after.split('\n')[0]!.slice(0, 24);
        const near = IN_BEFORE_RE.test(before) || RESOLUTION_FOLLOW_RE.test(after);
        const sameLine = RESOLUTION_CONTEXT_RE.test(lineBefore) || RESOLUTION_CONTEXT_RE.test(lineAfter);
        if (near || (sameLine && (parsed.value === 2 || parsed.value === 4 || suffix.latinLetter))) shakyMult = true;
      }

      if (Number.isInteger(parsed.value) && parsed.value <= 5) {
        // "меняю 2к квартиру на 3к": после числа комнат в той же строке `3к` тоже комнаты.
        const flat = FLAT_FOLLOW_RE.test(after) || FLAT_BEFORE_RE.test(before) || start < flatLineEnd;
        if (flat) {
          shakyMult = true;
          const lineEnd = text.indexOf('\n', start);
          flatLineEnd = lineEnd === -1 ? text.length : lineEnd;
        }
      }
    }

    let shakyCurrency = false;
    if (suffix.rubLetter && suffix.mult === null && Number.isInteger(parsed.value)) {
      // `46р`: размер одежды. `по 50р` размером не бывает.
      if (parsed.value >= 30 && parsed.value <= 70 && !EACH_BEFORE_RE.test(before)) shakyCurrency = true;
      // `1080р` вплотную: разрешение, набранное в русской раскладке.
      if (RESOLUTION_P.has(parsed.value) && text[numEnd]?.toLowerCase() === 'р') shakyCurrency = true;
    }

    atoms.push({
      start,
      end: suffix.end,
      value: parsed.value,
      form: parsed.form,
      decimals: parsed.decimals,
      mult: suffix.mult,
      currency: suffix.currency ?? (prefix ? (PREFIX_CURRENCIES[prefix[1]!] ?? null) : null),
      suffixed: suffix.mult !== null || suffix.currency !== null,
      keyword,
      blocked: blockedByWord || glued || unitAfter || countAfter || oddMult || model.ambiguous,
      blockedByWord,
      shakyMult,
      shakyCurrency,
      upper: null,
      lower: null,
      rangeStart: start,
      rangeEnd: suffix.end,
    });
    consumed = suffix.end;
  }
  return atoms;
}

/**
 * Связывает соседние числа в диапазоны: `20-25к`, `от 20 до 25 тыс`,
 * `$100-150`, `цена 2000-2500`. Нижняя граница берёт у верхней множитель и
 * валюту, верхняя берёт у нижней слово цены и знак валюты.
 */
function linkRanges(text: string, atoms: Atom[]): void {
  for (let i = 0; i + 1 < atoms.length; i++) {
    const a = atoms[i]!;
    const b = atoms[i + 1]!;
    if (a.suffixed || a.lower) continue;

    const between = text.slice(a.end, b.start);
    const before = text.slice(Math.max(0, a.start - 24), a.start);
    let rangeStart = a.start;
    if (TIGHT_DASH_RE.test(between)) {
      if (a.keyword === null && MODEL_WORD_BEFORE_RE.test(before)) continue;
    } else if (SPACED_DASH_RE.test(between)) {
      if (a.keyword === null) continue;
    } else if (TO_BETWEEN_RE.test(between)) {
      const from = FROM_BEFORE_RE.exec(before);
      if (!from) continue;
      rangeStart = a.start - from[0].length;
    } else {
      continue;
    }

    if (a.blockedByWord) {
      // "пробег 20-25к": обе границы не цены.
      b.blocked = true;
      continue;
    }
    if (a.blocked) continue;

    const upperAmount = b.value * (b.mult ?? 1);
    let mult = a.mult;
    if (b.mult !== null && a.value * b.mult < upperAmount) mult = b.mult;
    else if (a.value >= upperAmount) continue;

    a.mult = mult;
    a.currency ??= b.currency;
    b.currency ??= a.currency;
    b.keyword ??= a.keyword;
    a.upper = b;
    b.lower = a;
    a.rangeStart = rangeStart;
    b.rangeStart = rangeStart;
    a.rangeEnd = b.end;
    if (b.blocked) a.blocked = true;
  }
}

/** Голое число после предлога "за": не меньше 100 и не год. */
function weakBareOk(value: number): boolean {
  return Number.isInteger(value) && value >= 100 && !(value >= 2010 && value <= 2035);
}

function isPrice(a: Atom): boolean {
  if (a.blocked) return false;
  // `25.000` с множителем не бывает; без валюты нужно сильное слово цены.
  if (a.form === 'grouped' && (a.mult !== null || (a.currency === null && a.keyword !== 'strong'))) return false;
  // Дробь: только с множителем (`1,5 млн`) или как копейки при явной валюте (`999.90 ₽`).
  if (a.form === 'decimal' && a.mult === null && !(a.currency !== null && a.decimals === 2)) return false;
  if (a.upper && !isPrice(a.upper)) return false;

  if (a.currency !== null) return !a.shakyCurrency || a.keyword !== null;
  if (a.mult !== null) return !a.shakyMult || a.keyword !== null;
  if (a.keyword === 'strong') return true;
  if (a.keyword === 'weak') return weakBareOk(a.value);
  // Нижняя граница без своего множителя: `500-1.5к`.
  return a.upper !== null && (a.upper.mult !== null || a.upper.currency !== null);
}

/** Цена с внутренними пометками для выбора главной. */
interface FoundPrice {
  match: PriceMatch;
  /** Стоит сразу после слова цены. */
  afterKeyword: boolean;
  /** Цена покупки, магазина, доставки, скидка, залог: не цена объявления. */
  reference: boolean;
}

function isReference(text: string, previousEnd: number, start: number): boolean {
  const phrase = text.slice(Math.max(previousEnd, start - 96), start);
  let cut = 0;
  for (const m of phrase.matchAll(PHRASE_BREAK_RE)) cut = (m.index ?? 0) + m[0].length;
  const m = REFERENCE_RE.exec(phrase.slice(cut));
  return m !== null && !SELL_VERB_RE.test(m[1] ?? '');
}

function findPrices(text: string, defaultCurrency: Currency): FoundPrice[] {
  if (!text) return [];
  const atoms = buildAtoms(text);
  linkRanges(text, atoms);

  const found: FoundPrice[] = [];
  const references = new Map<Atom, boolean>();
  let previousEnd = 0;
  for (const atom of atoms) {
    if (!isPrice(atom)) continue;
    const amount = Math.round(atom.value * (atom.mult ?? 1) * 100) / 100;
    if (!(amount > 0) || amount > MAX_AMOUNT) continue;

    const reference = atom.lower
      ? (references.get(atom.lower) ?? false)
      : isReference(text, previousEnd, atom.rangeStart);
    references.set(atom, reference);
    previousEnd = atom.end;

    found.push({
      match: {
        amount,
        currency: atom.currency ?? defaultCurrency,
        raw: text.slice(atom.rangeStart, atom.rangeEnd),
        assumedCurrency: atom.currency === null,
      },
      afterKeyword: atom.keyword !== null && atom.lower === null && !reference,
      reference,
    });
  }
  return found;
}

/**
 * Все цены в тексте по порядку. Валюта, которой нет в тексте, берётся из
 * `defaultCurrency` (по умолчанию RUB) с пометкой `assumedCurrency: true`.
 */
export function extractPrices(text: string, options?: { defaultCurrency?: Currency }): PriceMatch[] {
  return findPrices(text, options?.defaultCurrency ?? 'RUB').map(p => p.match);
}

// ---------------------------------------------------------------------------
// Тип объявления
// ---------------------------------------------------------------------------

interface KindRule {
  kind: Exclude<ListingKind, 'unknown'>;
  /** Слово в тексте. */
  word: RegExp;
  /** Начало хэштега (без решётки). */
  tag: RegExp;
}

function wordRe(source: string): RegExp {
  return new RegExp(`${WB}(?:${source})${WE}`, 'iu');
}

/**
 * Слова и хэштеги типов объявлений.
 * - sell: продам, продаю, продаём, продаётся, продаются, продажа, распродажа, selling, for sale, wts.
 *   "Продано" и хэштег `#продано` сюда не входят.
 * - buy: куплю, купим, покупаю, ищу (кроме "ищу покупателя"), wtb, buying.
 * - swap: обмен, обменяю, меняю, махну; "без обмена" и "обмен не интересует" не считаются.
 * - giveaway: "отдам даром/бесплатно/в добрые руки", даром, бесплатно; "доставка бесплатно" не считается.
 * - service: услуги, оказываю; "ремонт" только хэштегом или первым словом текста (REPAIR_START_RE).
 */
const KIND_RULES: readonly KindRule[] = [
  {
    kind: 'sell',
    word: wordRe(String.raw`распрода\p{L}+|прода(?:м|ю|[её]м|[её]тся|ются|жа|жу)|selling|for\s+sale|wts`),
    tag: /^(?:прода(?!н)|распрода|sell|sale|wts)/iu,
  },
  {
    kind: 'buy',
    word: wordRe(String.raw`куплю|купим|покупаю|покупаем|ищу(?!\s+покупател)|wtb|buying`),
    tag: /^(?:купл|покуп|ищу|buy|wtb)/iu,
  },
  {
    kind: 'swap',
    word: wordRe(String.raw`(?<!без\s)обмен(?:а|яю|яем)?(?!\s+не)|меняю|поменяю|махну(?:сь)?`),
    tag: /^(?:обмен|меня|swap|trade)/iu,
  },
  {
    kind: 'giveaway',
    word: wordRe(
      String.raw`отда[мю]\s+(?:даром|бесплатно|в\s+добрые\s+руки)|(?<!не\s)даром|(?<!доставк\p{L}\s)бесплатно(?!\s+достав)`,
    ),
    tag: /^(?:отда|даром|бесплатно|free|giveaway)/iu,
  },
  {
    kind: 'service',
    word: wordRe(String.raw`услуг[иа]?|оказыва(?:ю|ем)`),
    tag: /^(?:услуг|ремонт|service)/iu,
  },
];

/** Хэштег: решётка и слово из букв, цифр и подчёркиваний. */
const HASHTAG_RE = /#([\p{L}\p{N}_]+)/gu;
/** "Ремонт" первым словом текста (перед ним допустимы эмодзи и знаки). */
const REPAIR_START_RE = /^[^\p{L}\p{N}#]*ремонт/iu;

/**
 * Тип объявления. Хэштеги важнее слов; среди хэштегов и среди слов побеждает
 * тот, что стоит раньше в тексте.
 */
export function detectListingKind(text: string): ListingKind {
  if (!text) return 'unknown';

  for (const m of text.matchAll(HASHTAG_RE)) {
    const rule = KIND_RULES.find(r => r.tag.test(m[1]!));
    if (rule) return rule.kind;
  }

  // Перед "ремонт" нет ни одной буквы, значит раньше него других слов быть не может.
  if (REPAIR_START_RE.test(text)) return 'service';

  let best: ListingKind = 'unknown';
  let bestIndex = Number.POSITIVE_INFINITY;
  for (const rule of KIND_RULES) {
    const m = rule.word.exec(text);
    if (m && m.index < bestIndex) {
      best = rule.kind;
      bestIndex = m.index;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Торг
// ---------------------------------------------------------------------------

/**
 * Отказ от торга: "без торга", "торга нет", "нет торга", "не торгуюсь",
 * "торг не уместен", "торг неуместен", "торг не предлагать", "торга не будет",
 * "no bargain", "not negotiable", "non-negotiable".
 */
const NO_BARGAIN_RE = new RegExp(
  String.raw`${WB}(?:без\s+торг(?:а|ов)|торг(?:а|ов)?\s+нет|нет\s+торга|не\s+торгу(?:юсь|емся)|торг\s+не\s*уместен` +
    String.raw`|торг\s+не\s+предлага\p{L}+|торга\s+не\s+будет|no\s+bargain\p{L}*|not\s+negotiable|non[-\s]negotiable)`,
  'giu',
);

/**
 * Торг: слово "торг" и его формы (торга, торгуюсь), negotiable. "Торговый",
 * "торговля", "восторг" не подходят из-за границ слова.
 */
const BARGAIN_RE = new RegExp(String.raw`${WB}(?:торг(?:а|у|и|ом|уюсь|уемся)?|negotiable)${WE}`, 'iu');

/** Упомянут ли торг. Отказ от торга сильнее упоминания. */
export function isNegotiable(text: string): boolean {
  if (!text) return false;
  return BARGAIN_RE.test(text.replace(NO_BARGAIN_RE, ' '));
}

// ---------------------------------------------------------------------------
// Объявление целиком
// ---------------------------------------------------------------------------

/**
 * Разбор объявления. Главная цена: первая после слова цены ("цена", "прошу",
 * "отдам за", "за"); если такой нет, первая с явной валютой; иначе первая.
 * У диапазона главная цена это нижняя граница. Цены покупки, магазина,
 * доставки, скидки и залоги в главные не попадают: если других цен нет,
 * `price` равен null, хотя в `prices` они остаются.
 */
export function analyzeListing(text: string, options?: { defaultCurrency?: Currency }): ListingInfo {
  const found = findPrices(text, options?.defaultCurrency ?? 'RUB');
  const own = found.filter(p => !p.reference);
  const main = own.find(p => p.afterKeyword) ?? own.find(p => !p.match.assumedCurrency) ?? own[0] ?? null;
  return {
    kind: detectListingKind(text),
    price: main ? main.match : null,
    prices: found.map(p => p.match),
    negotiable: isNegotiable(text),
  };
}
