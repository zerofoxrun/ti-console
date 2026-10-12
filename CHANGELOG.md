# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are [semantic](https://semver.org/).

## [0.63.0] — 2026-10-12

Source search is no longer Russian-first when the interface is English.

### Why

In direct mode — without SearXNG — a search engine accepts only so many
`site:` operators, so the extension takes the first eight entries of the
profile. That order was written for a Russian-speaking analyst: in three
profiles out of six, more than half of those eight were Russian-language
sites. With an English interface that produced a search mostly over the
Russian-speaking web, and it produced it silently: there were results,
just not the right ones.

Appending international sources to the end of each list would not have
fixed it. They would never reach direct mode — which is what the comment
above that list has said all along.

### Added
- 43 international sources across the six profiles: vendor research
  (Akamai, ReversingLabs, DomainTools, Lab52, nao-sec, Censys, Hunt.io,
  Silent Push, VirusTotal, Yoroi), CERTs (Switzerland, New Zealand,
  Brazil, India, Korea, Singapore, Austria, Israel), vulnerabilities
  (CVE Details, OpenCVE, Vulmon, Debian, Red Hat, Ubuntu, Palo Alto),
  community (The Register, Help Net Security, Security Affairs,
  DataBreaches.net, vx-underground, Lobsters, Cybersecurity Dive),
  detection (SigmaHQ, Atomic Red Team, HijackLibs, LOTS, filesec,
  MalAPI, LOLDrivers) and paste sites.

### Changed
- Each profile now declares which of its sites are Russian-language, and
  the order depends on the interface language. The rule is asymmetric on
  purpose. For a Russian interface the order is unchanged — the core
  there is a deliberate mix, and English-language research is what a
  Russian-speaking analyst needs most. For an English interface the
  Russian-language sites move out of the core and into the tail: an
  analyst who cannot read them gains nothing from spending the eight
  slots on them. Nothing is removed from any profile, and with SearXNG,
  where there is no limit, every site is still queried.

## [0.62.1] — 2026-10-12

### Fixed
- RIPEstat opened a dead address. The entry pointed at the old Launchpad
  app (`/app/launchpad/S1_<value>`), which that site no longer serves:
  clicking the tool produced an error page, and from the analyst's side
  it looked like "RIPE has nothing on this address". The entry now points
  at `/resource/<value>#tab=overview`.
- The same entry now uses `{{ioc_raw}}` instead of `{{ioc}}`. RIPEstat
  accepts prefixes as well as addresses, and percent-encoding turned
  `1.1.1.0/24` into `1.1.1.0%2F24`, which the resource page does not
  resolve. Verified against both `1.1.1.1` and `1.1.1.0/24`.

## [0.62.0] — 2026-10-12

Fourteen more services in the registry, and one translation that would
have been lost on the next rebuild.

### Added
- 14 services, 89 -> 103 in 9 categories. Vulnerabilities: FIRST EPSS,
  OSV.dev, CVE Details. Files: Joe Sandbox Cloud, Filescan.io and CIRCL
  hashlookup (one entry per hash algorithm — the service has a separate
  endpoint for each). Phishing: OpenPhish, PhishStats, CheckPhish, and
  Google Safe Browsing site status. Ransomware: Ransomware.live and
  Ransomwhere.
- Eight of the fourteen open straight on the value; six open a section
  of the site, because those services publish no search URL that could
  be verified. An unverified template is worse than a missing tool: it
  silently opens a 404 and the analyst reads that as "nothing found".

### Fixed
- `locales/en.js` is generated from `tools/i18n/ru-en.json`, but the
  0.61.0 string "счётчик, трекер или виджет страницы" had reached the
  generated file without passing through the master. Rebuilding the
  dictionary — which `BUILD.md` tells a reviewer to do — dropped that
  translation and showed the Russian reason in the English interface,
  with no error anywhere. The pair is now in the master, and
  `tools/locales.py` reports 0 untranslated strings.

## [0.61.0] — 2026-10-10

Counters and trackers no longer appear in the indicator list.

### Why

