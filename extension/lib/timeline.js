/* =============================================================================
 * timeline.js — хронология кейса и сводка для передачи смены
 * =============================================================================
 *
 * ЗАЧЕМ
 * -----
 * Кейс отвечает на вопрос «что известно». Он не отвечает на вопрос
 * «как мы к этому пришли»: когда появился индикатор, откуда он взялся,
 * что по нему открывали, почему поставлен такой вердикт.
 *
 * Эти два вопроса разные, и в отчёте клиенту они идут разными разделами.
 * Второй сейчас пишется по памяти в конце смены — то есть хуже всего
 * тогда, когда смена была тяжёлой.
 *
 * ГРАНИЦА, КОТОРУЮ ЭТОТ МОДУЛЬ НЕ ПЕРЕСЕКАЕТ
 * -------------------------------------------
 * Хронология не создаёт нового места хранения данных: она лежит в том же
 * профиле, что и кейс, живёт ровно столько же и очищается вместе с ним.
 * Наружу она уходит только там же, где уходит кейс, — в файл, который
 * аналитик скачал сам.
 *
 * Это важное свойство, и его легко потерять одной строкой кода. Поэтому:
 * очистка кейса ОБЯЗАНА очищать хронологию. Иначе удалённый индикатор
 * остаётся в профиле в виде записи «добавлен 45.151.45.31», и аналитик,
 * нажавший «очистить», получает не то, что просил.
 *
 * ЧТО ЗАПИСЫВАЕТСЯ, А ЧТО НЕТ
 * ----------------------------
 * Записывается то, что меняет состояние расследования: разобран источник,
 * добавлены индикаторы, изменён вердикт, открыт плейбук, выполнен экспорт.
 *
 * НЕ записывается текст заметок. Он уже есть в кейсе, а в хронологии стал
 * бы вторым экземпляром тех же клиентских данных — с ним пришлось бы
 * отдельно работать при очистке и при выгрузке. Фиксируется только факт:
 * «заметка изменена».
 *
 * НЕ записываются теги: это классификация, а не событие.
 *
 * ПОЧЕМУ СОБЫТИЯ СКЛЕИВАЮТСЯ
 * ---------------------------
 * Выпадающий список вердикта даёт событие на каждое изменение. Аналитик,
 * который прокликал «не проверен → вредоносный → подозрительный →
 * вредоносный», получил бы четыре строки хронологии вместо одной, и
 * хронология стала бы протоколом движений мыши. Соседние однотипные
 * события по одному значению склеиваются, а вердикт, вернувшийся к
 * исходному, удаляется целиком: ничего не произошло.
 * ========================================================================== */

'use strict';

/* Потолок числа событий. Кейс живёт в profile storage, и неограниченный
 * журнал там — это медленно растущая утечка места, которую никто не
 * заметит до отказа записи. 400 событий покрывают смену с запасом.
 *
 * Обрезанные события НЕ исчезают молча: в начало кладётся запись о том,
 * сколько их было. Молчаливая потеря данных хуже потери. */
const TIMELINE_CAP = 400;

/* Окно склейки соседних однотипных событий, миллисекунды. */
const MERGE_WINDOW_MS = 120000;

const KIND_TRUNCATED = 'timeline.truncated';

/* Реестр видов событий. label — как событие называется в хронологии,
 * text(ev) — как оно читается целиком. Вид, которого здесь нет,
 * отображается своим kind: незнакомое событие показывается как есть,
 * а не пропадает. */
