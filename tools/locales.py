#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NOTE FOR ADD-ON REVIEWERS (English summary; the rest is in Russian).

extension/locales/en.js is GENERATED, not hand-written: this script
builds it. Keys are the Russian source strings, extracted from the
extension sources; translations come from tools/i18n/ru-en.json.

    python3 tools/locales.py --проверить   # report only, writes nothing
    python3 tools/locales.py               # rebuild extension/locales/en.js

Running it on an unchanged tree reproduces the shipped file byte for
byte. A string with no translation is reported, never silently dropped:
a missing key degrades to readable Russian rather than to an empty UI.

----------------------------------------------------------------------

Сборка словаря локализации из мастер-файла переводов.

ЗАЧЕМ ОТДЕЛЬНЫЙ ИНСТРУМЕНТ
-------------------------
Ключ словаря — сама русская строка из кода или разметки. Значит, стоит
кому-то поправить подпись в исходнике, как её перевод отваливается:
ключ больше не совпадает, строка молча остаётся русской. Никакого
исключения при этом не происходит, и заметить это можно только глазами
на английском интерфейсе — то есть практически никогда.

Поэтому словарь не правится руками, а СОБИРАЕТСЯ: ключи берутся
из исходников, переводы — из мастер-файла tools/i18n/ru-en.json.
Строка, которой нет в мастере, попадает в отчёт как непереведённая.

ВТОРОЙ ПОВОД — МАГАЗИННАЯ СБОРКА. Она переписывает часть текстов:
убирает упоминания сервера, бэкенда и арендованного хоста. После
такой правки половина ключей в пакете другая, а старые значения
словаря тянули бы в магазин ровно те слова, ради удаления которых
правка и делалась. Поэтому сборщик вызывает этот модуль ещё раз,
уже для своего дерева файлов.

Запуск для рабочего дерева:
    python3 tools/locales.py              # пересобрать extension/locales/en.js
    python3 tools/locales.py --проверить  # ничего не писать, только отчёт
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

# В публичном дереве скрипт лежит в tools/, поэтому корень — на уровень выше.
КОРЕНЬ = pathlib.Path(__file__).resolve().parent.parent
МАСТЕР = КОРЕНЬ / "tools" / "i18n" / "ru-en.json"
ЦЕЛЬ = КОРЕНЬ / "extension" / "locales" / "en.js"

JS_ФАЙЛЫ = ["newtab/newtab.js", "panel/panel.js", "popup/popup.js",
            "content/card.js", "background.js",
            # Каталог функций и подписи состояний лисы — тоже интерфейс:
            # названия пресетов и всплывающие подсказки видно на экране.
            "lib/settings.js", "newtab/fox.js",
            # Модули, которые сами строят текст для экрана: подписи
            # хронологии, матрицы, черновиков правил, разбора писем
            # и HAR, локальных признаков, схемы кейса.
            "lib/casegraph.js", "lib/cases.js", "lib/compat.js",
            "lib/eml.js", "lib/fetchpage.js", "lib/filekind.js",
            "lib/har.js", "lib/localfacts.js", "lib/matrix.js",
            "lib/matrixpng.js", "lib/navlayer.js", "lib/noise.js",
            "lib/ownranges.js", "lib/packs.js", "lib/pdftext.js",
            "lib/pivot.js", "lib/playbook.js", "lib/query.js",
            "lib/rules.js", "lib/textools.js", "lib/timeline.js",
            "lib/triage.js", "lib/analyze.js", "lib/attack.js",
            "lib/capture.js",
            # Напоминание о невыгруженном кейсе — тоже текст на экране.
            # Файл, забытый в этом списке, не ломается и не падает:
            # его строки просто остаются русскими в английском
            # интерфейсе, и заметить это может только человек,
            # который туда посмотрел.
            "lib/unsaved.js",
            # Свои наборы проверок: тексты проверки состава видны
            # в редакторе наборов на вкладке настроек.
            "lib/myplaybooks.js"]
