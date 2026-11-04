/**
 * Smoke check of the Mentions sheet (0.18, roadmap O7) on the `doc=mentions` notebook (npm run harness:check). Notes are written
 * into the stand-in vault and the stand-in link index is filled for them, as Obsidian would: links by page number, by page id,
 * to the notebook without a page, an embed, a link to another notebook, and a link to a page that no longer exists. The check
 * drives the real view: the count badge follows the page in view, the sheet lists the notes of the page and of the notebook
 * with a line of context, a row opens its note at the line, and nothing is written. It leaves the sheet open for the screenshot.
 */
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface MentionsCheckApi {
	/** The notebook view (a `HarnessView`). */
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface Pos {
	line: number;
	col: number;
}
interface RefCache {
	link: string;
	original: string;
	position: { start: Pos; end: Pos };
}
interface AppLike {
	vault: {
		getFileByPath(p: string): { path: string } | null;
		create(p: string, data: string): Promise<unknown>;
		createFolder(p: string): Promise<unknown>;
		read(f: unknown): Promise<string>;
		on(name: string, cb: (...a: unknown[]) => void): unknown;
	};
	metadataCache: {
		resolvedLinks: Record<string, Record<string, number>>;
		caches: Map<string, unknown>;
		trigger(name: string, ...a: unknown[]): void;
	};
	workspace: { getLeaf: (...a: unknown[]) => unknown };
}

const NOTEBOOK = "Notebooks/Outline.notebook";

/** Builds a note from lines; a line that holds `[[...]]` gets a cache entry for it. */
function note(lines: string[]): { text: string; links: RefCache[]; embeds: RefCache[] } {
	const links: RefCache[] = [];
	const embeds: RefCache[] = [];
	lines.forEach((text, line) => {
		for (const m of text.matchAll(/(!?)\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/gu)) {
			const col = m.index ?? 0;
			const ref: RefCache = { link: m[2]!, original: m[0], position: { start: { line, col }, end: { line, col: col + m[0].length } } };
			(m[1] ? embeds : links).push(ref);
		}
	});
	return { text: lines.join("\n"), links, embeds };
}

export async function checkMentions(api: MentionsCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as HarnessView & { app: AppLike; openMentions(): void };
	const app = v.app;
	const results: CheckResult[] = [];
	const add = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
	const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	const pages = v.document.pages;
	const idOf = (i: number): string => pages[i]!.id;
	add("the notebook has pages to link to", pages.length >= 3, `${pages.length} pages`);

	const files: Record<string, string[]> = {
		"Notes/Lecture notes.md": ["# Lecture", "", `Summary of the derivation: see [[Outline.notebook#p2&id=${idOf(1)}|page two]] for the proof, and the long sentence that follows it goes on and on so that the context has to be cut around the link by the sheet.`, "Also [[Other.notebook#p1]] is unrelated."],
		"Notes/Exam.md": ["Revise [[Outline.notebook#p2]] before the exam.", `And the figure: ![[Outline.notebook#p1&id=${idOf(0)}]]`],
		"Notes/Index.md": ["The whole notebook: [[Outline.notebook]]"],
		"Projects/Old links.md": [`A page that was deleted: [[Outline.notebook#p9&id=pg-gone0000]]`],
	};
	await app.vault.createFolder("Notes").catch(() => undefined);
	await app.vault.createFolder("Projects").catch(() => undefined);
	const written: Record<string, string> = {};
	app.metadataCache.resolvedLinks = {};
	for (const [path, lines] of Object.entries(files)) {
		const n = note(lines);
		await app.vault.create(path, n.text);
		written[path] = n.text;
		app.metadataCache.caches.set(path, { links: n.links, embeds: n.embeds });
		app.metadataCache.resolvedLinks[path] = { [NOTEBOOK]: n.links.length + n.embeds.length };
	}
	app.metadataCache.trigger("resolved");

	const badge = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>(".nb-mentions-badge");
	const showPage = async (i: number): Promise<void> => {
		v.jumpToPage(i);
		await frames(4);
		await sleep(750); // the index is re-read after a short delay
	};

	await showPage(0);
	add("the badge counts the links to the first page (the embed)", badge()?.classList.contains("is-visible") === true && badge()?.querySelector(".nb-mentions-badge-count")?.textContent === "1", `${badge()?.className} / ${badge()?.textContent}`);
	await showPage(1);
	add("the badge counts the links to the second page (by id and by number)", badge()?.classList.contains("is-visible") === true && badge()?.querySelector(".nb-mentions-badge-count")?.textContent === "2", `${badge()?.className} / ${badge()?.textContent}`);
	await showPage(2);
	add("a page nobody links to shows no badge", badge()?.classList.contains("is-visible") !== true, badge()?.className ?? "none");
	await showPage(1);

	// The sheet.
	v.openMentions();
	await frames(3);
	await sleep(300);
	let modal = document.querySelector<HTMLElement>(".notebook-mentions-modal");
	if (modal && !modal.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(modal.closest(".modal") ?? modal);
	await frames(2);
	modal = document.querySelector<HTMLElement>(".notebook-mentions-modal");
	add("the sheet opens", modal !== null);
	const groups = [...(modal?.querySelectorAll<HTMLElement>(".nb-mentions-group") ?? [])];
	add("it has a group for the page and a group for the notebook", groups.length === 3 || groups.length === 2, `${groups.length} groups`);
	const rows = (g: HTMLElement | undefined) => [...(g?.querySelectorAll<HTMLElement>(".nb-mentions-row") ?? [])];
	const pageRows = rows(groups[0]);
	const names = pageRows.map((r) => r.querySelector(".nb-mentions-name")?.textContent);
	add("page two is linked from Exam and Lecture notes, by name", names.join(",") === "Exam,Lecture notes", names.join(","));
	add("each row shows its folder", pageRows.every((r) => r.querySelector(".nb-mentions-folder")?.textContent === "Notes"), "");
	const snippets = pageRows.map((r) => r.querySelector(".nb-mentions-snippet")?.textContent ?? "");
	add("each row shows a line of context", snippets[0]!.includes("Revise") && snippets[1]!.includes("[[Outline.notebook#p2&id="), snippets.join(" | ").slice(0, 200));
	add("a long line is cut around the link", snippets[1]!.length < 170 && snippets[1]!.includes("…"), `${snippets[1]!.length} chars`);
	const rest = rows(groups[groups.length - 1]).map((r) => r.querySelector(".nb-mentions-name")?.textContent);
	add("the second group lists the notes linking without a page, and a link to a deleted page", rest.join(",") === "Index,Old links", rest.join(","));
	add("other notebooks' links are not listed", !(modal?.textContent ?? "").includes("Other.notebook"), "");

	// Opening a row.
	const opened: Array<{ path: string; line: number | undefined }> = [];
	const realGetLeaf = app.workspace.getLeaf;
	app.workspace.getLeaf = () => ({ openFile: async (f: { path: string }, s?: { eState?: { line?: number } }) => void opened.push({ path: f.path, line: s?.eState?.line }) });
	pageRows[1]?.click();
	await frames(3);
	await sleep(100);
	app.workspace.getLeaf = realGetLeaf;
	add("a row opens its note at the line of the link", opened.length === 1 && opened[0]!.path === "Notes/Lecture notes.md" && opened[0]!.line === 2, JSON.stringify(opened));
	add("the sheet closes after opening", document.querySelector(".notebook-mentions-modal") === null);

	// Read only: nothing was written.
	let same = true;
	for (const [path, text] of Object.entries(written)) same = same && (await app.vault.read(app.vault.getFileByPath(path))) === text;
	add("no note was changed", same);

	// A page with nothing linked says so; the sheet is left open for the screenshot.
	await showPage(2);
	v.openMentions();
	await frames(3);
	await sleep(300);
	const open = document.querySelector<HTMLElement>(".notebook-mentions-modal");
	if (open && !open.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(open.closest(".modal") ?? open);
	await frames(2);
	add("a page without mentions says so", (document.querySelector(".notebook-mentions-modal")?.textContent ?? "").includes("No note links to this page."), "");
	await showPage(1);
	document.querySelector<HTMLElement>(".notebook-mentions-modal .nb-modal-close")?.click();
	await frames(2);
	v.openMentions();
	await frames(3);
	await sleep(300);
	const again = document.querySelector<HTMLElement>(".notebook-mentions-modal");
	if (again && !again.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(again.closest(".modal") ?? again);
	await frames(2);

	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: {} };
}
