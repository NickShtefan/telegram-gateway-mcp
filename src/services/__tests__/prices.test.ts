import { describe, expect, it } from 'vitest';
import {
  analyzeListing,
  detectListingKind,
  extractPrices,
  isNegotiable,
  maskPhones,
  type Currency,
  type ListingKind,
} from '../prices.js';

/** Неразрывный пробел, узкий неразрывный пробел и длинное тире: кодами, чтобы их было видно. */
const NBSP = String.fromCharCode(0x00a0);
const NNBSP = String.fromCharCode(0x202f);
const LONG_DASH = String.fromCharCode(0x2014);
const NB_HYPHEN = String.fromCharCode(0x2011);

type PriceCase = [text: string, amount: number, currency: Currency, assumed: boolean];

/** Ровно одна цена в тексте с такой суммой, валютой и пометкой о валюте. */
function expectSinglePrice([text, amount, currency, assumed]: PriceCase): void {
  const prices = extractPrices(text);
  expect(prices, text).toHaveLength(1);
  expect(prices[0], text).toMatchObject({ amount, currency, assumedCurrency: assumed });
}

describe('extractPrices: рубли с явной валютой', () => {
  const cases: PriceCase[] = [
    ['25 000 ₽', 25000, 'RUB', false],
    ['25000₽', 25000, 'RUB', false],
    ['25 000 руб', 25000, 'RUB', false],
    ['25000 руб.', 25000, 'RUB', false],
    ['25000р', 25000, 'RUB', false],
    ['25 000 р.', 25000, 'RUB', false],
    ['25 тыс руб', 25000, 'RUB', false],
    ['25 тыс. ₽', 25000, 'RUB', false],
    ['25000 рублей', 25000, 'RUB', false],
    ['25к ₽', 25000, 'RUB', false],
    ['25к руб', 25000, 'RUB', false],
    ['1.5 млн руб', 1500000, 'RUB', false],
    ['1,5 млн ₽', 1500000, 'RUB', false],
    ['1 500 000 ₽', 1500000, 'RUB', false],
    ['цена 25000 RUB', 25000, 'RUB', false],
    [`25${NBSP}000 ₽`, 25000, 'RUB', false],
    [`25${NNBSP}000${NNBSP}₽`, 25000, 'RUB', false],
    ['25.000 руб', 25000, 'RUB', false],
    ['25,000 ₽', 25000, 'RUB', false],
    ['1.500.000 руб', 1500000, 'RUB', false],
    ['150.000.000 руб', 150000000, 'RUB', false],
    ['1,500,000 руб', 1500000, 'RUB', false],
    ['1500 тыс. руб', 1500000, 'RUB', false],
    ['кроссовки 42 размер 2500 руб', 2500, 'RUB', false],
    ['2.5к руб', 2500, 'RUB', false],
    ['3 тысячи рублей', 3000, 'RUB', false],
    ['Диван, 15000 руб, самовывоз', 15000, 'RUB', false],
    ['Стол-5000р', 5000, 'RUB', false],
    ['💰7500₽💰', 7500, 'RUB', false],
    ['по 50р за штуку', 50, 'RUB', false],
    ['1 500,50 руб', 1500.5, 'RUB', false],
    ['999.90 ₽', 999.9, 'RUB', false],
    ['₽ 1200', 1200, 'RUB', false],
  ];
  it.each(cases)('%s', (...args) => expectSinglePrice(args));

  // В списке сокращений задания "т.р." стоит среди форм без валюты, но буква "р" это рубль.
  const thousandRub: PriceCase[] = [
    ['25т.р.', 25000, 'RUB', false],
    ['25 т.р', 25000, 'RUB', false],
    ['25 тр', 25000, 'RUB', false],
    ['25 т. руб.', 25000, 'RUB', false],
  ];
  it.each(thousandRub)('тысячи рублей аббревиатурой: %s', (...args) => expectSinglePrice(args));
});

