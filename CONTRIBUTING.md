# Contributing to Notebook

Thanks for helping! Notebook is a free, MIT-licensed, local-first Obsidian plugin for handwritten notes. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Request a feature

1. Look at the [public roadmap](https://plagemes.github.io/Obsidian-Notebook/): your idea may already be planned, and the most requested features are listed there.
2. If a request already exists, add a 👍 reaction to it instead of a "+1" comment. Requests are ranked by 👍.
3. Otherwise [open a feature request](https://github.com/Plagemes/Obsidian-Notebook/issues/new?template=feature_request.yml): one feature per request, with the problem you want to solve.
4. For an idea that is still vague, start a thread in [Discussions → Ideas](https://github.com/Plagemes/Obsidian-Notebook/discussions/categories/ideas).

## Report a bug

[Open a bug report](https://github.com/Plagemes/Obsidian-Notebook/issues/new?template=bug_report.yml) with the plugin version, Obsidian version, device, stylus and steps to reproduce. For pen and side-button problems, paste the log of **Notebook: Pen button test**. Never attach private notes. Reports from real Android tablets with a stylus are especially valuable: the plugin has not been verified on that hardware yet. Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

## Develop

```bash
npm ci                 # install exactly what package-lock.json says
npm run dev            # build in watch mode
npm run build          # production build (main.js)
npm test               # vitest on the pure logic
npm run lint           # eslint (Obsidian Scorecard rules) + tsc --noEmit
npm run harness:check  # browser harness in headless Chrome or Edge
```

A change is done when build, lint and tests pass. More in [docs/development.md](docs/development.md) and [docs/testing.md](docs/testing.md).

## Project rules, in brief

The full rules are in [CLAUDE.md](CLAUDE.md), the visual rules in [DESIGN.md](DESIGN.md) and the structure in [docs/architecture.md](docs/architecture.md).

- Strokes are always vector, in page coordinates, never raster only.
- Zero data loss: never overwrite a file that cannot be read.
- No Node or Electron modules at runtime (the plugin runs in the Android WebView); files only through the vault API.
- Every document format change has a tested migration.
- Every visible string exists in English and Italian (i18n).
- No cloud, no telemetry, no GPL or AGPL code; check the licence of anything you adapt.
- Every visible control works.

Keep commits small, write code, comments and docs in English, and update `CHANGELOG.md` and `docs/` when behaviour or the format changes.

## Licence

By contributing you agree that your work is released under the [MIT licence](LICENSE).
