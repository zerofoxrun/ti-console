# Building TI Console — for add-on reviewers

This archive is the complete source of the submitted package. Building it
produces a **byte-identical** file: compare the SHA-256 and you are done.

## Requirements

Python 3.11 or newer. Nothing else: no npm install, no network access, no
bundler, no transpiler, no minifier.

## Build

```
python3 tools/build.py --firefox
```

Output: `dist/ti-console.xpi`.

Expected SHA-256 for version 0.62.0:

```
d274aed1c8644a08d8e0493025bc4462af38b2a23901ebb5b4d0c97bd47430f0
```

Every zip entry carries a fixed timestamp (2026-01-01 00:00:00), which is
what makes the archive reproducible. Building twice gives the same bytes.

To build the Chrome package as well: `python3 tools/build.py --chrome`.

## What is generated, and by what

Three tools in this repository take files and produce files that ship
inside the extension. This is why the submission answers "yes" to the
source-code question. Each one is idempotent: running it on an unchanged
tree reproduces the file already in `extension/` byte for byte.

### 1. `tools/build.py` — packaging

Zips `extension/` with fixed timestamps and selects the manifest
(`manifest.json` for Firefox, `manifest.chrome.json` for Chrome). It does
not transform code: the files inside the package are the files in this
repository, comments included.

### 2. `tools/locales.py` — the English dictionary

`extension/locales/en.js` is generated, not hand-written.

```
python3 tools/locales.py --проверить   # report only, writes nothing
python3 tools/locales.py               # rebuild extension/locales/en.js
```

Dictionary keys are the Russian source strings, extracted from the
extension sources; translations come from `tools/i18n/ru-en.json`. A
string with no translation is reported, never dropped silently: a missing
key degrades to readable Russian rather than to an empty interface.

### 3. `tools/pdfjs_patch.py` — the patched pdf.js

**This is the one thing in the package that will not match its upstream.**

`extension/vendor/pdfjs/` contains pdfjs-dist 6.3.289, legacy build,
Apache-2.0, with the upstream LICENSE file next to it. It is minified
upstream; nothing in this project is minified by us.

Four deliberate edits are applied to the two minified files. They remove
the `Function`-constructor and dynamic-`import` warnings that the add-on
validator reports on unmodified pdf.js. None of them changes what pdf.js
does:

| File | Replaced | With | Why |
|---|---|---|---|
| both | `Function("return this")()` | `globalThis` | core-js's last-resort global lookup. The chain starts with a `globalThis` check, so this branch is unreachable wherever `globalThis` exists. |
| `pdf.min.mjs` | `import(this.workerSrc)` | `import("./worker-shim.mjs")` | The fake-worker fallback. The literal resolves to the same file `workerSrc` always points at, so the fallback is kept rather than removed. |
| `worker-shim.mjs` | `import './pdf.worker.min.mjs'` | `export * from './pdf.worker.min.mjs'` | Needed by the line above: the fallback reads `WorkerMessageHandler` from the module it imports. |
| `pdf.worker.min.mjs` | ``await import(`${wasmUrl}${file}`)`` | a rejected promise | Loads JS fallback decoders for JPEG 2000 / JBIG2. No such files are shipped and `wasmUrl` is never set, so the import already failed into the adjacent `catch`. Same failure, clearer message. Only text extraction is used here. |

Reproduce the patched files from a clean upstream copy:

```
npm pack pdfjs-dist@6.3.289 && tar xzf pdfjs-dist-6.3.289.tgz
cp package/legacy/build/pdf.min.mjs \
   package/legacy/build/pdf.worker.min.mjs \
   package/LICENSE extension/vendor/pdfjs/
python3 tools/pdfjs_patch.py
```

The script refuses to run unless every pattern matches exactly once, so
it cannot be applied blindly to a different pdf.js version. Check the
current state without writing anything:

```
python3 tools/pdfjs_patch.py --проверить
```

`shim.mjs` and `worker-shim.mjs` are ours, not upstream: eight lines
adding `Promise.withResolvers`, which pdf.js calls and which older
Firefox lacks.

## A note on language

Code comments in this project are in Russian: it is built for a
Russian-speaking SOC team. The interface itself ships in English by
default, with a Russian option. The three build tools above carry an
English summary in their header.
