/* =============================================================================
 * casegraph.js — схема кейса: откуда что взялось
 * =============================================================================
 *
 * ЧТО ЭТО НЕ ТАКОЕ
 * ----------------
 * Это НЕ граф связей инфраструктуры. Такой граф требует обогащения —
 * резолвов, пассивного DNS, данных о сертификатах, — а сервера у браузера
 * нет и обогащения он не делает. Нарисовать похожую картинку можно,
 * и она была бы враньём: аналитик прочитал бы рёбра как «эти хосты
 * связаны», а на деле они значили бы «оба лежали в одном PDF».
 *
 * Поэтому рёбер ровно два вида, и каждое подписано тем, что оно значит:
 *
 *   «из источника»  — индикатор извлечён вот отсюда. Источник —
 *                     отдельный узел, а не невидимая группа: тогда
 *                     «встретились в одном источнике» видно как два
 *                     ребра в один прямоугольник, а не как паутина
 *                     из n² линий между индикаторами.
 *
 *   «часть целого»  — вычисляется из САМИХ значений, без запросов:
 *                     URL → его хост, почта → её домен,
 *                     поддомен → домен, IP → подсеть.
 *                     Оба конца обязаны уже быть в кейсе: дорисовывать
 *                     узел, которого аналитик не добавлял, нельзя —
 *                     это ровно тот «выдуманный индикатор», от которого
 *                     защищается парсер.
 *
 * ПОРОГ ПОКАЗА
 * ------------
 * При десяти и меньше индикаторах таблица кейса читается быстрее схемы,
 * а схема из четырёх кружков выглядит как недоделка. MIN_FOR_GRAPH — это
 * не настройка вкуса, а граница, за которой картинка начинает выигрывать
 * у списка.
 * ========================================================================== */

'use strict';

