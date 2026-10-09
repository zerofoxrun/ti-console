/* =============================================================================
 * content/card.js — карточка индикатора прямо на странице
 * =============================================================================
 *
 * Внедряется ВМЕСТЕ с content/scan.js по требованию аналитика и живёт
 * ровно до снятия подсветки. Постоянного content-script у расширения нет.
 *
 * ЗАЧЕМ. Раньше разбор страницы уводил в консоль: аналитик читает отчёт
 * вендора, нажимает разбор, подсветка появляется — и дальше надо идти
 * в другую вкладку, искать там нужное значение и оттуда открывать
 * сервис. Карточка отвечает на вопрос «что известно про ЭТО значение»
 * там, где значение и находится.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ
 *
 *   - Списка сервисов. Его считает фон общим модулем lib/pivot.js —
 *     тем же, что и консоль. Две копии гейта разошлись бы молча,
 *     и карточка на чужой странице открыла бы то, что консоль
 *     закрывает: адрес заказчика в публичном сервисе.
 *   - Сети. Карточка не делает ни одного запроса. Открытие сервиса —
 *     это вкладка, которую по нажатию человека открывает фон.
 *   - Наблюдателя за DOM. Ничего не перерисовывается само: карточка
 *     появляется по клику и исчезает по Esc, клику мимо или снятию
 *     подсветки.
 *
 * СТИЛИ В ТЕНЕВОМ КОРНЕ. Карточка живёт в shadow root: страница
 * не может её оформить, а её оформление не протекает на страницу.
 * Подсветка (scan.js) остаётся обычными <mark> — она обязана
 * наследовать шрифт текста, в котором стоит.
 * ========================================================================== */
