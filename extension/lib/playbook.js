/* =============================================================================
 * playbook.js — планирование последовательности проверок
 * =============================================================================
 *
 * ЧТО ТАКОЕ ПЛЕЙБУК
 * -----------------
 * Именованная последовательность проверок под тип задачи: «домен
 * из фишинга» — это каждый раз crt.sh, whois, urlscan, VT, архивы,
 * в одном и том же порядке.
 *
 * Смысл не в экономии кликов. L1, держащий последовательность в голове,
 * на третьем пункте отвлекается — и пропуск НЕ ВИДЕН В ОТЧЁТЕ: отчёт
 * выглядит одинаково независимо от того, проверили crt.sh или нет.
 * Плейбук делает порядок проверок одинаковым у всех и воспроизводимым.
 *
 * ПОЧЕМУ ПЛАНИРОВАНИЕ ВЫНЕСЕНО СЮДА, А НЕ ЖИВЁТ В ИНТЕРФЕЙСЕ
 * ----------------------------------------------------------
 * Здесь решается, какие шаги выполнятся, а какие будут отброшены,
 * — в том числе отброшены TLP-гейтом. Ошибка в этом месте означает
 * отправку клиентского индикатора в публичный сервис, то есть ровно
 * то, ради предотвращения чего весь гейт и существует.
 * Такая логика обязана быть чистой функцией и покрытой тестами,
 * а не веткой внутри обработчика клика.
 *
 * ЧЕГО ПЛЕЙБУК НЕ ДЕЛАЕТ
 * ----------------------
 * Он не принимает решений и не ставит вердиктов. Он открывает вкладки
 * в заданном порядке. Вердикт ставит аналитик — иначе это был бы
 * автоматический сканер, а к нему другие требования и другая цена
 * ошибки.
 * ========================================================================== */

'use strict';

/** Причины, по которым шаг не выполняется. Строки идут в интерфейс как есть. */
const PB_SKIP = {
  MISSING: T('инструмента нет в реестре'),
  TYPE: T('не работает с этим типом'),
  TLP: T('скрыт режимом данных'),
  OWN: T('свой или клиентский адрес'),
};

/**
 * Разложить плейбук на выполнимые шаги и отброшенные, с причиной.
 *
 * @param {object} pb       запись плейбука из реестра
 * @param {Array}  tools    registry.tools
 * @param {string} type     тип индикатора (ipv4, domain, sha256…)
 * @param {string} tlp      'public' | 'client'
 * @param {boolean} свой    значение принадлежит своему/клиентскому диапазону
 *
 * ВТОРОЙ ГЕЙТ, РЯДОМ С TLP. Плейбук — единственное место, где одно
 * нажатие открывает десяток вкладок, и подтверждать каждую нечем:
 * вопрос «открыть 9 вкладок?» человек читает как «да». Поэтому
 * публичные шаги по своему адресу отбрасываются так же, как
 * отбрасываются шаги в клиентском режиме, — и называются в отчёте
 * о выполнении.
 */
function planPlaybook(pb, tools, type, tlp, свой = false) {
  const byId = new Map(tools.map((t) => [t.id, t]));
  const steps = [];
  const skipped = [];
  for (const id of pb.steps) {
    const tool = byId.get(id);
    if (!tool) { skipped.push({ id, why: PB_SKIP.MISSING }); continue; }
    if (!tool.types.includes(type)) { skipped.push({ id, why: PB_SKIP.TYPE }); continue; }
    /* TLP-гейт действует и здесь, и это главная строчка файла.
     * Без неё достаточно было бы завести плейбук, чтобы отправить
     * клиентский индикатор в публичный сервис в обход фильтра. */
    if (tlp === 'client' && tool.exposure === 'public') {
      skipped.push({ id, why: PB_SKIP.TLP });
      continue;
    }
    if (свой && tool.exposure === 'public') {
      skipped.push({ id, why: PB_SKIP.OWN });
      continue;
    }
    steps.push(tool);
  }
  return { steps, skipped };
}

/** Плейбуки, применимые хотя бы к одному из типов. */
function playbooksFor(playbooks, types) {
  const set = types instanceof Set ? types : new Set(types);
  return (playbooks || []).filter((p) => p.types.some((t) => set.has(t)));
}

/**
 * Проверка целостности плейбуков реестра.
 * Возвращает список проблем; пустой список — всё в порядке.
 *
 * Вызывается из CI. Шаг, ссылающийся на несуществующий инструмент,
 * молча выпадает при выполнении — то есть проверка, которую аналитик
 * считает сделанной, не делается, и в отчёте это никак не отражается.
 */
function validatePlaybooks(registry) {
  const problems = [];
  const byId = new Map((registry.tools || []).map((t) => [t.id, t]));
  const seen = new Set();
  for (const pb of registry.playbooks || []) {
    if (seen.has(pb.id)) problems.push(T`дубликат id плейбука: ${pb.id}`);
    seen.add(pb.id);
    if (!pb.name || !Array.isArray(pb.types) || !pb.types.length) {
      problems.push(T`${pb.id}: нет имени или типов`);
    }
    if (!Array.isArray(pb.steps) || !pb.steps.length) {
      problems.push(T`${pb.id}: нет шагов`);
      continue;
    }
    if (new Set(pb.steps).size !== pb.steps.length) {
      problems.push(T`${pb.id}: один и тот же инструмент встречается дважды`);
    }
    for (const id of pb.steps) {
      const tool = byId.get(id);
      if (!tool) { problems.push(T`${pb.id}: нет инструмента ${id}`); continue; }
      // Шаг, не подходящий ни под один тип плейбука, не выполнится никогда.
      if (!tool.types.some((t) => pb.types.includes(t))) {
        problems.push(T`${pb.id}: шаг ${id} не работает ни с одним из типов `
                    + T`${pb.types.join(', ')} (у него ${tool.types.join(', ')})`);
      }
    }
    /* Плейбук, целиком состоящий из публичных сервисов, в режиме
     * клиентских данных пуст. Это не ошибка — так и должно быть, —
     * но это надо знать при составлении, а не обнаруживать в работе. */
    const survives = pb.steps.filter((id) => byId.get(id) && byId.get(id).exposure !== 'public');
    if (!survives.length) {
      problems.push(T`ПРЕДУПРЕЖДЕНИЕ ${pb.id}: в режиме клиентских данных `
                  + T('не останется ни одного шага'));
    }
  }
  return problems;
}

const PLAYBOOK_API = { planPlaybook, playbooksFor, validatePlaybooks, PB_SKIP };
if (typeof module !== 'undefined' && module.exports) module.exports = PLAYBOOK_API;
if (typeof globalThis !== 'undefined') globalThis.TIPlaybook = PLAYBOOK_API;
