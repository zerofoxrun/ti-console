#!/usr/bin/env python3
"""
tools/update_tlds.py — обновить список TLD в разборщике из Public Suffix List.

ЗАЧЕМ
-----
Домены отсекаются по allow-list TLD: без него `main.js`, `report.pdf`
и `payload.dll` попадают в выдачу как домены. Список был написан руками
«сверху вниз» (основные gTLD + ccTLD + то, что вспомнилось) и содержал
около 200 записей из полутора тысяч существующих.

Чем это плохо: индикатор с TLD не из списка ПРОПАДАЕТ. Молча. В дайджесте
заказчик от 04.09.2026 так потерялся `api.gitpanel2v[.]bet` — автор отчёта сам
пометил его дефангом, то есть прямо сказал «это индикатор», а разборщик
его не показал и ничем об этом не сообщил. Аналитик видит 125 индикаторов
вместо 126 и не имеет способа заметить разницу.

Причём пропадают ровно те TLD, которыми пользуются атакующие: дешёвые
новые gTLD — .bet, .icu, .cfd, .sbs, .cyou, .top, .buzz, .quest. Список,
написанный по памяти, смещён в сторону респектабельных зон.

ИСТОЧНИК
--------
Public Suffix List (Mozilla), секция ICANN. Берётся из пакета
`publicsuffix2`, в котором лежит снимок списка, — это проверяемый
источник, а не перечисление по памяти.

    pip install publicsuffix2 --break-system-packages
    python3 tools/update_tlds.py

Скрипт правит два файла между маркерами и ничего больше:
    extension/lib/ioc.js      TLDS
    backend/app/detect.py     TLDS
Паритет клиента и сервера проверяется backend/tests/test_parity.py.

ЧТО НЕ ДЕЛАЕТСЯ
---------------
Двухлабельные суффиксы (`co.uk`, `com.ru`) берутся не отсюда: их в списке
3810, это 39 КБ в каждом из двух файлов. Они нужны только для вычисления
регистрируемого домена (группировка выдачи), а не для ОПОЗНАНИЯ домена,
и их короткий рукописный список остаётся на месте. Неполнота там даёт
неверную группировку, но не потерю индикатора.
"""

from __future__ import annotations

import os
import pathlib
import re
import sys
import textwrap

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Зоны, которые есть в PSL, но доменами у нас НЕ считаются.
#
# .onion — специального назначения (RFC 7686). Это не домен: он не
# резолвится, не принадлежит владельцу и работает только внутри Tor.
# В разборщике под него отдельный тип `onion`, и если адрес не подошёл
# под его шаблон, он обязан остаться неопознанным, а не превратиться
# в «домен», по которому аналитик пойдёт делать whois.
ИСКЛЮЧЕНИЯ = {"onion"}

# Двухлабельные суффиксы: остаются рукописными, см. «ЧТО НЕ ДЕЛАЕТСЯ».
MULTI = """
com.ru net.ru org.ru msk.ru spb.ru
co.uk org.uk ac.uk gov.uk
co.in biz.id or.id co.id ac.id go.id
com.br com.ar com.mx com.au com.cn com.tr com.ua com.tw com.hk com.sg
co.jp co.kr co.za co.il co.nz
""".split()


