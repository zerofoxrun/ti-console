/* =============================================================================
 * panel/panel.js — логика боковой панели
 * Читает результат последнего разбора из storage (а не из прямого сообщения:
 * панель может быть закрыта в момент, когда background закончил разбор).
 * ========================================================================== */

'use strict';

const $ = (s) => document.querySelector(s);
let TOOLS = null;
let LAST = null;
let TLP = 'public';

async function loadTools() {
  if (TOOLS) return TOOLS;
  TOOLS = await (await fetch(browser.runtime.getURL('data/tools.json'))).json();
  return TOOLS;
}

const allowed = (t) => (TLP === 'client' ? t.exposure !== 'public' : true);

function buildUrl(tool, value) {
  return tool.url.replace(/\{\{ioc\}\}/g, encodeURIComponent(value))
                 .replace(/\{\{ioc_raw\}\}/g, value);
}

/* Лиса в пустой панели.
 *
 * Панель узкая, поэтому масштаб 3 (48 пикселей), а не 5 как в консоли.
 * Запускается и останавливается вместе с пустым состоянием: кадры
 * в скрытом блоке — это расход батареи без единого зрителя, а боковая
 * панель у аналитика открыта весь день.
 *
 * Сдвиг не нужен: с большой лисой консоли эта на одном экране
 * не встречается. */
let panelFox = null;
function syncPanelFox(show) {
  const canvas = document.getElementById('p-fox');
  if (!canvas || !globalThis.TIFox) return;
  if (show && !panelFox) {
    panelFox = TIFox.startFox(canvas, { scale: 3 });
  } else if (!show && panelFox) {
    panelFox.stop();
    panelFox = null;
  }
}

async function render() {
  await loadTools();
  const list = $('#p-list');
  list.textContent = '';

  const iocs = LAST?.iocs || [];
  $('#p-count').textContent = iocs.length;
  $('#p-empty').hidden = iocs.length > 0;
  syncPanelFox(iocs.length === 0);
  /* `source` пишет фоновый скрипт, но в хранилище может лежать запись
   * от прежней сборки, где поля ещё не было. Без запасного значения
   * строка выводила «undefined: https://…» — видно на снимке панели. */
  $('#p-src').textContent = LAST?.pageUrl ? `${LAST.source || 'источник'}: ${LAST.pageUrl}` : '';

  for (const i of iocs) {
    const d = document.createElement('details');
    d.className = 'p-ioc';

    const s = document.createElement('summary');
    s.innerHTML = `<span class="ioc-type">${i.type}</span><span class="p-val"></span>` +
                  (i.count > 1 ? `<span class="badge badge-count" style="margin-left:auto">×${i.count}</span>` : '');
    s.querySelector('.p-val').textContent = i.value;

    const b = document.createElement('div');
    b.className = 'p-body';
    const chips = document.createElement('div');
    chips.className = 'tool-chips';

    const order = { internal: 0, limited: 1, public: 2 };
    const tools = TOOLS.tools
      .filter((t) => t.types.includes(i.type) && allowed(t))
      .sort((a, c) => order[a.exposure] - order[c.exposure] || a.name.localeCompare(c.name));

    if (!tools.length) {
      chips.innerHTML = '<span class="no-tools">Нет доступных инструментов в текущем режиме.</span>';
    }
    for (const t of tools) {
      const a = document.createElement('a');
      a.className = 'chip';
      a.href = buildUrl(t, i.value);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = `${t.note || ''}\n[${t.exposure}/${t.activity}]`;
      a.innerHTML = `<i class="dot dot-${t.exposure === 'internal' ? 'internal' : t.exposure === 'limited' ? 'limited' : 'public'}"></i>`;
      a.append(document.createTextNode(t.name));
      chips.append(a);
    }
    b.append(chips);
    d.append(s, b);
    list.append(d);
  }
}

async function refresh() {
  LAST = await browser.runtime.sendMessage({ cmd: 'get-last-scan' });
  await render();
}

/* ------------------------------------------------------------- действия */
$('#p-rescan').addEventListener('click', async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  await browser.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['lib/ioc.js', 'content/scan.js'],
  }).catch((e) => alert('Не удалось прочитать страницу: ' + e.message));
});

