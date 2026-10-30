# Repository settings (for the maintainer)

These settings live on GitHub, not in the repository. Do them once.

## About box (repository home, gear icon)

- **Description** (114 characters):
  `Handwritten notes and PDF annotation for Obsidian, built for stylus and Android tablets. Local-first, open source.`
- **Website:** https://plagemes.github.io/Obsidian-Notebook/
- **Topics** (14):
  `obsidian`, `obsidian-plugin`, `obsidian-md`, `handwriting`, `handwritten-notes`, `stylus`, `s-pen`, `note-taking`, `android`, `tablet`, `pdf-annotation`, `digital-ink`, `local-first`, `typescript`

## Labels (Issues, Labels)

| Name | Colour | Description |
|---|---|---|
| `feature-request` | `#a2eeef` | A new feature or improvement |
| `bug` | `#d73a4a` | Something does not work |
| `design` | `#7057ff` | UI, UX and visual design |
| `s-pen` | `#0e8a16` | Stylus and S Pen specifics |
| `good first issue` | `#008672` | Good for newcomers |

## Pages (Settings, Pages)

1. Open Settings, then Pages.
2. Under **Build and deployment, Source**, choose **GitHub Actions**.
3. Run the Pages workflow in `.github/workflows` (or push to `main`). The site appears at https://plagemes.github.io/Obsidian-Notebook/.

## Discussions (Settings, General, Features)

1. Tick **Discussions**.
2. Open the Discussions tab, then the pencil icon next to Categories.
3. Make sure a category named **Ideas** exists (format: open-ended discussion). The issue chooser links to `/discussions/categories/ideas`.

## Private vulnerability reporting

Settings, Code security: enable **Private vulnerability reporting** (used by `SECURITY.md`).

## Social preview

Settings, General, **Social preview**, Upload an image: `docs/media/social-preview.png` (1280 x 640 px).
