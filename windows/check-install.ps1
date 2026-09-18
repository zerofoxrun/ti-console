# =============================================================================
# check-install.ps1 — диагностика установки TI Console на Windows
#
#   powershell -ExecutionPolicy Bypass -File check-install.ps1
#
# Проверяет всё, что может помешать расширению встать, и печатает вывод,
# который достаточно переслать целиком. Ничего не меняет, кроме одного
# места — снятия метки «файл скачан из интернета», и об этом спрашивает.
#
# Порядок проверок соответствует вероятности причины, а не удобству кода.
# =============================================================================

$ErrorActionPreference = 'Continue'
$XpiDir = 'C:\TI-Console'
$problems = @()

function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Ok($t)      { Write-Host "  [ок]   $t" -ForegroundColor Green }
function Bad($t)     { Write-Host "  [!]    $t" -ForegroundColor Red; $script:problems += $t }
function Info($t)    { Write-Host "  [ ]    $t" }

# ---------------------------------------------------------------- 1. Firefox
Section '1. Firefox'

$ffCandidates = @(
  'C:\Program Files\Mozilla Firefox',
  'C:\Program Files (x86)\Mozilla Firefox',
  "$env:LOCALAPPDATA\Mozilla Firefox"
)
$ffDir = $ffCandidates | Where-Object { Test-Path (Join-Path $_ 'firefox.exe') } | Select-Object -First 1

if (-not $ffDir) {
  Bad 'firefox.exe не найден ни в одном из стандартных мест'
  Info ('искали: ' + ($ffCandidates -join '; '))
} else {
  Ok "каталог установки: $ffDir"
  $ver = (Get-Item (Join-Path $ffDir 'firefox.exe')).VersionInfo.ProductVersion
  Info "версия: $ver"
  # Снятие проверки подписи работает только на ESR, Developer Edition
  # и Nightly. На обычном Firefox неподписанное расширение не поставится
  # никаким способом, кроме временной загрузки.
  $iniPath = Join-Path $ffDir 'application.ini'
  if (Test-Path $iniPath) {
    $isEsr = (Select-String -Path $iniPath -Pattern 'esr' -Quiet)
    if ($isEsr) { Ok 'сборка ESR — снятие проверки подписи поддерживается' }
    else { Bad 'похоже, это обычный Firefox, а не ESR: неподписанное расширение не поставится' }
  }
}

# ------------------------------------------------------------------ 2. Файлы
Section '2. Файлы расширений'

if (-not (Test-Path $XpiDir)) {
  Bad "каталог $XpiDir не существует"
} else {
  foreach ($name in 'ti-console.xpi', 'ti-console-theme.xpi') {
    $p = Join-Path $XpiDir $name
    if (-not (Test-Path $p)) { Bad "нет файла $p"; continue }
    $f = Get-Item $p
    Ok "$name — $([math]::Round($f.Length/1KB)) КБ"

    # Метка «скачано из интернета». EDR и политики ограничений ПО умеют
    # блокировать чтение таких файлов, и наружу это выходит невнятной
    # ошибкой вида ERROR_NETWORK_FAILURE.
    $zone = Get-Item $p -Stream Zone.Identifier -ErrorAction SilentlyContinue
    if ($zone) { Bad "$name помечен как скачанный из интернета (Zone.Identifier)" }
    else { Info "$name — метки скачивания нет" }

    # Читается ли файл под текущим пользователем: именно это делает Firefox.
    try {
      $fs = [System.IO.File]::OpenRead($p); $fs.Close()
      Info "$name — читается текущим пользователем"
    } catch {
      Bad "$name НЕ читается текущим пользователем: $($_.Exception.Message)"
    }

    # XPI — это ZIP. Если архив битый, ошибка будет другая, но проверить дёшево.
    try {
      Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
      $z = [System.IO.Compression.ZipFile]::OpenRead($p)
      $hasManifest = $z.Entries | Where-Object { $_.FullName -eq 'manifest.json' }
      $z.Dispose()
      if ($hasManifest) { Info "$name — архив валиден, manifest.json на месте" }
      else { Bad "$name — в архиве нет manifest.json" }
    } catch {
      Bad "$name — архив не читается: $($_.Exception.Message)"
    }
  }
}

