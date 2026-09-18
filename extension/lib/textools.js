/* =============================================================================
 * textools.js — расшифровка и кодирование без единого сетевого запроса
 * =============================================================================
 *
 * ЗАЧЕМ
 * -----
 * Разбирая отчёт, аналитик каждый раз упирается в одно и то же:
 *
 *     powershell -enc SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQA...
 *
 * и уходит с этой строкой в CyberChef — то есть на чужой сайт, вставляя
 * туда содержимое расследования. Для отчёта вендора это безразлично,
 * для командной строки из инцидента клиента — нет.
 *
 * Здесь те же операции выполняются на месте. Это чистые вычисления:
 * ни одного обращения к сети, ни строки наружу.
 *
 * ЧТО ВАЖНО ЗНАТЬ ПРО BASE64 В WINDOWS
 * -------------------------------------
 * `powershell -EncodedCommand` кодирует строку в UTF-16LE, а не в UTF-8.
 * Раскодировав такую строку как UTF-8, получаешь текст, в котором между
 * каждыми двумя буквами стоит нулевой байт, — и он выглядит как мусор,
 * хотя расшифровка прошла верно. Поэтому декодер возвращает ОБА
 * прочтения и помечает, какое похоже на осмысленный текст.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО
 * -------------------------
 * Ни запуска, ни исполнения чего бы то ни было. Раскодированная строка —
 * это текст в поле ввода; дальше её разбирает тот же детерминированный
 * парсер индикаторов. Расширение не выполняет то, что нашло.
 * ========================================================================== */

'use strict';

(function initTextTools() {

if (typeof globalThis !== 'undefined' && globalThis.TIText
    && typeof globalThis.TIText.decodeBase64 === 'function') return;

/* ------------------------------------------------------------- base64 --- */

/* Похожа ли строка на base64.
 *
 * Проверка нужна не для красоты: в отчётах полно шестнадцатеричных хешей
 * длиной 64 символа, и они проходят по алфавиту base64. Поэтому одного
 * алфавита мало — смотрим ещё и на состав. Строка из одних hex-символов
 * почти наверняка хеш, а не закодированная нагрузка. */
function looksLikeBase64(s) {
  const t = String(s || '').trim();
  if (t.length < 16 || t.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return false;
  if (/^[0-9a-fA-F]+$/.test(t)) return false;          // это хеш, а не base64
  // В настоящем base64 обычно есть и заглавные, и строчные.
  return /[a-z]/.test(t) && /[A-Z0-9+/]/.test(t);
}

function b64ToBytes(s) {
  const clean = String(s || '').replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* Насколько текст похож на осмысленный.
 *
 * Нужно, чтобы выбрать между прочтениями UTF-8 и UTF-16LE и сказать это
 * вслух, а не молча показать одно из них. Считаем долю печатных символов;
 * нулевые байты штрафуем отдельно — именно они выдают UTF-16,
 * прочитанный как UTF-8. */
function textScore(s) {
  if (!s) return 0;
  let printable = 0, nulls = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0) { nulls++; continue; }
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 0xFFFD)) printable++;
  }
  const len = [...s].length || 1;
  return Math.max(0, (printable - nulls * 2) / len);
}

function decodeBytes(bytes, enc) {
  try {
    return new TextDecoder(enc, { fatal: false }).decode(bytes);
  } catch (_) {
    return '';
  }
}

/* Раскодировать base64. Возвращает ОБА прочтения и то, которое выбрано.
 *
 * {ok, chosen, encoding, utf8, utf16le, bytes, note} */
function decodeBase64(s) {
  let bytes;
  try {
    bytes = b64ToBytes(s);
  } catch (e) {
    return { ok: false, error: 'строка не является корректным base64' };
  }
  if (!bytes.length) return { ok: false, error: 'пустой результат' };

  const utf8 = decodeBytes(bytes, 'utf-8');
  const utf16le = decodeBytes(bytes, 'utf-16le');
  const s8 = textScore(utf8);
  const s16 = textScore(utf16le);

  /* UTF-16LE выбирается только при ЗАМЕТНОМ перевесе. Обычный текст
   * в UTF-8, прочитанный как UTF-16, даёт иероглифы со средним баллом,
   * и без порога выбор скакал бы от строки к строке. */
  const useUtf16 = s16 > s8 + 0.15;
  return {
    ok: true,
    bytes: bytes.length,
    utf8,
    utf16le,
    chosen: useUtf16 ? utf16le : utf8,
    encoding: useUtf16 ? 'UTF-16LE' : 'UTF-8',
    note: useUtf16
      ? 'Похоже на PowerShell -EncodedCommand: там строка кодируется в UTF-16LE'
      : '',
  };
}

