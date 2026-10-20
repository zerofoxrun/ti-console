# TI Console — Privacy Policy

Updated: October 2026 · Extension version: 1.1.0

## In short

TI Console does not collect, store remotely, or pass to anyone any data
about you or about your work.

## What stays in the browser

All of it. The text you paste, the indicators found, the case, notes,
verdicts, timeline and settings are kept in your browser profile
(`browser.storage.local`) and are available only to you. Resetting the
profile or removing the extension destroys that data irreversibly.

The extension has no server of its own, no accounts, no synchronisation
between users and no usage statistics.

## What network requests the extension makes

Exactly three kinds, and all three happen on your explicit action:

1. **Opening an analysis service you selected**, in a new tab. This is an
   ordinary browser navigation: the service sees what it would see if you
   had typed its address yourself.

2. **"Pull text from link"** — fetching a page at an address you typed in.
   The request comes from your address; the infrastructure you are
   investigating sees it. The interface says so next to the input field.

3. **Downloading the LOLBAS and GTFOBins references** when you press
   "Load". One static file is fetched from the rights holder's site. The
   request contains nothing from your work — no indicator, no page
   address, no case — only the name of the reference file. It happens
   once; afterwards the reference lives in your browser profile and is
   read from disk. "Forget" deletes it and revokes the permission.

Nothing else is sent: not indicators, not page contents, not the context
of your investigation — neither automatically nor on a button. The
difference between point 3 and "enrichment" is the point of the design:
enrichment sends out what you are investigating, whereas here nothing
leaves — the file travels towards you.

## Permissions

Access to websites (`<all_urls>`) is **not** requested at install time.
It is requested at the moment you press "Parse page" or "Pull text from
link", and you may refuse.

Permission for the three reference hosts (`lolbas-project.github.io`,
`gtfobins.github.io`, `gtfobins.org`) is requested separately — when you
press "Load" — and is revoked by "Forget". It is independent of the one
above: you can load the references without ever granting access to all
sites.

Each permission is explained in `extension/manifest.json`, next to the
permission itself.

## Third-party services

The extension contains a list of public analysis services and opens them
at your choice. What those services do with your query is governed by
their own policies; the extension passes them nothing beyond what you
opened yourself.

If your SOC distributes a list of own and client ranges through browser
policy (`ownRanges`, `ownDomains`), values inside those ranges are
flagged in the results and are never sent to public services: bulk open
skips them, your check list skips them, and opening a single one asks
for explicit confirmation. The list itself is never transmitted: it is read
from browser policy and used only for comparison on your machine.

## Changes

Changes to this policy are published in this file in the repository,
together with a change of the extension version.