# --------------------------------------------------------------- 3. Политика
Section '3. Политика'

if ($ffDir) {
  $polPath = Join-Path $ffDir 'distribution\policies.json'
  if (-not (Test-Path $polPath)) {
    Bad "нет $polPath"
  } else {
    Ok "файл на месте: $polPath"
    try {
      $pol = Get-Content $polPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $es = $pol.policies.ExtensionSettings
      foreach ($id in 'ti-console@soc.internal', 'ti-console-theme@soc.internal') {
        $entry = $es.$id
        if (-not $entry) { Bad "в политике нет записи $id"; continue }
        Info "$id -> $($entry.install_url)"
        # Путь из политики обязан указывать на существующий файл.
        $local = $entry.install_url -replace '^file:///', '' -replace '/', '\'
        $local = [System.Uri]::UnescapeDataString($local)
        if (Test-Path $local) { Ok "  файл по этому пути существует: $local" }
        else { Bad "  ФАЙЛА ПО ЭТОМУ ПУТИ НЕТ: $local" }
      }
    } catch {
      Bad "policies.json не разбирается как JSON: $($_.Exception.Message)"
    }
  }
}

# ------------------------------------------------------------- 4. AutoConfig
Section '4. Снятие проверки подписи (AutoConfig)'

if ($ffDir) {
  $ac  = Join-Path $ffDir 'defaults\pref\autoconfig.js'
  $cfg = Join-Path $ffDir 'firefox.cfg'
  $acOk = Test-Path $ac; $cfgOk = Test-Path $cfg

  if (-not $acOk -and -not $cfgOk) {
    Bad 'AutoConfig не настроен: неподписанное расширение установить нельзя'
    Info 'это самая частая причина, когда файлы на месте, а расширение не встаёт'
  } else {
    foreach ($f in @($ac, $cfg)) {
      if (-not (Test-Path $f)) { Bad "нет $f"; continue }
      $bytes = [System.IO.File]::ReadAllBytes($f)
      $text  = [System.Text.Encoding]::UTF8.GetString($bytes)
      Ok "$([System.IO.Path]::GetFileName($f)) на месте"
      # Первая строка обязана быть комментарием, иначе файл игнорируется молча.
      if (-not $text.StartsWith('//')) { Bad "  первая строка $f не комментарий — файл игнорируется" }
      # CRLF ломает AutoConfig без единого сообщения.
      $crlf = ([regex]::Matches($text, "`r`n")).Count
      if ($crlf -gt 0) { Bad "  в $f найдены переводы строк CRLF ($crlf) — нужен LF" }
      else { Info '  переводы строк LF' }
    }
  }
}

# ------------------------------------------------------------------- Итог
Section 'Итог'

if ($problems.Count -eq 0) {
  Write-Host '  Проблем не найдено. Если расширение всё равно не встаёт —' -ForegroundColor Green
  Write-Host '  откройте about:policies -> Errors и about:addons.' -ForegroundColor Green
} else {
  Write-Host "  Найдено проблем: $($problems.Count)" -ForegroundColor Red
  $problems | ForEach-Object { Write-Host "   - $_" -ForegroundColor Red }

  if ($problems -match 'Zone.Identifier') {
    Write-Host "`n  Снять метку скачивания? Это единственное изменение," -ForegroundColor Yellow
    Write-Host '  которое скрипт может сделать. [y/N]: ' -ForegroundColor Yellow -NoNewline
    if ((Read-Host) -eq 'y') {
      Get-ChildItem "$XpiDir\*.xpi" | Unblock-File
      Write-Host '  Метка снята. Перезапустите Firefox.' -ForegroundColor Green
    }
  }
}

Write-Host ''