function encodeBase64(s) {
  const bytes = new TextEncoder().encode(String(s == null ? '' : s));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/* Найти в тексте куски, похожие на base64.
 *
 * Отдельно ищем `-enc`/`-EncodedCommand`: в командной строке Windows
 * это самый частый носитель закодированной нагрузки, и там строка
 * стоит сразу за ключом. */
const ENC_FLAG = /-(?:e|ec|enc|encodedcommand)\s+([A-Za-z0-9+/=]{16,})/gi;
const B64_RUN = /[A-Za-z0-9+/]{24,}={0,2}/g;

function findBase64(text) {
  const src = String(text || '');
  const seen = new Set();
  const out = [];

  for (const m of src.matchAll(ENC_FLAG)) {
    const v = m[1];
    if (seen.has(v)) continue;
    seen.add(v);
    out.push({ value: v, from: 'ключ -EncodedCommand', index: m.index });
  }
  for (const m of src.matchAll(B64_RUN)) {
    const v = m[0];
    if (seen.has(v) || !looksLikeBase64(v)) continue;
    seen.add(v);
    out.push({ value: v, from: 'длинная строка base64', index: m.index });
  }
  return out.sort((a, b) => a.index - b.index);
}

/* ---------------------------------------------------------------- URL --- */

function decodeUrl(s) {
  const t = String(s || '');
  try {
    // Двойное кодирование встречается в фишинговых ссылках постоянно,
    // поэтому раскручиваем, пока строка меняется, но не больше трёх раз:
    // иначе можно уехать в бесконечный цикл на кривом входе.
    let cur = t;
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(cur.replace(/\+/g, ' '));
      if (next === cur) break;
      cur = next;
    }
    return { ok: true, value: cur };
  } catch (e) {
    return { ok: false, error: 'строка содержит некорректную %-последовательность' };
  }
}

function encodeUrl(s) { return encodeURIComponent(String(s == null ? '' : s)); }

/* ---------------------------------------------------------------- hex --- */

function hexToText(s) {
  const clean = String(s || '').replace(/0x/gi, '').replace(/[\s,:-]+/g, '');
  if (!clean || clean.length % 2) return { ok: false, error: 'нечётное число шестнадцатеричных цифр' };
  if (!/^[0-9a-fA-F]+$/.test(clean)) return { ok: false, error: 'не только шестнадцатеричные цифры' };
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return { ok: true, value: decodeBytes(bytes, 'utf-8'), bytes: bytes.length };
}

