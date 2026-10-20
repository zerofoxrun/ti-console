/* =============================================================================
 * popup.js — быстрый разбор одного значения
 * =============================================================================
 *
 * ЗАЧЕМ ОТДЕЛЬНОЕ ОКНО
 * --------------------
 * Самое частое действие аналитика — проверить ОДНО значение: пришёл адрес
 * в тикете, надо посмотреть, что это и куда с ним идти. Раньше для этого
 * открывалась целая вкладка консоли, то есть терялось место, где человек
 * работал.
 *
 * ЧТО ИЗМЕНИЛОСЬ У ЗНАЧКА
 * -----------------------
 * До этой версии клик по значку СРАЗУ разбирал страницу — действие без
 * предупреждения и без возможности передумать. Теперь клик открывает это
 * окно, а разбор страницы стал кнопкой в нём. Один лишний клик за то, что
 * у значка больше нет необъявленного действия.
 *
 * ГРАНИЦЫ
 * -------
 * Никаких сетевых запросов. Разбор — тот же ioc.js, что и везде, поэтому
 * тип и пометки совпадут с тем, что покажет консоль. Режим данных читается
 * из общего хранилища: попап обязан уважать TLP-гейт, иначе он становится
 * дырой в нём.
 * ========================================================================== */

'use strict';

const $ = (s) => document.querySelector(s);

let TOOLS = null;
let MODE = 'public';
let OWN = null;      // разбор своих и клиентских диапазонов из политики
let НАБОРЫ = [];     // «Мои проверки» из хранилища: ноль или один набор

async function init() {
  /* Локализация до первой отрисовки — попап маленький, и подмена
     подписей после показа была бы заметна как мигание. */
  await TII18n.инициализация();
  try {
    const { ti_tlp_mode } = await browser.storage.local.get('ti_tlp_mode');
    const managed = await browser.storage.managed.get().catch(() => ({}));
    const cfg = (managed && managed.defaultTlpMode) || null;
    MODE = ti_tlp_mode || cfg || 'public';
  } catch (_) { MODE = 'public'; }
  $('#p-mode').textContent = T('режим: ') + (MODE === 'client' ? T('клиентские данные') : T('публичные'));
  try {
    TOOLS = await (await fetch(browser.runtime.getURL('data/tools.json'))).json();
  } catch (_) { TOOLS = { tools: [], playbooks: [] }; }

  /* СВОИ И КЛИЕНТСКИЕ ДИАПАЗОНЫ ЧИТАЮТСЯ И ЗДЕСЬ.
   *
   * До 1.1.0 попап знал только про режим данных, а про диапазоны — нет.
   * Консоль в публичном режиме не пускала свой адрес в публичный сервис
   * и спрашивала подтверждение; попап в том же случае молча открывал
   * вкладку. Одна и та же политика обязана действовать на всех
   * поверхностях, иначе самая быстрая из них становится обходным путём. */
  try {
    const managed = await browser.storage.managed.get().catch(() => ({}));
    OWN = globalThis.TIOwnRanges
      ? TIOwnRanges.разобрать(managed && managed.ownRanges, managed && managed.ownDomains)
      : null;
  } catch (_) { OWN = null; }

  await загрузитьНаборы();
}

/**
 * «Мои проверки» из хранилища.
 *
 * Читается при каждом открытии попапа, а не кэшируется на сеанс:
 * состав правят в консоли, и попап обязан показать правку сразу, иначе
 * человек правит одно, а из трея открывается другое.
 *
 * Ненастроенный набор даёт пустой список, и блока наборов в окне просто
 * не будет: кнопка «нечего открывать» — это шум, а не информация.
 */
async function загрузитьНаборы() {
  if (!globalThis.TIMyPlaybooks) { НАБОРЫ = []; return; }
  let сырое = null;
  try {
    const r = await browser.storage.local.get(TIMyPlaybooks.КЛЮЧ);
    сырое = r && r[TIMyPlaybooks.КЛЮЧ];
  } catch (_) { сырое = null; }
  const { хранилище } = TIMyPlaybooks.нормализовать(сырое);
  НАБОРЫ = TIMyPlaybooks.список(хранилище, (TOOLS && TOOLS.tools) || []);
}