HTML_ФАЙЛЫ =["newtab/newtab.html", "panel/panel.html", "popup/popup.html"]
КИР = re.compile(r"[А-Яа-яЁё]")
АТРИБУТЫ = re.compile(r'(?:title|placeholder|aria-label)="([^"]+)"')


def литералы(текст: str):
    """Строковые литералы вне комментариев: (начало, конец, вид, значение).

    Собственный проход по символам, а не регулярное выражение: нужно
    отличать строку от комментария и правильно находить конец шаблона
    с вложенными `${ ... { } ... }`.
    """
    i, n = 0, len(текст)
    вых = []
    while i < n:
        c = текст[i]
        if c == "/" and i + 1 < n and текст[i + 1] == "/":
            j = текст.find("\n", i)
            i = n if j < 0 else j + 1
            continue
        if c == "/" and i + 1 < n and текст[i + 1] == "*":
            j = текст.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in "'\"":
            j = i + 1
            while j < n:
                if текст[j] == "\\":
                    j += 2
                    continue
                if текст[j] == c or текст[j] == "\n":
                    break
                j += 1
            if j < n and текст[j] == c:
                вых.append((i, j + 1, c, текст[i + 1:j]))
                i = j + 1
                continue
            i += 1
            continue
        if c == "`":
            j, глубина = i + 1, 0
            while j < n:
                if текст[j] == "\\":
                    j += 2
                    continue
                if текст[j] == "$" and j + 1 < n and текст[j + 1] == "{":
                    глубина += 1
                    j += 2
                    continue
                if глубина and текст[j] == "{":
                    глубина += 1
                    j += 1
                    continue
                if глубина and текст[j] == "}":
                    глубина -= 1
                    j += 1
                    continue
                if текст[j] == "`" and not глубина:
                    break
                j += 1
            if j < n and текст[j] == "`":
                вых.append((i, j + 1, "`", текст[i + 1:j]))
                i = j + 1
                continue
            i += 1
            continue
        i += 1
    return вых


ЭКРАНЫ = {"\\n": "\n", "\\t": "\t", "\\r": "\r", "\\\\": "\\",
           "\\'": "'", '\\"': '"', "\\`": "`", "\\$": "$"}


def развернуть(s: str) -> str:
    """Раскрывает escape-последовательности, как это делает движок JS.

    В исходнике строка записана как '…не применилось,\\n', а в память
    попадает перевод строки. Если оставить в ключе два символа «\\» и «n»,
    он никогда не совпадёт с тем, что придёт в T(), — подпись молча
    останется русской. Ровно так терялась подсказка о версии.
    """
    вых, i, n = [], 0, len(s)
    while i < n:
        if s[i] == "\\" and i + 1 < n:
            пара = s[i:i + 2]
            вых.append(ЭКРАНЫ.get(пара, пара))
            i += 2
            continue
        вых.append(s[i])
        i += 1
    return "".join(вых)


def канон(знач: str) -> str:
    """`${...}` -> `{0}`, `{1}`, … — так же, как это делает i18n.js.

    Вложенные фигурные скобки считаются: в `(x || {}).имя` наивное
    регулярное выражение обрывает подстановку на первой же `}`,
    и ключ расходится с тем, что соберёт браузер из strings.raw.
    """
    вых, i, n, счёт = [], 0, len(знач), 0
    while i < n:
        if знач[i] == "$" and i + 1 < n and знач[i + 1] == "{":
            глубина, j = 1, i + 2
            while j < n and глубина:
                if знач[j] == "{":
                    глубина += 1
                elif знач[j] == "}":
                    глубина -= 1
                j += 1
            вых.append("{%d}" % счёт)
            счёт += 1
            i = j
            continue
        вых.append(знач[i])
        i += 1
    return "".join(вых)


СУЩНОСТИ = {"&nbsp;": "\u00a0", "&amp;": "&", "&lt;": "<", "&gt;": ">",
             "&quot;": '"', "&#39;": "'", "&mdash;": "\u2014", "&nbsp": "\u00a0"}


