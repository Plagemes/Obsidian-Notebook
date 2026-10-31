/**
 * 0.13 ds-zettel: the Zettelkasten surfaces in the browser harness (`doc=zettel`, npm run harness:check): the real InboxView on
 * a stand-in service (items from the quick-notes sheet and two PDF notebooks), driven with synthetic taps; the card dialog,
 * the card-list rows, the slip-box confirmation and the card regions over the notebook page. Checks layout (no sideways
 * scroll, 40 px targets, no Obsidian default button look) and that every control still does what it did, then leaves each
 * surface open on request (`zettelState`) for the screenshots.
 */
import { WorkspaceLeaf, type App } from "./obsidian-stub";
import { InboxView } from "../../src/zettel/inbox-view";
import { CardListModal, ConfirmCardsModal, type CardAnswer } from "../../src/zettel/modals";
import { CardOverlay, type OverlaySource } from "../../src/zettel/overlay";
import type { CardRecord } from "../../src/zettel/card-content";
import type { InboxItem } from "../../src/zettel/inbox-items";
import type { InboxEntry, ItemStatus } from "../../src/zettel/inbox-state";
import type { InboxService } from "../../src/zettel/inbox-service";
import type { NotebookView } from "../../src/view/notebook-view";
import type { WorkspaceLeaf as ObsidianLeaf } from "obsidian";
import type { CheckResult } from "./reading-check";
import { obsidianStyledButtons } from "./library-check";

export interface ZettelCheckApi {
	app: App;
	view: unknown;
	errors: string[];
	notices: string[];
}

export type ZettelState = "inbox" | "open" | "empty" | "caught-up" | "scanning" | "card" | "card-luhmann" | "list" | "confirm" | "overlay";

const frames = (n = 2) => new Promise<void>((resolve) => {
	let left = n;
	const step = () => (--left <= 0 ? resolve() : window.requestAnimationFrame(step));
	window.requestAnimationFrame(step);
});

function tap(el: Element | null | undefined, pointerType: "pen" | "touch" | "mouse" = "touch"): void {
	if (!el) throw new Error("nothing to tap");
	const r = el.getBoundingClientRect();
	const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerType, isPrimary: true, pointerId: 9 };
	el.dispatchEvent(new PointerEvent("pointerdown", at));
	el.dispatchEvent(new PointerEvent("pointerup", at));
	(el as HTMLElement).click();
}

function type(input: HTMLInputElement | null | undefined, text: string): void {
	if (!input) throw new Error("no input");
	input.focus();
	input.value = text;
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** A page-sized picture with some handwriting-like strokes, as the service's preview. */
function inkPicture(seed: number, w = 520, h = 300): string {
	const c = createEl("canvas");
	c.width = w;
	c.height = h;
	const ctx = c.getContext("2d")!;
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, w, h);
	ctx.strokeStyle = "#1c2433";
	ctx.lineWidth = 2.4;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	for (let line = 0; line < 4; line++) {
		ctx.beginPath();
		let x = 30;
		const y = 60 + line * 56;
		ctx.moveTo(x, y);
		while (x < w - 50 - ((seed + line) % 3) * 60) {
			ctx.quadraticCurveTo(x + 8, y - 22 - ((x + seed) % 9), x + 16, y);
			ctx.quadraticCurveTo(x + 24, y + 18 + ((x * 3 + seed) % 7), x + 32, y);
			x += 34;
		}
		ctx.stroke();
	}
	return c.toDataURL("image/png");
}

const entryOf = (key: string, state: InboxEntry["state"], card?: string): InboxEntry => ({ key, state, at: Date.now(), ...(card ? { card, path: `Cards/${card}.md` } : {}) });

function item(n: number, source: string, notebookName: string, text: string, extra: Partial<InboxItem> = {}): InboxItem {
	return {
		key: `${source}|nb-${notebookName}|p${n}|b${n}`,
		source,
		kind: source === "pdf" ? "pdf-highlight" : "block",
		notebookPath: `Notebooks/${notebookName}.notebook`,
		notebookName,
		notebookId: `nb-${notebookName}`,
		pageId: `p${n}`,
		pageIndex: n - 1,
		pageSize: { width: 595, height: 842 },
		region: null,
		text,
		sig: 1,
		cardType: source === "pdf" ? "literature" : "permanent",
		order: n,
		...extra,
	};
}

