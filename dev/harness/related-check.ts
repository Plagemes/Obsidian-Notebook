/**
 * Smoke check of the "Related handwritten pages" panel (0.26, roadmap #422; `HARNESS_DOC=related npm run harness:check`): the real
 * RelatedView on a stand-in source (library entries for four notebooks, a timetable course). Checks that the rows are ranked with
 * their reasons, that a tap opens the page, the link button copies, a drag carries the embed, the panel follows a change of note
 * after the debounce, and the two empty states. The panel is left open with results for the screenshot; `relatedShot("empty")`
 * switches to the empty state for the second one.
 */
import { WorkspaceLeaf, type App } from "./obsidian-stub";
import type { WorkspaceLeaf as ObsidianLeaf } from "obsidian";
import type { LibraryEntry } from "../../src/library/index";
import type { RelatedNote, RelatedRow } from "../../src/library/related-pages";
import { RelatedView, RELATED_DEBOUNCE_MS, type RelatedSource } from "../../src/view/related-view";
import type { ClassEntry } from "../../src/timetable/schedule";
import type { CheckResult } from "./reading-check";

export interface RelatedCheckApi {
	app: App;
	errors: string[];
	notices: string[];
}

const frames = (n = 2) => new Promise<void>((resolve) => {
	let left = n;
	const step = () => (--left <= 0 ? resolve() : window.requestAnimationFrame(step));
	window.requestAnimationFrame(step);
});
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function entry(name: string, folder: string, pageTexts: Array<string | null>, extra: Partial<LibraryEntry> = {}): LibraryEntry {
	let text = "";
	const textPages: number[] = [];
	pageTexts.forEach((p, i) => {
		if (p === null) return;
		textPages.push(i, text.length);
		text += p + " ";
	});
	return {
		path: `${folder}/${name}.notebook`, folder, name, mtime: 1, size: 1, created: 1, modified: 1000 - name.length, pages: pageTexts.length,
		...(text ? { text, textPages } : {}), tags: [], favorite: false, cover: "#6d8bff", ...extra,
	};
}

const NOTE: RelatedNote = { path: "Notes/Optics.md", title: "Optics", aliases: ["Light theory"], tags: ["#physics/optics"], headings: ["Snell law", "Lenses"] };
const OTHER: RelatedNote = { path: "Notes/Gardening.md", title: "Gardening", aliases: [], tags: [], headings: [] };

const ENTRIES: LibraryEntry[] = [
	entry("Physics lectures", "Notebooks/Physics", ["Week 1", "See [[Optics]] for the ray model", "Snell law: n1 sin a = n2 sin b", "Lenses and mirrors", null, "Notes on light theory"], { pageTags: [{ page: 4, tags: ["physics"] }] }),
	entry("Lab book", "Notebooks/Physics", ["Setup", "Measured the refraction of optics glass", "[[Optics#Lenses|the lens]] result"]),
	entry("Optics", "Notebooks/Loose", ["Sketch of a telescope"]),
	entry("Waves", "Notebooks/Physics", ["Interference", "Standing waves"]),
	entry("Chemistry", "Notebooks/Chem", ["Acids and bases"]),
];

const CLASSES: ClassEntry[] = [{ id: "c1", course: "Physics", day: 1, start: "09:00", end: "10:00", weeks: "all", notebook: "Notebooks/Physics" }];

/** A tinted placeholder page, drawn once per row (the real source draws the page). */
function paintThumb(row: RelatedRow, img: HTMLImageElement): void {
	const c = createEl("canvas");
	c.width = 72;
	c.height = 96;
	const g = c.getContext("2d");
	if (!g) return;
	g.fillStyle = "#fbfaf5";
	g.fillRect(0, 0, 72, 96);
	g.strokeStyle = `hsl(${(row.name.length * 37 + row.page * 23) % 360} 45% 45%)`;
	g.lineWidth = 2;
	g.beginPath();
	for (let i = 0; i < 6; i++) {
		g.moveTo(8, 14 + i * 13);
		g.bezierCurveTo(24, 6 + i * 13, 44, 22 + i * 13, 64, 12 + i * 13 + (row.page % 3) * 2);
	}
	g.stroke();
	img.src = c.toDataURL("image/png");
}