describe('extractPrices: сокращения без валюты', () => {
  const cases: PriceCase[] = [
    ['25к', 25000, 'RUB', true],
    ['25 к', 25000, 'RUB', true],
    ['25k', 25000, 'RUB', true],
    ['25K', 25000, 'RUB', true],
    ['25 тыс', 25000, 'RUB', true],
    ['25 тыс.', 25000, 'RUB', true],
    ['25 тысяч', 25000, 'RUB', true],
    ['1.5 млн', 1500000, 'RUB', true],
    ['1,5кк', 1500000, 'RUB', true],
    ['2.5к', 2500, 'RUB', true],
    ['0,5 млн', 500000, 'RUB', true],
    ['2 миллиона', 2000000, 'RUB', true],
    ['Велосипед 25 к, торг', 25000, 'RUB', true],
    ['Велосипед 25 к торг', 25000, 'RUB', true],
    ['Коляска 12к.', 12000, 'RUB', true],
    ['Наушники\n3к\nСамовывоз', 3000, 'RUB', true],
    ['Велосипед 25 к. Самовывоз', 25000, 'RUB', true],
    ['стул 4к', 4000, 'RUB', true],
    ['отдам за 4к', 4000, 'RUB', true],
  ];
  it.each(cases)('%s', (...args) => expectSinglePrice(args));
});

describe('extractPrices: голое число после слова цены', () => {
  const cases: PriceCase[] = [
    ['цена 25000', 25000, 'RUB', true],
    ['цена: 25 000', 25000, 'RUB', true],
    ['Цена - 4500', 4500, 'RUB', true],
    ['Цена 💰 7000', 7000, 'RUB', true],
    ['Цена:\n3200', 3200, 'RUB', true],
    ['Цена: 25.000', 25000, 'RUB', true],
    ['цена всего 900', 900, 'RUB', true],
    ['цена за всё 6000', 6000, 'RUB', true],
    ['по цене 1800', 1800, 'RUB', true],
    ['стоимость 1200', 1200, 'RUB', true],
    ['прошу 3500', 3500, 'RUB', true],
    ['отдам за 500', 500, 'RUB', true],
    ['отдам за 50', 50, 'RUB', true],
    ['за 3000', 3000, 'RUB', true],
    ['заберите за 1500 сегодня', 1500, 'RUB', true],
    ['price 300', 300, 'RUB', true],
    ['Price: 1200', 1200, 'RUB', true],
  ];
  it.each(cases)('%s', (...args) => expectSinglePrice(args));
});

describe('extractPrices: другие валюты', () => {
  const cases: PriceCase[] = [
    ['$300', 300, 'USD', false],
    ['300$', 300, 'USD', false],
    ['300 $', 300, 'USD', false],
    ['300 usd', 300, 'USD', false],
    ['300 USD', 300, 'USD', false],
    ['300 долларов', 300, 'USD', false],
    ['300 баксов', 300, 'USD', false],
    ['$1.5k', 1500, 'USD', false],
    ['2 тыс. долларов', 2000, 'USD', false],
    ['iPhone 15 $700', 700, 'USD', false],
    ['€250', 250, 'EUR', false],
    ['250€', 250, 'EUR', false],
    ['250 eur', 250, 'EUR', false],
    ['250 евро', 250, 'EUR', false],
    ['300 usdt', 300, 'USDT', false],
    ['300 USDT', 300, 'USDT', false],
    ['300 юсдт', 300, 'USDT', false],
    ['500 000 тенге', 500000, 'KZT', false],
    ['500000 ₸', 500000, 'KZT', false],
    ['500000 kzt', 500000, 'KZT', false],
    ['5000 тг', 5000, 'KZT', false],
    ['5000 грн', 5000, 'UAH', false],
    ['5000 ₴', 5000, 'UAH', false],
    ['5000 uah', 5000, 'UAH', false],
    ['5к грн', 5000, 'UAH', false],
    ['300 byn', 300, 'BYN', false],
    ['300 бел. руб', 300, 'BYN', false],
    ['300 бел.руб.', 300, 'BYN', false],
    ['100 лари', 100, 'GEL', false],
    ['100 gel', 100, 'GEL', false],
    ['100 ₾', 100, 'GEL', false],
    ['50000 драм', 50000, 'AMD', false],
    ['50000 amd', 50000, 'AMD', false],
    ['1500 лир', 1500, 'TRY', false],
    ['1500 try', 1500, 'TRY', false],
    ['1500 ₺', 1500, 'TRY', false],
    ['200 дирхам', 200, 'AED', false],
    ['200 aed', 200, 'AED', false],
  ];
  it.each(cases)('%s', (...args) => expectSinglePrice(args));
});

