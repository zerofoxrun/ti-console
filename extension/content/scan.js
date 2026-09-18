/* =============================================================================
 * content/scan.js — парсер страницы на индикаторы компрометации
 * =============================================================================
 *
 * Внедряется по требованию через scripting.executeScript вместе с lib/ioc.js.
 * Постоянного content-script на всех страницах нет — см. комментарий
 * о разрешениях в manifest.json.
 *
 * ЧТО ДЕЛАЕТ
 *   1. Собирает видимый текст страницы (без script/style/noscript и скрытых
 *      узлов) + значения атрибутов href/src/data-* — индикаторы часто лежат
 *      именно в ссылках, а не в тексте.
 *   2. Прогоняет через IOC.extractIocs — тот же код, что и в умном поиске,
 *      поэтому результат на одном и том же содержимом совпадает.
 *   3. Подсвечивает найденное прямо на странице (не ломая DOM-структуру:
 *      правится только текстовый узел, оборачивается в <mark>).
 *   4. Отдаёт результат в background.
 *
 * ОГРАНИЧЕНИЯ (проверяемые)
 *   - Содержимое внутри closed shadow DOM недоступно — принципиально.
 *   - Внутри <iframe> с другого origin — недоступно без all_frames и
 *     соответствующих разрешений; в PoC не запрашивается.
 *   - PDF, открытый во встроенном pdf.js, — отдельный случай: текстовый слой
 *     рендерится постранично и по мере прокрутки, разбор увидит только
 *     отрисованные страницы. Для PDF корректный путь — выгрузить файл
 *     и разобрать через «Разбор IOC».
 * ========================================================================== */

(() => {
  'use strict';

  // Повторная инъекция в ту же вкладку не должна дублировать подсветку.
  if (window.__tiConsoleScanned) {
    window.__tiConsoleClearHighlights?.();
  }
  window.__tiConsoleScanned = true;

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS']);

  /* ------------------------------------------------ сбор текста страницы */
  function collectText() {
    const parts = [];

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        // Скрытые узлы пропускаем: это чаще всего мусор из шаблонов.
        const cs = getComputedStyle(p);
        if (cs.display === 'none' || cs.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) parts.push(n.nodeValue);

    // Атрибуты: ссылки и источники несут индикаторы чаще, чем видимый текст.
    for (const el of document.querySelectorAll('[href], [src], [data-url], [action]')) {
      for (const attr of ['href', 'src', 'data-url', 'action']) {
        const v = el.getAttribute?.(attr);
        if (v && !v.startsWith('javascript:')) parts.push(v);
      }
    }

    return parts.join('\n');
  }

  /* ---------------------------------------------------------- подсветка */
  const HL_CLASS = 'ti-console-hl';

  function injectStyle() {
    if (document.getElementById('ti-console-style')) return;
    const s = document.createElement('style');
    s.id = 'ti-console-style';
    s.textContent = `
      .${HL_CLASS}{background:#ffd54a3d;outline:1px solid #f59e0b;border-radius:2px;
        padding:0 1px;cursor:help;color:inherit}
      .${HL_CLASS}[data-ti-type="ipv4"],.${HL_CLASS}[data-ti-type="ipv6"]{outline-color:#3b82f6;background:#3b82f61f}
      .${HL_CLASS}[data-ti-type="domain"],.${HL_CLASS}[data-ti-type="url"]{outline-color:#22c55e;background:#22c55e1f}
      .${HL_CLASS}[data-ti-type="md5"],.${HL_CLASS}[data-ti-type="sha1"],
      .${HL_CLASS}[data-ti-type="sha256"]{outline-color:#a78bfa;background:#a78bfa1f}
      .${HL_CLASS}[data-ti-type="cve"]{outline-color:#ef4444;background:#ef44441f}
    `;
    document.head.append(s);
  }

  function highlight(values) {
    injectStyle();
    // Сопоставление по одному проходу: собираем одну общую регулярку
    // из экранированных значений — иначе N проходов по DOM на N индикаторов.
    if (!values.size) return 0;
    const escaped = Array.from(values.keys())
      .sort((a, b) => b.length - a.length)          // длинные первыми: sha256 до md5
      .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(${escaped.join('|')})`, 'gi');

    let count = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || SKIP_TAGS.has(p.tagName) || p.classList.contains(HL_CLASS)) {
          return NodeFilter.FILTER_REJECT;
        }
        return re.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    const targets = [];
    let n;
    while ((n = walker.nextNode())) targets.push(n);

    for (const node of targets) {
      const frag = document.createDocumentFragment();
      let last = 0;
      const text = node.nodeValue;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) frag.append(text.slice(last, m.index));
        const mark = document.createElement('mark');
        mark.className = HL_CLASS;
        mark.dataset.tiType = values.get(m[0].toLowerCase()) || '';
        mark.title = `IOC: ${mark.dataset.tiType}`;
        mark.textContent = m[0];
        frag.append(mark);
        last = m.index + m[0].length;
        count++;
      }
      if (last < text.length) frag.append(text.slice(last));
      node.parentNode.replaceChild(frag, node);
    }
    return count;
  }

  window.__tiConsoleClearHighlights = () => {
    for (const m of document.querySelectorAll('.' + HL_CLASS)) {
      m.replaceWith(document.createTextNode(m.textContent));
    }
    document.body.normalize();
  };

  /* -------------------------------------------------------------- запуск */
  const text = collectText();
  const iocs = IOC.extractIocs(text, { withContext: true, contextChars: 80 });

  // Индикаторы, «не маршрутизируемые» наружу (127.0.0.1, 10.х), из подсветки
  // исключаем — на технических страницах их сотни и они забивают выдачу.
  const highlightable = new Map();
  for (const i of iocs) {
    if (i.flags?.some((f) => f.startsWith('non-routable'))) continue;
    if (i.type === 'attack' || i.type === 'asn') continue;
    highlightable.set(i.value.toLowerCase(), i.type);
  }
  const marked = highlight(highlightable);

  browser.runtime.sendMessage({
    cmd: 'page-iocs',
    iocs,
    marked,
    pageUrl: location.href,
    pageTitle: document.title,
  });
})();
