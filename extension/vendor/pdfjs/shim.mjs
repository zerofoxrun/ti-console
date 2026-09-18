/* Подключение pdf.js со страницы расширения.
 *
 * Единственное назначение файла — добавить Promise.withResolvers до того,
 * как pdf.js его вызовет. Метод появился в Firefox 121, а расширение
 * объявляет strict_min_version 115.0; без этого pdf.js падает с TypeError
 * на первой же операции, а снаружи это выглядит как «PDF не разбирается»
 * без всякого объяснения.
 *
 * Реализация — дословно по спецификации (TC39 promise-with-resolvers):
 * вернуть промис и его resolve/reject.
 */
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new this((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}
export * from './pdf.min.mjs';