const EVENT_KINDS = {
  'case.started': {
    label: 'кейс начат',
    text: (e) => `кейс начат${e.title ? `: ${e.title}` : ''}`,
  },
  'source.parsed': {
    label: 'разобран источник',
    text: (e) => `разобран источник (${e.source || 'неизвестно'})`
      + `: индикаторов ${num(e.found)}`
      + (e.noise ? `, отсеяно ${num(e.noise)}` : '')
      + (e.url ? `\n  ${e.url}` : ''),
  },
  'ioc.added': {
    label: 'добавлены индикаторы',
    text: (e) => `добавлено в кейс: ${num(e.count)}`
      + (e.source ? ` (источник: ${e.source})` : ''),
  },
  'ioc.removed': {
    label: 'индикатор удалён',
    text: (e) => `удалён из кейса: ${e.value}`,
  },
  'verdict.set': {
    label: 'вердикт',
    text: (e) => `вердикт ${e.value}: ${e.from || 'не проверен'} → ${e.to}`,
  },
  'verdict.source': {
    label: 'чем проверен',
    text: (e) => `чем проверен ${e.value}: ${e.source}`,
  },
  'note.set': {
    label: 'заметка',
    text: (e) => `заметка к ${e.value} изменена`,
  },
  'playbook.run': {
    label: 'плейбук',
    text: (e) => `плейбук «${e.playbook}» по ${e.value}`
      + `: открыто ${num(e.opened)}`
      + (e.skipped ? `, пропущено ${num(e.skipped)}` : ''),
  },
  'tools.opened': {
    label: 'инструменты',
    text: (e) => `открыто инструментов: ${num(e.count)} по ${e.value}`,
  },
  'analysis.done': {
    label: 'анализ моделью',
    text: (e) => `анализ моделью (${e.task}): утверждений ${num(e.claims)}`
      + (e.unconfirmed ? `, без подтверждения ${num(e.unconfirmed)}` : ''),
  },
  'export.done': {
    label: 'экспорт',
    text: (e) => `экспорт ${e.format}`
      + (e.skipped ? `: не выгружено ${num(e.skipped)}` : ''),
  },
  'case.cleared': {
    label: 'кейс очищен',
    text: (e) => `кейс очищен (было индикаторов: ${num(e.count)})`,
  },
  [KIND_TRUNCATED]: {
    label: 'начало обрезано',
    text: (e) => `предыдущие события удалены из-за ограничения журнала: ${num(e.n)}`,
  },
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '0';
}

/* Виды, которые склеиваются, и ключ, по которому событие считается
 * «тем же самым». Всё, чего здесь нет, не склеивается никогда. */
const MERGEABLE = {
  'ioc.added': (e) => `${e.source || ''}`,
  'verdict.set': (e) => `${e.value}`,
  'verdict.source': (e) => `${e.value}`,
  'note.set': (e) => `${e.value}`,
};