def пробелы(с: str) -> str:
    """Нормализация ключа текстового узла — копия ключТекста() из i18n.js.

    HTML-сущности раскодируются: в DOM `&nbsp;` — это символ U+00A0,
    а `\s` в JavaScript его схлопывает в обычный пробел. Если оставить
    сущность в ключе, он разойдётся с тем, что увидит браузер, и подпись
    молча останется русской. Так терялась плашка о хранении кейса.
    """
    for сущ, зам in СУЩНОСТИ.items():
        с = с.replace(сущ, зам)
    return re.sub(r"\s+", " ", с).strip()


def ключи_js(текст: str) -> list[str]:
    вых = []
    for нач, _кон, вид, знач in литералы(текст):
        перед = текст[max(0, нач - 2):нач]
        if вид == "`":
            if перед.endswith("T"):
                вых.append(развернуть(канон(знач)))
        elif перед.endswith("T("):
            вых.append(развернуть(знач))
    return [к for к in вых if КИР.search(к)]


def ключи_html(текст: str) -> list[str]:
    текст = re.sub(r"<!--.*?-->", "", текст, flags=re.S)
    текст = re.sub(r"<script.*?</script>", "", текст, flags=re.S)
    текст = re.sub(r"<style.*?</style>", "", текст, flags=re.S)
    вых = [пробелы(a) for a in АТРИБУТЫ.findall(текст)]
    # Текстовый узел целиком: перенос строки в исходнике нового узла
    # не создаёт, поэтому бить по строкам файла нельзя.
    вых += [пробелы(к) for к in re.split(r"<[^>]+>", текст)]
    return [к for к in вых if к and КИР.search(к)]


def ключи_реестра(текст: str) -> list[str]:
    """Подписи из data/tools.json: категории дерева, плейбуки, заметки.

    Эти строки не лежат в коде — их не найти разбором исходников,
    а на экране они занимают всю левую колонку. Без них английский
    интерфейс выглядит наполовину переведённым, что хуже, чем
    непереведённым: пользователь перестаёт понимать, где язык
    интерфейса, а где данные.
    """
    try:
        d = json.loads(текст)
    except Exception:
        return []
    вых = []
    for c in d.get("categories", []):
        if c.get("label"):
            вых.append(c["label"])
    for p in d.get("playbooks", []):
        for поле in ("name", "note"):
            if p.get(поле):
                вых.append(p[поле])
    for t in d.get("tools", []):
        for поле in ("name", "note"):
            if t.get(поле):
                вых.append(t[поле])
    return [к for к in вых if КИР.search(к)]


def ключи_типов(текст: str) -> list[str]:
    """Подписи типов индикаторов из таблицы TYPE_LABELS в lib/ioc.js.

    Сам парсер не локализуется: его значения сравниваются с данными,
    и перевод их сломал бы разбор. Но подписи типов («Домен»,
    «Подсеть») видно на экране в заголовках групп и в таблице кейса,
    где они проходят через T() при отрисовке. Поэтому ключи берутся
    из таблицы, а не из обёрток.
    """
    m = re.search(r"const TYPE_LABELS = \{(.*?)\n\};", текст, re.S)
    if not m:
        return []
    return [з for з in re.findall(r"'([^']+)'", m.group(1)) if КИР.search(з)]


def ключи_фактов(текст: str) -> list[str]:
    """Имена локальных фактов из вызовов факт('имя', …) в lib/localfacts.js.

    ТОТ ЖЕ СЛУЧАЙ, ЧТО И TYPE_LABELS, и он уже стоил непереведённой
    строки в скриншоте магазина. Имя факта — ДАННЫЕ: по нему идёт
    сравнение в newtab.js (`f.имя === 'внимание'` -> класс is-warn),
    поэтому переводить его в месте создания нельзя. Перевод делается
    при отрисовке, через T(f.имя) — но там ключ приходит переменной,
    и разбор исходников его не видит. Ключа нет в словаре, T()
    возвращает его как есть, и в английском интерфейсе посреди
    карточки стоит русское «внимание». Ни ошибки, ни отчёта.
    """
    return [з for з in re.findall(r"факт\(\s*'([^']+)'", текст) if КИР.search(з)]


