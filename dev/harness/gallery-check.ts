/**
 * 0.26 gallery (#421): the `notebook-gallery` block of a Markdown note on the `doc=gallery` scenario (npm run harness:check).
 * Checked: a query shows its pages as a grid with notebook name and page number and real thumbnails from the shared page thumbnail
 * cache; a tap opens the notebook at that page (id first); a bad query shows one readable line and no grid; a query without a match
 * shows a quiet empty state; the grid is rebuilt when the indexed notebooks change; the grid fits the width; rendering writes nothing
 * to the vault; the builder produces the block it shows. The cards are left on screen for the screenshot.
 */
import { GalleryBuilderModal } from "../../src/integration/gallery-builder";
import { registerGallery } from "../../src/integration/gallery-render";
import { notebookPagesOf, type GalleryContext } from "../../src/integration/gallery-query";
import type { GalleryData } from "../../src/integration/gallery-service";
import type { LibraryEntry } from "../../src/library/index";
import { PageThumbs } from "../../src/library/page-thumbs";
import { createDocument, createStroke } from "../../src/model/document";
import { createMarker } from "../../src/model/markers";
import type { NotebookDocument } from "../../src/model/types";
import { App } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

export interface GalleryCheckApi {
	errors: string[];
	notices: string[];
}

type Processor = (source: string, el: HTMLElement, ctx: unknown) => void;

const COLORS = ["#1d4ed8", "#b91c1c", "#047857", "#7c3aed"];

/** A notebook of `pages` pages, each with a few wavy lines; `tags`/`markers` map a page index to what it carries. */
function notebook(seed: number, pages: number, tags: Record<number, string[]> = {}, markers: Record<number, "question" | "homework" | "gap"> = {}): NotebookDocument {
	const doc = createDocument(new Date(2026, 10, 1 + seed));
	while (doc.pages.length < pages) doc.pages.push({ ...doc.pages[0]!, id: `p${seed}-${doc.pages.length}`, strokes: [], elements: [] });
	doc.pages.forEach((page, p) => {
		page.id = `p${seed}-${p}`;
		for (let l = 0; l < 6; l++) {
			const pts: Array<[number, number, number]> = [];
			for (let i = 0; i < 40; i++) pts.push([70 + i * 12, 120 + l * 90 + Math.sin(i / 3 + p * 1.7 + seed * 2.3) * (10 + l + p * 4), 0.5]);
			page.strokes.push(createStroke(COLORS[(seed * 3 + p * 2 + l) % COLORS.length]!, 3, pts));
		}
		if (tags[p]) page.tags = tags[p];
		if (markers[p]) page.elements = [createMarker(markers[p], 480, 90)];
	});
	return doc;
}

