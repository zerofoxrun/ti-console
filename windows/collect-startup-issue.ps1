# =============================================================================
# collect-startup-issue.ps1 — сбор данных о падении при первом запуске
#
#   powershell -ExecutionPolicy Bypass -File collect-startup-issue.ps1
#
# ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ
# ----------------------
# about:crashes пуст, а браузер при первом запуске закрывается. Пустой
# about:crashes означает одно из двух, и различить это на глаз нельзя:
#
#   а) падения не было — процесс завершился штатно (чаще всего упёрся
#      в заблокированный профиль прошлого экземпляра);
#   б) падение было НАСТОЛЬКО рано, что сборщик отчётов Firefox ещё не
#      успел инициализироваться. Тогда следов в about:crashes нет,
#      но запись остаётся в журнале событий Windows.
#
# Скрипт собирает данные под оба варианта и складывает их в один файл.
#
# ЧТО ОН ДЕЛАЕТ С СИСТЕМОЙ
# ------------------------
# Ничего. Только читает: файлы профиля, журнал событий, список процессов.
# Ни одной записи, ни одного сетевого запроса. Убедиться в этом можно,
# прочитав скрипт целиком — он на 200 строк и без единого вызова наружу.
#
# ЧТО ПОПАДАЕТ В ОТЧЁТ
# --------------------
# Имена файлов и путей профиля, версии, времена событий, тексты ошибок
# Firefox из журнала Windows. Адресов посещённых страниц, содержимого
# вкладок и кейсов там нет. Перед отправкой отчёт можно прочитать
# обычным блокнотом.
# =============================================================================

$ErrorActionPreference = 'Continue'

# Куда класть отчёт.
#
# Не «Рабочий стол» напрямую: при перенаправленной папке (OneDrive,
# доменный профиль) GetFolderPath может вернуть пустую строку, и скрипт
# упал бы на первой же строке — то есть диагностический инструмент
# сломался бы ровно на той машине, которую диагностирует. Пробуем
# по очереди и берём первое, что существует.
$outDir = @(
  [Environment]::GetFolderPath('Desktop'),
  $env:USERPROFILE,
  (Get-Location).Path
) | Where-Object { $_ -and (Test-Path $_ -ErrorAction SilentlyContinue) } | Select-Object -First 1
if (-not $outDir) { $outDir = '.' }
$out = Join-Path $outDir 'ti-startup-issue.txt'

$lines = New-Object System.Collections.Generic.List[string]

function W($t) { $lines.Add($t); Write-Host $t }
function Section($t) {
  $lines.Add(''); $lines.Add("=== $t ==="); $lines.Add('')
  Write-Host "`n=== $t ===" -ForegroundColor Cyan
}

W "Отчёт собран: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
W "Компьютер: $env:COMPUTERNAME   Пользователь: $env:USERNAME"
try {
  W "Windows: $((Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).Caption) build $([Environment]::OSVersion.Version)"
} catch {
  W "Windows: build $([Environment]::OSVersion.Version) (название системы получить не удалось)"
}

# ------------------------------------------------------------- 1. Firefox
Section '1. Firefox'

# -ErrorAction SilentlyContinue обязателен: на машине без диска C:
# или с закрытым доступом Test-Path иначе засыпает вывод красным,
# и настоящие находки в нём тонут.
$ffDir = @(
  'C:\Program Files\Mozilla Firefox',
  'C:\Program Files (x86)\Mozilla Firefox',
  "$env:LOCALAPPDATA\Mozilla Firefox"
) | Where-Object {
      $_ -and (Test-Path (Join-Path $_ 'firefox.exe' -ErrorAction SilentlyContinue) -ErrorAction SilentlyContinue)
    } | Select-Object -First 1

if ($ffDir) {
  $exe = Join-Path $ffDir 'firefox.exe'
  W "каталог: $ffDir"
  W "версия:  $((Get-Item $exe).VersionInfo.ProductVersion)"
  W "изменён: $((Get-Item $exe).LastWriteTime)"
} else {
  W 'firefox.exe не найден в стандартных местах'
}

# --------------------------------------------- 2. Висящие процессы firefox
Section '2. Процессы firefox прямо сейчас'
#
# Это первая по вероятности причина «первый запуск закрывается, второй
# проходит»: предыдущий экземпляр не завершился, профиль заблокирован,
# новый процесс упирается в блокировку и выходит. Ко второму запуску
# старый процесс успевает умереть.
#
# Запускать скрипт для этой проверки надо при ЗАКРЫТОМ браузере.

$procs = Get-Process firefox -ErrorAction SilentlyContinue
if ($procs) {
  W "НАЙДЕНО процессов: $($procs.Count)  (браузер должен быть закрыт!)"
  foreach ($p in $procs) {
    W ("  PID {0}  запущен {1}  память {2} МБ" -f $p.Id, $p.StartTime, [int]($p.WorkingSet64 / 1MB))
  }
} else {
  W 'процессов firefox нет'
}

# ------------------------------------------------------------- 3. Профили
Section '3. Профили и блокировка'

