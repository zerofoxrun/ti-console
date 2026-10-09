# Contributing

## What is most useful

**Parser misses and false positives.** The extraction rules are the part
of the product that is wrong most often and most visibly. If a report
contains an indicator the extension did not find, or it turned
`report.pdf` into a domain, that is a good issue. Attach the fragment —
**with synthetic values**, see below.

**Tool registry corrections.** A service that changed its URL format,
went paid, disappeared, or whose exposure tag is wrong (`public` vs
`limited`) — that tag decides whether the tool is offered in client-data
mode, so getting it wrong has consequences.

**Translations.** The interface ships in English and Russian. Strings
live in `extension/locales/en.js`, keyed by the original Russian text.

## Never put real data in an issue

No real indicators, no client names, no fragments of actual reports.
Use RFC 5737 addresses (`203.0.113.0/24`, `198.51.100.0/24`,
`192.0.2.0/24`), domains under `example.com`, and invented hashes. An
issue containing a real client indicator will be edited or deleted.

## Code

The extension has no build step: the files under `extension/` are what
runs in the browser. Load it unpacked (see the README), edit, reload.

Two rules that are not negotiable, because the whole design rests on
them:

1. **No network request to a host the user did not choose.** Not for
   analytics, not for update checks, not for fonts.
2. **No remote code and no `eval`.** The extension runs under an MV3
   content security policy that forbids both; code that depends on them
   silently does nothing in Firefox.

If a change touches client-data mode, own ranges, or the exposure tag of
a tool, say in the pull request what you checked and how. Those three are
what keeps a client's indicator from being published by accident.

## Style

Keep the existing style of the file you are editing. Comments explain
*why*, not *what* — the code already says what it does.