export async function checkGallery(api: GalleryCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const app = new App();

	const docs: Record<string, NotebookDocument> = {
		"Notebooks/Analysis.notebook": notebook(1, 6, { 1: ["exam"], 3: ["exam", "ch2"] }, { 2: "question", 4: "homework" }),
		"Notebooks/Physics.notebook": notebook(2, 5, { 0: ["exam"], 4: ["lab"] }, { 1: "question" }),
		"Notebooks/Law.notebook": notebook(3, 4, { 2: ["exam"] }),
		"Notebooks/Sketches.notebook": notebook(4, 3),
	};
	const mtimes: Record<string, number> = {};
	let n = 0;
	const entries: LibraryEntry[] = [];
	for (const [path, doc] of Object.entries(docs)) {
		await app.vault.create(path, `{"harness":"${path}"}`);
		mtimes[path] = ++n;
		entries.push({
			path, folder: "Notebooks", name: path.replace(/^.*\//, "").replace(/\.notebook$/, ""), mtime: 1, size: 1, created: n, modified: 100 - n * 10,
			pages: doc.pages.length, tags: [], favorite: false, cover: "#4f46e5",
			pageTags: doc.pages.flatMap((p, i) => (p.tags ? [{ page: i, tags: p.tags }] : [])),
			bookmarks: path.includes("Physics") ? [{ page: 2, title: "Lens law" }] : [],
		});
	}
	const before = JSON.stringify(await Promise.all(app.vault.getFiles().map(async (f) => [f.path, await app.vault.read(f)])));

	let current = entries.slice();
	const listeners = new Set<() => void>();
	const ctx: GalleryContext = {
		courseOf: (p) => (p.includes("Analysis") ? ["Analysis"] : p.includes("Physics") ? ["Physics"] : []),
		globalBookmarks: (p) => (p.includes("Law") ? [{ pageId: docs[p]!.pages[1]!.id, num: 2 }] : []),
	};
	let reads = 0;
	const data: GalleryData = {
		entries: async () => current,
		context: () => ctx,
		pagesOf: async (e) => {
			reads++;
			const doc = docs[e.path];
			return doc ? notebookPagesOf({ pages: doc.pages, bookmarks: doc.meta?.bookmarks }, ctx.globalBookmarks(e.path).map((g) => g.pageId)) : null;
		},
		courses: () => ["Analysis", "Physics"],
		tags: async () => ["exam", "lab", "ch2"],
		onChange: (fn) => {
			listeners.add(fn);
			return () => void listeners.delete(fn);
		},
	};
	let thumbDraws = 0;
	let closed = false;
	const thumbs = new PageThumbs({
		fileOf: (path) => app.vault.getFileByPath(path) as never,
		readNotebook: async (file) => {
			thumbDraws++;
			return docs[file.path] ?? null;
		},
		idle: () => Promise.resolve(),
		isClosed: () => closed,
	}, (path) => mtimes[path] ?? 0);
	const opened: Array<{ path: string; page: number; pageId?: string }> = [];
	let processor: Processor | null = null;
	const plugin = { registerMarkdownCodeBlockProcessor: (_lang: string, fn: Processor) => void (processor = fn) };
	registerGallery(plugin as never, { app: app as never, data, thumbs, open: (file, page, pageId) => void opened.push({ path: file.path, page, pageId }) });
	add("the block language is registered", processor !== null);

	const host = (document.getElementById("harness-app") ?? document.body).createDiv({ cls: "markdown-rendered nb-gallery-host" });
	host.setCssProps({ padding: "12px", maxWidth: "760px" });
	const mount = (source: string) => {
		const el = host.createDiv();

		const sink = { sourcePath: "Study.md", addChild: (c: { load(): void }) => c.load() };
		processor!(source, el, sink);
		return el;
	};
	const tiles = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>(".nb-gallery-tile"));

	// A tag query: pages tagged exam, newest notebook first.
	const exam = mount("tag: #exam\nlimit: 8");
	await sleep(150);
	add("a tag query shows its pages", tiles(exam).length === 4, String(tiles(exam).length));
	const names = tiles(exam).map((t) => `${t.querySelector(".nb-gallery-name")?.textContent}|${t.querySelector(".nb-gallery-page")?.textContent}`);
	add("each tile names its notebook and page, newest notebook first", names.join(",") === "Analysis|p. 2,Analysis|p. 4,Physics|p. 1,Law|p. 3", names.join(","));
	for (let i = 0; i < 40 && exam.querySelectorAll(".nb-gallery-thumb img").length < 4; i++) await sleep(60);
	const imgs = Array.from(exam.querySelectorAll<HTMLImageElement>(".nb-gallery-thumb img"));
	add("every tile has a thumbnail", imgs.length === 4 && imgs.every((i) => i.src.startsWith("data:image")), String(imgs.length));
	add("the thumbnails show the page asked for (distinct images)", new Set(imgs.map((i) => i.src)).size === imgs.length);
	const head = exam.querySelector(".nb-gallery-head")?.textContent ?? "";
	add("the header says how many and what", head.includes("4") && head.includes("#exam"), head);

	// Layout.
	const root = exam.querySelector<HTMLElement>(".nb-gallery");
	const box = root?.getBoundingClientRect();
	add("the gallery fits the width", !!box && box.left >= 0 && box.right <= window.innerWidth + 1, box ? `${Math.round(box.left)}..${Math.round(box.right)} of ${window.innerWidth}` : "none");
	const cards = Array.from(exam.querySelectorAll<HTMLElement>(".nb-gallery-card"));
	add("a tile is a real button, at least 44 px tall", cards.length > 0 && cards.every((c) => c.tagName === "BUTTON" && c.getBoundingClientRect().height >= 44));
	const widths = new Set(cards.map((c) => Math.round(c.getBoundingClientRect().width)));
	add("the grid is responsive (columns share the width)", cards.every((c) => c.getBoundingClientRect().right <= (box?.right ?? 0) + 1) && widths.size <= 2, [...widths].join(","));

	// Tap opens the notebook at that page, by id.
	cards[1]?.click();
	add("a tap opens the notebook at the page", opened.length === 1 && opened[0]!.path === "Notebooks/Analysis.notebook" && opened[0]!.page === 4 && opened[0]!.pageId === undefined, JSON.stringify(opened));

	// Markers need the pages themselves.
	reads = 0;
	const marked = mount("marked: question|homework\nsort: title");
	await sleep(200);
	const mk = tiles(marked).map((t) => `${t.querySelector(".nb-gallery-name")?.textContent}${t.querySelector(".nb-gallery-page")?.textContent}`);
	add("marked: finds the pages with those markers", mk.join(",") === "Analysisp. 3,Analysisp. 5,Physicsp. 2", mk.join(","));
	const idTile = marked.querySelectorAll<HTMLElement>(".nb-gallery-card")[0]!;
	idTile.click();
	add("those taps carry the page id", opened[1]?.pageId === "p1-2", JSON.stringify(opened[1]));
	add("notebooks are read for it", reads > 0);

	// Bookmarks (the notebook's own and a global one) and courses.
	const bm = mount("bookmarked");
	await sleep(150);
	const bmNames = tiles(bm).map((t) => `${t.querySelector(".nb-gallery-name")?.textContent}${t.querySelector(".nb-gallery-page")?.textContent}`);
	add("bookmarked: own and global bookmarks", bmNames.join(",") === "Physicsp. 3,Lawp. 2", bmNames.join(","));
	const course = mount("course: Physics");
	await sleep(150);
	add("course: one notebook, its first page", tiles(course).length === 1 && tiles(course)[0]!.textContent.includes("Physics"));
	const one = mount("notebook: Notebooks/Sketches\nlimit: 2");
	await sleep(150);
	add("notebook: its pages in order", tiles(one).map((t) => t.querySelector(".nb-gallery-page")?.textContent).join(",") === "p. 1,p. 2");

	// A bad query and an empty one.
	const bad = mount("colour: red");
	const badText = bad.querySelector(".nb-gallery-error")?.textContent ?? "";
	add("a bad query shows one readable line and no grid", badText.includes("colour") && badText.length > 20 && tiles(bad).length === 0, badText);
	add("the error line is an alert", bad.querySelector(".nb-gallery-error")?.getAttribute("role") === "alert");
	const badValue = mount("limit: lots");
	add("a bad value is named", (badValue.textContent ?? "").includes("limit: lots"), badValue.textContent ?? "");
	const empty = mount("tag: #nothing-here");
	await sleep(150);
	add("no match shows a quiet empty state", tiles(empty).length === 0 && !!empty.querySelector(".nb-gallery-empty-title") && !empty.querySelector(".nb-gallery-error"), empty.textContent ?? "");

	// The indexed notebooks change: the open blocks are rebuilt.
	const before2 = tiles(empty).length;
	current = [...current, {
		path: "Notebooks/Extra.notebook", folder: "Notebooks", name: "Extra", mtime: 1, size: 1, created: 9, modified: 500, pages: 2, tags: [], favorite: false, cover: "#4f46e5",
		pageTags: [{ page: 1, tags: ["nothing-here"] }],
	}];
	docs["Notebooks/Extra.notebook"] = notebook(5, 2, { 1: ["nothing-here"] });
	await app.vault.create("Notebooks/Extra.notebook", "{}");
	for (const fn of listeners) fn();
	await sleep(250);
	add("a change of the notebooks rebuilds the open blocks", before2 === 0 && tiles(empty).length === 1, String(tiles(empty).length));

	// Nothing was written.
	const after = JSON.stringify(await Promise.all(app.vault.getFiles().filter((f) => f.path !== "Notebooks/Extra.notebook").map(async (f) => [f.path, await app.vault.read(f)])));
	add("rendering writes nothing to the vault", after === before);

	// The builder.
	const inserted: string[] = [];
	const modal = new GalleryBuilderModal(app as never, data, (block) => void inserted.push(block));
	modal.open();
	await sleep(60);
	const q = <T extends HTMLElement>(sel: string) => modal.modalEl.querySelector<T>(sel);
	const tag = q<HTMLInputElement>("[data-key=gal-tag]");
	const kind = q<HTMLSelectElement>("[data-key=gal-kind]");
	const courseSel = q<HTMLSelectElement>("[data-key=gal-course]");
	const limit = q<HTMLSelectElement>("[data-key=gal-limit]");
	add("the builder offers tag, course, marker, bookmark, count and order", !!tag && !!kind && !!courseSel && !!limit && !!q("[data-key=gal-sort]") && !!modal.modalEl.querySelector("input[type=checkbox]"));
	add("the tag field suggests the tags in use", modal.modalEl.querySelectorAll("datalist option").length === 3);
	if (tag && kind && courseSel && limit) {
		tag.value = "#exam";
		tag.dispatchEvent(new Event("input"));
		kind.value = "question";
		kind.dispatchEvent(new Event("change"));
		courseSel.value = "Analysis";
		courseSel.dispatchEvent(new Event("change"));
		limit.value = "6";
		limit.dispatchEvent(new Event("change"));
	}
	const preview = q("pre")?.textContent ?? "";
	add("the preview shows the block", preview === "```notebook-gallery\ntag: #exam\ncourse: Analysis\nmarked: question\nlimit: 6\n```", preview);
	const insert = Array.from(modal.modalEl.querySelectorAll<HTMLButtonElement>("button")).find((b) => (b.textContent ?? "").includes("Insert") && b.className.includes("primary"));
	insert?.click();
	add("Insert hands the block to the editor", inserted.length === 1 && inserted[0] === preview, inserted.join("|"));
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio, thumbDraws } };
}