# $env:APPDATA пуст только в нестандартной среде, но Join-Path на null
# бросает исключение и засоряет вывод красным. Проверяем явно.
$appData = $env:APPDATA
$profRoot = if ($appData) { Join-Path $appData 'Mozilla\Firefox' } else { $null }
$iniPath = if ($profRoot) { Join-Path $profRoot 'profiles.ini' } else { $null }
if (-not $appData) { W 'переменная APPDATA пуста — профиль искать негде' }
elseif (Test-Path $iniPath -ErrorAction SilentlyContinue) {
  $profDirs = Get-ChildItem (Join-Path $profRoot 'Profiles') -Directory -ErrorAction SilentlyContinue
  W "профилей: $($profDirs.Count)"
  foreach ($d in $profDirs) {
    $lock = Join-Path $d.FullName 'parent.lock'
    $has = if (Test-Path $lock -ErrorAction SilentlyContinue) { "ЕСТЬ parent.lock ($((Get-Item $lock).LastWriteTime))" } else { 'блокировки нет' }
    W "  $($d.Name)  изменён $($d.LastWriteTime)  $has"
  }
  # Несколько профилей — отдельный источник путаницы: политика применяется
  # ко всем, а расширение и настройки живут в конкретном.
  if ($profDirs.Count -gt 1) {
    W 'ВНИМАНИЕ: профилей больше одного — проверьте, что смотрите тот же, в котором работаете (about:profiles)'
  }
} else {
  W "profiles.ini не найден по пути $iniPath"
}

# ------------------------------------------------- 4. Отчёты о падениях
Section '4. Файлы отчётов о падениях'
#
# Проверяем НА ДИСКЕ, а не на about:crashes. Страница показывает то, что
# сборщик успел зарегистрировать; файлы появляются раньше и остаются,
# даже если отправка отключена.

$crashRoot = if ($appData) { Join-Path $appData 'Mozilla\Firefox\Crash Reports' } else { $null }
if (-not $crashRoot) { W 'APPDATA пуста — каталог отчётов искать негде' }
elseif (Test-Path $crashRoot -ErrorAction SilentlyContinue) {
  foreach ($sub in @('pending', 'submitted')) {
    $dir = Join-Path $crashRoot $sub
    if (Test-Path $dir -ErrorAction SilentlyContinue) {
      $files = Get-ChildItem $dir -File -ErrorAction SilentlyContinue
      W "$sub : файлов $($files.Count)"
      $files | Sort-Object LastWriteTime -Descending | Select-Object -First 5 |
        ForEach-Object { W "    $($_.Name)  $($_.LastWriteTime)" }
    } else {
      W "$sub : каталога нет"
    }
  }
  $evt = Join-Path $crashRoot 'events'
  if (Test-Path $evt -ErrorAction SilentlyContinue) {
    W "events: файлов $((Get-ChildItem $evt -File -ErrorAction SilentlyContinue).Count)"
  }
} else {
  W "каталога отчётов нет: $crashRoot"
  W 'это ожидаемо, если падений действительно не было'
}

# ------------------------------------- 5. Журнал событий Windows по firefox
Section '5. Журнал событий Windows (7 дней)'
#
# ГЛАВНЫЙ ИСТОЧНИК, когда about:crashes пуст. Падение на раннем старте
# сборщик отчётов Firefox не успевает записать, а Windows записывает
# всегда: источники Application Error, Application Hang, .NET Runtime,
# Windows Error Reporting.

$since = (Get-Date).AddDays(-7)
try {
  $events = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since } -ErrorAction Stop |
    Where-Object { $_.Message -match 'firefox' -or $_.ProviderName -match 'Error Reporting' }
  if ($events) {
    W "записей, упоминающих firefox: $($events.Count)"
    $events | Select-Object -First 12 | ForEach-Object {
      W ''
      W ("[{0}] {1} / id {2} / {3}" -f $_.TimeCreated, $_.ProviderName, $_.Id, $_.LevelDisplayName)
      $msg = ($_.Message -split "`n" | Select-Object -First 8) -join ' | '
      W ("    " + $msg)
    }
  } else {
    W 'записей про firefox за 7 дней нет'
    W 'это сильный довод: процесс НЕ падал аварийно, а завершался штатно'
  }
} catch {
  W "журнал прочитать не удалось: $($_.Exception.Message)"
  W 'попробуйте запустить PowerShell от имени администратора'
}

# ---------------------------------------------- 6. Политика и расширения
Section '6. Политика и расширения'

$polPaths = @()
if ($ffDir) { $polPaths += (Join-Path $ffDir 'distribution\policies.json') }
$polPaths += "$env:ProgramData\Mozilla\policies.json"
foreach ($p in $polPaths) {
  if (Test-Path $p -ErrorAction SilentlyContinue) {
    W "политика: $p  ($((Get-Item $p).LastWriteTime))"
    try {
      $json = Get-Content $p -Raw | ConvertFrom-Json
      W "  разбирается как JSON: да, ключей верхнего уровня $($json.policies.PSObject.Properties.Count)"
    } catch {
      W "  JSON НЕ РАЗБИРАЕТСЯ: $($_.Exception.Message)"
      W '  Firefox применит такой файл ЧАСТИЧНО — это выглядит как «половина настроек не работает»'
    }
  } else {
    W "политики нет: $p"
  }
}

$xpiDir = 'C:\TI-Console'
if (Test-Path $xpiDir -ErrorAction SilentlyContinue) {
  Get-ChildItem $xpiDir -Filter *.xpi | ForEach-Object {
    W "XPI: $($_.Name)  $([int]($_.Length/1KB)) КБ  $($_.LastWriteTime)"
  }
} else {
  W "каталога $xpiDir нет"
}

# --------------------------------------------------------------- итог
Section 'Итог'
W 'Пришлите этот файл целиком. Что из него читается:'
W '  - есть процессы firefox при закрытом браузере -> причина в блокировке профиля,'
W '    расширение ни при чём;'
W '  - в журнале Windows есть Application Error по firefox.exe -> падение было,'
W '    и в записи указан сбойный модуль: по нему видно, графика это, сеть или JS;'
W '  - и то и другое пусто -> браузер завершается штатно, причину искать'
W '    в ярлыке запуска, групповых политиках или антивирусе.'

$lines | Set-Content -Path $out -Encoding UTF8
Write-Host "`nОтчёт сохранён: $out" -ForegroundColor Green