class FakeSource implements RelatedSource {
	current: RelatedNote | null = NOTE;
	entriesNow: LibraryEntry[] = ENTRIES;
	course = true;
	opened: RelatedRow[] = [];
	copied: RelatedRow[] = [];
	refreshes = 0;
	private cb: (() => void) | null = null;
	note(): RelatedNote | null {
		return this.current;
	}
	entries(): readonly LibraryEntry[] {
		return this.entriesNow;
	}
	refresh(): Promise<void> {
		this.refreshes++;
		return Promise.resolve();
	}
	classes(): readonly ClassEntry[] {
		return CLASSES;
	}
	includeCourse(): boolean {
		return this.course;
	}
	thumb(row: RelatedRow, img: HTMLImageElement): void {
		paintThumb(row, img);
	}
	open(row: RelatedRow): void {
		this.opened.push(row);
	}
	copyLink(row: RelatedRow): void {
		this.copied.push(row);
	}
	dragText(row: RelatedRow): string {
		return `![[${row.path}#p${row.page + 1}]]`;
	}
	onChange(cb: () => void): () => void {
		this.cb = cb;
		return () => {
			this.cb = null;
		};
	}
	fire(): void {
		this.cb?.();
	}
}

let host: HTMLElement | null = null;
let view: RelatedView | null = null;

async function unmount(): Promise<void> {
	if (view) await view.onClose();
	view = null;
	host?.remove();
	host = null;
}

/** The panel drawn like the right sidebar of Obsidian: a column at the right edge of the window. */
async function mount(app: App, src: FakeSource): Promise<RelatedView> {
	await unmount();
	host = document.body.createDiv({ cls: "harness-related-host" });
	host.setCssStyles({ position: "fixed", top: "0", right: "0", bottom: "0", width: "min(380px, 100vw)", zIndex: "50", background: "var(--nb-bg)", borderLeft: "1px solid var(--nb-border)", display: "flex", flexDirection: "column" });
	const leaf = new WorkspaceLeaf(app, host);
	leaf.containerEl.setCssStyles({ flex: "1 1 auto", minHeight: "0", overflow: "auto" });
	view = new RelatedView(leaf as unknown as ObsidianLeaf, src);
	await view.onOpen();
	await frames(4);
	return view;
}

export async function relatedShot(api: RelatedCheckApi, state: "results" | "empty" | "none"): Promise<void> {
	const src = new FakeSource();
	if (state === "empty") src.current = OTHER;
	if (state === "none") src.current = null;
	await mount(api.app, src);
	await sleep(40);
}

