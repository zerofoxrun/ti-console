#!/usr/bin/env python3
"""
make-local.py — собирает policies-local.json из policies.json.

ЗАЧЕМ ГЕНЕРАТОР, А НЕ ВТОРОЙ ФАЙЛ РУКАМИ
-----------------------------------------
Два независимых файла политики разъезжаются на третьей правке, и заметно
это становится через месяц: где-то поправили список внутренних зон,
где-то нет. Поэтому локальный вариант — производная от основного,
отличия перечислены здесь одним списком и проверяются в CI.

ЧТО УБИРАЕТСЯ В ЛОКАЛЬНОМ ВАРИАНТЕ
-----------------------------------
Всё, что ссылается на сервер. Не потому, что сломается — расширение
переживает недоступность сервера и уходит на встроенную копию реестра, —
а потому что иначе браузер при каждом старте ходит на несуществующий
хост, и в журнале это выглядит как попытка соединения с чужим адресом.

    python3 policies/make-local.py
"""

from __future__ import annotations

import json
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
SRC = HERE / "policies.json"
DST = HERE / "policies-local.json"

# Куда положен XPI на машине. Формат file:/// документирован для
# install_url и работает в offline-установке.
#
# ИМЕНА ФАЙЛОВ ЗДЕСЬ И НА ДИСКЕ ОБЯЗАНЫ СОВПАДАТЬ. Это звучит очевидно
# и ровно на этом спотыкаются: сборка выдаёт ti-console-0.12.1.xpi,
# политика ждёт ti-console.xpi, расширение молча не ставится, а
# в about:policies при этом всё зелёное — ошибка видна только
# в about:addons по отсутствию дополнения.
# Поэтому имена без версии: версия лежит внутри манифеста и видна
# в about:addons, а в имени файла она только создаёт рассинхрон.
#
# ПОЧЕМУ C:\TI-Console, А НЕ C:\Program Files\TI-Console
# --------------------------------------------------------
# Схема file:/// для install_url поддерживается официально, и синтаксис
# с %20 формально верен. Но каталог внутри Program Files добавляет сразу
# три независимых способа получить ERROR_NETWORK_FAILURE, и ни один
# из них не виден в Проводнике:
#
#   1. Запись туда требует прав администратора. Если копирование прошло
#      без повышения прав, Windows перенаправляет его в VirtualStore
#      (%LOCALAPPDATA%\VirtualStore\Program Files\...). Проводник
#      показывает файл на месте — он склеивает оба вида, — а по
#      настоящему пути файла нет, и Firefox его не находит.
#   2. Пробел требует кодирования в %20. Ошибка в одном символе даёт
#      ту же самую ошибку сети без уточнений.
#   3. ACL на Program Files строже, чем на корне диска, и при ручной
#      правке прав легко отобрать чтение у пользователя.
#
# Каталог в корне диска без пробелов снимает все три разом. Это не
# обходной путь, а устранение переменных: отлаживать по одной строке
# «ERROR_NETWORK_FAILURE» дороже, чем не создавать ей поводов.
TARGETS = {
    "windows": (
        "file:///C:/TI-Console/ti-console.xpi",
        "file:///C:/TI-Console/ti-console-theme.xpi",
    ),
    "linux": (
        "file:///opt/ti-console/ti-console.xpi",
        "file:///opt/ti-console/ti-console-theme.xpi",
    ),
}


def strip_comments(obj):
    """Убирает все ключи, начинающиеся с подчёркивания, на любой глубине.

    ЗАЧЕМ. В policies.json комментарии живут ключами вида "_2_расширения":
    это документация, и она там полезна. Но Firefox на КАЖДЫЙ такой ключ
    пишет в about:policies → Errors строку «Unknown policy: _2_расширения».
    Функционально ничего не ломается, а практически ломается важное:
    вкладка Errors перестаёт быть индикатором. Приёмка «Errors пуста»
    становится невыполнимой, и настоящая ошибка в политике тонет среди
    полутора десятков наших же комментариев.

    Поэтому правило: ИСХОДНИК документирован, РАЗВОРАЧИВАЕМЫЙ ФАЙЛ чист.
    """
    if isinstance(obj, dict):
        return {k: strip_comments(v) for k, v in obj.items() if not k.startswith("_")}
    if isinstance(obj, list):
        return [strip_comments(v) for v in obj]
    return obj


