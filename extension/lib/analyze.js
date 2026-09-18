/* =============================================================================
 * analyze.js — анализ текста моделью ПРЯМО ИЗ БРАУЗЕРА
 * =============================================================================
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ
 * --------------------------
 * До сих пор к модели ходил бэкенд: он держал ключ, считал квоту и вёл
 * журнал. В локальной конфигурации бэкенда нет вообще, а модель нужна.
 * Поэтому расширение обращается к API провайдера напрямую.
 *
 * Это НЕ равноценная замена серверу, и делать вид, что равноценная,
 * нельзя. Что теряется:
 *
 *   1. Ключ провайдера лежит в политике на машине аналитика. Оттуда его
 *      читает и сам аналитик (about:debugging), и любой код, получивший
 *      исполнение в контексте расширения. Считайте ключ известным всем,
 *      у кого есть доступ к машине.
 *      ЕДИНСТВЕННАЯ РАБОЧАЯ ЗАЩИТА — жёсткий лимит трат на стороне
 *      провайдера. Не «следить за счётом», а именно ограничение,
 *      после которого ключ перестаёт работать.
 *   2. Общего кеша нет: одинаковые запросы разных аналитиков
 *      оплачиваются по отдельности.
 *   3. Журнала аудита нет.
 *   4. TLP-гейт остаётся только на клиенте. Серверной проверки,
 *      которую нельзя обойти, здесь просто негде разместить.
 *
 * Что НЕ теряется и перенесено сюда полностью: схемы, промпты, проверка
 * цитат и сверка техник с каталогом ATT&CK. Это и есть то, что отделяет
 * выжимку от вымысла, и оно обязано работать одинаково в обоих режимах.
 *
 * ПАРИТЕТ С СЕРВЕРОМ
 * ------------------
 * Логика проверки цитат — зеркало backend/app/analyze.py. Расхождение
 * означало бы, что один и тот же отчёт даёт разный результат в зависимости
 * от того, есть сервер или нет. Совпадение проверяется тестом
 * extension/lib/analyze.test.js и паритетным тестом на стороне бэкенда.
 *
 * КУДА МОЖЕТ ХОДИТЬ РАСШИРЕНИЕ
 * ----------------------------
 * Здесь раньше стояло: «список хостов зафиксирован в connect-src, подменить
 * llmBase на чужой адрес бесполезно — запрос заблокирует CSP». Это больше
 * не так. Директива ослаблена до `connect-src 'self' https:` ради разбора
 * индикаторов по ссылке (адрес там произвольный по условию задачи), и
 * подмена llmBase теперь браузером НЕ блокируется.
 *
 * Список PROVIDER_HOSTS ниже остался, но это не граница, а проверка на
 * опечатку: он даёт понятную ошибку вместо запроса не туда. Настоящих
 * ограничений два — llmModelAllowlist и то, что права на policies.json
 * есть только у администратора машины (а у него есть и XPI).
 * ========================================================================== */

'use strict';

/* ------------------------------------------------------------ константы -- */

const MIN_QUOTE_CHARS = 24;
// Цитата короче 24 символов ничего не доказывает: «атака», «C2», «2026 год»
// найдутся в любом тексте.

const MAX_QUOTE_CHARS = 1000;
// Верхняя граница против вырожденной стратегии «процитировать документ
// целиком»: формально верная цитата, практически — отказ от работы.

const MAX_INPUT_CHARS = 50000;
// ~18-25 тыс. токенов русского текста. Всё сверх обрезается, и в ответе
// выставляется truncated — молча не режем.

const MAX_OUTPUT_TOKENS = 4096;

const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
// Ограничение провайдера — 5 МБ на изображение УЖЕ В BASE64, а base64
// раздувает данные примерно в 1.37 раза. 3.5 МБ исходника укладывается
// в лимит с запасом. Картинку сверх лимита МЫ НЕ СЖИМАЕМ: уменьшение
// скриншота убивает мелкий шрифт, а мелкий шрифт здесь и есть предмет
// распознавания. Правильное действие — вырезать нужный фрагмент, и об
// этом надо сказать аналитику, а не молча испортить картинку.