/** Значение принадлежит своим или клиентским диапазонам. */
function чьё(det) {
  if (!OWN || !globalThis.TIOwnRanges || !det) return null;
  return TIOwnRanges.чей({ type: det.type, value: det.value }, OWN) || null;
}

/** Адрес сервиса с подставленным значением. */
function адрес(t, det) {
  return t.url.replace(/\{\{ioc\}\}/g, encodeURIComponent(det.value))
              .replace(/\{\{ioc_raw\}\}/g, det.value);
}

/**
 * Доступен ли инструмент для этого значения.
 *
 * Два правила, и второго здесь раньше не было: режим данных и свои
 * диапазоны. `можноОтправить` возвращает false только для публичных
 * сервисов, поэтому внутренние и ограниченные остаются доступны —
 * как в консоли.
 */
function allowed(t, det) {
  if (MODE === 'client' && t.exposure === 'public') return false;
  if (det && OWN && globalThis.TIOwnRanges
      && !TIOwnRanges.можноОтправить({ type: det.type, value: det.value }, OWN, t.exposure)) {
    return false;
  }
  return true;
}

function render(value) {
  const res = $('#res');
  res.textContent = '';
  const v = String(value || '').trim();
  if (!v) { res.hidden = true; return; }

  /* Берём ПЕРВЫЙ индикатор из вставленного, а не только detectType:
   * человек вставляет строку из тикета целиком, вместе с окружением. */
  const found = IOC.extractIocs(v, { withContext: false });
  const det = found.length ? found[0] : IOC.detectType(v);
  if (!det || !det.type) { res.hidden = true; return; }

  res.hidden = false;
  const head = document.createElement('div');
  head.className = 'res-type';
  head.textContent = det.typeLabel || det.type;
  const val = document.createElement('div');
  val.className = 'res-val';
  val.textContent = det.value;
  res.append(head, val);

  /* Пометки показываются здесь же: гомоглиф или «это догадка» нужны
   * до того, как аналитик куда-то пойдёт, а не после. */
  const flags = det.flags || [];
  if (flags.length) {
    const fl = document.createElement('div');
    fl.style.marginTop = '5px';
    for (const f of flags) {
      const b = document.createElement('span');
      b.className = 'badge' + (/^(ambiguous|non-routable)/.test(f) ? ' badge-warn' : '');
      b.style.marginRight = '4px';
      b.textContent = f;
      fl.append(b);
    }
    res.append(fl);
  }

  const подходящие = (TOOLS.tools || [])
    .filter((t) => (t.types || []).includes(det.type))
    .filter((t) => allowed(t, det));

  /* Почему сервисов стало меньше — говорится вслух. Молча укоротить
   * список значит дать аналитику думать, что проверять больше негде. */
  const своё = чьё(det);
  if (своё) {
    const п = document.createElement('p');
    п.className = 'more';
    п.textContent = T('Свой или клиентский: ')
      + (TIOwnRanges.подпись ? TIOwnRanges.подпись(своё) : '')
      + T(' — публичные сервисы пропущены.');
    res.append(п);
  }

  const chips = document.createElement('div');
  chips.className = 'tool-chips';
  chips.style.marginTop = '8px';
  if (!подходящие.length) {
    const s = document.createElement('span');
    s.className = 'no-tools';
    s.textContent = MODE === 'client'
      ? T('Нет доступных сервисов в режиме клиентских данных.')
      : T('Для этого типа в реестре нет сервисов.');
    chips.append(s);
  } else {
    for (const t of подходящие.slice(0, 12)) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.title = t.note || '';
      const dot = document.createElement('i');
      dot.className = 'dot dot-' + (t.exposure === 'limited' ? 'limited' : 'public');
      b.append(dot, document.createTextNode(' ' + t.name));
      b.addEventListener('click', () => {
        browser.tabs.create({ url: адрес(t, det), active: true });
        window.close();
      });
      chips.append(b);
    }
  }
  res.append(chips);

  if (подходящие.length > 12) {
    const m = document.createElement('p');
    m.className = 'more';
    m.textContent = T`Показаны 12 из ${подходящие.length}. Остальные — в консоли.`;
    res.append(m);
  }

  наборы(res, det, своё);
}