(() => {
  'use strict';

  /* Карточка на странице живёт в content-script: движок локализации
     и словарь внедряются вместе с ней (список files в background.js).
     Разметку обходить не нужно — карточка целиком строится кодом,
     поэтому dom:false. Инициализация асинхронная, но карточка
     появляется только по клику, то есть заведомо позже. */
  if (typeof TII18n !== 'undefined') TII18n.инициализация({ dom: false });

  const ХОСТ_ID = 'ti-console-card-host';
  const HL_CLASS = 'ti-console-hl';

  /* Повторная инъекция не должна давать вторую карточку и второй
   * слушатель: scan.js вызывается повторно при каждом разборе. */
  if (window.__tiConsoleCard) {
    window.__tiConsoleCard.снять();
  }

  let хост = null;
  let корень = null;
  let текущий = null;          // элемент <mark>, у которого открыта карточка

  function создатьХост() {
    if (хост && document.body.contains(хост)) return;
    хост = document.createElement('div');
    хост.id = ХОСТ_ID;
    /* Позиционирование на самом хосте, а не внутри тени: иначе
     * страница со своим position/transform на body уводила бы
     * карточку в сторону. */
    хост.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;'
      + 'margin:0;padding:0;border:0;z-index:2147483646;';
    корень = хост.attachShadow({ mode: 'open' });
    корень.innerHTML = T`
      <style>
        :host { all: initial; }
        .кк {
          position: absolute; min-width: 260px; max-width: 360px;
          font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          color: #e6edf3; background: #11161d;
          border: 1px solid #3a4553; border-radius: 8px;
          box-shadow: 0 10px 30px rgba(0,0,0,.45);
          padding: 10px 12px; box-sizing: border-box;
        }
        .знач { font: 600 13px ui-monospace, SFMono-Regular, Menlo, monospace;
                word-break: break-all; margin: 0 0 2px; }
        .тип { color: #9aa7b8; font-size: 11.5px; margin: 0 0 8px; }
        .свой { color: #f0b429; font-size: 11.5px; margin: 0 0 8px; }
        .ряд { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
        button { font: 12px inherit; color: #e6edf3; background: #1b2430;
                 border: 1px solid #3a4553; border-radius: 5px;
                 padding: 4px 8px; cursor: pointer; }
        button:hover { border-color: #5a6675; }
        button.гл { background: #1f6feb; border-color: #1f6feb; color: #fff; }
        .серв { display: flex; flex-direction: column; gap: 3px; max-height: 190px;
                overflow: auto; }
        .серв a { color: #79c0ff; text-decoration: none; font-size: 12.5px;
                  padding: 2px 0; }
        .серв a:hover { text-decoration: underline; }
        .платно { color: #f0b429; font-size: 10.5px; margin-left: 4px; }
        .закрыто { color: #9aa7b8; font-size: 11px; margin: 8px 0 0;
                   border-top: 1px solid #3a4553; padding-top: 6px; }
        .закрыть { position: absolute; top: 6px; right: 8px; border: 0;
                   background: none; color: #9aa7b8; font-size: 15px; padding: 0 4px; }
        .пусто { color: #9aa7b8; font-size: 12px; }
      </style>
      <div class="кк" role="dialog" aria-label="Индикатор"></div>`;
    document.body.append(хост);
  }

  function закрыть() {
    if (корень) корень.querySelector('.кк').style.display = 'none';
    текущий = null;
  }

  function снять() {
    закрыть();
    if (хост && хост.parentNode) хост.remove();
    хост = null; корень = null;
    document.removeEventListener('keydown', поКлавише, true);
    document.removeEventListener('click', поКлику, true);
  }

  function поКлавише(e) {
    if (e.key === 'Escape' && текущий) { e.stopPropagation(); закрыть(); }
  }

  function поКлику(e) {
    const метка = e.target && e.target.closest && e.target.closest('mark.' + HL_CLASS);
    if (метка) {
      /* Подсвеченное значение часто стоит внутри ссылки. Клик по нему
       * должен показывать карточку, а НЕ уводить на чужой сайт: уход
       * по ссылке из отчёта об атаке — это переход на инфраструктуру
       * атакующего, случайно и без решения человека. */
      e.preventDefault();
      e.stopPropagation();
      открыть(метка);
      return;
    }
    if (текущий && хост && !e.composedPath().includes(хост)) закрыть();
  }

  function поставить(рядомС) {
    const к = корень.querySelector('.кк');
    к.style.display = 'block';
    const r = рядомС.getBoundingClientRect();
    const ш = к.offsetWidth || 320;
    const в = к.offsetHeight || 160;
    let x = window.scrollX + r.left;
    let y = window.scrollY + r.bottom + 6;
    /* Не вылезать за окно: карточка у значения в правом столбце иначе
     * наполовину за экраном, и «ничего не открылось» — то же, что
     * сломано. */
    x = Math.max(window.scrollX + 4,
                 Math.min(x, window.scrollX + document.documentElement.clientWidth - ш - 4));
    if (r.bottom + в + 10 > window.innerHeight && r.top > в + 10) {
      y = window.scrollY + r.top - в - 6;
    }
    к.style.left = `${Math.round(x)}px`;
    к.style.top = `${Math.round(y)}px`;
  }

  function кнопка(текст, класс, действие) {
    const b = document.createElement('button');
    b.textContent = текст;
    if (класс) b.className = класс;
    b.addEventListener('click', действие);
    return b;
  }

  async function открыть(метка) {
    создатьХост();
    текущий = метка;
    /* Значение берём ОТРЕФАНЖЕННОЕ (его положил scan.js), а не то,
     * как оно написано на странице: `hxxps://x[.]com` в сервис
     * отправлять нельзя, да и в кейс он должен попасть в общей форме. */
    const значение = метка.dataset.tiValue || метка.textContent || '';
    const тип = метка.dataset.tiType || '';
    const к = корень.querySelector('.кк');
    к.textContent = '';
    к.append(Object.assign(document.createElement('p'),
                           { className: 'знач', textContent: значение }));
    к.append(Object.assign(document.createElement('p'),
                           { className: 'тип', textContent: T('читаю…') }));
    поставить(метка);

    let ответ = null;
    try {
      ответ = await browser.runtime.sendMessage({ cmd: 'pivot', значение, тип });
    } catch (e) {
      ответ = { ошибка: String((e && e.message) || e) };
    }
    if (текущий !== метка) return;            // успели закрыть или кликнуть другое
    нарисовать(к, значение, тип, ответ || {});
    поставить(метка);
  }

  function нарисовать(к, значение, тип, д) {
    к.textContent = '';
    к.append(кнопка('×', T('закрыть'), закрыть));

    к.append(Object.assign(document.createElement('p'),
                           { className: 'знач', textContent: значение }));
    к.append(Object.assign(document.createElement('p'), {
      className: 'тип',
      textContent: [д.метка || тип, д.вердикт ? T('вердикт: ') + д.вердикт : '',
                    д.вКейсе ? T('уже в кейсе') : ''].filter(Boolean).join(' · '),
    }));
    if (д.свой) {
      к.append(Object.assign(document.createElement('p'),
                             { className: 'свой', textContent: T('наш или клиентский: ') + д.свой }));
    }
    if (д.ошибка) {
      к.append(Object.assign(document.createElement('p'),
                             { className: 'пусто', textContent: T('Не отвечает фон: ') + д.ошибка }));
      return;
    }

    const ряд = document.createElement('div');
    ряд.className = 'ряд';
    ряд.append(кнопка(T('В кейс'), 'гл', async () => {
      const r = await browser.runtime.sendMessage({ cmd: 'pivot-to-case', значение, тип })
        .catch((e) => ({ ok: false, error: String(e && e.message) }));
      сказать(к, r && r.ok
        ? (r.added ? T('добавлено в кейс') : T('уже было в кейсе'))
        : T('не добавилось: ') + ((r && r.error) || T('неизвестно')));
    }));
    ряд.append(кнопка(T('Копировать дефангом'), '', () => {
      копировать(д.дефанг || значение).then((ok) =>
        сказать(к, ok ? T('скопировано дефангом') : T('буфер недоступен')));
    }));
    ряд.append(кнопка(T('Как есть'), '', () => {
      копировать(значение).then((ok) => сказать(к, ok ? T('скопировано') : T('буфер недоступен')));
    }));
    ряд.append(кнопка(T('В консоли'), '', () => {
      browser.runtime.sendMessage({ cmd: 'pivot-console', значение }).catch(() => {});
    }));
    к.append(ряд);

    const серв = document.createElement('div');
    серв.className = 'серв';
    for (const и of д.инструменты || []) {
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = и.имя;
      if (и.платно) {
        a.append(Object.assign(document.createElement('span'),
                               { className: T('платно'), textContent: T('платно') }));
      }
      a.addEventListener('click', (e) => {
        e.preventDefault();
        /* Вкладку открывает фон: content-script не должен открывать
         * окна сам — часть страниц это блокирует, и тогда «сервис
         * не открылся» выглядит как поломка расширения. */
        browser.runtime.sendMessage({ cmd: 'pivot-open', url: и.url }).catch(() => {});
      });
      серв.append(a);
    }
    if (!(д.инструменты || []).length) {
      серв.append(Object.assign(document.createElement('p'), {
        className: 'пусто',
        textContent: д.всего ? T('Все сервисы этого типа закрыты — см. ниже.')
                             : T('Для этого типа сервисов в реестре нет.'),
      }));
    }
    к.append(серв);

    /* Закрытое НАЗЫВАЕТСЯ. Короткий список без объяснения читается как
     * «сервисов нет», и аналитик идёт искать их в браузере — мимо
     * реестра и мимо гейта. */
    if (д.закрытоСтрокой) {
      к.append(Object.assign(document.createElement('p'),
                             { className: 'закрыто', textContent: T('Закрыто: ') + д.закрытоСтрокой }));
    }
  }

  function сказать(к, текст) {
    let п = к.querySelector('.сказ');
    if (!п) {
      п = document.createElement('p');
      п.className = T('закрыто сказ');
      к.append(п);
    }
    п.textContent = текст;
  }

  async function копировать(текст) {
    try {
      await navigator.clipboard.writeText(текст);
      return true;
    } catch (_) {
      /* Буфер на чужой странице доступен не всегда (разрешение, фокус,
       * http). Молчать нельзя: человек решит, что скопировалось. */
      return false;
    }
  }

  document.addEventListener('keydown', поКлавише, true);
  document.addEventListener('click', поКлику, true);

  window.__tiConsoleCard = { снять, закрыть };

  /* Снятие подсветки обязано убирать и карточку: иначе она останется
   * висеть у значения, которое больше не подсвечено. */
  const прежнее = window.__tiConsoleClearHighlights;
  if (typeof прежнее === 'function') {
    window.__tiConsoleClearHighlights = () => { снять(); прежнее(); };
  }
})();
