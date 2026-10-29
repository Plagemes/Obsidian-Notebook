# Libraries — what to reuse instead of writing

Date: 2026-10-29. Companion to [research.md](research.md) (reference *projects*) and [roadmap.md](roadmap.md) (items `#n`, `On`). This file is about small *dependencies* that would save effort or raise quality for planned features. Nothing here has been added to the project yet.

## Selection criteria

A library is recommended only if **all** of these hold:

1. **Licence** compatible with MIT: MIT, BSD-2/3, ISC, Apache-2.0, Zlib, 0BSD, Unlicense, Boost; MPL-2.0 only as an unmodified dependency. No GPL/AGPL/LGPL, no "dual MIT/GPL" where the safe branch is awkward, no non-commercial or unlicensed model weights.
2. **Runs in the Obsidian desktop app and in the Android WebView**: pure JS or WebAssembly, no Node built-ins (`fs`, `stream`, `Buffer` shims), no native modules, no child processes, no remote scripts, works offline.
3. **Size** counts: the current `main.js` is 271 KB minified / 85 KB gzipped. Sizes below are **gzipped** and, where marked *(m)*, measured by bundling only the named imports with esbuild (`--minify`, browser platform, gzip -9, 2026-10-29); the others come from bundlephobia (whole package, usually an upper bound). Anything above ~50 KB gz must be lazily loaded (see Integration notes).
4. **Alive enough**: a release or commit in the last ~2 years, or so small and finished that it does not matter.
5. **Tree-shakeable / modular** (or tiny).
6. **Does not duplicate** something the platform already gives us (see "Free from the platform" below) or something already written in `src/` (shape recognition, scan detection/homography/filters, convex hull, SHA-256 are already custom code).

Effort: **S** = under a day, **M** = 1–3 days, **L** = more than 3 days (includes UI and tests, not just the import).

## Recommended

In priority order.