/* ========================================================= МОИ ПРОВЕРКИ ==
 *
 * Отзыв аналитика: «не держать десяток вкладок» и «выбрать набор и
 * открыть только его, не заходя в консоль».
 *
 * Набор ОДИН и на все типы индикаторов. Шесть типизированных плейбуков
 * из поставки здесь больше не предлагаются: шесть кнопок в окне
 * шириной 360 пикселей — это выбор, которого аналитик не просил, и
 * четыре из шести всё равно не подходят найденному типу. Какие из
 * сервисов списка сработают, решает тип индикатора, а не человек.
 *
 * Состав настраивается в консоли (вкладка «Настройки»), а сюда приходит
 * готовым: редактор в окне 360 пикселей шириной — это не настройка,
 * а головоломка.
 *
 * ПЕРЕСПРОСА НЕТ, И ЭТО ОСОЗНАННО
 * -------------------------------
 * До этой правки набор больше восьми шагов требовал второго нажатия.
 * Смысл переспроса был в том, что человек не знает, сколько откроется.
 * Теперь он знает: число стоит на самой кнопке до нажатия («открыть 11»),
 * и состав набора он задал сам. Подтверждение того, что написано на
 * кнопке, которую только что нажали, — это не защита, а привычка жать
 * «да» не читая; она обесценивает и те подтверждения, которые нужны.
 *
 * Что осталось защитой: TLP-гейт и гейт своих диапазонов. Они не
 * спрашивают — они не открывают, и говорят почему.
 * ========================================================================= */

function наборы(res, det, своё) {
  if (!globalThis.TIPlaybook) return;
  const все = TIPlaybook.playbooksFor(НАБОРЫ, [det.type]);
  if (!все.length) return;

  const шапка = document.createElement('div');
  шапка.className = 'res-type';
  шапка.style.marginTop = '10px';
  шапка.textContent = T('Наборы проверок');
  res.append(шапка);

  for (const pb of все) {
    const план = TIPlaybook.planPlaybook(pb, TOOLS.tools || [], det.type, MODE, !!своё);
    const строка = document.createElement('div');
    строка.className = 'row';
    строка.style.marginTop = '6px';

    const кн = document.createElement('button');
    кн.className = 'btn btn-mini';
    кн.type = 'button';
    кн.disabled = план.steps.length === 0;
    кн.textContent = плана_подпись(pb, план);
    кн.title = T(pb.note || '');

    /* Одно нажатие — открытие. Кнопка гасится сразу, чтобы второе
     * нажатие по той же кнопке не открыло набор дважды: вкладки
     * создаются асинхронно, и за это время успевает пройти второй клик. */
    кн.addEventListener('click', async () => {
      кн.disabled = true;
      кн.textContent = T`Открываю ${план.steps.length}…`;
      const открыто = await открытьНабор(план.steps, det);
      кн.textContent = T`Открыто ${открыто} из ${план.steps.length}`;
    });
    строка.append(кн);

    /* Пропущенные шаги называются числом и причиной. Это та же
     * строчка, что в консоли: набор, молча открывший половину,
     * выглядит как набор, открывший всё.
     *
     * Пропуск по типу — не пропуск, а само устройство набора: список
     * один на все типы, и для IPv4 сервисы по хешам не открываются
     * по замыслу. Писать «пропущено 14: не работает с этим типом»
     * значило бы каждый раз сообщать об исправной работе — и приучить
     * не читать эту строку там, где она важна. */
    const названные = план.skipped.filter((s) => s.why !== TIPlaybook.PB_SKIP.TYPE);
    if (названные.length) {
      const пр = document.createElement('span');
      пр.className = 'cap-state';
      пр.textContent = T`пропущено ${названные.length}: ` + причины(названные);
      строка.append(пр);
    }
    res.append(строка);
  }
}

function плана_подпись(pb, план) {
  const имя = T(pb.name || pb.id);
  return план.steps.length
    ? T`${имя} — открыть ${план.steps.length}`
    : T`${имя} — нечего открывать`;
}

/** Причины пропуска, каждая по одному разу. */
function причины(skipped) {
  const было = [];
  for (const s of skipped) {
    const why = s && s.why ? String(s.why) : '';
    if (why && !было.includes(why)) было.push(why);
  }
  return было.join(', ');
}

