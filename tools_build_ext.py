#!/usr/bin/env python3
"""
tools_build_ext.py — сборка XPI с чистыми манифестами.

ПРАВИЛО, КОТОРОЕ ЗДЕСЬ РЕАЛИЗОВАНО
-----------------------------------
Исходник документирован, разворачиваемый артефакт чист.

В manifest.json комментарии живут ключами `_comment_*`, и там они
полезны: каждое архитектурное решение объяснено рядом с местом, где
оно принято. Но в установленном расширении эти ключи превращаются
в предупреждения «unknown property» в about:debugging, а в теме —
в риск посерьёзнее: объект `theme` валидируется схемой строго,
и лишний ключ внутри него может отправить всю тему в отказ.

Поэтому манифест в XPI собирается без комментариев. Файл в репозитории
остаётся как был.

    python3 tools_build_ext.py

Результат в dist/:
    ti-console.xpi          имена БЕЗ версии — ровно такие ждёт политика
    ti-console-theme.xpi
    ti-console-<версия>.xpi версионированные копии для серверной раздачи
    ti-console-theme-<версия>.xpi
"""

from __future__ import annotations

import json
import pathlib
import shutil
import sys
import zipfile

ROOT = pathlib.Path(__file__).parent
DIST = ROOT / "dist"

# Что не кладём в пакет: тесты и мусор редакторов.
SKIP_SUFFIX = (".test.js",)
SKIP_NAMES = {".DS_Store", "Thumbs.db"}


def strip_comments(obj):
    """Рекурсивно убирает ключи, начинающиеся с подчёркивания."""
    if isinstance(obj, dict):
        return {k: strip_comments(v) for k, v in obj.items() if not k.startswith("_")}
    if isinstance(obj, list):
        return [strip_comments(v) for v in obj]
    return obj


def pack(src_dir: pathlib.Path, out: pathlib.Path) -> dict:
    manifest = json.loads((src_dir / "manifest.json").read_text(encoding="utf-8"))
    clean = strip_comments(manifest)

    files = []
    for path in sorted(src_dir.rglob("*")):
        if not path.is_file():
            continue
        if path.name in SKIP_NAMES or path.name.endswith(SKIP_SUFFIX):
            continue
        if path.name == "manifest.json" and path.parent == src_dir:
            continue                       # положим очищенный
        files.append(path)

    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    # ZIP_DEFLATED и фиксированное время: пересборка без изменений
    # даёт побайтово тот же файл, и его можно сверять хешем.
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        info = zipfile.ZipInfo("manifest.json", date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, json.dumps(clean, ensure_ascii=False, indent=2))
        for path in files:
            rel = path.relative_to(src_dir).as_posix()
            fi = zipfile.ZipInfo(rel, date_time=(2026, 1, 1, 0, 0, 0))
            fi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(fi, path.read_bytes())

    return {
        "version": clean["version"],
        "id": clean["browser_specific_settings"]["gecko"]["id"],
        "files": len(files) + 1,
        "bytes": out.stat().st_size,
        "stripped": len(json.dumps(manifest)) - len(json.dumps(clean)),
    }


# ---------------------------------------------------------------- CHROME ---
#
# Манифест под Chrome ВЫВОДИТСЯ из манифеста Firefox, а не пишется рядом.
# Второй manifest.json, который правят руками, расходится с первым —
# и расходится молча: расширение в одном браузере просто работает иначе.
# Здесь перечислено ровно то, чем они отличаются, и каждая строка
# объяснена. Полнота перечисления проверяется в CI.

# Ключи манифеста, которых в Chrome нет или которые он понимает иначе.
FIREFOX_ONLY_KEYS = {
    # Идентификатор и минимальная версия Gecko. Chrome их игнорирует,
    # но в Web Store лишние ключи — повод для вопросов при ревью.
    "browser_specific_settings",
    # Боковая панель: в Chrome другой ключ, см. ниже.
    "sidebar_action",
}

# Разрешения, которых в Chrome нет. Неизвестное разрешение Chrome
# не игнорирует молча — он показывает ошибку при загрузке расширения.
FIREFOX_ONLY_PERMISSIONS = {
    # Резолв имени средствами браузера. В Chrome API dns отсутствует,
    # и подменить его нечем: единственный способ получить адрес там —
    # отправить имя хоста во внешний сервис, что запрещено требованием
    # проекта. В Chrome панель обязана сказать об этом вслух — см.
    # TICompat.нет('dns') в extension/lib/compat.js.
    "dns",
    # Тёмная схема для содержимого страниц. Косметика, уже в try/catch.
    "browserSettings",
}

# Разрешения, нужные только Chrome.
CHROME_ONLY_PERMISSIONS = {
    # Боковая панель в Chrome требует явного разрешения.
    "sidePanel",
}


def to_chrome(manifest: dict) -> dict:
    """Манифест Firefox -> манифест Chrome. Зеркало решений из compat.js."""
    m = {k: v for k, v in manifest.items() if k not in FIREFOX_ONLY_KEYS}

    # Фон: Chrome игнорирует background.scripts с версии 121 и требует
    # service_worker. Объявить оба ключа МОЖНО, и MDN это советует, но до
    # Firefox 121 присутствие service_worker ломало загрузку фоновой
    # страницы (bugzil.la/1860304), а у нас strict_min_version = 115.
    # Поэтому у каждого браузера свой ключ, а точка входа sw.js
    # подключает те же файлы в том же порядке.
    scripts = list(manifest.get("background", {}).get("scripts", []))
    m["background"] = {"service_worker": "sw.js"}

    # Боковая панель: sidebar_action -> side_panel.
    sidebar = manifest.get("sidebar_action") or {}
    if sidebar.get("default_panel"):
        m["side_panel"] = {"default_path": sidebar["default_panel"]}

    perms = [p for p in manifest.get("permissions", []) if p not in FIREFOX_ONLY_PERMISSIONS]
    perms += [p for p in sorted(CHROME_ONLY_PERMISSIONS) if p not in perms]
    m["permissions"] = perms

    # chrome_settings_overrides.homepage Chrome поддерживает только
    # на Windows и macOS. Ключ оставляем: на Linux он просто не сработает,
    # а удалять его значило бы лишить домашней страницы там, где она есть.

    return m, scripts