describe('extractPrices: диапазоны', () => {
  type RangeCase = [text: string, low: number, high: number, currency: Currency, assumed: boolean];
  const cases: RangeCase[] = [
    ['20-25к', 20000, 25000, 'RUB', true],
    ['от 20 до 25 тыс', 20000, 25000, 'RUB', true],
    ['20–25 тыс руб', 20000, 25000, 'RUB', false],
    [`20${LONG_DASH}25к`, 20000, 25000, 'RUB', true],
    ['1.5-2 млн', 1500000, 2000000, 'RUB', true],
    ['от 3000 до 5000 руб', 3000, 5000, 'RUB', false],
    ['от 1 до 5 тыс рублей', 1000, 5000, 'RUB', false],
    ['$100-150', 100, 150, 'USD', false],
    ['100-150$', 100, 150, 'USD', false],
    ['500-1.5к', 500, 1500, 'RUB', true],
    ['цена 2000-2500', 2000, 2500, 'RUB', true],
    ['цена 20 - 25к', 20000, 25000, 'RUB', true],
    ['бюджет 30-35к', 30000, 35000, 'RUB', true],
  ];
  it.each(cases)('%s', (text, low, high, currency, assumed) => {
    const prices = extractPrices(text);
    expect(prices.map(p => p.amount), text).toEqual([low, high]);
    for (const p of prices) expect(p, text).toMatchObject({ currency, assumedCurrency: assumed });
  });

  it('обе границы несут в raw весь диапазон', () => {
    expect(extractPrices('куплю, бюджет 20-25к').map(p => p.raw)).toEqual(['20-25к', '20-25к']);
    expect(extractPrices('работы от 20 до 25 тыс').map(p => p.raw)).toEqual(['от 20 до 25 тыс', 'от 20 до 25 тыс']);
  });

  it('модель и цена через дефис не становятся диапазоном', () => {
    expect(extractPrices('iPhone 14-45к').map(p => p.amount)).toEqual([45000]);
    expect(extractPrices('Айфон 11-15к').map(p => p.amount)).toEqual([15000]);
    expect(extractPrices('Samsung S20-25к').map(p => p.amount)).toEqual([25000]);
  });

  it('тире с пробелами без слова цены это разделитель, а не диапазон', () => {
    expect(extractPrices('iPhone 14 - 45к').map(p => p.amount)).toEqual([45000]);
    expect(extractPrices('Наушники 2 - 3к').map(p => p.amount)).toEqual([3000]);
  });
});

describe('extractPrices: поля результата', () => {
  it('raw это совпавший кусок без слова цены', () => {
    expect(extractPrices('Цена: 25 000 ₽, торг')).toEqual([
      { amount: 25000, currency: 'RUB', raw: '25 000 ₽', assumedCurrency: false },
    ]);
    expect(extractPrices('отдам за 12к.')).toEqual([{ amount: 12000, currency: 'RUB', raw: '12к', assumedCurrency: true }]);
    expect(extractPrices('ноутбук $1.5k')[0]?.raw).toBe('$1.5k');
    expect(extractPrices('25 тыс. руб.')[0]?.raw).toBe('25 тыс. руб.');
  });

  it('валюта по умолчанию подставляется только когда валюты нет в тексте', () => {
    expect(extractPrices('25к', { defaultCurrency: 'KZT' })).toEqual([
      { amount: 25000, currency: 'KZT', raw: '25к', assumedCurrency: true },
    ]);
    expect(extractPrices('цена 150', { defaultCurrency: 'GEL' })[0]).toMatchObject({ amount: 150, currency: 'GEL' });
    expect(extractPrices('25к руб', { defaultCurrency: 'KZT' })[0]).toMatchObject({
      currency: 'RUB',
      assumedCurrency: false,
    });
    expect(extractPrices('25 т.р.', { defaultCurrency: 'GEL' })[0]).toMatchObject({
      amount: 25000,
      currency: 'RUB',
      assumedCurrency: false,
    });
  });

  it('несколько цен идут в порядке текста', () => {
    const prices = extractPrices('Стол 5000 руб, стул 1500р, лампа $20, полка 2к');
    expect(prices.map(p => [p.amount, p.currency])).toEqual([
      [5000, 'RUB'],
      [1500, 'RUB'],
      [20, 'USD'],
      [2000, 'RUB'],
    ]);
  });

  it('знак валюты достаётся одному числу', () => {
    expect(extractPrices('300$ 256gb').map(p => p.amount)).toEqual([300]);
    expect(extractPrices('25000₽ 2023').map(p => p.amount)).toEqual([25000]);
  });

  it('номер модели и объём памяти не приклеиваются к цене через пробел', () => {
    expect(extractPrices('iPhone 15 100 000 руб').map(p => p.amount)).toEqual([100000]);
    expect(extractPrices('iPhone 15 Pro Max 256 110 000 руб').map(p => p.amount)).toEqual([110000]);
    expect(extractPrices('iPhone 15 256 100 000 руб').map(p => p.amount)).toEqual([100000]);
    expect(extractPrices('iPhone 15 650 000 тенге').map(p => p.amount)).toEqual([650000]);
    expect(extractPrices('iPhone 13 Pro 45 000 руб').map(p => p.amount)).toEqual([45000]);
    expect(extractPrices('iPhone 13 128 000 руб').map(p => p.amount)).toEqual([128000]);
    expect(extractPrices('MacBook Pro 1 200 000 тенге').map(p => p.amount)).toEqual([1200000]);
    expect(extractPrices('Samsung 25 000 руб').map(p => p.amount)).toEqual([25000]);
    expect(extractPrices('Toyota Camry 1 500 000 руб').map(p => p.amount)).toEqual([1500000]);
  });

  it('пустой текст даёт пустой список', () => {
    expect(extractPrices('')).toEqual([]);
  });
});