Parsing a blog page produced seven hundred characters of a Roistat
analytics URL. Inside the base64 there is a counter id, the address of
the page being read and the visitor's cookies. The only thing that
makes it an indicator is that it is syntactically a valid URL. The
existing rules did not catch it: the host is not the source, not a
social platform, not an aggregator. Almost every page produces URLs
like that, and in the results they sit next to the real findings.

### Added
- `TELEMETRY_HOSTS` in `lib/noise.js` — 121 domains: web analytics and
  counters, browser monitoring beacons, A/B platforms, ad networks and
  pixels, captchas, cookie-consent banners, chat and call-back widgets.
  Matching is by domain and its subdomains, which is why the list holds
  `roistat.com` rather than `cllctr.roistat.com`.
- `TINoise.isTelemetryHost(host)` and `TINoise.isTelemetryUrl(url)`.
  The second one strips defanging first: in a report the address is
  written `hxxps://mc.yandex[.]ru/…`, and without that the check would
  silently fail to match.

### What the rule does not do
- **Nothing is deleted.** A match goes to the “filtered as page
  furniture” group with the reason “counter, tracker or page widget”,
  is counted, and comes back with one click — exactly like a running
  header or a link to a social network. This is not politeness: the
  Google Analytics Measurement Protocol is used for exfiltration and
  `googletagmanager` as a link in a loading chain. A counter can be an
  indicator, and it must not be made invisible.
- **Matching is by domain, not by substring.**
  `roistat.com.attacker.tld`, `fake-roistat.com` and
  `mc.yandex.ru.evil.top` are other people's hosts and stay in the main
  list. Substring matching would filter out the very trick used in
  phishing.
- **Hosts that carry payloads are not on the list** — `github.io`,
  `pages.dev`, `workers.dev`, `firebaseapp.com`, `s3.amazonaws.com`,
  `jsdelivr`, `unpkg`, link shorteners. They serve counter scripts too,
  but the cost of a mistake there is different.

### Notes for reviewers
- 31 new checks in `lib/noise.test.js`, more than half of them about
  what must NOT be filtered. The list itself is guarded too: non-empty,
  no duplicates, no overlap with the platform and aggregator lists,
  every entry a lower-case domain.
- The checks were run twice against deliberately broken code: with the
  rule disabled 7 went red, with substring matching 5 went red.

## [0.60.1] — 2026-10-09

Three Russian strings left untranslated in the English interface. They
were caught on a store screenshot, a minute before it would have gone
into the public listing.

### Fixed
- The name of a local fact (`внимание` / "caution"). The translation
  existed in the master file but never reached `locales/en.js`: the key
  comes from data, not from a literal in the code, so the extractor did
  not collect it. `tools/locales.py` now reads fact names out of the
  `факт('…', …)` calls in `lib/localfacts.js`, the same way it already
  read indicator type labels out of `TYPE_LABELS`.
- The playbook name on the card button. The key `Плейбук: {0}` was
  translated; the name substituted into it was not.
- Service names in the card chips and in the side panel. The tool tree
  on the left translated them, the card printed them raw, so the
  interface looked half-translated.

All three live in the EXPANDED indicator card and all three reach `T()`
as a variable, which is why neither the static dictionary check nor the
interface run caught them: the card opens on a click.

### Changed
- The add-on icon is now the fox, not a blue square with the letters
  "TI". It is the `idle0` frame from `newtab/fox.js`, generated from
  that file's palette and pixel matrix rather than redrawn, so it
  cannot drift from the fox on screen. The listing icon is one image
  for every locale, and Mozilla's own guidance is to avoid letters in
  it unless they are a recognisable brand.

### Notes for reviewers
- `tools/ui-audit/i18n.mjs` now expands the indicator cards and looks
  for Cyrillic inside them. Run against the code before the fix, it
  finds exactly these three strings.
- Text the analyst pasted (`.ioc-context`, `.wrap-proof-val`, indicator
  values) is excluded from that search on purpose: the card quotes its
  source, and translating a quotation would be a forgery.

## [0.60.0] — 2026-10-09

Zero warnings from the Mozilla Add-ons validator. The 0.59.0 package
reported 0 errors and 22 warnings; this one reports 0 / 0 / 0.