$('#p-copy').addEventListener('click', async () => {
  const text = (LAST?.iocs || []).map((i) => i.value).join('\n');
  await navigator.clipboard.writeText(text);
  $('#p-copy').textContent = 'Скопировано';
  setTimeout(() => ($('#p-copy').textContent = 'Копировать все'), 1400);
});

/* Кладём в АКТИВНЫЙ кейс общего хранилища `ti_cases`.
 *
 * Здесь раньше стояла запись в `ti_case_items` с комментарием «тот же
 * ключ, что и у главной вкладки». С 0.28.0 это перестало быть правдой:
 * вкладка перешла на `ti_cases`, панель осталась на старом ключе, и
 * «В кейс» из панели молча никуда не попадало — панель при этом честно
 * писала «+7». Найдено сплошным прогоном, а не тестом: у панели и
 * вкладки разные файлы, и по отдельности каждый был исправен.
 *
 * Добавление идёт через общую TICases.addItemsToActive — чтобы
 * правило «только активный кейс» было одно на оба места. */
$('#p-case').addEventListener('click', async () => {
  const btn = $('#p-case');
  const items = LAST?.iocs || [];
  if (!items.length) { flash(btn, 'нечего', 'В кейс'); return; }

  const raw = (await browser.storage.local.get(TICases.STORE_KEY))[TICases.STORE_KEY];
  const r = TICases.addItemsToActive(raw, items, { source: LAST.pageUrl || 'страница' });
  if (!r.ok) { flash(btn, r.error, 'В кейс', 2600); return; }

  await browser.storage.local.set({ [TICases.STORE_KEY]: r.store });
  /* Вкладка расширения могла быть открыта в момент записи; без сигнала
   * она показывала бы старый кейс до перезагрузки. */
  browser.runtime.sendMessage({ cmd: 'cases-changed' }).catch(() => {});
  flash(btn, `+${r.added}` + (r.созданКейс ? ' · новый кейс' : '')
             + (r.повторов ? ` · ${r.повторов} уже были` : ''), 'В кейс',
        r.созданКейс || r.повторов ? 2600 : 1400);
});

function flash(btn, text, back, ms = 1400) {
  btn.textContent = text;
  setTimeout(() => { btn.textContent = back; }, ms);
}

$('#p-clear').addEventListener('click', async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  await browser.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.__tiConsoleClearHighlights?.(),
  }).catch(() => {});
  await browser.runtime.sendMessage({ cmd: 'clear-badge' });
});

/* ==================== ХОСТ ТЕКУЩЕЙ СТРАНИЦЫ ==========================
 *
 * Замена расширения Country Flags & IP Whois. Оно показывает флаг страны
 * сервера прямо в адресной строке — пассивно, ничего не спрашивая.
 * Полезно: «сайт российского банка», резолвящийся в хостинг в Молдове,
 * виден сразу.
 *
 * ЧЕГО МЫ НЕ ДЕЛАЕМ И ПОЧЕМУ
 * --------------------------
 * Страну и ASN по адресу без сервера получить неоткуда:
 *   - внешний запрос к ipinfo и подобным отправил бы туда историю
 *     посещений аналитика — ровно то, за что мы не ставим VT4Browsers;
 *   - своя база IP→страна весит мегабайты, устаревает и тянет
 *     лицензионные условия.
 * Поэтому здесь показывается ТОЛЬКО то, что определяется локально:
 * адрес (резолв самим браузером) и его класс по RFC. Страна и ASN —
 * в один клик, через инструменты реестра, то есть с явным решением
 * аналитика, а не автоматически при каждом открытии страницы.
 *
 * Резолв идёт через browser.dns.resolve — разрешение "dns", не host
 * permission: доступа к содержимому страниц оно не даёт.
 * ==================================================================== */

let HOST_TAB = null;