function toMs(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/* Добавление события. Возвращает НОВЫЙ массив — вызывающий код обязан
 * сохранить результат, а не полагаться на мутацию: молчаливая мутация
 * массива, который где-то отрисовывается, — источник расхождения
 * интерфейса и хранилища. */
function addEvent(timeline, event, opts = {}) {
  const cap = opts.cap || TIMELINE_CAP;
  const now = opts.now || new Date().toISOString();
  const ev = { t: now, ...event };
  if (!ev.kind) return Array.isArray(timeline) ? timeline.slice() : [];

  const out = Array.isArray(timeline) ? timeline.slice() : [];
  const last = out[out.length - 1];
  const keyOf = MERGEABLE[ev.kind];

  if (last && keyOf && last.kind === ev.kind
      && keyOf(last) === keyOf(ev)
      && toMs(ev.t) - toMs(last.t) <= (opts.mergeWindowMs ?? MERGE_WINDOW_MS)) {
    const merged = mergeEvents(last, ev);
    out.pop();
    // Вердикт, вернувшийся к исходному, — это не событие. Строка
    // «не проверен → не проверен» в отчёте клиенту выглядит как ошибка,
    // и она ею и является.
    if (merged) out.push(merged);
    return trim(out, cap);
  }

  out.push(ev);
  return trim(out, cap);
}

function mergeEvents(prev, next) {
  switch (next.kind) {
    case 'ioc.added':
      return { ...next, count: Number(prev.count || 0) + Number(next.count || 0) };
    case 'verdict.set': {
      const from = prev.from;
      if (from === next.to) return null;      // вернулись к исходному
      return { ...next, from };
    }
    default:
      return next;                            // остальное — последнее побеждает
  }
}

/* Обрезка журнала.
 *
 * Запись об обрезке сама занимает слот — поэтому при переполнении на одно
 * событие удаляются два. Это не описка: лучше честно показать «удалено 2»,
 * чем держать журнал ровно в cap ценой скрытой потери. */
function trim(list, cap) {
  if (list.length <= cap) return list;

  const head = list[0] && list[0].kind === KIND_TRUNCATED ? list[0] : null;
  let body = head ? list.slice(1) : list.slice();
  let dropped = head ? Number(head.n || 0) : 0;

  const excess = (1 + body.length) - cap;     // 1 — слот самой записи об обрезке
  if (excess > 0) {
    dropped += excess;
    body = body.slice(excess);
  }
  const t = body.length ? body[0].t : list[list.length - 1].t;
  return [{ t, kind: KIND_TRUNCATED, n: dropped }, ...body];
}

function formatEvent(ev) {
  const spec = EVENT_KINDS[ev.kind];
  if (!spec) return `${ev.kind}`;
  try { return spec.text(ev); } catch (_) { return spec.label; }
}

/* Время события. Локальное — хронология читается человеком на той же
 * машине, где события происходили; UTC заставлял бы его пересчитывать. */
function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function fmtDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'дата неизвестна';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

/* Группировка по дням. Расследование, начатое вечером и законченное утром,
 * без разделения по дням читается как одно непрерывное — а между строками
 * там ночь и другая смена. */
function groupByDay(timeline) {
  const days = [];
  for (const ev of timeline || []) {
    const day = fmtDay(ev.t);
    const cur = days[days.length - 1];
    if (cur && cur.day === day) cur.events.push(ev);
    else days.push({ day, events: [ev] });
  }
  return days;
}

/* ===================================================== СВОДКА СМЕНЫ ====
 *
 * Сводка отвечает на четыре вопроса принимающего смену, и ни на один
 * больше:
 *   1. Что это за кейс.
 *   2. Что уже сделано.
 *   3. Что установлено.
 *   4. Что осталось и что требует решения.
 *
 * Четвёртый пункт — тот, ради которого всё остальное. «Требует решения» —
 * не настроение, а проверяемые признаки:
 *   - вердикт стоит, но не указано, чем проверен: это мнение, а не факт,
 *     и в отчёт клиенту оно в таком виде идти не должно;
 *   - индикатор снят с картинки и не сверен глазами;
 *   - индикатор получен бесскобочным дефангом («evil dot com»), то есть
 *     является догадкой парсера.
 * ==================================================================== */

const VERDICT_LABELS = {
  unknown: 'не проверен',
  malicious: 'вредоносный',
  suspicious: 'подозрительный',
  clean: 'чистый',
  irrelevant: 'не относится',
};

function verdictOf(i) {
  return i && i.verdict ? i.verdict : 'unknown';
}

function summarizeWork(timeline) {
  const t = timeline || [];
  const count = (kind) => t.filter((e) => e.kind === kind).length;
  const sum = (kind, field) => t.filter((e) => e.kind === kind)
    .reduce((n, e) => n + (Number(e[field]) || 0), 0);
  return {
    events: t.length,
    sources: count('source.parsed'),
    added: sum('ioc.added', 'count'),
    verdicts: count('verdict.set'),
    playbooks: count('playbook.run'),
    toolsOpened: sum('tools.opened', 'count') + sum('playbook.run', 'opened'),
    exports: count('export.done'),
    first: t.length ? t[0].t : null,
    last: t.length ? t[t.length - 1].t : null,
  };
}

function needsDecision(items) {
  const out = [];
  for (const i of items || []) {
    const v = verdictOf(i);
    const reasons = [];
    if (v !== 'unknown' && !String(i.verdictSource || '').trim()) {
      reasons.push('вердикт без указания, чем проверен');
    }
    if (i.needsVisualCheck) reasons.push('снят с картинки, не сверен глазами');
    if ((i.flags || []).includes('ambiguous:refang')) {
      reasons.push('получен бесскобочным дефангом — догадка парсера');
    }
    if (reasons.length) out.push({ value: i.value, type: i.typeLabel || i.type, reasons });
  }
  return out;
}

/* Сводка. Чистая функция: на вход кейс и хронология, на выход текст.
 * Никаких обращений к DOM и хранилищу — это делает её проверяемой,
 * а проверять её надо: текст, который уходит сменщику, ошибается тихо. */
function buildHandover(opts = {}) {
  const items = (opts.items || []).slice();
  const timeline = opts.timeline || [];
  const title = String(opts.title || '').trim() || 'Без названия';
  const tlp = opts.tlp || 'TLP:AMBER';
  const now = opts.now || new Date().toISOString();
  const work = summarizeWork(timeline);

  const byVerdict = {};
  for (const i of items) byVerdict[verdictOf(i)] = (byVerdict[verdictOf(i)] || 0) + 1;

  const listOf = (v, limit = 20) => items.filter((i) => verdictOf(i) === v)
    .slice(0, limit)
    .map((i) => `  - ${i.value}${i.verdictSource ? ` — ${i.verdictSource}` : ''}`);

  const more = (v, limit = 20) => {
    const n = items.filter((i) => verdictOf(i) === v).length;
    return n > limit ? [`  - …и ещё ${n - limit}`] : [];
  };

  const L = [];
  L.push(`СВОДКА ДЛЯ ПЕРЕДАЧИ СМЕНЫ`);
  L.push(`Кейс: ${title}`);
  /* Версия сборки в подписи. Сводка уходит сменщику и живёт дольше
   * вкладки; по ней потом разбираются, почему результат такой. Без
   * версии по тексту нельзя сказать, каким кодом он получен. */
  const ver = String(opts.version || '').trim();
  L.push(`${tlp} · составлено ${fmtDay(now)} ${fmtTime(now)}`
         + (ver ? ` · TI Console ${ver}` : ''));
  L.push('');

  L.push('1. ЧТО СДЕЛАНО');
  if (!work.events) {
    L.push('  Действий не записано: кейс собран до появления хронологии');
    L.push('  либо заполнялся вручную.');
  } else {
    L.push(`  Разобрано источников: ${work.sources}`);
    L.push(`  Добавлено индикаторов: ${work.added}`);
    L.push(`  Проставлено вердиктов: ${work.verdicts}`);
    L.push(`  Запущено плейбуков: ${work.playbooks}, открыто сервисов: ${work.toolsOpened}`);
    if (work.first) {
      L.push(`  Первое действие: ${fmtDay(work.first)} ${fmtTime(work.first)}`
           + ` · последнее: ${fmtDay(work.last)} ${fmtTime(work.last)}`);
    }
  }
  L.push('');

  L.push('2. ЧТО УСТАНОВЛЕНО');
  if (!items.length) {
    L.push('  Кейс пуст.');
  } else {
    L.push(`  Индикаторов всего: ${items.length}`);
    for (const v of ['malicious', 'suspicious', 'clean', 'irrelevant', 'unknown']) {
      if (byVerdict[v]) L.push(`  ${VERDICT_LABELS[v]}: ${byVerdict[v]}`);
    }
    if (byVerdict.malicious) {
      L.push('');
      L.push('  Вредоносные:');
      L.push(...listOf('malicious'), ...more('malicious'));
    }
    if (byVerdict.suspicious) {
      L.push('');
      L.push('  Подозрительные:');
      L.push(...listOf('suspicious'), ...more('suspicious'));
    }
  }
  L.push('');

  L.push('3. ЧТО ОСТАЛОСЬ');
  const unknown = items.filter((i) => verdictOf(i) === 'unknown');
  if (!unknown.length) {
    L.push('  Непроверенных индикаторов нет.');
  } else {
    L.push(`  Не проверено: ${unknown.length} из ${items.length}`);
    L.push(...unknown.slice(0, 30).map((i) => `  - ${i.value} (${i.typeLabel || i.type})`));
    if (unknown.length > 30) L.push(`  - …и ещё ${unknown.length - 30}`);
  }
  L.push('');

  L.push('4. ТРЕБУЕТ РЕШЕНИЯ');
  const nd = needsDecision(items);
  if (!nd.length) {
    L.push('  Нет.');
  } else {
    for (const n of nd.slice(0, 30)) {
      L.push(`  - ${n.value}: ${n.reasons.join('; ')}`);
    }
    if (nd.length > 30) L.push(`  - …и ещё ${nd.length - 30}`);
  }
  L.push('');
  L.push('---');
  L.push('Сводка собрана из кейса и хронологии TI Console.');
  L.push('Выводы и приоритеты — за аналитиком: здесь только факты работы.');

  return L.join('\n');
}

/* Раздел хронологии для скелета отчёта. Отдельно от сводки: у них разные
 * читатели. Сводку читает сменщик, хронологию — получатель отчёта, и ему
 * нужен не список действий аналитика, а порядок появления фактов. */
function buildTimelineMarkdown(timeline, opts = {}) {
  const days = groupByDay(timeline || []);
  if (!days.length) return '_Хронология не записывалась._';
  const limit = opts.limit || 200;
  let shown = 0;
  const out = [];
  for (const d of days) {
    out.push(`**${d.day}**`, '');
    for (const ev of d.events) {
      if (shown >= limit) { out.push(`_…показаны первые ${limit} событий._`); return out.join('\n'); }
      out.push(`- \`${fmtTime(ev.t)}\` ${formatEvent(ev).replace(/\n\s*/g, ' — ')}`);
      shown++;
    }
    out.push('');
  }
  return out.join('\n').trim();
}

const TIMELINE_API = {
  TIMELINE_CAP, MERGE_WINDOW_MS, EVENT_KINDS, KIND_TRUNCATED, VERDICT_LABELS,
  addEvent, formatEvent, fmtTime, fmtDay, groupByDay,
  summarizeWork, needsDecision, buildHandover, buildTimelineMarkdown,
};
if (typeof module !== 'undefined' && module.exports) module.exports = TIMELINE_API;
if (typeof globalThis !== 'undefined') globalThis.TITimeline = TIMELINE_API;