def суффиксы() -> list[str]:
    try:
        import publicsuffix2
    except ImportError:
        sys.exit("нет пакета publicsuffix2: pip install publicsuffix2 --break-system-packages")

    dat = pathlib.Path(publicsuffix2.__file__).parent / "public_suffix_list.dat"
    if not dat.exists():
        sys.exit(f"не найден {dat}")

    секция = "icann"
    одно: set[str] = set()
    for строка in dat.read_text(encoding="utf-8").splitlines():
        s = строка.strip()
        if s.startswith("// ===BEGIN PRIVATE"):
            секция = "private"
            continue
        if s.startswith("// ===BEGIN ICANN"):
            секция = "icann"
            continue
        if not s or s.startswith("//") or секция != "icann":
            continue
        s = s.lstrip("*!.")
        if "." in s:
            continue
        одно.add(s)

    # В PSL интернационализированные зоны записаны в Unicode (`рф`, `السعودية`).
    # В тексте отчёта встречается и та и другая форма, поэтому храним обе:
    # Unicode-запись и punycode.
    итог = set(одно)
    for t in одно:
        if not t.isascii():
            try:
                итог.add(t.encode("idna").decode("ascii"))
            except Exception:
                pass  # несколько зон не проходят idna-кодирование; они остаются в Unicode
    итог.update(MULTI)
    итог -= ИСКЛЮЧЕНИЯ
    return sorted(итог)


НАЧАЛО = "СПИСОК TLD НАЧАЛО"
КОНЕЦ = "СПИСОК TLD КОНЕЦ"

# Маркеры стоят СНАРУЖИ объявления, и генератор переписывает объявление
# целиком. Раньше они стояли внутри строкового литерала, и их собственные
# слова («//», «СПИСОК», «TLD», «НАЧАЛО», «КОНЕЦ») попадали в множество
# TLD наравне с зонами. Вреда это не приносило — сравнение идёт по
# строчным буквам, — но список, в котором лежит слово «НАЧАЛО»,
# перестаёт быть списком.


def вписать(path: pathlib.Path, тело: str) -> bool:
    текст = path.read_text(encoding="utf-8")
    шаблон = re.compile(
        rf"(?P<b>[^\n]*{НАЧАЛО}[^\n]*\n).*?(?P<e>[^\n]*{КОНЕЦ}[^\n]*)",
        re.S,
    )
    if not шаблон.search(текст):
        sys.exit(f"{path}: нет маркеров «{НАЧАЛО}» / «{КОНЕЦ}»")
    новый = шаблон.sub(lambda m: m.group("b") + тело + m.group("e"), текст)
    if новый == текст:
        return False
    path.write_text(новый, encoding="utf-8")
    return True


def main() -> None:
    список = суффиксы()
    # break_on_hyphens=False ОБЯЗАТЕЛЕН: без него textwrap рвёт зоны
    # в punycode по дефису — `xn--p1ai` превращался в `xn--` и `p1ai`,
    # то есть ломались ВСЕ интернационализированные зоны, включая .рф.
    # break_long_words — по той же причине, но для длинных зон.
    строки = textwrap.wrap(" ".join(список), width=92,
                           break_on_hyphens=False, break_long_words=False)

    js = ("const TLDS = new Set(`\n" + "\n".join(строки)
          + "\n`.trim().split(/\\s+/));\n")
    py = ("TLDS: set[str] = set(\n"
          + "\n".join('    "' + x + ' "' for x in строки)
          + "\n    .split()\n)\n")

    # Контроль записанного: ни один токен не должен начинаться или
    # кончаться дефисом. Такой токен означает разорванную зону.
    битые = [t for t in " ".join(строки).split() if t.startswith("-") or t.endswith("-")]
    if битые:
        sys.exit(f"перенос порвал зоны: {битые[:6]} — список не записан")
    if len(" ".join(строки).split()) != len(список):
        sys.exit("после переноса изменилось число записей — список не записан")

    изменено = []
    if вписать(ROOT / "extension/lib/ioc.js", js):
        изменено.append("extension/lib/ioc.js")
    if вписать(ROOT / "backend/app/detect.py", py):
        изменено.append("backend/app/detect.py")

    print(f"TLD: {len(список)} записей "
          f"({sum(1 for t in список if '.' not in t)} однолабельных, "
          f"{sum(1 for t in список if '.' in t)} двухлабельных)")
    print("изменено: " + (", ".join(изменено) if изменено else "ничего, списки совпадают"))


if __name__ == "__main__":
    main()