/** The stand-in for InboxService: the same public surface the view uses, with its state in memory. */
class FakeInbox {
	items: InboxItem[] = [];
	states = new Map<string, ItemStatus>();
	listeners = new Set<() => void>();
	calls: string[] = [];
	covering: CardRecord[] = [];
	created: CardAnswer[] = [];
	refreshes = 0;
	slow = false;

	get all(): readonly InboxItem[] {
		return this.items;
	}

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private changed(): void {
		for (const fn of this.listeners) fn();
	}

	status(i: InboxItem): ItemStatus {
		return this.states.get(i.key) ?? { status: "open", changed: false };
	}

	async refresh(progress?: (done: number, total: number) => void): Promise<unknown> {
		this.refreshes++;
		progress?.(1, 3);
		if (this.slow) await new Promise<void>((r) => (releaseScan = r));
		this.changed();
		return { items: this.items, scanned: 3 };
	}

	coveringCards(i: InboxItem): CardRecord[] {
		return i.key === this.items[1]?.key ? this.covering : [];
	}

	preview(i: InboxItem): Promise<string | null> {
		return Promise.resolve(inkPicture(i.order));
	}

	textOf(i: InboxItem): Promise<string> {
		return Promise.resolve(i.text);
	}

	cardDefaults(i: InboxItem, type: CardAnswer["type"]): Promise<Partial<CardAnswer>> {
		return Promise.resolve({ title: i.text.split(/[.:]/)[0] ?? "", type, source: type === "literature" ? "Anatomy handbook, p. 12" : "", tags: ["study"] });
	}

	createCard(i: InboxItem, answer: CardAnswer): Promise<boolean> {
		this.created.push(answer);
		this.states.set(i.key, { status: "card", entry: entryOf(i.key, "card", "1a") });
		this.changed();
		return Promise.resolve(true);
	}

	discard(i: InboxItem): Promise<boolean> {
		this.calls.push(`discard:${i.order}`);
		this.states.set(i.key, { status: "discarded", entry: entryOf(i.key, "discarded") });
		this.changed();
		return Promise.resolve(true);
	}

	reopen(i: InboxItem): Promise<boolean> {
		this.calls.push(`reopen:${i.order}`);
		this.states.delete(i.key);
		this.changed();
		return Promise.resolve(true);
	}

	markCovered(i: InboxItem, card: CardRecord): Promise<boolean> {
		this.calls.push(`covered:${card.id}`);
		this.states.set(i.key, { status: "card", entry: entryOf(i.key, "card", card.id) });
		this.changed();
		return Promise.resolve(true);
	}

	link(i: InboxItem, card: CardRecord): Promise<boolean> {
		this.states.set(i.key, { status: "linked", entry: entryOf(i.key, "linked", card.id) });
		this.changed();
		return Promise.resolve(true);
	}

	openItem(i: InboxItem): void {
		this.calls.push(`open:${i.order}`);
	}

	openCard(path: string): void {
		this.calls.push(`card:${path}`);
	}

	cards(): CardRecord[] {
		return CARDS;
	}
}

const card = (id: string, title: string, orphaned = false): CardRecord => ({
	path: `Cards/${id}.md`, id, title, notebookId: "nb-Quick notes", notebookLink: "[[Notebooks/Anatomia/Ossa.notebook|Ossa]]", pageId: "p1", region: null, orphaned, links: [],
});
const CARDS: CardRecord[] = [
	card("1", "Spaced repetition beats rereading"), card("1a", "Retrieval practice"), card("1b", "Interleaving topics"),
	card("2", "Entropy and information"), card("3", "Bone remodelling", true),
];

function seedItems(f: FakeInbox): void {
	f.items = [
		item(1, "loose-sheet", "Quick notes", "Spaced repetition beats rereading: review at growing intervals."),
		item(2, "loose-sheet", "Quick notes", "What links entropy and information? Check Shannon's definition against the thermodynamic one."),
		item(3, "loose-sheet", "Quick notes", ""),
		item(4, "pdf", "Anatomia – slides", "Osteoblasts deposit new bone matrix while osteoclasts resorb it.", { pageIndex: 11, origin: { pdfName: "Anatomy handbook.pdf", pdfPage: 12 } }),
		item(5, "pdf", "Anatomia – slides", "Compact bone is organised in osteons.", { pageIndex: 12, origin: { pdfName: "Anatomy handbook.pdf", pdfPage: 13 }, kind: "pdf-comment" }),
		item(6, "pdf", "Fisiologia – lezione 3", "La pompa sodio-potassio mantiene il potenziale di riposo.", { pageIndex: 2, origin: { pdfName: "Fisiologia 3.pdf", pdfPage: 3 } }),
	];
	f.states.clear();
	f.states.set(f.items[2]!.key, { status: "open", changed: true });
	f.states.set(f.items[4]!.key, { status: "linked", entry: entryOf(f.items[4]!.key, "linked", "2") });
	f.covering = [CARDS[0]!];
}