async function showHost() {
  const box = $('#p-host');
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    HOST_TAB = tab;
    if (!tab || !/^https?:/i.test(tab.url || '')) { box.hidden = true; return; }
    const host = new URL(tab.url).hostname;
    $('#p-host-name').textContent = host;
    $('#p-host-ips').textContent = '';
    $('#p-deny-note').hidden = true;
    box.hidden = false;
    refreshDenyState();

    /* В Chrome API dns нет, и подменить его нечем: единственный способ
     * получить адрес там — отправить имя хоста во внешний сервис, что
     * запрещено первым требованием проекта.
     *
     * Кнопку НЕ прячем. Спрятанная кнопка — это «функции никогда не было»,
     * и аналитик, знающий её по Firefox, будет искать причину в себе.
     * Отключённая кнопка с причиной — это «функции здесь нет и вот почему». */
    const btn = $('#p-host-resolve');
    if (btn && globalThis.TICompat && TICompat.нет('dns')) {
      btn.disabled = true;
      btn.title = 'В этом браузере недоступно';
      const было = $('#p-host-nodns');
      if (!было) {
        const p = document.createElement('p');
        p.id = 'p-host-nodns';
        p.className = 'p-host-note';
        p.textContent = 'Резолв имени в этом браузере недоступен: в Chrome нет API, '
          + 'который резолвит средствами самого браузера. Сделать это через внешний '
          + 'сервис значило бы отправить туда имя расследуемого хоста.';
        $('#p-host-ips').after(p);
      }
    }
  } catch (_) {
    box.hidden = true;
  }
}

/* Класс адреса определяется локально и без базы — по RFC.
 * Это немного, но это ровно то, что чаще всего нужно знать сразу:
 * не смотрит ли «внешний» домен внутрь периметра. */
function ipv4Note(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => Number.isNaN(n))) return '';
  if (o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168))
    return 'частный адрес (RFC 1918) — домен указывает внутрь сети';
  if (o[0] === 127) return 'петля — домен указывает на саму машину';
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return 'CGNAT (RFC 6598)';
  if (o[0] === 169 && o[1] === 254) return 'link-local';
  if (o[0] === 0 || o[0] >= 224) return 'зарезервирован';
  return '';
}

async function resolveHost() {
  const btn = $('#p-host-resolve');
  const out = $('#p-host-ips');
  const host = $('#p-host-name').textContent;
  if (!host) return;
  btn.disabled = true;
  out.textContent = 'резолв…';

  let rec;
  try {
    rec = await browser.dns.resolve(host);
  } catch (e) {
    out.textContent = '';
    const p = document.createElement('p');
    p.className = 'p-host-note';
    // Известная причина отказа: DNS через SOCKS-прокси. Firefox отдаёт
    // NS_ERROR_UNKNOWN_PROXY_HOST, и без объяснения это выглядит поломкой.
    p.textContent = /PROXY_HOST/i.test(String(e.message || e))
      ? 'Резолв недоступен: DNS идёт через SOCKS-прокси. Это настройка прокси, а не ошибка.'
      : 'Резолв не удался: ' + String(e.message || e).slice(0, 120);
    out.append(p);
    btn.disabled = false;
    return;
  }

  out.textContent = '';
  await loadTools();
  const lookups = TOOLS.tools.filter((t) =>
    ['bgp-he', 'ipinfo', 'shodan', 'greynoise', 'talos'].includes(t.id) && allowed(t));

  for (const ip of rec.addresses || []) {
    const row = document.createElement('div');
    row.className = 'p-host-ip';
    const v = document.createElement('span');
    v.textContent = ip;
    row.append(v);

    const note = ipv4Note(ip);
    if (note) {
      const n = document.createElement('span');
      n.className = 'badge badge-warn';
      n.textContent = note;
      row.append(n);
    }
    // Страна и ASN — по клику, а не автоматически: это внешний запрос.
    for (const t of lookups) {
      if (!t.types.some((ty) => ty === 'ipv4' || ty === 'ipv6')) continue;
      const a = document.createElement('a');
      a.className = 'chip';
      a.href = buildUrl(t, ip);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = t.name;
      row.append(a);
    }
    out.append(row);
  }

  const note = document.createElement('p');
  note.className = 'p-host-note';
  note.textContent = rec.isTRR
    ? 'Резолв выполнен браузером через DoH. Наружу ничего, кроме самого DNS-запроса, не ушло.'
    : 'Резолв выполнен браузером системным резолвером. Страна и ASN — по ссылкам выше, это уже внешний запрос.';
  out.append(note);
  btn.disabled = false;
}

