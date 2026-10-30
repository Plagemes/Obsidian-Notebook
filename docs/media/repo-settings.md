# Repository settings

Settings to apply by hand on GitHub (they are not stored in the repository). Images in this folder are rendered by the browser harness (`npm run harness:check`, `dev/harness/banner.html`) and copied here with `npm run harness:media`.

## About (the gear next to "About" on the repository page)

**Description** (under 120 characters):

> Handwrite in Obsidian like on a real notebook: S Pen pressure, PDFs, equations, local-first. Free and open source.

**Website:** https://plagemes.github.io/Obsidian-Notebook/

**Topics** (15):

`obsidian` · `obsidian-plugin` · `obsidian-md` · `handwriting` · `handwritten-notes` · `note-taking` · `stylus` · `s-pen` · `android` · `pdf-annotation` · `digital-notebook` · `local-first` · `vector-graphics` · `study-tools` · `typescript`

Check **Releases** and uncheck **Packages** and **Deployments** under "Include in the home page" if you want a cleaner sidebar (Deployments appears once Pages is deployed).

## Social preview

Settings → General → Social preview → **Edit → Upload an image**: [`social-preview.png`](social-preview.png) (1280 × 640, the generated art with the name and tagline).

## GitHub Pages (live roadmap)

Settings → Pages → Build and deployment → **Source: GitHub Actions**. The workflow `.github/workflows/pages.yml` then publishes `site/` on every push to `main` that touches `docs/roadmap.md`, `CHANGELOG.md`, `site/`, the header art or `scripts/roadmap-data.mjs`, and can be run by hand (Actions → Pages → Run workflow).

## Feature requests

- Issues → Labels → **New label** `feature-request` (for example colour `#6D8BFF`, description "A request for a new feature"). The issue form adds it, and the roadmap page lists open issues with this label sorted by 👍.
- The bug form uses the label `bug` (it exists by default).
- Settings → General → Features → turn on **Discussions**, then create (or keep) a category **Ideas** (format "Open-ended discussion" or "Ideas"). The issue chooser links to `discussions/categories/ideas`.