interface Mounted {
	root: HTMLElement;
	host: HTMLElement;
	view: InboxView;
	fake: FakeInbox;
	luhmann: boolean;
}

/** Lets a scan that was kept running (the "scanning" screenshot) finish. */
let releaseScan: (() => void) | null = null;
let mounted: Mounted | null = null;
let overlay: CardOverlay | null = null;
let modal: { close(): void; modalEl: HTMLElement } | null = null;
let backdrop: HTMLElement | null = null;

async function unmount(): Promise<void> {
	releaseScan?.();
	releaseScan = null;
	if (mounted) {
		await mounted.view.onClose();
		mounted.host.remove();
		mounted = null;
	}
	closeModal();
	document.querySelectorAll(".notebook-card-modal").forEach((n) => n.remove());
	overlay?.detach();
	overlay = null;
	document.querySelectorAll(".harness-zettel-note").forEach((n) => n.remove());
}

function closeModal(): void {
	modal?.close();
	modal = null;
	backdrop?.remove();
	backdrop = null;
}

/** The Inbox drawn like a leaf of Obsidian's workspace, over the page. */
async function mount(app: App, fake: FakeInbox, luhmann = false): Promise<Mounted> {
	await unmount();
	const host = document.body.createDiv({ cls: "harness-zettel-host" });
	const leaf = new WorkspaceLeaf(app, host);
	leaf.containerEl.addClass("harness-zettel-leaf");
	const view = new InboxView(leaf as unknown as ObsidianLeaf, fake as unknown as InboxService, () => luhmann);
	// A scan that is kept running (the "scanning" screenshot) would hold onOpen: do not wait for it.
	const opened = view.onOpen();
	if (!fake.slow) await opened;
	await frames(3);
	mounted = { root: view.contentEl, host, view, fake, luhmann };
	return mounted;
}

function showModal(m: { open(): void; modalEl: HTMLElement; close(): void }): void {
	closeModal();
	m.open();
	backdrop = document.body.createDiv({ cls: "harness-modal-container harness-zettel-backdrop" });
	backdrop.appendChild(m.modalEl);
	modal = m;
}

function overlaySource(cards: CardRecord[]): OverlaySource {
	return { visibleCards: () => cards, show: () => true, seen: () => undefined };
}

/** Sets a surface up for a screenshot. */
export async function zettelState(api: ZettelCheckApi, state: ZettelState): Promise<void> {
	const fake = new FakeInbox();
	if (state === "empty") fake.items = [];
	else seedItems(fake);
	if (state === "caught-up") for (const i of fake.items) fake.states.set(i.key, { status: "discarded", entry: entryOf(i.key, "discarded") });
	if (state === "scanning") {
		fake.items = [];
		fake.slow = true;
	}
	if (state === "overlay") {
		await unmount();
		const v = api.view as NotebookView;
		overlay = new CardOverlay(v, overlaySource([card("1", "Spaced repetition"), { ...card("1a", "Retrieval practice"), region: { x: 60, y: 90, width: 300, height: 180 } }, { ...card("2b", "Entropy"), region: { x: 120, y: 340, width: 260, height: 140 } }]));
		overlay.refresh();
		await frames(3);
		return;
	}
	const m = await mount(api.app, fake, state === "card-luhmann");
	if (state === "open" || state === "card" || state === "card-luhmann" || state === "list") {
		tap(m.root.querySelectorAll<HTMLElement>(".nb-zk-item-head")[1], "pen");
		await frames(4);
	}
	if (state === "card" || state === "card-luhmann") {
		tap(m.root.querySelector(".nb-zk-actions .mod-cta"), "touch");
		await frames(4);
		const dlg = document.querySelector<HTMLElement>(".notebook-card-modal");
		if (dlg) {
			// Obsidian's modal container: a dimmed layer above the leaf that centres the dialog.
			backdrop?.remove();
			backdrop = document.body.createDiv({ cls: "harness-modal-container harness-zettel-backdrop" });
			backdrop.appendChild(dlg);
			type(dlg.querySelector<HTMLInputElement>(".nb-zk-input"), "Spaced repetition beats rereading");
			const inputs = dlg.querySelectorAll<HTMLInputElement>(".nb-zk-input");
			type(inputs[2], "Cognitive science, memory study");
			dlg.querySelector<HTMLInputElement>(".nb-zk-input")?.blur();
		}
	}
	if (state === "list") {
		const link = [...m.root.querySelectorAll<HTMLElement>(".nb-zk-actions button")].find((b) => b.textContent?.includes("Link"));
		void link;
		showCardList(api.app, m.fake);
	}
	if (state === "confirm") {
		showModal(new ConfirmCardsModal(api.app as never, "Every page becomes a card: 24 notes will be created in Notebooks/Cards. New pages will get their note automatically.", () => undefined));
	}
	await frames(3);
	window.scrollTo(0, 0);
}

