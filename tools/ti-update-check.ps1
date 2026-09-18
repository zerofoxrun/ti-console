<#
    ti-update-check.ps1 — почему обновление TI Console не применилось

    ЗАЧЕМ ЭТОТ СКРИПТ СУЩЕСТВУЕТ
    ----------------------------
    Обновление локальной установки делается заменой XPI на диске. Если оно
    не применилось, браузер об этом НЕ СООБЩАЕТ: тот же экран, то же
    поведение, ни ошибки, ни пометки. «Обновил, ничего не изменилось»
    и «исправление не работает» выглядят одинаково.

    Скрипт превращает это в отчёт: что лежит на диске, что стоит в профиле,
    какие там версии и что говорит политика. Ничего не меняет — только
    читает и печатает.

    ЗАПУСК (обычные права, администратор не нужен):
        powershell -ExecutionPolicy Bypass -File ti-update-check.ps1

    Вывод целиком можно отправить в SOC.
#>

$ErrorActionPreference = 'Continue'
$EXT_ID    = 'ti-console@soc.internal'
$DISK_PATH = 'C:\TI-Console\ti-console.xpi'

function Заголовок($t) {
    Write-Host ''
    Write-Host ('=' * 66)
    Write-Host "  $t"
    Write-Host ('=' * 66)
}

function ВерсияИзXpi($path) {
    # XPI — обычный zip. Читаем manifest.json, не распаковывая на диск.
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
        $zip = [System.IO.Compression.ZipFile]::OpenRead($path)
        try {
            $entry = $zip.Entries | Where-Object { $_.FullName -eq 'manifest.json' }
            if (-not $entry) { return '(нет manifest.json)' }
            $reader = New-Object System.IO.StreamReader($entry.Open())
            $json = $reader.ReadToEnd() | ConvertFrom-Json
            $reader.Close()
            return $json.version
        } finally { $zip.Dispose() }
    } catch { return "(не прочитать: $($_.Exception.Message))" }
}

Заголовок ' 1. ФАЙЛ НА ДИСКЕ'
if (Test-Path -LiteralPath $DISK_PATH) {
    $f = Get-Item -LiteralPath $DISK_PATH
    Write-Host "  путь:     $($f.FullName)"
    Write-Host "  размер:   $([math]::Round($f.Length/1KB)) КБ"
    Write-Host "  изменён:  $($f.LastWriteTime)"
    Write-Host "  ВЕРСИЯ:   $(ВерсияИзXpi $f.FullName)"
} else {
    Write-Host "  НЕ НАЙДЕН: $DISK_PATH" -ForegroundColor Red
    Write-Host '  Проводник склеивает настоящий каталог с VirtualStore и может'
    Write-Host '  показывать файл, которого по пути нет. Проверьте: dir /b "C:\TI-Console\"'
}

# VirtualStore: копия, созданная при записи без прав администратора.
$vs = Join-Path $env:LOCALAPPDATA 'VirtualStore\TI-Console\ti-console.xpi'
if (Test-Path -LiteralPath $vs) {
    Write-Host ''
    Write-Host '  ВНИМАНИЕ: есть копия в VirtualStore — значит запись шла без прав' -ForegroundColor Yellow
    Write-Host "  $vs  (версия $(ВерсияИзXpi $vs))"
    Write-Host '  Firefox читает НЕ её. Скопируйте файл заново с правами администратора.'
}

Заголовок ' 2. ЧТО ГОВОРИТ ПОЛИТИКА'
$polPaths = @(
    'C:\Program Files\Mozilla Firefox\distribution\policies.json',
    'C:\Program Files (x86)\Mozilla Firefox\distribution\policies.json'
) | Where-Object { Test-Path -LiteralPath $_ }