/* --------------------------------------------------------- нормализация -- */

const PUNCT_MAP = {
  '«': '"', '»': '"', '“': '"', '”': '"', '„': '"', '‟': '"',
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '—': '-', '–': '-', '‒': '-', '−': '-', '―': '-',
  ' ': ' ', ' ': ' ', ' ': ' ',
  '​': '', '﻿': '', '­': '',
};
const PUNCT_RE = new RegExp('[' + Object.keys(PUNCT_MAP).join('') + ']', 'g');

/**
 * Приведение к виду, в котором сравниваются цитата и источник.
 *
 * Убираются только различия, возникающие при копировании текста и не
 * меняющие смысла: форма кавычек и тире, неразрывные и нулевой ширины
 * пробелы, кратность пробелов, регистр, форма Unicode.
 *
 * НЕ убираются и убираться не должны: слова, цифры, знаки препинания,
 * порядок. Иначе проверка перестаёт быть проверкой.
 */
function normalize(text) {
  return String(text == null ? '' : text)
    .normalize('NFKC')
    .replace(PUNCT_RE, (c) => PUNCT_MAP[c])
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/** Проверка одной цитаты. Возвращает [подтверждена, причина отказа]. */
function verifyQuote(quote, sourceNorm) {
  if (!quote || !String(quote).trim()) return [false, 'пустая цитата'];
  const q = normalize(quote);
  if (q.length < MIN_QUOTE_CHARS) {
    return [false, `цитата короче ${MIN_QUOTE_CHARS} символов — не доказывает утверждение`];
  }
  if (q.length > MAX_QUOTE_CHARS) {
    return [false, `цитата длиннее ${MAX_QUOTE_CHARS} символов — это пересказ документа, а не цитата`];
  }
  return sourceNorm.includes(q) ? [true, ''] : [false, 'дословного совпадения в исходном тексте нет'];
}

/* -------------------------------------------------------- каталог ATT&CK -- */

const TECHNIQUE_RE = /^T\d{4}(?:\.\d{3})?$/;
let ATTACK_IDS = null;

/**
 * Каталог подгружается из файла расширения один раз. Проверки формата
 * недостаточно: «T9999» ей удовлетворяет, а такой техники не существует.
 * Каталога нет — работаем по формату и честно отдаём catalogChecked=false,
 * а не делаем вид, что проверили.
 */
async function loadAttackCatalog() {
  if (ATTACK_IDS) return ATTACK_IDS;
  try {
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      // Node: тесты и паритетная проверка с Python. В браузере эта ветка
      // недостижима — require там нет.
      const fs = require('fs'), path = require('path');
      const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'attack-techniques.json'), 'utf8');
      ATTACK_IDS = new Set(JSON.parse(raw).techniques);
    } else {
      const url = (typeof browser !== 'undefined' && browser.runtime)
        ? browser.runtime.getURL('data/attack-techniques.json')
        : '../data/attack-techniques.json';
      ATTACK_IDS = new Set((await (await fetch(url)).json()).techniques);
    }
  } catch (_) {
    // Каталога нет — работаем по формату и честно отдаём catalogChecked=false,
    // а не делаем вид, что проверили.
    ATTACK_IDS = new Set();
  }
  return ATTACK_IDS;
}

/** Только для тестов: подменить каталог, в том числе на пустой. */
function __setCatalog(ids) { ATTACK_IDS = ids === null ? null : new Set(ids); }

/* ------------------------------------------------------------- схемы ----- */
// format/response_format ограничивает декодирование так, что невалидный
// JSON сгенерировать нельзя. Это снимает класс ошибок разбора, но ничего
// не говорит о правдивости содержимого — за неё отвечает проверка цитат.