/** The card picker: the stand-in has no prompt, so it is drawn like Obsidian's (input + result rows). */
function showCardList(app: App, fake: FakeInbox): void {
	closeModal();
	const picked: string[] = [];
	const list = new CardListModal(app as never, fake.cards().map((c) => ({ card: c, where: c.orphaned ? "orphaned: its page was deleted" : "Ossa", orphaned: c.orphaned })), (chosen) => picked.push(chosen.card.id));
	const el = list.modalEl;
	el.className = "modal prompt nb-ui notebook-card-list";
	el.empty();
	const inputWrap = el.createDiv({ cls: "prompt-input-container" });
	inputWrap.createEl("input", { cls: "prompt-input", attr: { type: "text", placeholder: "Find a card" } });
	const results = el.createDiv({ cls: "prompt-results" });
	list.getItems().forEach((it, i) => {
		const row = results.createDiv({ cls: `suggestion-item${i === 1 ? " is-selected" : ""}` });
		row.addEventListener("click", () => {
			list.onChooseItem(it);
			closeModal();
		});
		list.renderSuggestion({ item: it, match: { score: 0, matches: [] } }, row);
	});
	el.addClass("harness-zettel-list-modal");
	backdrop = document.body.createDiv({ cls: "harness-modal-container harness-zettel-backdrop" });
	backdrop.appendChild(el);
	modal = { close: () => el.remove(), modalEl: el };
	(el as HTMLElement & { picked?: string[] }).picked = picked;
}

export async function checkZettel(api: ZettelCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	try {
		return await runChecks(api, results);
	} catch (e) {
		throw new Error(`${(e as Error).message} (after: ${results[results.length - 1]?.name ?? "start"})`);
	}
}