| # | Area | Library | Licence | Size gz | Serves items | Effort | Notes |
|---|---|---|---|---|---|---|---|
| 1 | zip, gzip, deflate | [fflate](https://github.com/101arrowz/fflate) 0.8.3 | MIT | 5.9 KB *(m)* zip+unzip, 4.5 KB gzip only | #82 portable `.zip`, #127 scheduled zip backups, #34 compressed notebooks, #83 Xournal++ `.xopp` (gzip XML), #165 annotation package, M5 NotebookLM export package, **PDF export (flate content streams: today's writer is uncompressed)**, #164 | S | Zero deps, sync and async APIs, active (May 2026). Use `zipSync`/`unzipSync`/`zlibSync` only; the async worker path is tree-shaken out. `CompressionStream` is native but cannot make zip archives and has no sync API. |
| 2 | PDF editing: embed/copy original vector pages, merge, split, rotate/crop, form filling, annotations | [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 | MIT (deps: pako MIT+Zlib, @pdf-lib/standard-fonts MIT, @pdf-lib/upng MIT, tslib 0BSD) | 175 KB *(m)*, not tree-shakeable | #47 export keeping original vector PDF pages, #153 fill forms and export filled, #154 signature/date stamps, #76 rotate/crop pages, #77 merge/split/extract, #80, #157 ink as native PDF annotations (low-level `/Ink` dict), #23 PDF copy | M | The only practical pure-JS option. Last release Nov 2021, repo last pushed Jul 2024, 318 open issues: **pin the exact version**. No encrypted PDFs (see @cantoo fork). Load lazily (dynamic `import()`). Keep our own writer for ink pages; use pdf-lib only to `embedPdf`/`copyPages` the original page and merge the ink page on top. Viewing/text/annotation *reading* stays with Obsidian's pdf.js. |
| 3 | Expression parser, units, fractions, complex, matrices, statistics | [mathjs](https://github.com/josdejong/mathjs) 15.2.0, custom build via `create()` | Apache-2.0 (deps MIT: typed-function, decimal.js, complex.js, fraction.js, seedrandom, tiny-emitter, escape-latex, javascript-natural-sort, @babel/runtime) | ~90–100 KB *(m)* custom (parse+evaluate+units+fractions+complex+matrix+common functions); 88 KB without units; 202 KB full | #113 function graphs (safe parser, never eval), #182 advanced calculator, #147 computable table, #181 values by name | M | One parser for graphs and calculator, as the roadmap asks. Compiles expressions to closures, **no `eval`/`new Function`** (checked in the bundle). Build with `create({...Dependencies})` and a locked-down instance (override `import`, `createUnit`, `reviver`, `parse`, `evaluate` inside user expressions: documented "Security" pattern). Lazy load. |
| 4 | QR code generation | [uqr](https://github.com/unjs/uqr) 0.1.3 | MIT | 4.1 KB *(m)* | #190 page QR, #58 `obsidian://` QR, #165 QR-based WebRTC pairing | S | Zero deps, returns a boolean matrix or SVG (draw it on canvas or embed in a note). Active (Apr 2026). |
| 5 | QR code scanning (camera frames) | [jsQR](https://github.com/cozmo/jsQR) 1.4.0 | Apache-2.0 | 45 KB *(m)* | #165 pairing by scanning a QR, #190, #58 | S | Pure JS, takes `ImageData`, no wasm loading problems. Last release 2021 but stable (repo pushed May 2026). Slow on dense codes (WebRTC SDP): compress the SDP with fflate before encoding. `BarcodeDetector` is not reliable in the Android WebView. Alternative below. |
| 6 | Full-text search over notebooks and PDF text | [MiniSearch](https://github.com/lucaong/minisearch) 7.2.0 | MIT | 5.7 KB *(m)* | #16 global library search, #44 search PDF text, #19/O19 companion-note search, #119 page tags filter | S | Prefix + fuzzy + field boosts, index serialises to JSON (store next to the library index). For plain title/tag suggestion lists use Obsidian's `prepareFuzzySearch` instead (free). |
| 7 | Colour utilities (contrast, lighten, mix, HSL/HSV, parse) | [colord](https://github.com/omgovich/colord) 2.10.0 | MIT | 1.9 KB *(m)* (+ a11y plugin for WCAG contrast) | #7 colour picker/recents/eyedropper, #21 paper colours with ink adapted for contrast, #101 colours with meaning, #35 pens | S | Zero deps. culori (14.8 KB) only if perceptual (OKLCH) palettes are wanted. |
| 8 | Arrows and connectors between shapes | [perfect-arrows](https://github.com/steveruizok/perfect-arrows) 0.3.7 | MIT | 2.1 KB *(m)* | M3b arrows, #69 smart connectors, #70 mind maps, #131 | S | Same author as perfect-freehand; box-to-box and point-to-point curved arrows with head angles. Last release 2021 but tiny and finished. |
| 9 | Polyline simplification | [simplify-js](https://github.com/mourner/simplify-js) 1.2.4 | BSD-2-Clause | 0.7 KB *(m)* | #66 smooth/straighten strokes, #34 smaller files, #4 scribble and #139 gesture pre-processing, #129 | S | Radial-distance + Douglas–Peucker, no deps. Inked points need a `{x,y}` adapter. |
| 10 | Calendar/ICS parsing and recurrence | [ts-ics](https://github.com/Neuvernetzung/ts-ics) 2.4.7 | MIT | 7.0 KB *(m)* | #115 class timetable import from `.ics`, #162 calendar view, #118 planner generator, #132 | S | TypeScript, `convertIcsCalendar` + `extendByRecurrenceRule` for weekly classes. Young (2023) but active (Sep 2026). Dates themselves: use Obsidian's `moment`. |
| 11 | Polygon boolean operations (union/intersection/difference/xor) | [polygon-clipping](https://github.com/mfogel/polygon-clipping) 0.15.7 | MIT (deps robust-predicates Unlicense, splaytree MIT) | 9.5 KB *(m)* | #99 area highlighter merge, #185 erase area (shape cases), #178 split infinite page, #144 solids' hidden faces, #145, #184 paint bucket regions | S | Robust (exact predicates), GeoJSON-like arrays. Last release 2023, stable. No polygon offsetting (see clipper2-js). Only add when the first of these items is built. |
| 12 | SVG path parsing and transforms | [svgpath](https://github.com/fontello/svgpath) 2.6.0 | MIT | 4.5 KB (bp) | #83 SVG import (arcs→curves, relative→absolute, matrix transforms), interactive-HTML/SVG export checks (#164) | S | Zero deps. Parse the SVG itself with `DOMParser`. |
| 13 | Implicit curves (marching squares) | [d3-contour](https://github.com/d3/d3-contour) 4.0.2 (+ d3-array) | ISC | 3.1 KB (bp) | #113 implicit curves `f(x,y)=0` and shaded regions | S | Takes a sampled grid, returns polygons: far less work than writing marching squares with correct joins. Skip the rest of d3. |
| 14 | CRDT for live collaboration | [Yjs](https://github.com/yjs/yjs) 13.6.33 (+ lib0) | MIT | 23 KB *(m)* (`Doc`, `Map`, `Array`, encode/apply update) | #165 live collaboration, #123 stroke authors, #122 (only if the conflict merge outgrows "union by stroke id") | L | Pure JS, no wasm, very active (Sep 2026). **Not needed for #122** (merge by unique stroke id is a set union; write it directly). Needed only for real-time #165, with a hand-written provider on a native `RTCPeerConnection` data channel (do **not** use y-webrtc/simple-peer, see Rejected). Plan it for M12, not before. |

### Free from the platform (use these, add nothing)

| Need | API | Serves |
|---|---|---|
| PDF text content, annotations, outline, links, rendering | `loadPdfJs()` (pdf.js `getTextContent`, `getAnnotations`, `getOutline`) | #43–46, #105, #155, #156 (annotation **import** needs no library) |
| Equation typesetting | `loadMathJax()`, `renderMath()`, `finishRenderMath()` | #110 |
| Dates | `moment` exported by `obsidian` | #115, #118, #162, #55 |
| Fuzzy / simple text matching | `prepareFuzzySearch`, `prepareSimpleSearch` | #16, O4 link suggestions |
| HTTP without CORS (Drive, OneDrive REST) | `requestUrl` | #126, #127 |
| OAuth redirect / deep links | `registerObsidianProtocolHandler` | #58, O4, #126 |
| Hashing, encryption (PBKDF2 + AES-GCM) | Web Crypto (`crypto.subtle`; already used in `src/pdf/hash.ts`) | #28, #31 |
| Raster resize, compress, crop, rotate, brightness/contrast, white→transparent | Canvas 2D / `OffscreenCanvas`, `toBlob('image/jpeg'/'image/webp')` | #171, #172, #128, #29 |
| Gzip/deflate of single blobs | `CompressionStream` / `DecompressionStream` | #34 |
| Audio capture and playback | `MediaRecorder`, `<audio>`, `AnalyserNode` | M5 audio sync |
| WebRTC transport | `RTCPeerConnection` data channels (LAN works with host candidates, no STUN) | #165 |
| XML (Xournal++, InkML, SVG, ICS-like) | `DOMParser`, `XMLSerializer` | #83, #166 |

## Alternatives / maybe later

| Area | Library | Licence | Size gz | Serves | When / why not now |
|---|---|---|---|---|---|
| PDF editing (maintained fork) | [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) 2.11.1 (Sep 2026) | MIT | 245 KB *(m)* | #47, #153, #157 | Drop-in API fork with encrypted-PDF support and ongoing fixes. Switch to it if pdf-lib 1.17.1 fails on real PDFs or if encrypted PDFs matter. Heavier (culori, fflate, node-html-better-parser deps). `@pdfme/pdf-lib` (MIT, 220 KB *(m)*) is a similar fork. |
| Expression parser (light) | [expr-eval-fork](https://github.com/jorenbroekema/expr-eval) 3.0.3 | MIT | 7.9 KB *(m)* | #113 only | 11× smaller than mathjs, fast, no units/matrices/complex. Contains one `new Function` reference (review-bot noise). Fallback if mathjs proves too heavy for graphs alone. |
| Exact numbers (if no mathjs) | fraction.js 5.3.4, complex.js 2.4.3, js-quantities 1.8.0 | MIT | 2.4 / 2.5 / 9.0 KB | #182 | Only if the calculator is built without mathjs. |
| QR scanning (dense codes) | [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) 3.1.6 (reader build) | MIT | 14 KB JS + 0.95 MB `.wasm` | #165, #190 | Much better on dense/rotated codes. The wasm cannot ride in the plugin download (only `main.js`, `manifest.json`, `styles.css` are installed) so it would be base64-embedded (+1.3 MB) or downloaded. Use if jsQR proves too slow for the WebRTC pairing code. |
| Printed-text OCR | [tesseract-wasm](https://github.com/robertknight/tesseract-wasm) 0.11.0 (BSD-2) or [tesseract.js](https://github.com/naptha/tesseract.js) 7.0.0 (Apache-2.0) | see left | 15 KB / 3.6 KB JS + 1.8 MB / 2.9 MB wasm + 2–3 MB `eng` traineddata (Apache-2.0) | M5 OCR of scanned PDFs and #29 scans → search (#44, O19) | **Printed text only**: poor on handwriting. Needs the wasm and language data downloaded on demand (opt-in, disclosed) and a Worker (test blob-URL workers on the device). tesseract-wasm is smaller and simpler; tesseract.js has more languages and a bigger community. |
| Handwriting OCR | `onnxruntime-web` 1.31.1 (MIT, 54 KB JS + 14.8 MB `.wasm`, single-thread only in WebView) + `Xenova/trocr-small-handwritten` (weights MIT, ~60 MB int8: encoder 22 MB + decoder 38 MB) | MIT | see left | M5 handwriting → text | Heavy, English line images only, IAM-trained (dataset terms: research use; check before shipping). Strictly an opt-in download behind the planned "swappable provider" interface. No bundled option exists today. |
| Equation editor | [MathLive](https://github.com/arnog/mathlive) 0.111.1 | MIT | 216 KB (bp) + fonts | #110 live-preview editor | Baseline for #110: a LaTeX text field with live preview by Obsidian's own MathJax and a palette of buttons that insert snippets (fractions, matrices, integrals…): zero dependencies. MathLive gives a WYSIWYG editor and virtual keyboard but ships its own renderer and fonts (must be inlined for offline use). Revisit if the baseline feels poor on the tablet. |
| Spatial index | [rbush](https://github.com/mourner/rbush) 4.0.1 (MIT, 2.2 KB gz) / [flatbush](https://github.com/mourner/flatbush) 4.6.2 (ISC, 2.8 KB gz) | MIT/ISC | 2–3 KB | lasso/eraser/select-by-area/#129 on pages with thousands of strokes | `src/ink/hit-test.ts` works on bounding boxes. Add only if the 10,000-stroke benchmark shows hit-testing is a bottleneck. rbush supports insert/remove; flatbush is static and faster. |
| Laser pointer trail | [@excalidraw/laser-pointer](https://github.com/excalidraw/laser-pointer) 1.3.2 | MIT | 2.0 KB | #12, #87 | Produces a tapered fading trail outline. A hand-written fading polyline is also easy: take it if the look matters. |
| Curve fitting | [fit-curve](https://github.com/soswow/fit-curve) 0.2.0 | MIT | 1.9 KB (bp) | #34 smaller ink, #66, cleaner SVG/InkML export | Schneider algorithm turns point lists into Béziers. Last release 2020. Only if file size becomes a problem after simplify-js. |
| Polygon offset | [clipper2-js](https://github.com/IRobot1/clipper2-ts) 1.2.4 | Boost-1.0 (permissive, no attribution needed in binaries) | 18.8 KB (bp) | thickening/offsetting regions (#99, #184) | Only if polygon-clipping is not enough (it has no offset). |
| Robust booleans (alt) | [martinez-polygon-clipping](https://github.com/w8r/martinez) 0.9.0 | MIT | 6.7 KB *(m)* | as #11 | Smaller and more active (Oct 2026) but has had robustness bugs on degenerate input. |
| Calendar (alt) | [ical.js](https://github.com/kewisch/ical.js) 2.2.1 | MPL-2.0 (allowed unmodified) | 22.9 KB *(m)* | #115 | Most battle-tested parser (Thunderbird). Takes MPL-2.0 file-level obligations: do not patch its files. |
| Oauth helpers | [oauth4webapi](https://github.com/panva/oauth4webapi) 3.8.8 | MIT | 14 KB (bp) | #126 | Optional: PKCE and token handling are ~50 lines on Web Crypto. For Drive/OneDrive use a thin hand-written REST client over `requestUrl` (about 4 endpoints each). |
| Real-time over the internet | [Trystero](https://github.com/dmotz/trystero) 0.26.0 | MIT | 26 KB (bp) | #165 remote guests | Serverless signalling through public Nostr/BitTorrent relays. Needs internet, so it does not replace the offline QR pairing. |
| CRDT (alt) | [loro-crdt](https://github.com/loro-dev/loro) 1.17.1 | MIT | 15 KB JS + ~1.5 MB wasm | #165 | Better history/time-travel, but wasm. Yjs is simpler to ship. |
| Waveform / audio regions | [wavesurfer.js](https://github.com/katspaugh/wavesurfer.js) 8.0.3 | BSD-3-Clause | 14.5 KB (bp) | M5 audio, #132 | Drawing recorded peaks on a canvas is ~80 lines; take it only for the regions/seek UI. |
| Text diff | [jsdiff](https://github.com/kpdecker/jsdiff) 9.0.0 | BSD-3-Clause | 1.4 KB *(m)* | #121 diff of text boxes | Ink diff is by stroke id (no library). |
| Hand-drawn shape style | [roughjs](https://github.com/rough-stuff/rough) 4.6.6 | MIT | 8.6 KB (bp) | optional sketchy shapes (M3b/#37) | Aesthetic only. |
| Worker RPC | [comlink](https://github.com/GoogleChromeLabs/comlink) 4.4.2 | Apache-2.0 | 1.9 KB | OCR/ONNX workers | Only once a worker exists. |

## Rejected

- **mupdf** — AGPL-3.0.
- **hyperformula** — GPL-3.0 (spreadsheet formulas for #147); use the mathjs parser with a cell-reference scope instead.
- **potrace (npm)** — GPL-2.0; **neo-inkml** — GPL-3.0 (InkML is plain XML: write it with `XMLSerializer`); **lamejs** — LGPL.
- **ink-on** (handwritten maths → LaTeX in the browser, 7 MB int8 model) — attractive, but 1 author, 9 stars, created Mar 2026, and the CoMER model it is based on has **no licence file** (GitHub shows none) plus unclear CROHME dataset terms. Do not bundle; re-check if upstream adds a licence.
- **scanic** (Rust/wasm document scanner, MIT, 59 KB gz) — duplicates `src/scan` (homography, edge detection, filters already custom with no dependency).
- **opencv.js / @techstark/opencv-js / jscanify** — 4.3 MB gz (26 MB min), jscanify also pulls `canvas`/`jsdom`.
- **simple-peer** — Node stream/Buffer shims, unmaintained since 2022; **peerjs** — default flow needs a signalling server; **y-webrtc** — depends on simple-peer + websocket signalling. Use native `RTCPeerConnection`.
- **automerge** — 1.6 MB gz wasm bundle; overkill.
- **googleapis / google-auth-library / gapi-script** — Node-oriented or loads remote scripts (527 KB gz, breaks offline and store rules); **@microsoft/microsoft-graph-client** — 96 KB gz for four REST calls.
- **function-plot** — 44 KB gz + d3, SVG/DOM-owned rendering and interactions would fight our canvas element, attached ink and vector export; parse with mathjs, draw ourselves.
- **KaTeX** (75 KB gz) — Obsidian already ships MathJax. **@cortex-js/compute-engine** — 1.5 MB gz.
- **pdfjs-dist** — already provided by `loadPdfJs()`; **unpdf**, **@embedpdf/engines** (PDFium wasm + fonts, ~200 KB gz JS alone) — redundant; **pdf-merger-js** — thin wrapper over pdf-lib; **pdfkit/pdfmake** — Node-centred and our writer already works.
- **jszip** — dual MIT/GPL-3.0, 28 KB gz and readable-stream shims; **@zip.js/zip.js** — 90 KB gz; **pako/uzip** — fflate covers it in less space.
- **pica, browser-image-compression, upng-js, jpeg-js, jSquash codecs** — the canvas already resizes, crops and encodes JPEG/WebP/PNG; jSquash adds per-codec wasm (only worth it for oxipng/mozjpeg size optimisation, not now).
- **moment/dayjs/date-fns** — `moment` ships with Obsidian. **Fuse.js** — MiniSearch and Obsidian's fuzzy search cover the cases. **hash-wasm** — 76 KB gz, Web Crypto covers SHA-256/PBKDF2 (revisit only for Argon2 in #28).
- **expr-eval 2.0.2** — unmaintained since 2019 with known prototype-pollution issues; use mathjs or the fork.
- **paper.js** (102 KB gz), **bezier-js** (8 KB; few needs beyond what graphs/shapes already implement), **hull.js** (we already have `convexHull` in `src/scan/geometry.ts`), **@2players/dollar1-unistroke-recognizer** (2018, wrapper): shape and gesture recognition (#4, #139) is better written in-house — the $1/$P/$Q algorithms are ~100–200 lines each, and the reference JavaScript is BSD-3-Clause, so it can be ported with attribution.
- **simple-statistics** (ISC, 0.5 KB tree-shaken) — fine, but mathjs already has the statistics functions; use it only if mathjs is dropped.
- **imagetracerjs** (Unlicense) — bitmap→vector tracing for "image to ink" is not on the roadmap; remember it if it appears.

## Integration notes

**Bundling**
- Keep one `main.js` (CJS, `external: obsidian, electron, @codemirror/*, @lezer/*`, as now). Add `mainFields: ["browser", "module", "main"]` and keep `platform: "browser"` semantics so packages resolve their browser builds; `scripts/check-bundle.mjs` already fails the build if a Node built-in is `require`d. All recommended packages were checked: none requires a Node module, none contains `eval`; only expr-eval-fork has one `new Function` (it is an alternative, not a pick).
- **Lazy loading without file splitting**: esbuild turns `await import("pdf-lib")` into a lazily initialised module inside the same file (verified: it emits `Promise.resolve().then(() => (init_x(), x_exports))`). The code is parsed at startup but only *executed* on first use. Do this for pdf-lib (175 KB gz) and mathjs (~95 KB gz); the small ones can be static imports. Parse cost of ~450 KB extra minified JS is small next to the Android WebView start-up, but measure it on the device with the performance overlay.
- Propose a size guard in `check-bundle`: warn above 600 KB minified, fail above 1.5 MB, so dependencies are a conscious decision. Expected after items 1–11: roughly 271 KB now + ~600 KB min (almost all pdf-lib and mathjs).
- **Only `main.js`, `manifest.json` and `styles.css` are installed from a release.** WebAssembly binaries and ML models therefore have to be base64-embedded (+33 %) or downloaded on first use into the plugin folder (opt-in, with the network use disclosed in the README, as Obsidian's developer policies require). None of the recommended picks needs wasm; every wasm option above is in "maybe later".
- Android WebView: no `SharedArrayBuffer` without cross-origin isolation, so no threaded wasm (ONNX Runtime must run with `numThreads = 1`); test blob-URL Web Workers on the tablet before relying on them; big PDFs held by pdf-lib live fully in memory.

**Licence attribution**
- MIT/BSD/ISC require the notice to be kept in distributions; Apache-2.0 (mathjs, jsQR, comlink) additionally requires the licence text and any upstream `NOTICE` to be kept. Use esbuild `legalComments: "eof"` (keeps `@license` banners inside `main.js`) **and** add a "Third-party licences" section to `README.md` listing each dependency, version, licence and URL (now only perfect-freehand). Create a `NOTICE` file when the first Apache-2.0 dependency lands, copying mathjs's and jsQR's licence headers.
- Transitive licences were read from the npm manifests: all MIT except pako (MIT AND Zlib), robust-predicates (Unlicense), d3-array (ISC), tslib (0BSD), @babel/runtime (MIT). Re-run a licence check (`npx license-checker --production --summary`) in CI whenever a dependency is added.
- No code was copied from any repository; ideas from the $-family papers are re-implemented, or ported with the original BSD-3 notice kept.

**Risks**
- **pdf-lib is effectively unmaintained** (last release 2021). Pin the exact version, keep our own PDF writer for the ink layer, and keep @cantoo/pdf-lib as the escape hatch (same API). Cover the integration with tests on a few real PDFs (scanned, with forms, with fonts).
- **mathjs is a large attack surface** if expressions come from notes or shared notebooks: use the restricted instance, never expose `import`/`createUnit`, cap expression length and evaluation time, and test with the published prototype-pollution payloads.
- **Young projects** among the picks: ts-ics (2023) and uqr (2023). Both are small enough to replace; pin versions.
- **Collaboration (#165)** is the largest unknown: Yjs is solid, but the transport (WebRTC over LAN via QR-exchanged SDP, the web viewer for guests) is custom work. Prototype the QR pairing with fflate + uqr + jsQR first; if SDP is too dense for a QR, split it into several frames or use a short-lived relay as an opt-in.
- **OCR/handwriting recognition**: no small, permissively licensed, offline-in-browser handwriting recogniser exists today; keep M5 behind the provider interface and treat any model as an optional download whose licence is shown to the user.
- Sizes drift with new releases; re-measure when upgrading (`esbuild --bundle --minify` on a one-line entry, then `gzip -9`).