describe('extractPrices: что ценой не считается', () => {
  const cases: string[] = [
    // годы
    '2023',
    '2024 год',
    'куплен в 2023 г.',
    'за 2023 год',
    'документы за 2023',
    // модели и характеристики
    'iPhone 15',
    '15 Pro Max',
    'Samsung A52',
    'Redmi Note 12',
    '256 gb',
    '256гб',
    '8/256',
    '16 ГБ ОЗУ, 1 ТБ SSD',
    '12 мес',
    '12 месяцев гарантии',
    '100%',
    'АКБ 87%',
    '55 дюймов',
    'диагональ 55"',
    'M2',
    'RTX 4070',
    'i5-12400F',
    '5000 mAh',
    '5к мАч',
    '120 Гц',
    '65W зарядка',
    'камера 48 мп',
    'Телевизор 4K UHD',
    'монитор 27 2к 144 гц',
    'снимает в 4к',
    'монитор 1080р',
    '10x15 см',
    // телефоны
    '+7 999 123-45-67',
    '89991234567',
    '8 (999) 123-45-67',
    'тел. 8-999-123-45-67 Ольга',
    // даты и время
    '12.05',
    '18:30',
    '01.10.2026',
    'с 10 до 20',
    'звонить после 18',
    '24/7',
    // количество и размеры
    '2 шт',
    '3 штуки',
    'за 2 шт',
    '42 размер',
    'размер 46р',
    '42 р-р',
    'XL',
    'размер 46-48',
    'рост 164',
    '2к квартира',
    'Меняю 2к квартиру на 3к с доплатой',
    'отдам за 1 шоколадку',
    'цена 3 пачки',
    // пробег, вес, время
    '45 000 км',
    'пробег 45к км',
    '25к км',
    'пробег 45к',
    'пробег 45 тыс.',
    '100к пробег',
    '5 кг',
    '500 г',
    '25 т',
    'за 15 минут',
    'за 2 дня',
    'за 10-15 минут',
    // артикулы, id, номера
    'арт. 123456',
    'артикул 4567890',
    'id 123456789',
    'лот № 12 500 руб',
    '#12345',
    'https://example.com/item/25000',
    '4276 1234 5678 9012',
    // слова вместо цены
    'бесплатно',
    'даром',
    'отдам даром',
    'цена договорная',
    // неоднозначные записи: лучше без цены, чем с неверной
    'iPhone 12 500$',
    'iPhone 7 500 руб',
    'iPhone 13 256 500$',
    '500,600,700 руб',
    '15 000 т.р.',
    '25000к',
    '2000 млн',
    '1.500 млн',
    // голые числа и мусор
    '25',
    '25000',
    '25 000',
    '25.000',
    '0 руб',
    '0к',
    '2000000000000 руб',
    '1500.5 руб',
    'д. 25 к. 2',
    'приеду в 5 к вам',
    'куплю PS5 к новому году',
    'Ryzen 5 AMD Radeon',
    'пиши в 5000 тг: @seller',
    '10к подписчиков',
  ];
  it.each(cases)('%s', text => {
    expect(extractPrices(text), text).toEqual([]);
  });
});