/**
 * Открывает шаги набора ФОНОВЫМИ вкладками.
 *
 * active: false здесь принципиально. С active: true браузер
 * перебрасывает человека на каждую следующую вкладку, и к концу
 * открытия он смотрит на последний сервис, не понимая, где остальные.
 */
async function открытьНабор(шаги, det) {
  let открыто = 0;
  for (const [n, t] of шаги.entries()) {
    try {
      await browser.tabs.create({ url: адрес(t, det), active: false });
      открыто++;
    } catch (_) { /* браузер может отказать — считаем честно, что открылось */ }
    /* Тот же ограничитель, что в консоли. Без паузы Firefox считает
     * серию открытий popup-flood и схлопывает часть вкладок — молча,
     * то есть набор из одиннадцати шагов превращается в набор из шести,
     * и человек об этом не узнаёт. В Chromium этого не наблюдалось,
     * но пауза в 400 мс на каждые пять вкладок дешевле, чем
     * расхождение поведения между браузерами. */
    if (n % 5 === 4) await new Promise((r) => setTimeout(r, 400));
  }
  return открыто;
}

function go() { render($('#q').value); }

$('#go').addEventListener('click', go);
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
});

$('#scan').addEventListener('click', () => {
  /* Разбор страницы переехал сюда с клика по значку. Сообщение уходит
   * фоновому скрипту: попап закроется раньше, чем разбор закончится. */
  browser.runtime.sendMessage({ cmd: 'scan-active-tab' }).catch(() => {});
  window.close();
});

$('#scan-case').addEventListener('click', () => {
  /* Разбор страницы СРАЗУ В КЕЙС.
   *
   * Отдельная кнопка, а не галочка рядом с первой: это разные решения,
   * и второе необратимее. Нажав его, аналитик говорит «всё, что тут
   * найдётся, относится к моему расследованию» — и адрес страницы
   * попадёт в хронологию, а оттуда в отчёт.
   *
   * Автоматического сбора со всех вкладок за этим не стоит и стоять
   * не будет: одна кнопка — одна страница. */
  browser.runtime.sendMessage({ cmd: 'scan-active-tab-into-case' }).catch(() => {});
  window.close();
});

/* --- сбор с этой вкладки ---
 *
 * Состояние спрашивается при каждом открытии попапа и показывается
 * словами. Сбор, о котором человек забыл, — это расширение, которое
 * молча читает страницы; поэтому здесь и подпись, и значок ● на самой
 * кнопке расширения. */
async function обновитьСбор() {
  let с = null;
  try {
    const r = await browser.runtime.sendMessage({ cmd: 'capture-state' });
    с = r && r.сеанс;
    $('#cap-state').textContent = (r && r.подпись) || T('сбор не идёт');
  } catch (_) {
    $('#cap-state').textContent = T('состояние сбора неизвестно');
  }
  $('#cap-state').className = 'cap-state' + (с ? ' is-on' : '');
  $('#cap-toggle').textContent = с ? T('Остановить сбор') : T('Собирать с этой вкладки');
  $('#cap-toggle').classList.toggle('btn-primary', !!с);
  return с;
}

$('#cap-toggle').addEventListener('click', async () => {
  const идёт = $('#cap-toggle').textContent === T('Остановить сбор');
  const r = await browser.runtime
    .sendMessage({ cmd: идёт ? 'capture-stop' : 'capture-start' })
    .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  if (r && r.ok === false) {
    /* Отказ ОБЪЯСНЯЕТСЯ прямо здесь. «Нажал — ничего не произошло»
     * для функции, которая должна была начать работать в фоне,
     * неотличимо от поломки. */
    $('#cap-state').textContent = T('не включено: ') + (r.error || T('неизвестно'));
    $('#cap-state').className = 'cap-state is-on';
    return;
  }
  await обновитьСбор();
});

$('#open').addEventListener('click', async () => {
  await browser.tabs.create({ url: browser.runtime.getURL('newtab/newtab.html'), active: true });
  window.close();
});

/* Значение из буфера не подставляется автоматически: чтение буфера без
 * спроса — это ровно то поведение, за которое ругают чужие расширения. */
init().then(() => { обновитьСбор(); $('#q').focus(); });