def build(policies: dict, target: str = "windows") -> dict:
    ext_path, theme_path = TARGETS[target]
    p = json.loads(json.dumps(policies))  # глубокая копия

    # 1. Расширения ставятся с диска, а не с внутреннего хоста.
    #
    #    updates_disabled ОБЯЗАН быть false, и вот почему.
    #
    #    Здесь стояло true с объяснением «без update_url обновлять неоткуда,
    #    а попытка проверки даст ошибку в about:addons». Объяснение было
    #    неверным. При install_url вида file:// Firefox обновляет расширение
    #    из САМОГО ФАЙЛА: «Firefox will update or re-install the extension
    #    whenever the XPI file at that path changes»
    #    (firefox-admin-docs.mozilla.org, ExtensionSettings).
    #
    #    То есть true выключал единственный работающий путь обновления
    #    локальной установки — и выключал МОЛЧА: замена XPI на диске не
    #    давала ни ошибки, ни сообщения, ни изменения поведения. Аналитик
    #    клал новый файл, перезапускал браузер и продолжал работать
    #    на прежней сборке. Поймано на разборе жалобы «обновил, ничего
    #    не изменилось»: две выгрузки кейса подряд были сделаны старым
    #    кодом, хотя файлы заменялись.
    #
    #    Цена обратного решения — ровно то, чего боялись: в about:addons
    #    кнопка проверки обновлений может отработать вхолостую. Это
    #    видимая мелочь против невидимой поломки.
    ext = p["ExtensionSettings"]
    ext["ti-console@soc.internal"]["install_url"] = ext_path
    ext["ti-console@soc.internal"]["updates_disabled"] = False
    ext["ti-console-theme@soc.internal"]["install_url"] = theme_path
    ext["ti-console-theme@soc.internal"]["updates_disabled"] = False
    # uBlock Origin остаётся с AMO: это внешний адрес, а не наш сервер,
    # и обновления ему нужны — блокировщик без свежих списков бесполезен.

    # 2. Поисковая система на SearXNG убирается: сервера нет.
    if "SearchEngines" in p and "Add" in p["SearchEngines"]:
        p["SearchEngines"]["Add"] = [
            e for e in p["SearchEngines"]["Add"] if "searx" not in e.get("URLTemplate", "").lower()
        ]
        if p["SearchEngines"].get("Default", "").startswith("TI: SearXNG"):
            p["SearchEngines"].pop("Default", None)

    # 3. Исключение в WebsiteFilter под адрес сервера больше не нужно.
    if "WebsiteFilter" in p:
        p["WebsiteFilter"].pop("Exceptions", None)

    # 4. Разрешение всплывающих окон для сервера.
    if "PopupBlocking" in p:
        p["PopupBlocking"]["Allow"] = [
            u for u in p["PopupBlocking"].get("Allow", []) if "ti.example.ru" not in u
        ]
        if not p["PopupBlocking"]["Allow"]:
            p["PopupBlocking"].pop("Allow")

    # 5. Конфигурация расширения: адреса и токен уходят.
    #    Расширение видит отсутствие apiUrl и работает полностью локально:
    #    реестр берётся из встроенной копии, блок анализа моделью скрыт,
    #    глобальный поиск переходит в резервный режим.
    cfg = p["3rdparty"]["Extensions"]["ti-console@soc.internal"]
    for key in ("apiUrl", "searxUrl", "apiToken", "toolsRefreshMin"):
        cfg.pop(key, None)

    # 6. Комментарий про прокси устарел ещё в основном файле: прокси нет.
    if "DNSOverHTTPS" in p:
        p["DNSOverHTTPS"]["_why"] = (
            "DoH выключен: имена исследуемых доменов не должны уходить "
            "стороннему резолверу в обход корпоративного DNS."
        )

    return strip_comments(p)


def main() -> int:
    target = "windows"
    out_path = DST
    args = sys.argv[1:]
    if "--linux" in args:
        target = "linux"
        out_path = HERE / "policies-local-linux.json"
    if "--server" in args:
        # Серверный вариант: та же чистка комментариев, но без снятия
        # ссылок на сервер. Нужен, чтобы при переходе на серверную версию
        # не получить те же полтора десятка «Unknown policy» в Errors.
        src = json.loads(SRC.read_text(encoding="utf-8"))
        clean = {"policies": strip_comments(src["policies"])}
        dst = HERE / "policies-server.json"
        dst.write_text(json.dumps(clean, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        left = [k for k in clean["policies"] if k.startswith("_")]
        print(f"[=] {dst.name} собран, комментариев осталось: {len(left)}")
        return 0
    if not SRC.exists():
        print(f"нет {SRC}", file=sys.stderr)
        return 1
    data = json.loads(SRC.read_text(encoding="utf-8"))
    ext_path, theme_path = TARGETS[target]
    # Шапку-комментарий кладём НЕ ключом политики: "_comment_generated"
    # на верхнем уровне безвреден (Firefox читает только "policies"),
    # но путать его с ключами внутри policies не стоит — там он стал бы
    # ещё одной строкой в Errors.
    out = {
        "_readme": [
            "ЭТОТ ФАЙЛ СГЕНЕРИРОВАН. Руками не править.",
            "Источник: policies/policies.json, генератор: policies/make-local.py",
            f"Цель: {target}. Для другой ОС: python3 policies/make-local.py --linux",
            "Правки вносятся в основной файл, потом перегенерировать.",
            "",
            "Локальный вариант: сервера нет вообще. Работают дерево инструментов,",
            "умный поиск, разбор страниц, кейс, экспорт и скелет отчёта.",
            "Не работают: метапоиск через SearXNG (остаётся резервный режим),",
            "автоматическое обогащение, анализ моделью.",
            "",
            "ЧТО ПРОВЕРИТЬ ПЕРЕД РАСКАТКОЙ:",
            f"  1. Файлы лежат ровно по этим путям и ровно с этими именами:",
            f"     {ext_path}",
            f"     {theme_path}",
            "     Имя файла на диске и в политике обязано совпадать: при",
            "     расхождении расширение просто не ставится, а about:policies",
            "     при этом показывает зелёное — видно только в about:addons.",
            "  2. Внутренние зоны в WebsiteFilter: сейчас там заглушки",
            "     *.internal, *.corp, *.local — подставьте свои.",
        ],
        "policies": build(data["policies"], target),
    }
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    globals()["DST"] = out_path

    # Проверяем результат, а не верим ему: ни одного упоминания сервера.
    text = out_path.read_text(encoding="utf-8")
    leaked = [m for m in ("ti.example.ru", "apiToken", "searxUrl") if m in text]
    if leaked:
        print(f"[!] в локальной политике остались ссылки на сервер: {leaked}", file=sys.stderr)
        return 1
    print(f"[=] {out_path.name} собран для {target}, "
          f"{len(text.splitlines())} строк, ссылок на сервер нет")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
