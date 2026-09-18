/* Проверка клиентского модуля анализа. Запуск:
 *   node extension/lib/analyze.test.js
 *
 * Сеть не нужна: тестируются чистые функции. Вывод модели недетерминирован
 * по определению и тестироваться не может; тестируется то, что ОБЯЗАНО быть
 * детерминированным, — проверка цитат и сверка с каталогом.
 *
 * Если эти тесты покраснели, значит ослабла проверка, а не модель. Чинить
 * надо код: смысл механизма в строгости, и «подкрутить, чтобы проходило»
 * здесь означает выключить его.
 */
'use strict';
const A = require('./analyze.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL  ${name}` + (detail ? `\n        ${detail}` : '')); }
}

const SOURCE =
  'В марте 2026 года группировка Sandworm использовала фишинговые письма ' +
  'с вложением в формате LNK. После открытия вложения на узел загружался ' +
  'загрузчик, обращавшийся к серверу управления по адресу 185.220.101.34. ' +
  'Закрепление выполнялось через задачу планировщика Windows.';

const n = A.normalize;

(async () => {

/* ------------------------------------------------------- 1. нормализация */
{
  check('схлопывание пробелов', n('а   б\n\nв\tг') === 'а б в г');
  check('кавычки и тире приводятся', n('«текст» — тут') === n('"текст" - тут'));
  check('типографские кавычки', n('“x”') === n('"x"'));
  check('неразрывный пробел', n('а б') === 'а б');
  check('нулевой ширины убирается', n('сло​во') === 'слово');
  check('регистр не важен', n('Sandworm') === n('SANDWORM'));

  // Цифры, знаки препинания и порядок трогать нельзя — иначе проверка
  // перестаёт что-либо доказывать.
  check('цифры сохраняются', n('185.220.101.34') === '185.220.101.34');
  check('запятая значима', n('а, б') !== n('а б'));
  check('порядок слов значим', n('а б') !== n('б а'));
}

/* --------------------------------------------------------- 2. цитаты --- */
{
  const src = n(SOURCE);
  let [ok] = A.verifyQuote('обращавшийся к серверу управления по адресу 185.220.101.34', src);
  check('точная цитата подтверждается', ok);

  [ok] = A.verifyQuote('фишинговые    письма\nс вложением в формате LNK', src);
  check('цитата с иными пробелами подтверждается', ok);

  [ok] = A.verifyQuote('Использовался файл "loader.dll" на узле.',
                       n('Использовался файл «loader.dll» на узле.'));
  check('цитата с другими кавычками подтверждается', ok);

  let reason;
  [ok, reason] = A.verifyQuote('злоумышленники рассылали письма с вредоносными вложениями', src);
  check('пересказ отбрасывается', !ok && reason.includes('дословного совпадения'), reason);

  [ok] = A.verifyQuote('адрес 10.10.10.10 использовался как резервный сервер управления', src);
  check('выдуманный факт отбрасывается', !ok);

  [ok, reason] = A.verifyQuote('Sandworm', src);
  check('слишком короткая цитата отбрасывается', !ok && reason.includes('короче'), reason);

  [ok, reason] = A.verifyQuote('', src);
  check('пустая цитата отбрасывается', !ok && reason.includes('пустая'), reason);

  const huge = 'я '.repeat(800);
  [ok, reason] = A.verifyQuote(huge, n(huge));
  check('документ целиком вместо цитаты отбрасывается', !ok && reason.includes('длиннее'), reason);
}

/* ------------------------------------------------------ 3. разметка ---- */
{
  const out = await A.applyVerification('summary', {
    headline: 'Кампания Sandworm с LNK-вложениями',
    claims: [
      { claim: 'Использовались LNK-вложения',
        quote: 'с вложением в формате LNK. После открытия вложения' },
      { claim: 'Использовался Cobalt Strike',
        quote: 'на узел был установлен Cobalt Strike Beacon версии 4.9' },
    ],
  }, SOURCE);
  check('выжимка: подтверждено 1', out.verified_count === 1, `получено ${out.verified_count}`);
  check('выжимка: отброшено 1', out.unverified_count === 1);
  check('выжимка: headline сохранён', out.headline === 'Кампания Sandworm с LNK-вложениями');
  check('выжимка: не помечена как генеративная', out.generated === false);
}

{
  const out = await A.applyVerification('report', {
    context: 'Кампания релевантна.',
    recommendations: [{ action: 'Проверить журналы', rationale: 'поиск следов', priority: 'high' }],
  }, SOURCE);
  // Рекомендации нельзя подтвердить цитатой — и притворяться, что проверка
  // была, тоже нельзя.
  check('рекомендации помечены как генеративные', out.generated === true);
  check('рекомендации не заявлены проверяемыми', out.verifiable === false);
  check('рекомендации: счётчик подтверждённых ноль', out.verified_count === 0);
}

{
  const out = await A.applyVerification('iocs', {
    indicators: [{
      value: '185.220.101.34', role: 'c2', claim: 'сервер управления',
      quote: 'обращавшийся к серверу управления по адресу 185.220.101.34',
    }],
  }, SOURCE);
  check('роли индикаторов: подтверждено', out.verified_count === 1);
  check('роль сохранена', out.indicators[0].role === 'c2');
}

{
  const out = await A.applyVerification('summary', { claims: ['строка', null] }, SOURCE);
  check('мусор вместо объектов пропускается без падения', out.claims.length === 0);
  const empty = await A.applyVerification('summary', {}, SOURCE);
  check('отсутствующий ключ даёт пустой результат', empty.verified_count === 0);
}

/* ------------------------------------------------------ 4. каталог ----- */
{
  const QUOTE = 'Закрепление выполнялось через задачу планировщика Windows';

  A.__setCatalog(null);                       // настоящий каталог из файла
  let out = await A.applyVerification('attack', {
    techniques: [{ technique_id: 'T9999', name: 'Придуманная', claim: 'выдумка', quote: QUOTE }],
  }, SOURCE);
  check('несуществующая техника с верным форматом отбрасывается',
        out.techniques[0].verified === false &&
        String(out.techniques[0].reason).includes('нет в каталоге'),
        JSON.stringify(out.techniques[0]));
  check('отметка о сверке с каталогом выставлена', out.techniques[0].catalog_checked === true);

  out = await A.applyVerification('attack', {
    techniques: [
      { technique_id: 'T1053.005', name: 'Scheduled Task', claim: 'планировщик', quote: QUOTE },
      // ICS-матрица: энергетика профильный сектор, техники T0xxx там бывают.
      { technique_id: 'T0800', name: 'Activate Firmware Update Mode', claim: 'ICS', quote: QUOTE },
    ],
  }, SOURCE);
  check('настоящие техники подтверждаются', out.techniques.every((t) => t.verified),
        JSON.stringify(out.techniques));

  out = await A.applyVerification('attack', {
    techniques: [{ technique_id: ' t1053 ', name: 'x', claim: 'y', quote: QUOTE }],
  }, SOURCE);
  check('идентификатор нормализуется', out.techniques[0].technique_id === 'T1053');

  out = await A.applyVerification('attack', {
    techniques: [{ technique_id: 'фишинг', name: 'x', claim: 'y', quote: QUOTE }],
  }, SOURCE);
  check('нарушение формата отбрасывается',
        out.techniques[0].verified === false &&
        String(out.techniques[0].reason).includes('формату ATT&CK'));

  A.__setCatalog([]);                         // каталога нет
  out = await A.applyVerification('attack', {
    techniques: [{ technique_id: 'T9999', name: 'x', claim: 'y', quote: QUOTE }],
  }, SOURCE);
  check('без каталога деградируем честно: формат прошёл',
        out.techniques[0].verified === true && out.techniques[0].catalog_checked === false);
  A.__setCatalog(null);
}

/* --------------------------------------------------- 5. строгая схема -- */
{
  const s = A.strictSchema(A.SCHEMAS.summary);
  check('strictSchema: additionalProperties false', s.additionalProperties === false);
  check('strictSchema: все поля в required',
        JSON.stringify(s.required.sort()) === JSON.stringify(['claims', 'headline']));
  check('strictSchema: вложенные объекты тоже',
        s.properties.claims.items.additionalProperties === false);
  check('strictSchema: исходная схема не испорчена',
        A.SCHEMAS.summary.additionalProperties === undefined);
}

/* ------------------------------------------------- 6. конфиг политики -- */
{
  check('без llmProvider конфига нет', A.configFromManaged({}) === null);
  check('без ключа конфига нет',
        A.configFromManaged({ llmProvider: 'anthropic', llmModel: 'm' }) === null);
  check('неизвестный провайдер отвергается',
        A.configFromManaged({ llmProvider: 'нечто', llmModel: 'm', llmApiKey: 'k' }) === null);
  const cfg = A.configFromManaged({ llmProvider: 'Anthropic', llmModel: 'claude-haiku-4-5', llmApiKey: 'k' });
  check('регистр провайдера не важен', cfg && cfg.provider === 'anthropic', JSON.stringify(cfg));
  check('все провайдеры имеют реализацию',
        ['anthropic', 'cloudru', 'openai'].every((p) => typeof A.PROVIDERS[p] === 'function'));
}

/* ----------------------------------------------- 7. картинки и OCR ----- */
{
  const tiny = 'iVBORw0KGgoAAAANSUhEUg==';   // содержимое неважно, важна форма

  const img = A.parseImageDataUrl('data:image/png;base64,' + tiny);
  check('data-URL разбирается', img.mediaType === 'image/png' && img.data === tiny);

  let err = '';
  try { A.parseImageDataUrl('https://example.com/a.png'); } catch (e) { err = e.message; }
  check('обычная ссылка не принимается за картинку', /data-URL/.test(err), err);

  err = '';
  try { A.parseImageDataUrl('data:image/bmp;base64,' + tiny); } catch (e) { err = e.message; }
  check('неподдерживаемый формат отвергается с названием формата',
        /image\/bmp/.test(err) && /PNG/.test(err), err);

  // SVG — это разметка, а не растр: распознавать там нечего, а вот
  // отправить провайдеру содержимое чужого файла — вполне можно.
  err = '';
  try { A.parseImageDataUrl('data:image/svg+xml;base64,' + tiny); } catch (e) { err = e.message; }
  check('SVG не принимается', /не поддерживается/.test(err), err);

  // Предел считается ДО отправки: отказ локально бесплатен, отказ
  // провайдера за превышение — нет.
  const big = 'A'.repeat(Math.ceil(A.MAX_IMAGE_BYTES * 4 / 3) + 1000);
  err = '';
  try { A.parseImageDataUrl('data:image/png;base64,' + big); } catch (e) { err = e.message; }
  check('картинка сверх предела отвергается', /предел/.test(err), err);
  check('совет при превышении — вырезать фрагмент, а не сжать',
        /[Вв]ырежьте/.test(err), err);

  // Размер считается из base64 без запуска декодера: 4 символа = 3 байта.
  const kb = A.parseImageDataUrl('data:image/png;base64,' + 'A'.repeat(4000));
  check('размер считается из base64', kb.bytes === 3000, String(kb.bytes));

  check('ocr объявлена задачей по картинке', A.VISION_TASKS.has('ocr'));
  check('у ocr есть схема', !!A.SCHEMAS.ocr);
  check('схема ocr требует text и unclear',
        JSON.stringify(A.SCHEMAS.ocr.required) === JSON.stringify(['text', 'unclear']));

  // Главное свойство: ocr нельзя запустить как текстовую задачу. Иначе
  // она попала бы в applyVerification, где цитаты «проверяются» по пустому
  // источнику, и любой результат оказался бы неподтверждённым молча.
  let caught = '';
  try { await A.run({ provider: 'anthropic', model: 'm', apiKey: 'k' }, 'ocr', 'x'); }
  catch (e) { caught = e.message; }
  check('run() отказывается выполнять ocr', /runOcr/.test(caught), caught);

  // Промпт распознавания — это и есть весь механизм защиты индикатора
  // от «улучшения». Проверяем, что правила из него не выпали.
  const P = A.PROMPTS.ocr;
  check('промпт ocr запрещает исправлять', /НИЧЕГО НЕ ИСПРАВЛЯЙ/.test(P));
  check('промпт ocr запрещает достраивать', /НИЧЕГО НЕ ДОСТРАИВАЙ/.test(P));
  check('промпт ocr называет дефанг явно', /hxxps/.test(P));
  check('промпт ocr перечисляет похожие символы', /0 и O/.test(P) && /1 и l/.test(P));
  check('промпт ocr требует заполнять unclear', /unclear/.test(P));
}

console.log(`\n  Пройдено: ${pass}   Провалено: ${fail}\n`);
process.exit(fail ? 1 : 0);

})();