def check_chrome(m: dict, scripts: list[str], sw_src: str) -> list[str]:
    """Проверить выведенный манифест ДО упаковки."""
    err = []
    if "sidebar_action" in m:
        err.append("в манифесте Chrome остался sidebar_action")
    for p in FIREFOX_ONLY_PERMISSIONS:
        if p in m.get("permissions", []):
            err.append(f"в манифесте Chrome осталось разрешение {p}, которого там нет")
    if m.get("background", {}).get("scripts"):
        err.append("в манифесте Chrome остался background.scripts — Chrome его игнорирует")
    # Порядок подключения в sw.js обязан совпадать с background.scripts
    # манифеста Firefox: разойдясь, они дадут разный порядок инициализации
    # в двух браузерах, и это не будет видно ни в одном тесте интерфейса.
    import re as _re
    m_sw = _re.search(r"importScripts\(([^)]*)\)", sw_src)
    в_sw = _re.findall(r"['\"]([^'\"]+)['\"]", m_sw.group(1)) if m_sw else []
    if в_sw != scripts:
        err.append(f"sw.js подключает {в_sw}, а background.scripts — {scripts}")
    return err


def pack_chrome(src_dir: pathlib.Path, out: pathlib.Path) -> dict:
    """Сборка под Chrome: тот же код, выведенный манифест."""
    manifest = strip_comments(json.loads((src_dir / "manifest.json").read_text(encoding="utf-8")))
    clean, scripts = to_chrome(manifest)
    problems = check_chrome(clean, scripts, (src_dir / "sw.js").read_text(encoding="utf-8"))
    if problems:
        for p in problems:
            print(f"[!] {p}", file=sys.stderr)
        raise SystemExit(1)

    files = [p for p in sorted(src_dir.rglob("*"))
             if p.is_file() and p.name not in SKIP_NAMES
             and not p.name.endswith(SKIP_SUFFIX)
             and not (p.name == "manifest.json" and p.parent == src_dir)]

    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        info = zipfile.ZipInfo("manifest.json", date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, json.dumps(clean, ensure_ascii=False, indent=2))
        for path in files:
            fi = zipfile.ZipInfo(path.relative_to(src_dir).as_posix(),
                                 date_time=(2026, 1, 1, 0, 0, 0))
            fi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(fi, path.read_bytes())

    # Распакованная копия: её грузят через «Загрузить распакованное
    # расширение» в chrome://extensions. Это единственный способ поставить
    # расширение в Chrome на неуправляемой машине без Web Store.
    unpacked = DIST / "chrome-unpacked"
    if unpacked.exists():
        shutil.rmtree(unpacked)
    unpacked.mkdir(parents=True)
    (unpacked / "manifest.json").write_text(
        json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8")
    for path in files:
        dst = unpacked / path.relative_to(src_dir)
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(path.read_bytes())

    return {"version": clean["version"], "files": len(files) + 1,
            "bytes": out.stat().st_size, "unpacked": unpacked}


def main() -> int:
    if "--chrome" in sys.argv:
        meta = pack_chrome(ROOT / "extension", DIST / "ti-console-chrome.zip")
        print(f"[=] ti-console-chrome.zip     v{meta['version']:8} "
              f"{meta['bytes'] // 1024:3} КБ, {meta['files']} файлов")
        print(f"    распакованная копия -> {meta['unpacked'].relative_to(ROOT)}")
        return 0

    targets = [
        (ROOT / "extension", "ti-console"),
        (ROOT / "theme", "ti-console-theme"),
    ]
    results = {}
    for src, base in targets:
        if not (src / "manifest.json").exists():
            print(f"[!] нет {src}/manifest.json", file=sys.stderr)
            return 1
        plain = DIST / f"{base}.xpi"
        meta = pack(src, plain)
        # Версионированная копия для серверной раздачи, где её ждёт
        # updates.json. Для локальной раскатки используется имя без версии.
        versioned = DIST / f"{base}-{meta['version']}.xpi"
        versioned.write_bytes(plain.read_bytes())
        results[base] = meta
        print(f"[=] {plain.name:24} v{meta['version']:8} {meta['bytes'] // 1024:3} КБ, "
              f"{meta['files']} файлов, комментариев вырезано {meta['stripped']} байт")

    # Проверяем результат, а не верим ему.
    for base, meta in results.items():
        with zipfile.ZipFile(DIST / f"{base}.xpi") as z:
            m = json.loads(z.read("manifest.json"))
            left = [k for k in m if k.startswith("_")]
            if left:
                print(f"[!] в {base}.xpi остались комментарии: {left}", file=sys.stderr)
                return 1
            if "theme" in m and any(k.startswith("_") for k in m["theme"]):
                print(f"[!] комментарий внутри объекта theme в {base}.xpi", file=sys.stderr)
                return 1
            if any(n.endswith(".test.js") for n in z.namelist()):
                print(f"[!] в {base}.xpi попали тесты", file=sys.stderr)
                return 1
    print("[=] манифесты чистые, тестов в пакетах нет")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