export async function checkRelated(api: RelatedCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		const src = new FakeSource();
		const v = await mount(api.app, src);
		const root = v.contentEl;
		const rows = () => [...root.querySelectorAll<HTMLElement>(".nb-rel-row")];
		const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? "";
		const reasonOf = (r: Element) => text(r.querySelector(".nb-rel-reason > span:last-child"));
		const summary = () => rows().map((r) => `${text(r.querySelector(".nb-rel-name"))}:${r.dataset.page}:${reasonOf(r)}`);

		add("the panel root carries the design-system scope", root.classList.contains("nb-ui") && root.classList.contains("notebook-related"));
		add("a header with the title and the note", text(root.querySelector(".nb-rel-title")) === "Related pages" && text(root.querySelector(".nb-rel-subtitle")).includes("Optics"), text(root.querySelector(".nb-rel-subtitle")));
		const s = summary();
		add("rows are ranked: links first, then title, alias, tag, heading, course last", s[0]!.endsWith("Links here") && s[s.length - 1]!.endsWith("Same course") && s.length >= 6, s.join(" | "));
		add("the page that links to the note leads", s[0]!.startsWith("Physics lectures:1:") || s[0]!.startsWith("Lab book:2:"), s[0] ?? "");
		add("the course row is the first page of a notebook of the course", rows().some((r) => reasonOf(r) === "Same course" && r.dataset.page === "0" && text(r.querySelector(".nb-rel-detail")) === "Physics"));
		add("every row has a thumbnail, the page number and a reason chip", rows().every((r) => !!r.querySelector(".nb-rel-thumb img[src]") && /^Page \d+$/.test(text(r.querySelector(".nb-rel-page"))) && !!r.querySelector(".nb-rel-reason")));
		add("the reason chip is not a control", rows().every((r) => r.querySelector(".nb-rel-reason")?.tagName === "SPAN"));
		add("no sideways scroll", root.scrollWidth <= root.clientWidth + 1, `${root.scrollWidth} > ${root.clientWidth}`);
		add("the row and the link button are at least 40 px", rows().every((r) => (r.querySelector<HTMLElement>(".nb-rel-main")?.offsetHeight ?? 0) >= 40 && (r.querySelector<HTMLElement>(".nb-rel-copy")?.offsetHeight ?? 0) >= 40));
		add("the buttons carry a long-press explanation", (root.querySelector<HTMLElement>(".nb-rel-copy")?.dataset.help ?? "").startsWith("help.related") && (root.querySelector<HTMLElement>(".nb-rel-refresh")?.dataset.help ?? "").startsWith("help.related"));

		root.querySelector<HTMLButtonElement>(".nb-rel-main")?.click();
		add("a tap on a row opens that page", src.opened.length === 1 && src.opened[0]!.page === Number(rows()[0]!.dataset.page) && src.opened[0]!.path === rows()[0]!.dataset.path);
		root.querySelector<HTMLButtonElement>(".nb-rel-copy")?.click();
		add("the link button copies the link of that page", src.copied.length === 1 && src.copied[0]!.path === rows()[0]!.dataset.path);
		const dt = new DataTransfer();
		rows()[0]!.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
		add("a drag carries the page's embed", dt.getData("text/plain").startsWith("![[Notebooks/") && rows()[0]!.getAttribute("draggable") === "true", dt.getData("text/plain"));

		src.course = false;
		await v.onClose();
		await v.onOpen();
		await frames(2);
		add("without the course setting no course row is listed", !summary().some((x) => x.endsWith("Same course")), summary().join(" | "));
		src.course = true;

		src.current = OTHER;
		src.fire();
		add("the change is debounced, not instant", rows().length > 0 && text(root.querySelector(".nb-rel-subtitle")).includes("Optics"));
		await sleep(RELATED_DEBOUNCE_MS + 120);
		add("after the debounce the panel follows the note and shows the nothing-related state", rows().length === 0 && !!root.querySelector(".nb-empty-state") && text(root.querySelector(".nb-empty-title")) === "Nothing related yet", text(root.querySelector(".nb-empty-title")));

		src.current = null;
		src.fire();
		await sleep(RELATED_DEBOUNCE_MS + 120);
		add("with no note open it says so", text(root.querySelector(".nb-empty-title")) === "No note open", text(root.querySelector(".nb-empty-title")));

		src.current = NOTE;
		src.entriesNow = [];
		src.fire();
		await sleep(RELATED_DEBOUNCE_MS + 120);
		add("an empty index asks to be read once", src.refreshes >= 1);

		await relatedShot(api, "results");
		add("left open with results for the screenshot", (view?.contentEl.querySelectorAll(".nb-rel-row").length ?? 0) >= 6);
	} catch (e) {
		add("the check ran to the end", false, (e as Error).stack ?? String(e));
	}
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { width: window.innerWidth } };
}