async function runChecks(api: ZettelCheckApi, results: CheckResult[]): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const w = window.innerWidth;

	// --- Inbox with items ---
	const fake = new FakeInbox();
	seedItems(fake);
	const m = await mount(api.app, fake);
	const root = m.root;
	const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel);
	const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
	add("the inbox root carries the design-system scope", root.hasClass("nb-ui") && root.hasClass("nb-app"));
	add("styled layout: the view is a flex column on the design background", getComputedStyle(root).display === "flex" && getComputedStyle(root).flexDirection === "column", `${getComputedStyle(root).display} ${getComputedStyle(root).backgroundColor}`);
	add("the header has the title and the count", q(".nb-page-title")?.textContent === "Inbox" && q(".nb-page-subtitle")?.textContent === "5 to process", q(".nb-page-subtitle")?.textContent ?? "");
	add("one panel per notebook, in the subject colour", qa(".nb-zk-group").length === 3 && qa(".nb-zk-group").every((g) => !!g.style.getPropertyValue("--nb-c")), String(qa(".nb-zk-group").length));
	add("rows for the open items only", qa(".nb-zk-item").length === 5, String(qa(".nb-zk-item").length));
	add("the filter chips list the sources with their counts", qa(".nb-zk-filters .nb-chip").map((c) => c.textContent).join("|") === "All5|Quick notes3|PDF highlights and comments2|Show processed", qa(".nb-zk-filters .nb-chip").map((c) => c.textContent).join("|"));
	add("the changed item says so", qa(".nb-zk-item-badges .nb-pill.is-accent").length === 1);
	add("the PDF row names its source page", qa(".nb-zk-item-meta").some((e) => e.textContent === "p. 12 · Anatomy handbook.pdf, p. 12"), qa(".nb-zk-item-meta").map((e) => e.textContent).join(" / "));
	const small = qa("button, .nb-chip").filter((b) => {
		const r = b.getBoundingClientRect();
		return r.width > 0 && (r.height < 39.5 || r.width < 39.5);
	});
	add("every target is at least 40 px", small.length === 0, small.map((b) => b.className).join(", "));
	const scroll = q(".nb-zk-scroll")!;
	add("nothing overflows sideways", scroll.scrollWidth <= scroll.clientWidth + 1, `${scroll.scrollWidth} > ${scroll.clientWidth}`);
	const grey = obsidianStyledButtons(root);
	add("no button shows Obsidian's default button look", grey.length === 0, grey.slice(0, 4).map((el) => el.className || el.tagName).join(", "));
	const art = q<HTMLElement>(".nb-header-art");
	add("the header art is decoration only (hidden from assistive tech, no pointer events)", !art || (art.getAttribute("aria-hidden") === "true" && getComputedStyle(art).pointerEvents === "none"));

	// Filter by source.
	tap(qa(".nb-zk-filters .nb-chip")[2], "touch");
	await frames();
	add("a source chip filters the list", qa(".nb-zk-item").length === 2 && qa(".nb-zk-filters .nb-chip.is-active")[0]?.textContent?.startsWith("PDF") === true);
	tap(qa(".nb-zk-filters .nb-chip")[0], "mouse");
	await frames();
	add("All shows everything again", qa(".nb-zk-item").length === 5);

	// Show processed.
	tap(q(".nb-zk-toggle"), "pen");
	await frames();
	add("Show processed adds the processed rows", qa(".nb-zk-item").length === 6 && qa(".nb-zk-item.is-done").length === 1 && q(".nb-zk-toggle")?.getAttribute("aria-pressed") === "true", String(qa(".nb-zk-item").length));
	tap(q(".nb-zk-toggle"), "pen");
	await frames();

	// Open an item: panel, preview, text, covering card, actions.
	tap(qa(".nb-zk-item-head")[1], "pen");
	await frames(4);
	add("tapping a row opens its panel", qa(".nb-zk-item.is-selected").length === 1 && q(".nb-zk-item-head[aria-expanded=true]") !== null);
	add("with the ink on its paper and the text", q<HTMLImageElement>(".nb-zk-preview")?.src.startsWith("data:image") === true && (q(".nb-zk-text")?.textContent ?? "").startsWith("What links entropy"));
	add("a card that already covers it is offered", (q(".nb-zk-covered-text")?.textContent ?? "").includes("1 Spaced repetition") && qa(".nb-zk-covered button").length === 2);
	const labels = qa(".nb-zk-actions button").map((b) => b.textContent);
	add("the actions are all there", JSON.stringify(labels) === JSON.stringify(["Permanent card…", "Link to a card…", "Discard", "Skip", "Open in notebook"]), labels.join("|"));
	add("the primary action is the accent button", qa(".nb-zk-actions .mod-cta").length === 1 && qa(".nb-zk-actions button")[0]?.classList.contains("mod-cta") === true);
	add("the panel does not overflow", scroll.scrollWidth <= scroll.clientWidth + 1);

	// Actions.
	tap(qa(".nb-zk-covered button")[0], "touch");
	add("Open card goes to the card", fake.calls.includes("card:Cards/1.md"), fake.calls.join(","));
	tap(qa(".nb-zk-actions button")[4], "mouse");
	add("Open in notebook goes to the page", fake.calls.includes("open:2"), fake.calls.join(","));
	tap(qa(".nb-zk-actions button")[3], "pen");
	await frames(3);
	add("Skip selects the next open item", qa(".nb-zk-item.is-selected").length === 1 && (qa(".nb-zk-item.is-selected .nb-zk-item-text")[0]?.textContent ?? "") === "Writing", qa(".nb-zk-item.is-selected .nb-zk-item-text")[0]?.textContent ?? "none");
	tap(qa(".nb-zk-actions button")[2], "touch");
	for (let i = 0; i < 6 && !fake.calls.some((c) => c.startsWith("discard")); i++) await frames();
	await frames(4);
	add("Discard marks the item processed and moves on", fake.calls.includes("discard:3") && qa(".nb-zk-item").length === 4 && root.querySelector(".nb-page-subtitle")?.textContent === "4 to process", `${fake.calls.join(",")} ${root.querySelector(".nb-page-subtitle")?.textContent}`);

	// Make a card: the dialog.
	const selected = qa(".nb-zk-item.is-selected .nb-zk-actions .mod-cta")[0];
	tap(selected, "touch");
	await frames(4);
	const dlg = () => document.querySelector<HTMLElement>(".notebook-card-modal");
	const dq = <T extends HTMLElement = HTMLElement>(sel: string) => dlg()?.querySelector<T>(sel) ?? null;
	const dqa = (sel: string) => [...(dlg()?.querySelectorAll<HTMLElement>(sel) ?? [])];
	add("Permanent card… opens the card dialog in the design system", !!dlg() && dlg()!.hasClass("nb-ui"));
	if (dlg()) {
		add("the dialog shows the ink, the fields and three type tiles", !!dq(".nb-zk-preview") && dqa(".nb-zk-input").length === 3 && dqa(".nb-zk-type").length === 3, `${dqa(".nb-zk-input").length} inputs ${dqa(".nb-zk-type").length} types`);
		add("it starts with the suggested values", dq<HTMLInputElement>(".nb-zk-input")?.value.startsWith("Osteoblasts deposit") === true && dqa(".nb-zk-type.is-active")[0]?.dataset.id === "literature" && dqa(".nb-zk-tag").map((e) => e.textContent).join() === "#study");
		const small2 = dqa("button, input").filter((b) => {
			const r = b.getBoundingClientRect();
			return r.width > 0 && (r.height < 39.5 || r.width < 39.5);
		});
		add("the dialog's targets are at least 40 px", small2.length === 0, small2.map((b) => b.className).join(", "));
		add("no dialog button shows Obsidian's default button look", obsidianStyledButtons(dlg()!).length === 0, obsidianStyledButtons(dlg()!).map((el) => el.className).join(", "));
		const box = dlg()!.getBoundingClientRect();
		add("the dialog fits the screen", box.left >= 0 && box.right <= w + 0.5 && box.height <= window.innerHeight + 0.5, `${Math.round(box.left)}-${Math.round(box.right)} of ${w}, ${Math.round(box.height)} tall`);
		tap(dqa(".nb-zk-type")[2], "pen");
		add("choosing a type marks it (a radio group)", dqa(".nb-zk-type.is-active").length === 1 && dqa(".nb-zk-type")[2]?.getAttribute("aria-checked") === "true" && dqa(".nb-zk-type")[1]?.getAttribute("aria-checked") === "false");
		type(dqa(".nb-zk-input")[2] as HTMLInputElement, "memory, #study  review");
		add("the tags are previewed as they will be saved", dqa(".nb-zk-tag").map((e) => e.textContent).join() === "#memory,#study,#review", dqa(".nb-zk-tag").map((e) => e.textContent).join());
		const first = dq<HTMLInputElement>(".nb-zk-input")!;
		first.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		for (let i = 0; i < 10 && fake.created.length === 0; i++) await frames();
		const made = fake.created[0];
		add("Enter creates the card with what was entered", !!made && made.type === "fleeting" && made.title.startsWith("Osteoblasts deposit") && made.tags.join() === "memory,study,review", JSON.stringify(made));
		add("and the dialog closes", !dlg());
	}

	// Cancel leaves everything as it was.
	fake.created.length = 0;
	await frames(4);
	tap(qa(".nb-zk-item.is-selected .nb-zk-actions .mod-cta")[0], "touch");
	await frames(4);
	tap(dq(".nb-zk-footer .nb-pill-btn:not(.mod-cta)"), "mouse");
	await frames(2);
	add("Cancel closes the dialog without creating anything", !dlg() && fake.created.length === 0);

	// Luhmann: the extra field.
	await mount(api.app, fake, true);
	tap(document.querySelectorAll<HTMLElement>(".nb-zk-item-head")[0], "touch");
	await frames(3);
	tap(document.querySelector(".nb-zk-item.is-selected .nb-zk-actions .mod-cta"), "touch");
	await frames(3);
	add("with Luhmann numbering the dialog asks for the parent card", dqa(".nb-zk-input").length === 4, String(dqa(".nb-zk-input").length));
	tap(dq(".nb-zk-footer .nb-pill-btn:not(.mod-cta)"), "mouse");

	// Link: the card list rows.
	await mount(api.app, fake);
	showCardList(api.app, fake);
	await frames(2);
	const rows = [...document.querySelectorAll<HTMLElement>(".notebook-card-list .nb-zk-card-row")];
	add("the card list shows the id, the title and where each card is", rows.length === 5 && rows[1]?.querySelector(".nb-zk-card-id")?.textContent === "1a" && rows[1]?.querySelector(".nb-zk-card-title")?.textContent === "Retrieval practice", String(rows.length));
	add("an orphaned card is marked", rows[4]?.classList.contains("is-orphan") === true && (rows[4]?.querySelector(".nb-zk-card-where")?.textContent ?? "").startsWith("orphaned"));
	const listEl = document.querySelector<HTMLElement & { picked?: string[] }>(".notebook-card-list");
	tap(rows[2], "touch");
	await frames();
	add("choosing a row hands the card back", listEl?.picked?.join() === "1b", listEl?.picked?.join() ?? "none");

	// Confirmation dialog.
	showModal(new ConfirmCardsModal(api.app as never, "Every page becomes a card: 24 notes will be created in Notebooks/Cards.", () => (fake.calls.push("confirmed"))));
	await frames(2);
	add("the slip-box confirmation is a design-system dialog with two buttons", !!dlg()?.hasClass("nb-ui") && dqa(".nb-zk-footer button").length === 2);
	tap(dq(".nb-zk-footer .mod-cta"), "touch");
	await frames();
	add("Create cards confirms and closes", fake.calls.includes("confirmed") && !dlg());

	// Empty states.
	const empty = new FakeInbox();
	const me = await mount(api.app, empty);
	const eq = (sel: string) => me.root.querySelector<HTMLElement>(sel);
	add("an empty inbox teaches what arrives here", eq(".nb-empty-title")?.textContent === "Your inbox is empty" && (eq(".nb-empty-body")?.textContent ?? "").includes("PDF"), eq(".nb-empty-title")?.textContent ?? "none");
	add("with the generated illustration (or an icon with reduced effects)", !!eq(".nb-empty-art") || !!eq(".nb-empty-icon"));
	add("the filters are hidden while there is nothing", eq(".nb-zk-filters")?.hasClass("is-hidden") === true);
	const before = empty.refreshes;
	tap(eq(".nb-empty-actions .nb-pill-btn"), "touch");
	await frames(3);
	add("Look again scans again", empty.refreshes === before + 1, `${before} -> ${empty.refreshes}`);

	const done = new FakeInbox();
	seedItems(done);
	for (const i of done.items) done.states.set(i.key, { status: "discarded", entry: entryOf(i.key, "discarded") });
	const md = await mount(api.app, done);
	const dq2 = (sel: string) => md.root.querySelector<HTMLElement>(sel);
	add("when everything is processed the inbox says so and offers the processed items", dq2(".nb-empty-title")?.textContent === "All caught up" && dq2(".nb-empty-actions .mod-cta")?.textContent === "Show processed", dq2(".nb-empty-title")?.textContent ?? "none");
	tap(dq2(".nb-empty-actions .mod-cta"), "touch");
	await frames(3);
	add("Show processed lists them", md.root.querySelectorAll(".nb-zk-item.is-done").length === 6);

	// The card regions over the page.
	await zettelState(api, "overlay");
	const regions = [...document.querySelectorAll<HTMLElement>(".notebook-zettel-region")];
	add("the card regions are drawn over the page", regions.length === 3, String(regions.length));
	add("the badges carry the ids", [...document.querySelectorAll(".notebook-zettel-badge")].map((b) => b.textContent).join() === "1,1a,2b");
	add("the overlay never takes pointer events", getComputedStyle(document.querySelector(".notebook-zettel-overlay")!).pointerEvents === "none" && regions.every((r) => getComputedStyle(r).pointerEvents === "none"));
	await unmount();

	await zettelState(api, "inbox");
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio, width: w } };
}