def собрать_ключи(читать) -> list[str]:
    """читать(rel) -> str | None. Возвращает ключи в порядке появления."""
    порядок: dict[str, None] = {}
    for rel in JS_ФАЙЛЫ:
        т = читать(rel)
        if т is None:
            continue
        for к in ключи_js(т):
            порядок.setdefault(к, None)
    for rel in HTML_ФАЙЛЫ:
        т = читать(rel)
        if т is None:
            continue
        for к in ключи_html(т):
            порядок.setdefault(к, None)
    т = читать("lib/ioc.js")
    if т is not None:
        for к in ключи_типов(т):
            порядок.setdefault(к, None)
    т = читать("lib/localfacts.js")
    if т is not None:
        for к in ключи_фактов(т):
            порядок.setdefault(к, None)
    т = читать("data/tools.json")
    if т is not None:
        for к in ключи_реестра(т):
            порядок.setdefault(к, None)
    return sorted(порядок)


ШАПКА = """// АНГЛИЙСКИЙ СЛОВАРЬ ИНТЕРФЕЙСА — ФАЙЛ СОБИРАЕТСЯ, НЕ ПРАВИТСЯ РУКАМИ
// -------------------------------------------------------------------
// Источник переводов: tools/i18n/ru-en.json. Ключи берутся из исходников
// расширения, поэтому правка подписи в коде сразу видна как пропавший
// перевод: python3 tools_i18n.py --проверить.
//
// Ключ — исходная русская строка. Отсутствие ключа означает «показать
// русский»: непереведённая строка видна на экране и ничего не ломает.
// Ключи текстовых узлов разметки нормализованы по пробелам — так же,
// как их считает ключТекста() в lib/i18n.js.
(function (глоб) {
  'use strict';
  var СЛОВАРЬ = {
"""

ПОДВАЛ = """  };
  глоб.TI_LOCALE_EN = СЛОВАРЬ;
  if (typeof module !== 'undefined' && module.exports) module.exports = СЛОВАРЬ;
})(typeof self !== 'undefined' ? self
   : (typeof globalThis !== 'undefined' ? globalThis : this));
"""


def собрать_словарь(ключи: list[str], мастер: dict) -> tuple[str, list[str]]:
    """Возвращает (текст en.js, список непереведённых ключей)."""
    нет = [к for к in ключи if not мастер.get(к)]
    тело = "".join(
        "    %s: %s,\n" % (json.dumps(к, ensure_ascii=False),
                           json.dumps(мастер[к], ensure_ascii=False))
        for к in ключи if мастер.get(к))
    return ШАПКА + тело + ПОДВАЛ, нет


def мастер() -> dict:
    return json.loads(МАСТЕР.read_text(encoding="utf-8"))


def для_дерева(корень: pathlib.Path) -> tuple[str, list[str]]:
    def читать(rel: str):
        p = корень / rel
        return p.read_text(encoding="utf-8") if p.exists() else None
    return собрать_словарь(собрать_ключи(читать), мастер())


def main() -> int:
    только_проверить = "--проверить" in sys.argv
    текст, нет = для_дерева(КОРЕНЬ / "extension")
    записей = текст.count("\n    \"")
    if нет:
        print(f"[!] без перевода: {len(нет)}", file=sys.stderr)
        for к in нет[:20]:
            print("    " + к[:110], file=sys.stderr)
        if len(нет) > 20:
            print(f"    …и ещё {len(нет) - 20}", file=sys.stderr)
    if только_проверить:
        print(f"словарь: {записей} записей, без перевода {len(нет)}")
        return 1 if нет else 0
    ЦЕЛЬ.parent.mkdir(parents=True, exist_ok=True)
    ЦЕЛЬ.write_text(текст, encoding="utf-8")
    print(f"словарь собран: {записей} записей, без перевода {len(нет)}")
    return 1 if нет else 0


if __name__ == "__main__":
    raise SystemExit(main())