const CLAIM_ITEM = {
  type: 'object',
  properties: { claim: { type: 'string' }, quote: { type: 'string' } },
  required: ['claim', 'quote'],
};

const SCHEMAS = {
  summary: {
    type: 'object',
    properties: {
      headline: { type: 'string' },
      claims: { type: 'array', items: CLAIM_ITEM },
    },
    required: ['headline', 'claims'],
  },
  iocs: {
    type: 'object',
    properties: {
      indicators: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            role: {
              type: 'string',
              enum: ['c2', 'payload-delivery', 'phishing', 'exfiltration',
                     'scanning', 'victim', 'unknown'],
            },
            claim: { type: 'string' },
            quote: { type: 'string' },
          },
          required: ['value', 'role', 'claim', 'quote'],
        },
      },
    },
    required: ['indicators'],
  },
  attack: {
    type: 'object',
    properties: {
      techniques: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            technique_id: { type: 'string' },
            name: { type: 'string' },
            claim: { type: 'string' },
            quote: { type: 'string' },
          },
          required: ['technique_id', 'name', 'claim', 'quote'],
        },
      },
    },
    required: ['techniques'],
  },
  report: {
    type: 'object',
    properties: {
      context: { type: 'string' },
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            rationale: { type: 'string' },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['action', 'rationale', 'priority'],
        },
      },
    },
    required: ['context', 'recommendations'],
  },
  /* Распознавание текста с картинки. Стоит особняком от всех остальных
   * задач, и об этом отличии должен знать не только код, но и аналитик:
   *
   *   у остальных задач есть ИСТОЧНИК, по которому цитату можно проверить
   *   поиском подстроки. У распознавания источник — пиксели, сверить
   *   с ними программно нечего. Проверка цитат здесь неприменима не
   *   потому, что её «не сделали», а потому, что сверять не с чем.
   *
   * Что делается вместо неё:
   *   1. unclear — модель обязана сама перечислить фрагменты, в которых
   *      не уверена. Это не гарантия, но это единственное место, где
   *      модель признаётся, что угадывала;
   *   2. распознанный текст показывается ЦЕЛИКОМ рядом с картинкой,
   *      чтобы аналитик сверил глазами;
   *   3. индикаторы из него достаёт тот же детерминированный парсер —
   *      он отсеет то, что не является индикатором по форме (длина хеша,
   *      октеты IPv4, существующий TLD);
   *   4. каждый такой индикатор помечается source=ocr и несёт эту метку
   *      до отчёта включительно.
   */
  ocr: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      unclear: { type: 'array', items: { type: 'string' } },
    },
    required: ['text', 'unclear'],
  },
};

// Задача report — единственная ГЕНЕРАТИВНАЯ: рекомендации не содержатся
// в источнике, подтвердить их цитатой нельзя. Смешивать её с извлекающими
// задачами в одном признаке «проверено» нельзя — это разные по природе вещи.
const GENERATIVE_TASKS = new Set(['report']);

// Задачи, которым на вход идёт картинка, а не текст. Проверка цитат
// к ним неприменима — см. комментарий у схемы ocr.
const VISION_TASKS = new Set(['ocr']);

const TASK_KEY = { summary: 'claims', iocs: 'indicators', attack: 'techniques', report: null, ocr: null };

/**
 * Дополняет схему тем, чего требует строгий режим Claude и OpenAI:
 * additionalProperties:false и ВСЕ свойства в required.
 */
function strictSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(strictSchema);
  const out = { ...schema };
  if (out.type === 'object') {
    const props = {};
    for (const [k, v] of Object.entries(out.properties || {})) props[k] = strictSchema(v);
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  } else if (out.type === 'array' && out.items) {
    out.items = strictSchema(out.items);
  }
  return out;
}

/* ------------------------------------------------------------- промпты --- */

