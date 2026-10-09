/* То же для Worker: обмен сообщениями внутри pdf.js построен на
 * Promise.withResolvers, поэтому полифил нужен по обе стороны.
 * Этот файл и указывается как workerSrc. */
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new this((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}
import './pdf.worker.min.mjs';