describe('detectListingKind', () => {
  const cases: Array<[text: string, kind: ListingKind]> = [
    ['Продам велосипед', 'sell'],
    ['продаю коляску', 'sell'],
    ['Продаётся гараж', 'sell'],
    ['Продается гараж', 'sell'],
    ['Продажа щенков', 'sell'],
    ['ПРОДАМ СРОЧНО', 'sell'],
    ['Распродажа детских вещей', 'sell'],
    ['Selling my bike', 'sell'],
    ['Bike for sale', 'sell'],
    ['WTS RTX 3080', 'sell'],
    ['#продам iPhone', 'sell'],
    ['Куплю гараж', 'buy'],
    ['покупаю золото', 'buy'],
    ['Ищу детскую коляску', 'buy'],
    ['WTB iPhone 13', 'buy'],
    ['Buying old laptops', 'buy'],
    ['#куплю ноутбук', 'buy'],
    ['Обмен на iPhone', 'swap'],
    ['Меняю PS4 на Xbox', 'swap'],
    ['обменяю на ноутбук', 'swap'],
    ['Махну не глядя', 'swap'],
    ['#обмен', 'swap'],
    ['Отдам даром диван', 'giveaway'],
    ['Диван даром', 'giveaway'],
    ['Котята бесплатно', 'giveaway'],
    ['Отдам в добрые руки щенка', 'giveaway'],
    ['#отдам детские вещи', 'giveaway'],
    ['Услуги сантехника', 'service'],
    ['Оказываю помощь с переездом', 'service'],
    ['Ремонт стиральных машин', 'service'],
    ['🔧 Ремонт телефонов', 'service'],
    ['#ремонт техники', 'service'],
    ['#услуги грузчиков', 'service'],
    // хэштег важнее слова, даже если стоит позже
    ['Продам или обменяю. #обмен', 'swap'],
    ['Ищу покупателя на гараж #продам', 'sell'],
    // из двух хэштегов и из двух слов побеждает первое
    ['#продам #обмен', 'sell'],
    ['#куплю #продам', 'buy'],
    ['Продам или обменяю', 'sell'],
    ['Обменяю или продам', 'swap'],
    ['Куплю или обменяю', 'buy'],
    // отрицания и ложные совпадения
    ['Продам ноутбук, обмен не интересует', 'sell'],
    ['Ноутбук в идеале, без обмена', 'unknown'],
    ['Ноутбук, доставка бесплатно', 'unknown'],
    ['Телефон после ремонта', 'unknown'],
    ['Продам телефон после ремонта', 'sell'],
    ['Ищу покупателя на гараж', 'unknown'],
    ['Продано', 'unknown'],
    ['#продано', 'unknown'],
    ['за тыщу отдам', 'unknown'],
    ['Нужен велосипед', 'unknown'],
    ['iPhone 13, 45к', 'unknown'],
    ['', 'unknown'],
  ];
  it.each(cases)('%s -> %s', (text, kind) => {
    expect(detectListingKind(text)).toBe(kind);
  });
});

describe('isNegotiable', () => {
  const cases: Array<[text: string, expected: boolean]> = [
    ['торг', true],
    ['Торг уместен', true],
    ['возможен торг', true],
    ['небольшой торг', true],
    ['торг при осмотре', true],
    ['Цена 5000, торг.', true],
    ['торгуюсь', true],
    ['#торг', true],
    ['price negotiable', true],
    ['без торга', false],
    ['Без торга!', false],
    ['торга нет', false],
    ['не торгуюсь', false],
    ['no bargain', false],
    ['торг не уместен', false],
    ['торг неуместен', false],
    ['цена окончательная, нет торга', false],
    ['not negotiable', false],
    ['торговый центр рядом', false],
    ['я в восторге', false],
    ['Продам стол 5000 руб', false],
    ['', false],
  ];
  it.each(cases)('%s -> %s', (text, expected) => {
    expect(isNegotiable(text)).toBe(expected);
  });
});