const COMMON_RULES = `
Ты работаешь в SOC и разбираешь публичный отчёт по угрозам.

ЖЁСТКИЕ ПРАВИЛА:
1. Опирайся ТОЛЬКО на приведённый текст. Ничего не добавляй из общих знаний.
2. К каждому утверждению приложи поле quote — фрагмент исходного текста
   ДОСЛОВНО, символ в символ, включая знаки препинания. Не пересказывай,
   не переводи и не сокращай цитату. Копируй как есть.
3. Цитата должна быть длиной не меньше одного полного предложения.
4. Если в тексте нет данных для пункта — не выдумывай его, просто не включай.
5. Отвечай строго по JSON-схеме, без пояснений вокруг JSON.

Проверка автоматическая: цитата ищется в исходном тексте поиском подстроки.
Неточная цитата — утверждение отбрасывается целиком.
`;

const PROMPTS = {
  summary: COMMON_RULES + `
ЗАДАЧА: краткая выжимка для дежурной смены.
headline — одна строка, суть отчёта.
claims — от 3 до 8 ключевых фактов: кто, что, как, против кого, чем детектится.
`,
  iocs: COMMON_RULES + `
ЗАДАЧА: определить РОЛЬ каждого индикатора в атаке.
Извлечением значений занимается отдельный детерминированный парсер — от тебя
нужна не выдача списка, а контекст: чем является этот адрес или хеш.
role: c2 — управление; payload-delivery — раздача полезной нагрузки;
phishing — фишинговая площадка; exfiltration — вывод данных;
scanning — сканирование; victim — пострадавший; unknown — из текста не ясно.
Индикаторы, роль которых в тексте не описана, не включай.
`,
  attack: COMMON_RULES + `
ЗАДАЧА: сопоставить описанные действия с MITRE ATT&CK.
technique_id — идентификатор вида T1566 или T1566.001, ровно в этом формате.
name — официальное название техники.
claim — что именно в тексте соответствует этой технике.
Не притягивай технику по одному ключевому слову: нужно описанное действие.
`,
  report: `
Ты работаешь в SOC и готовишь ЧЕРНОВИК раздела рекомендаций.

context — 2-3 предложения: почему это релевантно защищаемой инфраструктуре.
recommendations — конкретные проверяемые действия. Не «усилить мониторинг»,
а «проверить журналы прокси на обращения к перечисленным доменам за 30 дней».
priority: high — при подтверждённой эксплуатации или активной кампании;
medium — превентивно; low — гигиена.

Это черновик для аналитика, а не готовый текст. Не выдумывай названия систем
и версии, которых нет в исходном тексте.
`,
  /* Промпт распознавания. Каждое правило здесь отвечает конкретному
   * способу испортить индикатор, и ни одно не является общими словами.
   *
   * Правило 2 (не исправлять) — главное. Обученная на текстах модель
   * склонна «починить» то, что выглядит сломанным: превратить
   * hxxps в https, evil[.]com в evil.com, опечатку в известное слово.
   * Для отчёта это было бы улучшением, для индикатора — подменой:
   * дефанг снимает наш собственный парсер, и снимает предсказуемо.
   *
   * Правило 3 (не достраивать) — против обрезанных строк. Хеш, у которого
   * не влез хвост, модель охотно допишет до 64 символов. Такой хеш
   * пройдёт все проверки формата и будет бесполезен либо вреден.
   *
   * Правило 4 (похожие символы) — 0/O, 1/l/I, 5/S, rn/m. В обычном тексте
   * различие незаметно, в домене и хеше оно решает всё. */
  ocr: `
Ты распознаёшь текст с изображения для аналитика SOC. Это НЕ пересказ
и НЕ перевод: нужен точный текст, который видно на картинке.

ЖЁСТКИЕ ПРАВИЛА:
1. Перепиши весь видимый текст, сохраняя порядок и переносы строк.
   Таблицу передавай построчно, разделяя ячейки пробелами.
2. НИЧЕГО НЕ ИСПРАВЛЯЙ. Если написано hxxps://evil[.]com — так и пиши.
   Не раскрывай дефанг, не исправляй опечатки, не дополняй сокращения,
   не переводи. Ты переписываешь, а не улучшаешь.
3. НИЧЕГО НЕ ДОСТРАИВАЙ. Если строка обрезана краем картинки или
   многоточием — перепиши ровно столько, сколько видно. Не дополняй хеш
   до полной длины и не угадывай остаток адреса.
4. Символы, которые легко спутать (0 и O, 1 и l и I, 5 и S, rn и m),
   передавай ровно так, как выглядит на картинке.
5. Всё, в чём ты не уверен, продублируй в массив unclear: сам фрагмент
   как ты его прочитал. Пустой unclear означает полную уверенность —
   не ставь его пустым «на всякий случай».
6. Если текста на картинке нет — верни пустой text и пустой unclear.
`,
};

