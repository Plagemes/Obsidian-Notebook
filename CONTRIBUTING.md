# Contributing to Notebook

Thanks for helping! Notebook is a free, MIT-licensed, local-first Obsidian plugin for handwritten notes.

## Request a feature

1. Look at the [public roadmap](https://plagemes.github.io/Obsidian-Notebook/): it may already be planned, and it lists the most requested features.
2. If a request already exists, add a 👍 reaction to it. Requests are ranked by 👍.
3. Otherwise [open a feature request](https://github.com/Plagemes/Obsidian-Notebook/issues/new?template=feature_request.yml). For an idea that is still vague, start a thread in [Discussions → Ideas](https://github.com/Plagemes/Obsidian-Notebook/discussions/categories/ideas).

## Report a bug

[Open a bug report](https://github.com/Plagemes/Obsidian-Notebook/issues/new?template=bug_report.yml) with the plugin version, your device, the Obsidian version and the steps to reproduce. For pen and side-button problems, paste the log of **Notebook: Pen button test**. Reports from real Android tablets with a stylus are especially valuable: the plugin has not been verified on that hardware yet.

## Build and test

```bash
npm ci
npm run build   # type-check, production build (main.js)
npm run lint    # eslint + tsc --noEmit
npm test        # vitest
```

`npm run dev` builds in watch mode; `npm run harness:check` runs the browser harness in headless Chrome or Edge. More in [docs/development.md](docs/development.md) and [docs/testing.md](docs/testing.md).

## Rules for code

The project rules are in [CLAUDE.md](CLAUDE.md) and the visual rules in [DESIGN.md](DESIGN.md). The most important:

- no Node or Electron modules at runtime (the plugin runs in the Android WebView); files only through the vault API;
- strokes are always vector, in page coordinates;
- every change of the document format has a tested migration;
- zero data loss: never overwrite a file that cannot be read;
- no cloud, no telemetry; no GPL or AGPL code;
- every visible control works.

Keep commits small, write in English, and update `CHANGELOG.md` and `docs/` when behaviour or the format changes.