function textToHex(s) {
  return [...new TextEncoder().encode(String(s == null ? '' : s))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------------------------------------------------------- MD5 --- */
/*
 * MD5 написан здесь руками, и это осознанно: WebCrypto его не считает
 * (алгоритм признан небезопасным для подписи), а в отчётах вендоров
 * хеши чаще всего именно MD5 — сверять приходится с ними.
 *
 * Для СВЕРКИ ХЕША слабость MD5 значения не имеет: мы не подписываем им
 * ничего, а сравниваем с тем, что напечатано в отчёте. Проверяется
 * тестом на векторах из RFC 1321.
 */
function md5(input) {
  const bytes = new TextEncoder().encode(String(input == null ? '' : input));
  return md5Bytes(bytes);
}

function md5Bytes(bytes) {
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  const len = bytes.length;
  const withPad = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, bitLen >>> 0, true);
  dv.setUint32(withPad.length - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);

  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16)      { F = (B & C) | (~B & D);      g = i; }
      else if (i < 32) { F = (D & B) | (~D & C);      g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D;               g = (3 * i + 5) % 16; }
      else             { F = C ^ (B | ~D);            g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  return [a0, b0, c0, d0].map((n) => {
    let hex = '';
    for (let i = 0; i < 4; i++) hex += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    return hex;
  }).join('');
}

/* ------------------------------------------------------------- хеши ----- */

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* SHA считает WebCrypto: свою реализацию писать незачем, а MD5 он
 * не умеет принципиально. Возвращаем все четыре сразу — аналитик
 * сверяет с тем, что напечатано в отчёте, а там формат какой угодно. */
async function hashText(text) {
  const bytes = new TextEncoder().encode(String(text == null ? '' : text));
  return hashBytes(bytes);
}

async function hashBytes(bytes) {
  const out = { md5: md5Bytes(bytes), bytes: bytes.length };
  const subtle = (globalThis.crypto && globalThis.crypto.subtle) || null;
  if (!subtle) return { ...out, error: 'WebCrypto недоступен: посчитан только MD5' };
  const [s1, s256, s512] = await Promise.all([
    subtle.digest('SHA-1', bytes),
    subtle.digest('SHA-256', bytes),
    subtle.digest('SHA-512', bytes),
  ]);
  return { ...out, sha1: toHex(s1), sha256: toHex(s256), sha512: toHex(s512) };
}

/* ------------------------------------------------ список индикаторов ---- */

/* Дедупликация и подсчёт по типам.
 *
 * Дедупликация идёт по КАНОНИЧЕСКОЙ форме: `EVIL.com`, `evil.com`
 * и `evil[.]com` — одно и то же значение, и в тикете они не должны
 * стоять тремя строками. Регистр сохраняется от первого вхождения:
 * для URL он бывает значимым. */
function dedupeList(text, iocApi) {
  const IOCX = iocApi || globalThis.IOC;
  const raw = String(text || '').split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
  const seen = new Map();
  for (const item of raw) {
    const value = IOCX ? IOCX.refang(item) : item;
    const key = value.toLowerCase();
    if (seen.has(key)) { seen.get(key).count++; continue; }
    /* detectType возвращает объект {type, typeLabel, value}, а не строку.
     * Первая версия клала сюда объект целиком, и подсчёт по типам давал
     * один ключ «[object Object]» — тест это и поймал. */
    const det = IOCX && IOCX.detectType ? IOCX.detectType(value) : null;
    seen.set(key, {
      value,
      type: (det && det.type) || 'unknown',
      typeLabel: (det && det.typeLabel) || 'не распознан',
      count: 1,
    });
  }
  const items = [...seen.values()];
  const byType = {};
  for (const i of items) byType[i.type] = (byType[i.type] || 0) + 1;
  return {
    items,
    total: raw.length,
    unique: items.length,
    duplicates: raw.length - items.length,
    byType,
  };
}

/* ------------------------------------------- сравнение двух списков ---- */

/* «Что нового в обновлённом отчёте».
 *
 * Вендор публикует вторую версию отчёта; вопрос аналитика — какие
 * индикаторы добавились. Сейчас это делается глазами или уходом
 * в сторонний diff, то есть содержимое расследования опять уезжает
 * на чужой сайт.
 *
 * НИЧЕГО НЕ ХРАНИТСЯ: оба списка вставляет человек, результат живёт
 * до следующего нажатия. Поэтому здесь нет вопроса о накоплении
 * истории по клиентам — накапливать нечего.
 *
 * Сравнение идёт по КАНОНИЧЕСКОЙ форме: `evil[.]com` из старого отчёта
 * и `evil.com` из нового — одно значение, и «добавилось» о нём сказать
 * нельзя. */
function diffLists(aText, bText, iocApi) {
  const IOCX = iocApi || globalThis.IOC;
  const norm = (t) => {
    const map = new Map();
    for (const raw of String(t || '').split(/[\s,;]+/)) {
      const v = raw.trim();
      if (!v) continue;
      const canon = IOCX ? IOCX.refang(v) : v;
      const key = canon.toLowerCase();
      if (!map.has(key)) map.set(key, canon);
    }
    return map;
  };
  const A = norm(aText);
  const B = norm(bText);

  const onlyA = [];
  const onlyB = [];
  const both = [];
  for (const [k, v] of A) (B.has(k) ? both : onlyA).push(v);
  for (const [k, v] of B) if (!A.has(k)) onlyB.push(v);

  return {
    onlyA, onlyB, both,
    countA: A.size, countB: B.size,
    added: onlyB.length, removed: onlyA.length, common: both.length,
  };
}

const TEXT_API = {
  looksLikeBase64, decodeBase64, encodeBase64, findBase64,
  decodeUrl, encodeUrl, hexToText, textToHex,
  md5, md5Bytes, hashText, hashBytes, textScore, dedupeList, diffLists,
};
if (typeof module !== 'undefined' && module.exports) module.exports = TEXT_API;
if (typeof globalThis !== 'undefined') globalThis.TIText = TEXT_API;

})();