### Changed
- Markup is built as nodes, not strings. Thirteen `innerHTML`
  assignments and two `insertAdjacentHTML` calls are gone, replaced by
  `lib/dom.js` (`TIDom.эл`). The module deliberately has no `html`
  option. Values taken from a visited page — indicator type, parser
  flags, tool names, range labels from policy — are now set through
  `textContent` and `setAttribute`, which cannot be parsed as markup.
  `escapeHtml` / `escapeAttr` were removed with the last caller.
- The fallback timer that reveals the page if initialisation fails
  moved from an inline `<script>` in `newtab.html` to
  `newtab/fallback.js`.
- `lib/pdftext.js` loads pdf.js through a literal specifier
  (`import('../vendor/pdfjs/shim.mjs')`) instead of a string built at
  run time.
- `browser_specific_settings.gecko_android.strict_min_version` is now
  `142.0`. Desktop Firefox reads `data_collection_permissions` from
  140, Android only from 142; without a separate floor the declaration
  was not shown to users on Android 140–141.
- pdf.js is patched by `tools/pdfjs_patch.py`: the `Function`
  constructor (a dead last-resort `globalThis` lookup in core-js) and
  two dynamic `import` calls are replaced. The vendor files are still
  never edited by hand — updating pdf.js is copying two files and
  running one command, and the script refuses to run if a pattern does
  not match exactly once. Side effect: pdf.js's fake-worker fallback
  now works; previously PDF parsing failed outright when a real Worker
  could not start.

### Fixed
- Preset identifiers are no longer translated. `id: T('базовый')` meant
  the preset was stored as `basic` in English and became unknown after
  switching back to Russian, silently turning the feature set into
  "custom". The displayed name is still translated; the id is not.

### Notes for reviewers
- `lib/dom.test.js` walks the sources and fails if `innerHTML` or
  `insertAdjacentHTML` reappears anywhere in the extension.
- `tools/ui-audit/pdfjs-patched.mjs` parses a real PDF with the patched
  pdf.js under the extension's own CSP (`script-src 'self'`, no
  `unsafe-eval`), through both the worker and the fallback path, and
  compares the extracted text against a reference captured from the
  unpatched build.
- Every one of these checks was run against deliberately broken code
  and failed there before being accepted.

## [0.59.0] — 2026-10-09

English interface by default, with a language selector in the header.

### Added
- Language selector in the top-right corner: English and Russian. On a
  fresh profile the interface is English; the choice is stored in
  `storage.local` and survives a restart.
- 1536 interface strings translated: main screen, side panel, popup,
  on-page card, background notifications, report skeleton, verdict
  labels, tool tree and the settings catalogue.
- `_locales/` for the store listing name and short description.

### Changed
- Switching the language reloads the tab. Redrawing live state in another
  language would require every block to survive a change of labels
  without losing data; a reload costs a fraction of a second and cannot
  disagree with the state. The case, settings and triage queue live in
  storage and are unaffected.

### Notes for reviewers
- Enum values are not translated. Indicator types, verdicts and modes are
  compared by English keys (`malicious`, `public`); the Russian word is
  only displayed. An automated check reads the sources, collects every
  literal used in a comparison and fails if any of them is present in the
  dictionary.
- The page body is hidden until the dictionary is applied, so an English
  user never sees a flash of the source language; if the script fails,
  the page is shown as is after 1.5 s.

## Earlier versions

0.58.0 — capture from a tagged tab into the triage queue.
0.57.0 — on-page card with tool suggestions next to a highlighted value.
0.56.0 — settings: feature presets for different roles.
0.55.0 — indicators from images (OCR), PDF text layer fixes.
0.54.0 — HAR parsing; 0.53.0 — `.eml` parsing with Received path.
0.52.0 — ATT&CK matrix as a picture and as a Navigator layer.
0.50.0 — detection rule drafts: Sigma, Suricata, YARA.
0.45.0 — case, report skeleton, STIX 2.1 export.
0.40.0 — client-data mode and own/client ranges from browser policy.
