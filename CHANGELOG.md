# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are [semantic](https://semver.org/).

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