(function initCaseGraph() {

if (typeof globalThis !== 'undefined' && globalThis.TIGraph
    && typeof globalThis.TIGraph.buildGraph === 'function') return;

const MIN_FOR_GRAPH = 11;          // «больше десяти» — решение заказчика

const EDGE_LABELS = {
  'from-source': 'из источника',
  'part-of': 'часть целого',
};

/** Хост из URL. null, если это не URL. */
function hostOfUrl(v) {
  try { return new URL(String(v)).hostname.toLowerCase(); } catch (_) { return null; }
}

/** Домен из адреса почты. */
function domainOfEmail(v) {
  const m = /@([^@\s]+)$/.exec(String(v || ''));
  return m ? m[1].toLowerCase() : null;
}

/** Входит ли IPv4 в подсеть вида a.b.c.d/nn. Без библиотек и без сети. */
function ipInCidr(ip, cidr) {
  const [base, bitsRaw] = String(cidr).split('/');
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const num = (s) => {
    const p = String(s).split('.').map(Number);
    if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
    // >>> 0: без него сдвиг на 32 даёт отрицательное число.
    return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  };
  const a = num(ip); const b = num(base);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const mask = (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

const HOSTY = new Set(['domain', 'onion']);

/**
 * Схема кейса.
 * @param {Array} items индикаторы активного кейса
 * @returns {{nodes: Array, edges: Array, sources: Array, enough: boolean, total: number}}
 */
function buildGraph(items) {
  const list = (Array.isArray(items) ? items : []).filter((i) => i && i.value);
  const nodes = [];
  const edges = [];

  /* --- узлы-индикаторы ------------------------------------------------ */
  const byValue = new Map();       // нижний регистр значения -> узел
  for (const i of list) {
    const value = String(i.value);
    const key = value.toLowerCase();
    if (byValue.has(key)) continue;            // один узел на значение
    const n = {
      id: 'i:' + key,
      kind: 'ioc',
      type: i.type || 'keyword',
      typeLabel: i.typeLabel || i.type || '',
      label: value,
      verdict: i.verdict || 'unknown',
      source: i.source || '',
    };
    byValue.set(key, n);
    nodes.push(n);
  }

  /* --- узлы-источники и рёбра «из источника» -------------------------- */
  const sources = new Map();       // подпись -> узел
  for (const i of list) {
    const src = String(i.source || '').trim();
    if (!src) continue;                        // источник не записан — рисовать нечего
    if (!sources.has(src)) {
      const n = { id: 's:' + src, kind: 'source', label: src, count: 0 };
      sources.set(src, n);
      nodes.push(n);
    }
    const s = sources.get(src);
    const target = byValue.get(String(i.value).toLowerCase());
    if (!target) continue;
    s.count++;
    edges.push({
      from: target.id, to: s.id, kind: 'from-source',
      label: EDGE_LABELS['from-source'], source: src,
      why: `${target.label} извлечён из: ${src}`,
    });
  }

  /* --- рёбра «часть целого» -------------------------------------------
   * Считаются из самих значений. Второй конец обязан уже быть в кейсе. */
  const hostNode = (h) => (h ? byValue.get(String(h).toLowerCase()) : null);

  for (const n of nodes) {
    if (n.kind !== 'ioc') continue;

    if (n.type === 'url') {
      const t = hostNode(hostOfUrl(n.label));
      if (t && t !== n) {
        edges.push({ from: n.id, to: t.id, kind: 'part-of', label: EDGE_LABELS['part-of'],
                     why: `${t.label} — хост этого адреса` });
      }
    }

    if (n.type === 'email') {
      const t = hostNode(domainOfEmail(n.label));
      if (t && t !== n) {
        edges.push({ from: n.id, to: t.id, kind: 'part-of', label: EDGE_LABELS['part-of'],
                     why: `${t.label} — домен этого адреса почты` });
      }
    }

    if (HOSTY.has(n.type)) {
      /* Поддомен → домен. Ищем САМЫЙ ДЛИННЫЙ из присутствующих предков:
       * если в кейсе есть и evil.top, и a.evil.top, то b.a.evil.top
       * должен цепляться к a.evil.top, а не через голову. */
      const parts = n.label.toLowerCase().split('.');
      let best = null;
      for (let k = 1; k < parts.length - 1; k++) {
        const cand = hostNode(parts.slice(k).join('.'));
        if (cand && cand !== n) { best = cand; break; }
      }
      if (best) {
        edges.push({ from: n.id, to: best.id, kind: 'part-of', label: EDGE_LABELS['part-of'],
                     why: `${n.label} — поддомен ${best.label}` });
      }
    }

    if (n.type === 'ipv4') {
      for (const m of nodes) {
        if (m.kind === 'ioc' && m.type === 'cidr' && ipInCidr(n.label, m.label)) {
          edges.push({ from: n.id, to: m.id, kind: 'part-of', label: EDGE_LABELS['part-of'],
                       why: `${n.label} входит в ${m.label}` });
        }
      }
    }
  }

  /* Дубликаты рёбер не нужны: один и тот же индикатор может прийти
   * из одного источника несколько раз. */
  const seen = new Set();
  const uniq = [];
  for (const e of edges) {
    const k = `${e.kind}|${e.from}|${e.to}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(e);
  }

  const iocCount = nodes.filter((n) => n.kind === 'ioc').length;
  return {
    nodes,
    edges: uniq,
    sources: [...sources.values()],
    total: iocCount,
    enough: iocCount >= MIN_FOR_GRAPH,
  };
}

/** Что сказать, если схему показывать рано. */
function whyNotShown(g) {
  if (!g || g.enough) return '';
  return `Схема появится, когда в кейсе станет больше ${MIN_FOR_GRAPH - 1} индикаторов `
       + `(сейчас ${g ? g.total : 0}). На меньшем числе таблица читается быстрее.`;
}

const API = { buildGraph, whyNotShown, ipInCidr, hostOfUrl, domainOfEmail,
              MIN_FOR_GRAPH, EDGE_LABELS };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof globalThis !== 'undefined') globalThis.TIGraph = API;

})();