$('#p-host-resolve').addEventListener('click', resolveHost);

/* «Не сканировать этот сайт».
 *
 * Список политики меняется только новой сборкой, а «не трогай вот эту
 * вики» нужно прямо сейчас. Локальный список ДОБАВЛЯЕТ запреты и живёт
 * в профиле; снять запрет политики отсюда нельзя.
 *
 * Добавление запрета — безопасная операция по определению: хуже
 * от лишнего запрета не станет никому, кроме самого аналитика,
 * а он же его и поставил. */
$('#p-host-deny').addEventListener('click', async () => {
  const host = $('#p-host-name').textContent.trim();
  if (!host) return;
  const r = await browser.runtime.sendMessage({ cmd: 'deny-add', host });
  const note = $('#p-deny-note');
  note.hidden = false;
  if (r && r.ok) {
    note.textContent = `«${host}» добавлен в локальный список: страницы этого сайта `
      + 'больше не разбираются. Список хранится только в этом браузере.';
  } else if (r && r.already) {
    note.textContent = `«${host}» и так не разбирается — запрет уже действует `
      + '(политика SOC или локальный список).';
  } else {
    note.textContent = 'не получилось добавить: ' + ((r && r.error) || 'неизвестная ошибка');
  }
  await refreshDenyState();
});

/* Состояние кнопки: если сайт уже запрещён, предлагать «не сканировать»
 * бессмысленно — надо показать, ЧЕМ он запрещён. Разница существенная:
 * локальный запрет аналитик снимет сам, запрет политики — нет. */
async function refreshDenyState() {
  const btn = $('#p-host-deny');
  const host = $('#p-host-name').textContent.trim().toLowerCase();
  if (!btn || !host) return;
  let lists;
  try { lists = await browser.runtime.sendMessage({ cmd: 'deny-list' }); } catch (_) { return; }
  if (!lists) return;
  const byPolicy = (lists.policy || []).find((p) => host.includes(String(p).toLowerCase()));
  const byLocal = (lists.local || []).find((p) => host.includes(String(p).toLowerCase()));
  if (byPolicy) {
    btn.disabled = true;
    btn.textContent = 'запрещён политикой';
    btn.title = `Разбор запрещён политикой SOC по шаблону «${byPolicy}». Снять нельзя.`;
  } else if (byLocal) {
    btn.disabled = false;
    btn.textContent = 'снять запрет';
    btn.title = `Локальный запрет по «${byLocal}». Поставлен вами, снимается тоже вами.`;
    btn.onclick = async () => {
      await browser.runtime.sendMessage({ cmd: 'deny-remove', host: byLocal });
      $('#p-deny-note').hidden = true;
      btn.onclick = null;
      await refreshDenyState();
    };
  } else {
    btn.disabled = false;
    btn.textContent = 'не сканировать';
    btn.title = 'Больше не разбирать страницы этого сайта. Список хранится только в этом браузере';
    btn.onclick = null;
  }
}

$('#p-tlp').addEventListener('change', (e) => { TLP = e.target.value; render(); });

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.cmd === 'iocs-scanned') refresh();
  if (msg?.cmd === 'notify') alert(msg.message);
});

// Синхронизируем режим данных и тему с главной вкладкой.
// Панель и новая вкладка не должны выглядеть по-разному — это одно рабочее место.
(async () => {
  const { ti_tlp_mode, ti_theme } = await browser.storage.local.get(['ti_tlp_mode', 'ti_theme']);
  let theme = ti_theme;
  try {
    const managed = await browser.storage.managed.get();
    if (managed?.theme) theme = managed.theme;
  } catch (_) { /* политика не задана */ }

  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');

  if (ti_tlp_mode) { TLP = ti_tlp_mode; $('#p-tlp').value = TLP; }
  refresh();
  showHost();
})();

// Хост меняется при переходе по ссылкам и при переключении вкладок —
// иначе панель показывала бы адрес страницы, которой уже нет на экране.
browser.tabs.onActivated.addListener(showHost);
browser.tabs.onUpdated.addListener((id, info) => { if (info.url) showHost(); });
