# Research — reference projects and Obsidian API

Date: 2026-10-29. Sources: README, LICENSE and key files of the repositories; `obsidian.d.ts` from the `obsidian@1.14.4` package; docs.obsidian.md. No external code was copied into the repo.

## Comparison matrix

| Repo | License | Reuse in MIT | Stylus / pressure / palm rejection | Data model and on-disk format | What we reuse |
|---|---|---|---|---|---|
| obsidianmd/obsidian-sample-plugin | 0-BSD | Yes, no restrictions | — | `manifest.json`, `main.js` (CJS), `styles.css` | **Structure and build**: esbuild (CJS, `external` obsidian/electron/codemirror/lezer/Node builtins), strict tsconfig. Adapted, not copied verbatim. |
| zsviczian/obsidian-excalidraw-plugin | AGPL-3.0 | **No** for the code (network copyleft). Only ideas rewritten from scratch. | Delegated to the Excalidraw library; the plugin only passes `penMode`. In pen mode the finger pans. No palm rejection by area/pressure. Open issues on S Pen ergonomics and resting palm. | `.excalidraw.md`: `excalidraw-plugin: parsed` frontmatter, searchable text section, scene JSON in a ```compressed-json``` block (LZ-String). Opening intercepted with `around(WorkspaceLeaf.prototype, {setViewState})` (monkey-around). `TextFileView` view, autosave 30 s mobile / 60 s desktop, cache backup with a restore prompt if the scene loads empty. | **Ideas**: save coordinator with dirty flag and flush on unload; backup and restore; hybrid `.md` format as a possible M4 evolution. **Negative lesson**: fragile workspace patching, large files indexed, history that bloats Sync (#958). |
| ellimist-afk/handwriting | CC BY-NC-ND 4.0 | **No** (forbids commercial use and derivative works) | Per-device pointer router (pen draws, touch pans/pinches, mouse off by default), pressure calibration, "palm gate", wet canvas + commit on pen-up, prediction. | JSON sidecar `.handwriting/<id>.json` per note; `.tmp` write + rename; `schemaVersion` as first field; future versions read-only; unknown fields preserved; coordinates in CSS px at zoom 1. | **Ideas only**, rewritten from scratch: read-only for future versions, preserve unknown fields, separate "wet" layer. Active (push 2026-10-28). |
| steveruizok/perfect-freehand | MIT | **Yes, as a dependency** (v1.2.3, zero dependencies) | Input `[x, y, pressure]`; `simulatePressure` (default true) for devices without pressure. | None: `getStroke(points, options) → [x, y][]` (outline polygon). | **Dependency** for stroke shape. Recomputes the whole outline on every call: fine for the live stroke (short writing strokes), for saved strokes the `Path2D` is cached. |
| saber-notes/saber | GPL-3.0 | **No** for the code. Ideas only. Flutter/Dart. | Distinguishes stylus from the rest; pressure normalized on device min/max, `null` if unavailable; no real palm rejection: after the first stylus it disables finger drawing; stylus button as a separate event. | `.sbn2` (BSON), integer version `v` (currently 19), chained `if (v < N)` migrations, newer files read-only, corrupted files shown as a placeholder. When a stroke ends, the simulated pressure is written into the points. | **Ideas**: integer version + chained migrations; read-only for future versions; write simulated pressure into the points (deterministic rendering). |
| LinwoodDev/Butterfly | AGPL-3.0 (app), Apache-2.0 (`api/`), CC-BY-SA (images/docs) | **No** for the app; `api/` compatible but in Dart, not needed. | Configurable source→action mapping (pen, inverted pen, buttons, touch); "pen only" mode; pressure modes (ignore first stroke / all / none). | `.bfly` = zip with manifest, `pages/{i}.{name}.json`, assets named by hash. `PenElement { points: PathPoint(x,y,pressure), property }`. | **Ideas**: one page per entry (useful when pages become many), assets by hash (M3), configurable input mapping (M2). |
| 1€ filter (Casiez, Roussel, Vogel, CHI 2012) | Algorithm from the paper | Yes: own implementation from the paper's description, no code copied | Adaptive low-pass for noisy pointer input: cutoff rises with speed (low jitter at rest, low lag in motion). | — | **Algorithm** in `ink/one-euro.ts` behind the "Stabilization" setting. |
| mozilla/pdf.js | Apache-2.0 | Yes (attribution/NOTICE) | — | — | **Nothing in M1.** For M3 use Obsidian's `loadPdfJs(): Promise<any>` (present in `obsidian.d.ts` 1.14.4) before considering `pdfjs-dist`. |

## Verified Obsidian APIs (`obsidian.d.ts` 1.14.4)

- `registerView(type, (leaf) => View)` and `registerExtensions(['notebook'], type)` (extensions without the dot).
- `FileView` (`file: TFile | null`, `allowNoFile`, `onLoadFile(file)`, `onUnloadFile(file)`, `getDisplayText()`, `canAcceptExtension(ext)`). `TextFileView` adds `data`, `requestSave` (2 s debounce documented, internal logic not inspectable), `save()`, `getViewData()`/`setViewData(data, clear)`; reloading on external modification is not documented in the `.d.ts`.
- `vault.create`, `vault.createFolder` (throws if it exists), `vault.read` (to be used for read-modify-write, not `cachedRead`), `vault.modify`, `vault.process(file, fn)` (atomic, synchronous `fn`, since 1.1.0), `vault.getFileByPath`/`getFolderByPath` (since 1.5.7), `normalizePath`, `vault.on('modify' | 'delete' | 'rename')`.
- `Platform.isMobile`, `Platform.isAndroidApp`; `addRibbonIcon`, `addCommand`, `PluginSettingTab`, `loadData`/`saveData`, `registerDomEvent`, `registerEvent`.
- Since 1.7.2 tabs are "deferred": `leaf.view` may not be instantiated yet.
- `workspace.on('quit')` is "best effort" and unreliable on mobile: saving cannot rely on it → flush on `visibilitychange` (hidden) and `pagehide`.
- Mobile: no Node/Electron modules (crash), regex lookbehind only on iOS ≥ 16.4, Android debugging with `chrome://inspect`.

## Consequences for M1

1. **View**: `FileView` (not `TextFileView`) to have full control over saving: serialize → re-validate → write with `vault.process`, and never write if the file was not readable. `TextFileView` would write whatever `getViewData()` returns, with internal logic that cannot be verified.
2. **Stroke shape**: perfect-freehand as the only runtime dependency (MIT).
3. **Format**: versioned JSON with a custom extension (see `docs/architecture.md`).
4. **Licenses**: no GPL/AGPL/CC-NC code copied. The ideas taken from Excalidraw, Handwriting, Saber and Butterfly were reimplemented from scratch.

## Conflicted copies made by sync clients (#122)

Date: 2026-10-29. Web search of vendor pages, university IT pages and forum reports; no code copied. Vendors document the behaviour (both versions are kept, one gets another name in the same folder) more clearly than the exact name, which varies by client, version and OS. Patterns recognised by `src/storage/conflicts.ts`:

| Client | Name of the conflicted copy | Confidence |
|---|---|---|
| OneDrive (Windows) | `Name-<COMPUTERNAME>.ext`, also with a counter (`-1`); computer names are NetBIOS-like (≤ 15 letters, digits, hyphens, not all digits) | reported consistently (e.g. University of Windsor IT, "OneDrive duplicate files"; sharepointmaven.com); not in Microsoft documentation found |
| OneDrive (macOS), Dropbox | `Name (conflicted copy).ext`, `Name (<user>'s conflicted copy <date>).ext` | Dropbox help; reports for OneDrive on macOS |
| Google Drive for desktop | `[Conflict] Name.ext` (also reported as a `[Conflict]` suffix) | third-party guides (filerev.com, addictivetips.com); not in Google documentation found |
| Google Drive (web, Android) and file managers ("keep both") | `Name (1).ext`, `Name (2).ext` | widespread; the cause may also be a plain copy |
| Autosync for Google Drive / OneDrive (MetaCtrl, Android) | a "conflict" suffix with a timestamp (MetaCtrl blog, 2015); exact format not documented | low: matched by the generic `Name (… conflict …)` / `Name_conflict…` patterns |
| FolderSync (Android) | not documented (foldersync.io "Sync issues" describes when, not how) | unknown: covered only if the name contains "conflict" or "(n)" |
| Syncthing | `Name.sync-conflict-YYYYMMDD-HHMMSS-<DEVICE>.ext` | Syncthing documentation |

Because names are only a hint (and `Name (1)` is also what a plain copy gets), a file is offered for merging only when the base file `Name.notebook` exists in the same folder and both hold the **same document id**. An unrelated notebook with a similar name has its own id and is never offered. The user's sync app (Google Drive / OneDrive on Android) should be checked on the device and the table updated (testing protocol R2).

Sources: [University of Windsor IT, "Known Issue: OneDrive duplicate files"](https://uwindsor.teamdynamix.com/TDClient/1975/Portal/KB/Article/29832/Known-Issue-OneDrive-duplicate-files), [SharePoint Maven, "How OneDrive sync resolves sync conflicts"](https://sharepointmaven.com/how-onedrive-sync-resolves-sync-conflicts/), [Digital Citizen, "Cloud sync conflicts explained"](https://www.digitalcitizen.life/cloud-sync-conflicts-explained-why-files-duplicate-or-overwrite-themselves/), [FileRev, "How to find and resolve conflicted files in Google Drive"](https://filerev.com/blog/find-resolve-conflicted-google/), [MetaCtrl, "MD5 checksum in Autosync for Google Drive"](https://metactrl.com/blog/2015/07/22/drivesync-and-md5-checksum/), [FolderSync, "Sync issues"](https://foldersync.io/docs/help/syncissues), [Obsidian forum, "FolderSync conflicts on Android (through Google Drive)"](https://forum.obsidian.md/t/foldersync-conflicts-on-android-through-google-drive/37189).
