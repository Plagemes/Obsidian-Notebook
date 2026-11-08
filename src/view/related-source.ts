/**
 * 0.26 (#422): what the "Related handwritten pages" panel reads from Obsidian: the Markdown note in front and its metadata
 * (title, aliases, tags, headings), the library index and the thumbnails of the quick page switcher, and the timetable. Read-only.
 */
import { getAllTags, TFile, type App, type WorkspaceLeaf } from "obsidian";
import { copyPageLink, pageLinkText } from "../integration/page-share";
import { openNotebookAtPage } from "../integration/open";
import type { PageHit } from "../library/page-search";
import { aliasesOf, type RelatedNote, type RelatedRow } from "../library/related-pages";
import type { Timetable } from "../timetable/schedule";
import { showNotice } from "./notice";
import { t } from "../i18n";
import type { QuickNavService } from "./quick-switcher";
import { RELATED_VIEW_TYPE, type RelatedSource } from "./related-view";

export interface RelatedSourceDeps {
	quickNav: () => QuickNavService | null;
	timetable: () => Timetable | null;
	includeCourse: () => boolean;
}

/** The note a Markdown leaf shows, or null for any other kind of leaf (by view type, like the share code does). */
function noteOf(leaf: WorkspaceLeaf | null): TFile | null {
	const view = leaf?.view;
	if (!view || view.getViewType() !== "markdown") return null;
	const file = (view as { file?: unknown }).file;
	return file instanceof TFile ? file : null;
}

export function createRelatedSource(app: App, deps: RelatedSourceDeps): RelatedSource {
	let current: TFile | null = noteOf(app.workspace.getMostRecentLeaf()) ?? app.workspace.getLeavesOfType("markdown").map(noteOf).find((f) => f !== null) ?? null;

	const profile = (file: TFile): RelatedNote => {
		const cache = app.metadataCache.getFileCache(file);
		const fm: unknown = cache?.frontmatter;
		const aliases = aliasesOf(fm);
		return {
			path: file.path,
			title: file.basename,
			aliases,
			tags: cache ? getAllTags(cache) ?? [] : [],
			headings: (cache?.headings ?? []).map((h) => h.heading),
		};
	};
	const fileOf = (row: RelatedRow): TFile | null => app.vault.getFileByPath(row.path);

	return {
		note: () => {
			if (current && !app.vault.getFileByPath(current.path)) current = null;
			return current ? profile(current) : null;
		},
		entries: () => deps.quickNav()?.dir.index.all() ?? [],
		refresh: async () => {
			await deps.quickNav()?.dir.refresh(() => undefined);
		},
		classes: () => deps.timetable()?.entries ?? [],
		includeCourse: deps.includeCourse,
		thumb: (row, img) => {
			const hit: PageHit = { path: row.path, name: row.name, page: row.page, kind: "page", score: row.score, detail: row.detail, modified: row.modified };
			deps.quickNav()?.thumbs.request(hit, img);
		},
		open: (row) => {
			const file = fileOf(row);
			if (!file) {
				showNotice(t("quicknav.notebookGone"));
				return;
			}
			void openNotebookAtPage(app, file, row.page + 1);
		},
		copyLink: (row) => {
			const file = fileOf(row);
			if (!file) {
				showNotice(t("quicknav.notebookGone"));
				return;
			}
			void copyPageLink(app, file, row.page + 1);
		},
		dragText: (row) => {
			const file = fileOf(row);
			return file ? pageLinkText(app, file, row.page + 1, "embed") : "";
		},
		onChange: (cb) => {
			const leafRef = app.workspace.on("active-leaf-change", (leaf) => {
				const file = noteOf(leaf);
				if (file && file !== current) {
					current = file;
					cb();
				}
			});
			const metaRef = app.metadataCache.on("changed", (file) => {
				if (current && file.path === current.path) cb();
			});
			const renameRef = app.vault.on("rename", (file, old) => {
				if (current && old === current.path && file instanceof TFile) {
					current = file;
					cb();
				}
			});
			const deleteRef = app.vault.on("delete", (file) => {
				if (current && file.path === current.path) {
					current = null;
					cb();
				}
			});
			return () => {
				app.workspace.offref(leafRef);
				app.metadataCache.offref(metaRef);
				app.vault.offref(renameRef);
				app.vault.offref(deleteRef);
			};
		},
	};
}

/** Opens the panel in the right sidebar, or brings the open one forward. */
export async function openRelatedPanel(app: App): Promise<void> {
	const { workspace } = app;
	const open = workspace.getLeavesOfType(RELATED_VIEW_TYPE)[0];
	const leaf = open ?? workspace.getRightLeaf(false);
	if (!leaf) return;
	if (!open) await leaf.setViewState({ type: RELATED_VIEW_TYPE, active: true });
	await workspace.revealLeaf(leaf);
}