if (-not $polPaths) {
    Write-Host '  policies.json не найден в каталоге Firefox.' -ForegroundColor Red
    Write-Host '  Без политики расширение ставится вручную, и обновление тоже ручное.'
} else {
    foreach ($pp in $polPaths) {
        Write-Host "  файл: $pp"
        try {
            $pol = Get-Content -LiteralPath $pp -Raw -Encoding UTF8 | ConvertFrom-Json
            $cfg = $pol.policies.ExtensionSettings.$EXT_ID
            if (-not $cfg) {
                Write-Host "  в политике нет записи $EXT_ID" -ForegroundColor Red
            } else {
                Write-Host "    installation_mode: $($cfg.installation_mode)"
                Write-Host "    install_url:       $($cfg.install_url)"
                Write-Host "    updates_disabled:  $($cfg.updates_disabled)"
                if ($cfg.updates_disabled -eq $true) {
                    Write-Host ''
                    Write-Host '    ПРИЧИНА НАЙДЕНА.' -ForegroundColor Red
                    Write-Host '    updates_disabled: true запрещает Firefox обновлять расширение.'
                    Write-Host '    Замена XPI на диске при этом НИЧЕГО не делает и ни о чём'
                    Write-Host '    не сообщает. Нужна политика из свежей поставки, где стоит false.'
                }
                # Самая частая причина: скопирован СЕРВЕРНЫЙ вариант политики.
                # В архиве он лежал под тем же именем policies.json, что ждёт
                # Firefox, и в нём адрес внутреннего хоста. Firefox не может
                # его получить — и молчит: ни ошибки, ни записи в Errors.
                if ($cfg.install_url -notlike 'file:///*') {
                    Write-Host ''
                    Write-Host '    ПРИЧИНА НАЙДЕНА.' -ForegroundColor Red
                    Write-Host '    Расширение ставится не с диска, а по сетевому адресу:'
                    Write-Host "      $($cfg.install_url)"
                    Write-Host '    Это ПОЛИТИКА ДЛЯ КОНТУРА С СЕРВЕРОМ. Если сервера нет,'
                    Write-Host '    Firefox не может забрать файл, установка и обновление'
                    Write-Host '    не происходят, и он об этом НЕ СООБЩАЕТ: в about:policies'
                    Write-Host '    вкладка Errors остаётся пустой.'
                    Write-Host ''
                    Write-Host '    Что делать: взять policies.json из КОРНЯ поставки'
                    Write-Host '    (там install_url вида file:///) и положить его сюда:'
                    Write-Host "      $pp"
                    Write-Host '    Затем закрыть Firefox полностью и запустить снова.'
                } else {
                    # Путь из политики и путь на диске обязаны совпадать.
                    $fromPolicy = ($cfg.install_url -replace '^file:///', '') -replace '/', '\'
                    if ($fromPolicy -and ($fromPolicy -ne $DISK_PATH)) {
                        Write-Host ''
                        Write-Host "    Политика ждёт файл по пути: $fromPolicy" -ForegroundColor Yellow
                        Write-Host '    Проверьте, что вы заменяли ИМЕННО его.'
                    }
                }
            }
        } catch {
            Write-Host "  политика не разбирается: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host '  Синтаксическая ошибка в policies.json — Firefox молча применит её частично.'
        }
    }
}

Заголовок ' 3. ЧТО СТОИТ В ПРОФИЛЕ'
$profRoot = Join-Path $env:APPDATA 'Mozilla\Firefox\Profiles'
if (-not (Test-Path -LiteralPath $profRoot)) {
    Write-Host '  каталог профилей не найден' -ForegroundColor Red
} else {
    $найдено = $false
    foreach ($prof in Get-ChildItem -LiteralPath $profRoot -Directory) {
        $xpi = Join-Path $prof.FullName "extensions\$EXT_ID.xpi"
        if (Test-Path -LiteralPath $xpi) {
            $найдено = $true
            $f = Get-Item -LiteralPath $xpi
            Write-Host "  профиль:  $($prof.Name)"
            Write-Host "  изменён:  $($f.LastWriteTime)"
            Write-Host "  ВЕРСИЯ:   $(ВерсияИзXpi $xpi)" -ForegroundColor Cyan
        }
    }
    if (-not $найдено) {
        Write-Host '  расширение в профилях не найдено — оно не установлено' -ForegroundColor Yellow
    }
}

Заголовок ' 4. FIREFOX ЗАПУЩЕН?'
$ff = Get-Process firefox -ErrorAction SilentlyContinue
if ($ff) {
    Write-Host "  ДА, процессов: $($ff.Count)" -ForegroundColor Yellow
    Write-Host '  Обновление применяется при запуске. Закройте браузер ПОЛНОСТЬЮ'
    Write-Host '  (не окно, а процесс) и запустите заново.'
} else {
    Write-Host '  нет, не запущен'
}

Заголовок ' ЧТО ДЕЛАТЬ'
Write-Host @'
  Сверьте три версии из пунктов 1 и 3 с той, что прислал SOC.

  Версия на диске новая, в профиле старая
      -> обновление не применилось. Смотрите пункт 2: если там
         updates_disabled: true — это причина, нужна новая политика.
         Если false — закройте Firefox полностью и запустите снова.

  Версия на диске старая
      -> заменён не тот файл. Сверьте путь с тем, что ждёт политика.

  В пункте 2 install_url начинается с https:// или http://
      -> скопирован СЕРВЕРНЫЙ вариант политики. Нужен policies.json
         из корня поставки, в нём адрес вида file:///. По сетевому адресу
         Firefox ничего не получит и промолчит.

  Всё сходится, а поведение прежнее
      -> откройте консоль (Ctrl+T) и посмотрите номер версии в подвале
         дерева инструментов слева внизу. Если он совпадает с поставкой,
         дело не в обновлении — присылайте выгрузку кейса, в ней есть
         поле extension с версией.

  Крайняя мера, если ничего не помогает:
      1) закрыть Firefox;
      2) удалить файл <профиль>\extensions\ti-console@soc.internal.xpi;
      3) запустить Firefox — политика поставит расширение заново с диска.
'@
Write-Host ''
