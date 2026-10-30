# Development

How to build, test and release Notebook. How to contribute is in [CONTRIBUTING.md](../CONTRIBUTING.md).

| Command | What it does |
|---|---|
| `npm run dev` | build in watch mode |
| `npm run build` | type-check, production build, check that `main.js` requires nothing but `obsidian` |
| `npm test` | vitest (unit tests) |
| `npm run lint` | eslint + `tsc --noEmit` |
| `npm run bench` | benchmarks of the pure logic (serialize, open, save check, eraser, lasso, stroke geometry, input filter) on a generated 10,000-stroke notebook; not part of `npm test` |
| `node scripts/make-stress-notebook.mjs 5000` | writes `stress.notebook` with 5000 strokes for performance tests |

## Releasing

Releases are built by the **Release** workflow (`.github/workflows/release.yml`): when a version tag is pushed it builds the plugin and attests `main.js`, `manifest.json` and `styles.css`.

Order matters: **publish the release (push the tag) before merging a manifest version bump into `main`.** The community plugin directory reads `manifest.json` at the head of `main` and complains if no release with that version exists yet.

Beta versions: on the feature branch, push a tag made of the manifest version plus a suffix (for example `0.4.0-beta.1`). The workflow publishes it as a GitHub pre-release, which BRAT can install; directory users are not affected until the version bump is merged into `main` and the `0.4.0` tag is pushed.

Rules for contributors are in [CLAUDE.md](../CLAUDE.md) (no Node/Electron modules at runtime, vector strokes only, versioned format with tested migrations, zero data loss).

## Browser harness

`npm run harness` builds and serves a browser harness of the real notebook view (with Obsidian replaced by a stub); `npm run harness:check` drives it in headless Chrome or Edge and writes screenshots to `dev/harness/dist/shots/`. Details are in [testing.md](testing.md). The repository banner, the social preview and the art band of the roadmap page are rendered there too (`dev/harness/banner.html`, screenshots in `dev/harness/dist/shots/banner/`) and copied into `docs/media/`.

## Roadmap page

`node scripts/roadmap-data.mjs` reads `docs/roadmap.md` and `CHANGELOG.md` and writes `site/roadmap.json` (and copies the header art into `site/media/`). The **Pages** workflow (`.github/workflows/pages.yml`) runs it on every push to `main` that touches the roadmap, the changelog, the script or `site/`, and publishes `site/` to GitHub Pages.
