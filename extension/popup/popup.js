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

async function init() {
  try {
    const { ti_tlp_mode } = await browser.storage.local.get('ti_tlp_mode');
    const managed = await browser.storage.managed.get().catch(() => ({}));
    const cfg = (managed && managed.defaultTlpMode) || null;
    MODE = ti_tlp_mode || cfg || 'public';
  } catch (_) { MODE = 'public'; }
  $('#p-mode').textContent = 'режим: ' + (MODE === 'client' ? 'клиентские данные' : 'публичные');
  try {
    TOOLS = await (await fetch(browser.runtime.getURL('data/tools.json'))).json();
  } catch (_) { TOOLS = { tools: [] }; }
}

/** Доступен ли инструмент в текущем режиме. Правило одно на всё расширение. */
function allowed(t) {
  if (MODE === 'client' && t.exposure === 'public') return false;
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
    .filter(allowed);

  const chips = document.createElement('div');
  chips.className = 'tool-chips';
  chips.style.marginTop = '8px';
  if (!подходящие.length) {
    const s = document.createElement('span');
    s.className = 'no-tools';
    s.textContent = MODE === 'client'
      ? 'Нет доступных сервисов в режиме клиентских данных.'
      : 'Для этого типа в реестре нет сервисов.';
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
        const url = t.url.replace(/\{\{ioc\}\}/g, encodeURIComponent(det.value))
                         .replace(/\{\{ioc_raw\}\}/g, det.value);
        browser.tabs.create({ url, active: true });
        window.close();
      });
      chips.append(b);
    }
  }
  res.append(chips);

  if (подходящие.length > 12) {
    const m = document.createElement('p');
    m.className = 'more';
    m.textContent = `Показаны 12 из ${подходящие.length}. Остальные — в консоли.`;
    res.append(m);
  }
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

$('#open').addEventListener('click', async () => {
  await browser.tabs.create({ url: browser.runtime.getURL('newtab/newtab.html'), active: true });
  window.close();
});

/* Значение из буфера не подставляется автоматически: чтение буфера без
 * спроса — это ровно то поведение, за которое ругают чужие расширения. */
init().then(() => $('#q').focus());
