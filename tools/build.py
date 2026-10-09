#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build TI Console packages for Chrome and Firefox.

There is no bundler and no transpiler: the files under ``extension/`` are
exactly what runs in the browser. All this script does is zip them with
the right manifest and drop anything that should not ship.

    python3 tools/build.py --firefox    -> dist/ti-console.xpi
    python3 tools/build.py --chrome     -> dist/ti-console-chrome.zip
                                           dist/chrome-unpacked/

Both archives are deterministic: entry timestamps are fixed, so an
unchanged source tree always produces a byte-identical file. That is what
makes the package reproducible for store review — build it yourself and
compare the hash.

Why two manifests. Firefox uses an event page and ``background.scripts``;
Chrome uses a service worker and ``background.service_worker`` and has
ignored ``scripts`` since Chrome 121. Firefox has no ``sidePanel``
permission, Chrome has no ``dns`` and no ``browserSettings``. Keeping the
two manifests side by side as plain files, rather than generating one
from the other, means you can read exactly what each browser receives.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "extension"
DIST = ROOT / "dist"

# Fixed timestamp for every zip entry: without it the archive differs on
# every build and cannot be compared by hash.
WHEN = (2026, 1, 1, 0, 0, 0)

# Never shipped: the Chrome manifest is chosen explicitly, and editor
# leftovers have no business in a reviewed package.
SKIP_NAMES = {"manifest.chrome.json", ".DS_Store", "Thumbs.db"}
SKIP_SUFFIX = (".test.js", ".orig", ".rej", "~")


def собрать(манифест: pathlib.Path, выход: pathlib.Path,
            распаковать: pathlib.Path | None = None) -> dict:
    if not манифест.exists():
        sys.exit(f"[!] no {манифест.relative_to(ROOT)}")
    данные = json.loads(манифест.read_text(encoding="utf-8"))

    файлы: list[tuple[str, bytes]] = []
    for путь in sorted(SRC.rglob("*")):
        if not путь.is_file():
            continue
        if путь.name in SKIP_NAMES or путь.name.endswith(SKIP_SUFFIX):
            continue
        отн = путь.relative_to(SRC).as_posix()
        if отн == "manifest.json":
            continue                      # the chosen one is written below
        файлы.append((отн, путь.read_bytes()))

    DIST.mkdir(parents=True, exist_ok=True)
    if выход.exists():
        выход.unlink()
    with zipfile.ZipFile(выход, "w", zipfile.ZIP_DEFLATED) as z:
        шапка = zipfile.ZipInfo("manifest.json", date_time=WHEN)
        шапка.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(шапка, json.dumps(данные, ensure_ascii=False, indent=2))
        for отн, тело in файлы:
            инфо = zipfile.ZipInfo(отн, date_time=WHEN)
            инфо.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(инфо, тело)

    if распаковать is not None:
        if распаковать.exists():
            shutil.rmtree(распаковать)
        распаковать.mkdir(parents=True)
        (распаковать / "manifest.json").write_text(
            json.dumps(данные, ensure_ascii=False, indent=2), encoding="utf-8")
        for отн, тело in файлы:
            цель = распаковать / отн
            цель.parent.mkdir(parents=True, exist_ok=True)
            цель.write_bytes(тело)

    return {"version": данные["version"], "files": len(файлы) + 1,
            "bytes": выход.stat().st_size}


def проверить(архив: pathlib.Path) -> None:
    """Look at the result instead of trusting it."""
    with zipfile.ZipFile(архив) as z:
        имена = z.namelist()
        м = json.loads(z.read("manifest.json"))
        лишние = [n for n in имена if n.endswith(".test.js")]
        if лишние:
            sys.exit(f"[!] tests ended up in the package: {лишние[:3]}")
        остатки = [k for k in м if k.startswith("_")]
        if остатки:
            sys.exit(f"[!] comment keys left in the manifest: {остатки}")
        if м.get("manifest_version") != 3:
            sys.exit("[!] manifest_version must be 3")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--firefox", action="store_true", help="build the XPI for Firefox / AMO")
    p.add_argument("--chrome", action="store_true", help="build the ZIP for Chrome Web Store")
    a = p.parse_args()
    if not (a.firefox or a.chrome):
        p.print_help()
        return 1

    if a.firefox:
        out = DIST / "ti-console.xpi"
        meta = собрать(SRC / "manifest.json", out)
        проверить(out)
        print(f"[=] {out.name:24} v{meta['version']:8} "
              f"{meta['bytes'] // 1024:4} KB, {meta['files']} files")

    if a.chrome:
        out = DIST / "ti-console-chrome.zip"
        meta = собрать(SRC / "manifest.chrome.json", out, DIST / "chrome-unpacked")
        проверить(out)
        print(f"[=] {out.name:24} v{meta['version']:8} "
              f"{meta['bytes'] // 1024:4} KB, {meta['files']} files")
        print(f"    unpacked copy -> {(DIST / 'chrome-unpacked').relative_to(ROOT)}"
              "  (chrome://extensions -> Load unpacked)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
