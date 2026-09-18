/*
 * compat.test.js — слой совместимости с Chrome.
 *
 * Проверяется не «переименование», а три свойства, каждое из которых
 * теряется одной строкой и ни одно не видно в интерфейсе:
 *   1. в Chrome появляется `browser`, в Firefox ничего не ломается;
 *   2. отсутствующие возможности НЕ подменяются заглушками;
 *   3. открытие боковой панели уходит в тот API, который есть.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, 'compat.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ок    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`); }
}

/** Поднять compat.js в среде, похожей на нужный браузер. */
function среда(глобалы) {
  const ctx = vm.createContext({ console, ...глобалы });
  ctx.globalThis = ctx;
  vm.runInContext(SRC, ctx, { filename: 'compat.js' });
  return ctx;
}

const ff = () => ({
  browser: {
    runtime: { getBrowserInfo: async () => ({ name: 'Firefox' }) },
    dns: { resolve: async () => ({ addresses: ['1.2.3.4'] }) },
    browserSettings: { overrideContentColorScheme: { set: async () => {} } },
    sidebarAction: { open: async () => 'sidebar' },
  },
});

const ch = (extra = {}) => ({
  chrome: {
    runtime: {},                       // getBrowserInfo в Chrome нет
    sidePanel: { open: async () => 'panel' },
    ...extra,
  },
});

console.log('\n=== compat.js ===\n');

/* --- 1. псевдоним --- */
{
  const c = среда(ch());
  check('в Chrome появляется browser', typeof c.browser !== 'undefined');
  check('browser — это сам chrome, а не копия', c.browser === c.chrome,
        'копия теряет this у части реализаций Chrome');
  check('Chrome опознан как Chrome', c.TICompat.chrome === true && c.TICompat.firefox === false);
}
{
  const f = среда(ff());
  const было = f.browser;
  check('в Firefox browser не подменяется', f.browser === было);
  check('Firefox опознан как Firefox', f.TICompat.firefox === true && f.TICompat.chrome === false,
        'опознание идёт по НАЛИЧИЮ API, а не по строке user agent');
}

/* --- 2. отсутствующее не подменяется --- */
{
  const c = среда(ch());
  check('в Chrome dns объявлен отсутствующим', c.TICompat.нет('dns') === true);
  check('ЗАГЛУШКИ ВМЕСТО dns НЕТ', typeof c.browser.dns === 'undefined',
        'заглушка, молча возвращающая пустоту, — способ соврать аналитику');
  check('в Chrome нет настройки схемы содержимого', c.TICompat.нет('contentColorScheme') === true);
  check('в Chrome нет sidebarAction', c.TICompat.нет('sidebar') === true);

  const f = среда(ff());
  check('в Firefox dns на месте', f.TICompat.есть('dns') === true);
  check('в Firefox sidebarAction на месте', f.TICompat.есть('sidebar') === true);
  check('в Firefox sidePanel отсутствует', f.TICompat.нет('sidePanel') === true);
}

/* --- 3. открытие боковой панели --- */
(async () => {
  {
    const f = среда(ff());
    check('в Firefox панель открывается через sidebarAction',
          (await f.TICompat.открытьПанель(7)) === 'sidebar');
  }
  {
    let принято = null;
    const c = среда(ch());
    c.chrome.sidePanel.open = async (arg) => { принято = arg; return 'panel'; };
    check('в Chrome панель открывается через sidePanel',
          (await c.TICompat.открытьПанель(7)) === 'panel');
    check('ID ВКЛАДКИ ПЕРЕДАН', принято && принято.tabId === 7,
          'sidePanel.open без tabId или windowId не открывает ничего');
  }
  {
    /* Ни того, ни другого: обещание обязано отклониться, а не «сделать
     * вид». Молчаливый успех здесь означал бы, что аналитик нажал
     * и ничего не произошло, а расширение считает, что всё хорошо. */
    const n = среда({ chrome: { runtime: {} } });
    let отклонено = false;
    await n.TICompat.открытьПанель(1).catch(() => { отклонено = true; });
    check('БЕЗ ОБОИХ API ВЫЗОВ ОТКЛОНЯЕТСЯ', отклонено);
  }

  /* --- 4. возможности перечислимы --- */
  {
    const c = среда(ch());
    const в = c.TICompat.возможности();
    check('список возможностей отдаётся копией', (v => { v.dns = true; return c.TICompat.нет('dns'); })(в) === true);
    check('в списке названы все четыре возможности',
          ['dns', 'contentColorScheme', 'sidebar', 'sidePanel'].every((k) => k in в),
          Object.keys(в).join(', '));
  }

  console.log(`\n  Пройдено: ${pass}   Провалено: ${fail}\n`);
  process.exit(fail ? 1 : 0);
})();