/* ------------------------------------------------------------ провайдеры -- */
// Список ЗДЕСЬ — единственный: в манифесте стоит connect-src 'self' https:,
// то есть браузер чужой хост не отклонит. Проверка нужна, чтобы опечатка
// в policies.json давала понятную ошибку, а не запрос не по адресу.
// Границей это не является — см. шапку файла.

const PROVIDER_HOSTS = {
  anthropic: 'https://api.anthropic.com',
  cloudru: 'https://foundation-models.api.cloud.ru',
};

function userBlock(text) {
  return `ИСХОДНЫЙ ТЕКСТ:\n\n${text}`;
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('модель вернула невалидный JSON вопреки схеме: ' + e.message);
  }
}

async function callAnthropic(cfg, prompt, text, schema, image) {
  // Картинка идёт ПЕРЕД текстом: у Anthropic это задокументированный
  // порядок для задач вида «изображение + инструкция», он заметно точнее
  // обратного.
  const content = image
    ? [{ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
       { type: 'text', text: text || 'Распознай текст с изображения.' }]
    : userBlock(text);
  const body = {
    model: cfg.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    system: prompt,
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema } },
  };
  const r = await fetch((cfg.base || PROVIDER_HOSTS.anthropic) + '/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      // Без этого заголовка API отклоняет запросы из браузерного контекста.
      // Название выбрано Anthropic намеренно пугающим: ключ в браузере —
      // это осознанный размен, а не норма. Разбор размена — в шапке файла.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Claude API вернул ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  if (data.stop_reason === 'refusal') {
    throw new Error('модель отказалась отвечать на этот текст');
  }
  if (data.stop_reason === 'max_tokens') {
    throw new Error(`ответ обрезан лимитом в ${MAX_OUTPUT_TOKENS} токенов`);
  }
  return parseJson((data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
}

async function callOpenAiCompatible(cfg, prompt, text, schema, image) {
  const base = (cfg.base || PROVIDER_HOSTS.cloudru).replace(/\/+$/, '');
  const url = (base.endsWith('/v1') ? base : base + '/v1') + '/chat/completions';
  // В OpenAI-совместимом API картинка передаётся как data-URL внутри
  // блока image_url. Это тот же base64, просто другая упаковка.
  const userContent = image
    ? [{ type: 'text', text: text || 'Распознай текст с изображения.' },
       { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } }]
    : userBlock(text);
  const body = {
    model: cfg.model,
    temperature: 0,
    max_tokens: MAX_OUTPUT_TOKENS,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'ti_analysis', schema, strict: true },
    },
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: userContent },
    ],
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Провайдер вернул ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return parseJson(data.choices[0].message.content);
}

const PROVIDERS = {
  anthropic: callAnthropic,
  cloudru: callOpenAiCompatible,
  openai: callOpenAiCompatible,
};

/* ---------------------------------------------------------- проверка ----- */

