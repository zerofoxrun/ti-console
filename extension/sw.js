/* =============================================================================
 * sw.js — точка входа фона В CHROME
 * =============================================================================
 *
 * Firefox в MV3 использует event page и ключ `background.scripts`, Chrome —
 * service worker и ключ `background.service_worker`, причём `scripts`
 * игнорируется с Chrome 121
 * (https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background).
 *
 * Объявить в одном манифесте оба ключа МОЖНО, и MDN прямо это советует,
 * но у нас `strict_min_version: 115`, а до Firefox 121 присутствие
 * `service_worker` ломало загрузку фоновой страницы
 * (https://bugzil.la/1860304). Поэтому манифест под Chrome собирается
 * отдельно (tools_build_ext.py --chrome), и точка входа тоже отдельная.
 *
 * Файл намеренно состоит из одной строки: вся логика остаётся в
 * background.js, общем для обоих браузеров. Порядок подключения тот же,
 * что в `background.scripts` манифеста Firefox, и это проверяется в CI —
 * разойтись они не должны.
 * ========================================================================== */

importScripts('lib/compat.js', 'lib/ioc.js', 'background.js');