describe('maskPhones', () => {
  const masked: Array<[text: string, expected: string]> = [
    ['+7 999 123-45-67', '+7 9** ***-**-67'],
    ['8 (999) 123-45-67', '8 (9**) ***-**-67'],
    ['89991234567', '89*******67'],
    ['+79991234567', '+79*******67'],
    ['8-999-123-45-67', '8-9**-***-**-67'],
    ['7 999 123 45 67', '7 9** *** ** 67'],
    ['8 029 123-45-67', '8 0** ***-**-67'],
    ['+380 50 123 45 67', '+38* ** *** ** 67'],
    ['+1 (415) 555-2671', '+1 (4**) ***-**71'],
    ['+995 555 12 34 56', '+99* *** ** ** 56'],
    ['Звоните 8 999 123 45 67, цена 25 000 руб', 'Звоните 8 9** *** ** 67, цена 25 000 руб'],
    ['+7 999 123-45-67 25 000 руб', '+7 9** ***-**-67 25 000 руб'],
    ['89991234567 2500р', '89*******67 2500р'],
    ['89991234567/89997654321', '89*******67/89*******21'],
    ['wa.me/79991234567', 'wa.me/79*******67'],
    ['(+7 999 123-45-67)', '(+7 9** ***-**-67)'],
    ['Тел.:89991234567.', 'Тел.:89*******67.'],
    ['+7(999)123-45-67', '+7(9**)***-**-67'],
    ['8 999 1234567', '8 9** *****67'],
    ['8 800 555 35 35', '8 8** *** ** 35'],
    ['+375 29 123-45-67', '+37* ** ***-**-67'],
    ['+90 532 123 45 67', '+90 *** *** ** 67'],
    ['+7 999 123-45-67, 8 (999) 123-45-67 и 89991234567', '+7 9** ***-**-67, 8 (9**) ***-**-67 и 89*******67'],
    ['+7 999 123-45-67 89991234568', '+7 9** ***-**-67 89*******68'],
    [`+7 999 123${NB_HYPHEN}45${NB_HYPHEN}67`, `+7 9** ***${NB_HYPHEN}**${NB_HYPHEN}67`],
  ];
  it.each(masked)('маскирует: %s', (text, expected) => {
    expect(maskPhones(text)).toBe(expected);
  });

  const untouched: string[] = [
    '25 000 000 руб',
    '8 500 000 руб',
    '7 800 000 4 000 000',
    '+12345',
    '+1234567890123456',
    '9991234567',
    'EAN 7612345678900',
    '7 900 000 ₽',
    '1 500 000',
    '89 000 рублей',
    '4276 1234 5678 9012',
    '4276123456789012',
    '8600 1234 5678 9012',
    'id 1234567890',
    'ИНН 7712345678',
    'ИНН 771234567890',
    'заказ №123456',
    'арт. 7895412',
    '2026-10-01 18:30',
    '123-45-67',
    'vk.com/id89991234567',
    '#89991234567',
    'iPhone 8 256 гб',
    '',
  ];
  it.each(untouched)('не трогает: %s', text => {
    expect(maskPhones(text)).toBe(text);
  });
});