async function applyVerification(task, raw, source) {
  const sourceNorm = normalize(source);

  if (GENERATIVE_TASKS.has(task)) {
    // Рекомендации не выводятся из цитат — их нечем проверять.
    // Помечаем честно и не притворяемся, что проверка была.
    return {
      generated: true,
      verifiable: false,
      note: 'Рекомендации сгенерированы моделью и НЕ подтверждены цитатами. '
          + 'Это черновик: решение принимает аналитик.',
      context: raw.context || '',
      recommendations: raw.recommendations || [],
      verified_count: 0,
      unverified_count: 0,
    };
  }

  const key = TASK_KEY[task];
  const items = Array.isArray(raw[key]) ? raw[key] : [];
  const catalog = await loadAttackCatalog();
  const checked = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const [ok, reason] = verifyQuote(item.quote, sourceNorm);
    const entry = { ...item, verified: ok };
    if (!ok) entry.reason = reason;

    if (task === 'attack') {
      const tid = String(item.technique_id || '').trim().toUpperCase();
      entry.technique_id = tid;
      if (!TECHNIQUE_RE.test(tid)) {
        entry.verified = false;
        entry.reason = `идентификатор техники «${tid}» не соответствует формату ATT&CK`;
      } else if (catalog.size && !catalog.has(tid)) {
        // Формат правильный, техники не существует. Именно так выглядит
        // правдоподобная выдумка, и без каталога она проходит насквозь.
        entry.verified = false;
        entry.reason = `техники ${tid} нет в каталоге ATT&CK`;
        entry.catalog_checked = true;
      } else {
        entry.catalog_checked = catalog.size > 0;
      }
    }
    checked.push(entry);
  }

  const verified = checked.filter((c) => c.verified).length;
  const out = {
    generated: false,
    verifiable: true,
    verified_count: verified,
    unverified_count: checked.length - verified,
  };
  out[key] = checked;
  if (task === 'summary') out.headline = raw.headline || '';
  return out;
}

/* -------------------------------------------------------------- запуск --- */

/**
 * Конфигурация приезжает из политики (browser.storage.managed):
 *   llmProvider  anthropic | cloudru | openai
 *   llmModel     имя модели у провайдера
 *   llmApiKey    ключ
 *   llmBase      необязательно: свой адрес для openai-совместимого API
 */
function configFromManaged(m) {
  if (!m || !m.llmProvider) return null;
  const provider = String(m.llmProvider).trim().toLowerCase();
  if (!PROVIDERS[provider]) return null;
  if (!m.llmApiKey || !m.llmModel) return null;
  return { provider, model: String(m.llmModel), apiKey: String(m.llmApiKey), base: m.llmBase || '' };
}

async function run(cfg, task, text, sourceUrl = '') {
  if (!SCHEMAS[task]) throw new Error('неизвестная задача: ' + task);
  if (VISION_TASKS.has(task)) throw new Error('задача «' + task + '» работает с картинкой — вызывайте runOcr');
  const fn = PROVIDERS[cfg.provider];
  if (!fn) throw new Error('неизвестный провайдер: ' + cfg.provider);

  const truncated = text.length > MAX_INPUT_CHARS;
  const body = text.slice(0, MAX_INPUT_CHARS);

  const t0 = Date.now();
  const raw = await fn(cfg, PROMPTS[task], body, strictSchema(SCHEMAS[task]));
  const elapsed = Date.now() - t0;

  // Проверяем по ТОМУ ЖЕ тексту, который видела модель. Если проверять
  // по полному, а модель видела обрезанный, цитаты из хвоста подтвердятся
  // без основания.
  const result = await applyVerification(task, raw, body);
  Object.assign(result, {
    task,
    model: cfg.model,
    provider: cfg.provider,
    external: true,
    source_url: sourceUrl,
    elapsed_ms: elapsed,
    truncated,
    input_chars: body.length,
  });
  if (truncated) {
    result.truncated_note = `Текст обрезан до ${MAX_INPUT_CHARS} символов. `
      + 'Анализ выполнен по началу документа — проверьте, не осталось ли '
      + 'существенное в отброшенной части.';
  }
  return result;
}

/* ---------------------------------------------------- распознавание ------ */

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
// Ровно те типы, которые принимают оба провайдера. BMP и TIFF не принимает
// никто, SVG — это разметка, а не растр, и распознавать там нечего.

/**
 * Разбирает data-URL вида data:image/png;base64,AAAA... в { mediaType, data }.
 * Отдельная функция, потому что проверять тип и размер надо ДО отправки:
 * ошибка провайдера за 402 рубля хуже, чем отказ локально и бесплатно.
 */
function parseImageDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m) throw new Error('это не изображение в формате data-URL');
  const mediaType = m[1].toLowerCase();
  if (!IMAGE_TYPES.includes(mediaType)) {
    throw new Error(`формат ${mediaType} не поддерживается: нужен PNG, JPEG, WebP или GIF`);
  }
  const data = m[2];
  // base64 кодирует 3 байта в 4 символа; хвостовые "=" не считаются.
  const bytes = Math.floor(data.replace(/=+$/, '').length * 3 / 4);
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error(
      `картинка ${(bytes / 1024 / 1024).toFixed(1)} МБ, предел ${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(1)} МБ. `
      + 'Вырежьте нужный фрагмент: это и дешевле, и точнее, чем сжимать целый экран.');
  }
  return { mediaType, data, bytes };
}

/**
 * Распознаёт текст с картинки. Возвращает { text, unclear, ... }.
 *
 * Сознательно НЕ возвращает индикаторы: их достаёт IOC.extractIocs
 * из вызывающего кода. Разделение не формальное — оно означает, что
 * список индикаторов получается детерминированным парсером из текста,
 * а не выдачей модели. Модель здесь отвечает только за «что написано
 * на картинке», и ошибиться может только в этом.
 */
async function runOcr(cfg, dataUrl) {
  const fn = PROVIDERS[cfg.provider];
  if (!fn) throw new Error('неизвестный провайдер: ' + cfg.provider);
  const image = parseImageDataUrl(dataUrl);

  const t0 = Date.now();
  const raw = await fn(cfg, PROMPTS.ocr, '', strictSchema(SCHEMAS.ocr), image);
  const elapsed = Date.now() - t0;

  const text = String(raw.text || '');
  return {
    task: 'ocr',
    text,
    unclear: Array.isArray(raw.unclear) ? raw.unclear.map(String).filter(Boolean) : [],
    // Явно и машиночитаемо: проверка цитат не выполнялась и выполнена
    // быть не может. Интерфейс обязан показать это, а не промолчать.
    verifiable: false,
    generated: false,
    note: 'Текст распознан моделью. Сверить его программно не с чем — '
        + 'источником была картинка. Сверьте глазами, прежде чем вносить '
        + 'индикаторы в кейс.',
    model: cfg.model,
    provider: cfg.provider,
    external: true,
    image_bytes: image.bytes,
    image_type: image.mediaType,
    elapsed_ms: elapsed,
  };
}

const ANALYZE_API = {
  MIN_QUOTE_CHARS, MAX_QUOTE_CHARS, MAX_INPUT_CHARS, MAX_IMAGE_BYTES, IMAGE_TYPES,
  SCHEMAS, PROMPTS, PROVIDERS, PROVIDER_HOSTS, GENERATIVE_TASKS, VISION_TASKS, TASK_KEY,
  normalize, verifyQuote, strictSchema, applyVerification,
  loadAttackCatalog, configFromManaged, run, runOcr, parseImageDataUrl, __setCatalog,
};

if (typeof module !== 'undefined' && module.exports) module.exports = ANALYZE_API;
if (typeof globalThis !== 'undefined') globalThis.TIAnalyze = ANALYZE_API;