describe('analyzeListing: объявления целиком', () => {
  interface ListingCase {
    name: string;
    text: string;
    kind: ListingKind;
    /** Главная цена: [сумма, валюта, валюта подставлена] или null. */
    price: [number, Currency, boolean] | null;
    /** Суммы всех цен по порядку. */
    amounts: number[];
    negotiable: boolean;
  }

  const listings: ListingCase[] = [
    {
      name: 'айфон с хэштегом, ценой и телефоном',
      text: [
        '#продам',
        '📱 iPhone 13 Pro 256 гб, синий',
        'АКБ 87%, комплект полный',
        'Цена: 62 000 ₽, небольшой торг',
        'Тел: +7 999 123-45-67',
      ].join('\n'),
      kind: 'sell',
      price: [62000, 'RUB', false],
      amounts: [62000],
      negotiable: true,
    },
    {
      name: 'цена покупки не становится главной',
      text: [
        'Продам велосипед Stels Navigator 500, 2021 год, рама 18"',
        'Покупал за 35к, отдам за 22к. Торг при осмотре.',
        'Писать в лс или 89991234567',
      ].join('\n'),
      kind: 'sell',
      price: [22000, 'RUB', true],
      amounts: [35000, 22000],
      negotiable: true,
    },
    {
      name: 'покупка с диапазоном бюджета',
      text: ['Куплю PlayStation 5 с дисководом, бюджет 30-35к', 'Рассмотрю варианты с 2 геймпадами'].join('\n'),
      kind: 'buy',
      price: [30000, 'RUB', true],
      amounts: [30000, 35000],
      negotiable: false,
    },
    {
      name: 'отдам даром без цены',
      text: [
        '🎁 Отдам даром детскую кроватку, самовывоз с Ленина 25.',
        'Звонить 8 (999) 123-45-67 после 18:30',
      ].join('\n'),
      kind: 'giveaway',
      price: null,
      amounts: [],
      negotiable: false,
    },
    {
      name: 'обмен с доплатой',
      text: [
        '#обмен',
        'Меняю Xiaomi Redmi Note 12 8/256 на iPhone 12 с моей доплатой 5 тыс. руб',
        'Без торга',
      ].join('\n'),
      kind: 'swap',
      price: [5000, 'RUB', false],
      amounts: [5000],
      negotiable: false,
    },
    {
      name: 'услуги с ценой "от"',
      text: [
        '#услуги #ремонт',
        'Ремонт стиральных машин на дому. Выезд мастера от 500 руб, диагностика бесплатно.',
        'Гарантия 12 мес. Тел. +7 (999) 123-45-67',
      ].join('\n'),
      kind: 'service',
      price: [500, 'RUB', false],
      amounts: [500],
      negotiable: false,
    },
    {
      name: 'английское объявление в долларах',
      text: [
        'Selling MacBook Air M2 2023, 8/256, battery 96%',
        'Price: $850, negotiable',
        'WhatsApp +995 555 12 34 56',
      ].join('\n'),
      kind: 'sell',
      price: [850, 'USD', false],
      amounts: [850],
      negotiable: true,
    },
    {
      name: 'две валюты, отказ от торга',
      text: ['Продаю Canon EOS R6 + объектив 24-105', 'Цена 1500$ или 140 000 ₽', 'Торга нет!'].join('\n'),
      kind: 'sell',
      price: [1500, 'USD', false],
      amounts: [1500, 140000],
      negotiable: false,
    },
    {
      name: 'машина: год, пробег, объём и миллионы',
      text: [
        'Продам Toyota Camry 2018 г., пробег 85 000 км, 2.5 л, 181 л.с.',
        'Цена 2 150 000 руб. Обмен не интересует.',
        '☎️ 8-999-123-45-67',
      ].join('\n'),
      kind: 'sell',
      price: [2150000, 'RUB', false],
      amounts: [2150000],
      negotiable: false,
    },
    {
      name: 'одежда с размером и ростом',
      text: [
        'Куртка зимняя Columbia, размер 46-48, рост 170',
        'Состояние отличное, надевала пару раз',
        '1500р',
        '#продам #одежда',
      ].join('\n'),
      kind: 'sell',
      price: [1500, 'RUB', false],
      amounts: [1500],
      negotiable: false,
    },
    {
      name: 'телевизор 4K: цена нового и своя',
      text: [
        'Телевизор Samsung 55" 4K UHD Smart TV, 2022 года',
        'Новый стоит 60 000 руб, прошу 38к',
        'Торг уместен',
      ].join('\n'),
      kind: 'unknown',
      price: [38000, 'RUB', true],
      amounts: [60000, 38000],
      negotiable: true,
    },
    {
      name: 'тенге и казахстанский номер',
      text: [
        'Продам диван угловой, б/у 2 года',
        '150 000 тенге, самовывоз Алматы',
        '+7 701 123 45 67 Айгуль',
      ].join('\n'),
      kind: 'sell',
      price: [150000, 'KZT', false],
      amounts: [150000],
      negotiable: false,
    },
    {
      name: 'услуги с диапазоном "от и до"',
      text: ['Оказываю услуги электрика. Работы от 1 до 5 тыс рублей.', 'Звоните: +380 50 123 45 67'].join('\n'),
      kind: 'service',
      price: [1000, 'RUB', false],
      amounts: [1000, 5000],
      negotiable: false,
    },
    {
      name: 'распродажа с несколькими ценами',
      text: 'Распродажа! Все по 500 руб, кроссовки Nike 42 размер 2500 руб, куртка 3к',
      kind: 'sell',
      price: [500, 'RUB', false],
      amounts: [500, 2500, 3000],
      negotiable: false,
    },
    {
      name: 'USDT после слова цены важнее доллара раньше в тексте',
      text: ['WTS аккаунт Steam, 120 игр, инвентарь на 300$', 'Цена 250 USDT, торг', 'tg: @seller'].join('\n'),
      kind: 'sell',
      price: [250, 'USDT', false],
      amounts: [300, 250],
      negotiable: true,
    },
    {
      name: 'одни характеристики, цены нет',
      text: ['iPhone 15 Pro Max 256gb, идеал, 100% акб', 'В лс'].join('\n'),
      kind: 'unknown',
      price: null,
      amounts: [],
      negotiable: false,
    },
    {
      name: 'в тексте только цена покупки: главной цены нет',
      text: 'Продаю коляску Cybex, покупали за 45000 руб в 2023. Цена договорная, пишите.',
      kind: 'sell',
      price: null,
      amounts: [45000],
      negotiable: false,
    },
    {
      name: 'пробег с буквой "к" рядом с ценой',
      text: ['Продам Kia Rio 2017, пробег 95к км, один хозяин', '680 тыс. руб, торг у капота'].join('\n'),
      kind: 'sell',
      price: [680000, 'RUB', false],
      amounts: [680000],
      negotiable: true,
    },
    {
      name: 'доставка и цена после неё',
      text: ['💺 Кресло офисное, почти новое', 'Доставка по городу 300 руб', 'Цена 4500'].join('\n'),
      kind: 'unknown',
      price: [4500, 'RUB', true],
      amounts: [300, 4500],
      negotiable: false,
    },
    {
      name: 'цена с явной валютой важнее сокращения раньше в тексте',
      text: 'Продам ноут Lenovo, брали дороже. Отдам 30к или 28 000 руб наличными',
      kind: 'sell',
      price: [28000, 'RUB', false],
      amounts: [30000, 28000],
      negotiable: false,
    },
  ];

  it.each(listings)('$name', ({ text, kind, price, amounts, negotiable }) => {
    const info = analyzeListing(text);
    expect(info.kind).toBe(kind);
    expect(info.prices.map(p => p.amount)).toEqual(amounts);
    expect(info.negotiable).toBe(negotiable);
    if (price === null) {
      expect(info.price).toBeNull();
    } else {
      expect(info.price).toMatchObject({ amount: price[0], currency: price[1], assumedCurrency: price[2] });
    }
  });

  it('главная цена входит в список цен тем же объектом', () => {
    const info = analyzeListing('Продам стол 5000 руб, торг');
    expect(info.prices).toContain(info.price);
    expect(info).toEqual({
      kind: 'sell',
      price: { amount: 5000, currency: 'RUB', raw: '5000 руб', assumedCurrency: false },
      prices: [{ amount: 5000, currency: 'RUB', raw: '5000 руб', assumedCurrency: false }],
      negotiable: true,
    });
  });

  it('валюта по умолчанию доходит до цен объявления', () => {
    const info = analyzeListing('Продам стол, цена 150', { defaultCurrency: 'GEL' });
    expect(info.price).toEqual({ amount: 150, currency: 'GEL', raw: '150', assumedCurrency: true });
  });

  it('продающий глагол отменяет пометку "цена покупки"', () => {
    expect(analyzeListing('Купил не подошёл продаю за 3000').price?.amount).toBe(3000);
    expect(analyzeListing('Брала за 8000, отдам за 2500').price?.amount).toBe(2500);
    expect(analyzeListing('В магазине цена 90000, отдам за 60000').price?.amount).toBe(60000);
  });

  it('телефон из объявления маскируется, а цена остаётся', () => {
    const text = 'Продам iPhone 13, 45 000 руб. Тел: +7 999 123-45-67';
    const masked = maskPhones(text);
    expect(masked).toBe('Продам iPhone 13, 45 000 руб. Тел: +7 9** ***-**-67');
    expect(analyzeListing(masked).price?.amount).toBe(45000);
    expect(analyzeListing(text).prices).toHaveLength(1);
  });

  it('пустой текст', () => {
    expect(analyzeListing('')).toEqual({ kind: 'unknown', price: null, prices: [], negotiable: false });
  });
});
