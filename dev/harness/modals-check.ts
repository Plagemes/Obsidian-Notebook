/**
 * Smoke check of the dialogs, prompts and cards on the shared modal shell (wave 0.13 ds-modals, `doc=modals`,
 * npm run harness:check): the real classes from src/view/ and src/ui/destructive.ts on the harness stand-in for Obsidian,
 * opened inside a dimmed layer like Obsidian's modal container, driven with synthetic clicks and typing. For each one:
 * the shell's header (title, art band, close button), 40 px targets, no sideways overflow, no button in Obsidian's own
 * look; and what the controls do (apply, pick, cancel, close). `modalShot(name)` leaves one open for the screenshots.
 */
import type { App } from "obsidian";
import { createPage, createStroke } from "../../src/model/document";
import { PAGE_SIZES } from "../../src/model/types";
import type { ExportRequest } from "../../src/view/export";
import { confirmDestructive } from "../../src/ui/destructive";
import { ColourPicker } from "../../src/view/colour-picker";
import { EquationEditor, type EquationDraft } from "../../src/view/equation-editor";
import { ExportModal, MarkdownExportModal } from "../../src/view/export-dialog";
import { FindReplaceModal } from "../../src/view/find-replace";
import { GotoPageModal } from "../../src/view/goto-page";
import { askExercisePaper, askLayoutOptions, askLectureSetup } from "../../src/view/lecture-pack-modal";
import { StyleModal, ResizeModal } from "../../src/view/arrange-modals";
import { NewNotebookModal } from "../../src/view/modals";
import { PasteModal } from "../../src/view/paste-modal";
import { askPdfRange } from "../../src/view/pdf-range-modal";
import { PenTestModal } from "../../src/view/pen-test-modal";
import { askRedo, showAttempts, type RedoChoice } from "../../src/view/practice-modal";
import { SharedClipModal } from "../../src/view/shared-clip-modal";
import { StampPalette, type StampHost } from "../../src/view/stamp-palette";
import { obsidianStyledButtons } from "./library-check";
import type { CheckResult } from "./reading-check";

export interface ModalsCheckApi {
	app: unknown;
	errors: string[];
	notices: string[];
}

/** What the harness screenshots, in this order. */
export const MODAL_NAMES = [
	"resize", "style", "export", "export-png", "markdown", "pdf-range", "practice", "attempts", "lecture", "exercise-paper", "layout", "new-notebook",
	"pen-test", "paste", "clips", "find", "confirm", "goto", "colour-picker", "equation", "stamps",
] as const;
export type ModalName = typeof MODAL_NAMES[number];


interface Handle {
	root: HTMLElement;
	close: () => void;
}

let handle: Handle | null = null;

const frames = (n = 2) => new Promise<void>((resolve) => {
	let left = n;
	const step = () => (--left <= 0 ? resolve() : window.requestAnimationFrame(step));
	window.requestAnimationFrame(step);
});

/** Closes whatever showModal opened. */
export function closeModal(): void {
	const h = handle;
	handle = null;
	if (!h) return;
	try {
		h.close();
	} catch {
		// Already closed.
	}
	h.root.remove();
}

function layer(): HTMLElement {
	return document.body.createDiv({ cls: "harness-modal-container" });
}

/** Puts an opened Modal's element inside the dimmed layer, as Obsidian's modal container does. */
function adopt(modalEl: HTMLElement, close: () => void): HTMLElement {
	const root = layer();
	root.appendChild(modalEl);
	handle = { root, close };
	return modalEl;
}

/** The last `.modal` the page holds (for the `askX` helpers, which open their own Modal). */
function lastModal(): HTMLElement {
	const all = [...document.querySelectorAll<HTMLElement>("body > .modal")];
	const el = all[all.length - 1];
	if (!el) throw new Error("no modal opened");
	return el;
}

function adoptLast(): HTMLElement {
	const el = lastModal();
	return adopt(el, () => el.querySelector<HTMLElement>(".nb-modal-close")?.click());
}

function tap(el: Element | null, pointerType: "pen" | "touch" | "mouse" = "touch"): void {
	if (!el) throw new Error("nothing to tap");
	const r = el.getBoundingClientRect();
	const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerType, isPrimary: true, pointerId: 9 };
	el.dispatchEvent(new PointerEvent("pointerdown", at));
	el.dispatchEvent(new PointerEvent("pointerup", at));
	(el as HTMLElement).click();
}

function type(input: HTMLInputElement | HTMLTextAreaElement | null, text: string): void {
	if (!input) throw new Error("no input");
	input.value = text;
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

const visible = (el: Element): boolean => {
	const r = el.getBoundingClientRect();
	return r.width > 0 && r.height > 0;
};
const buttonByText = (root: ParentNode, text: string): HTMLButtonElement | null => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text) ?? null;

// ---------------------------------------------------------------- scenario data

const redoPage = () => {
	const page = createPage(PAGE_SIZES.a4);
	page.strokes.push(
		createStroke("#dc2626", 2, [[40, 100, 0.5], [90, 102, 0.5], [140, 100, 0.5]], "pen"),
		createStroke("#2563eb", 2, [[40, 140, 0.5], [90, 142, 0.5]], "pen"),
		createStroke("#facc15", 14, [[40, 180, 0.5], [90, 182, 0.5]], "highlighter"),
	);
	return page;
};

const equationDraft = (): EquationDraft => ({ latex: String.raw`\int_0^1 x^2\,dx = \frac{1}{3}`, inline: false, numbered: false, fontSize: 18, color: "#1e1e1e" });

const noopStampHost = (app: App): StampHost => ({
	app,
	folder: () => "Notebooks",
	editable: () => true,
	doc: () => null,
	captureSelection: () => null,
	penStyle: () => ({ color: "#1e1e1e", width: 2 }),
	viewTarget: () => null,
	pageAtClient: () => null,
	execute: () => undefined,
	select: () => undefined,
});

interface Probe {
	picked: unknown[];
	events: string[];
	redo?: Promise<RedoChoice | null>;
	ask?: Promise<unknown>;
}

function stageFor(): HTMLElement {
	const root = document.body.createDiv({ cls: "harness-card-stage" });
	const stage = root.createDiv({ cls: "notebook-stage" });
	handle = { root, close: () => undefined };
	return stage;
}

/** Opens one scenario and leaves it open. Returns what the controls reported while it was opened (for the checks). */
export async function showModal(api: ModalsCheckApi, name: ModalName): Promise<Probe> {
	const app = api.app as App;
	closeModal();
	const probe: Probe = { picked: [], events: [] };
	switch (name) {
		case "resize": {
			const m = new ResizeModal(app, { width: 240.5, height: 120.25 }, (size) => probe.picked.push(size));
			m.open();
			adopt(m.modalEl, () => m.close());
			break;
		}
		case "style": {
			const m = new StyleModal(app, {
				tools: [{ tool: "pen", count: 12 }, { tool: "highlighter", count: 3 }],
				colours: [{ colour: "#dc2626", count: 8 }, { colour: "#2563eb", count: 4 }, { colour: "#facc15", count: 3 }],
				combos: [{ tool: "pen", colour: "#dc2626", count: 8 }, { tool: "pen", colour: "#2563eb", count: 4 }, { tool: "highlighter", colour: "#facc15", count: 3 }],
			}, (choice) => probe.picked.push(choice));
			m.open();
			adopt(m.modalEl, () => m.close());
			break;
		}
		case "export":
		case "export-png": {
			const m = new ExportModal({
				app, pageCount: 3, pageIndex: 1, pageFirst: false, defaultFolder: "Notebooks/Demo (PNG)", canPrint: true,
				...(name === "export-png" ? { initialFormat: "png" as const } : {}),
				run: (request: ExportRequest) => probe.picked.push(request),
			});
			m.open();
			adopt(m.modalEl, () => m.close());
			break;
		}
		case "markdown": {
			const m = new MarkdownExportModal({ app, pageCount: 3, defaultFolder: "Notebooks/Demo (MD)", run: (folder, dpi) => probe.picked.push({ folder, dpi }) });
			m.open();
			adopt(m.modalEl, () => m.close());
			break;
		}
		case "pdf-range": {
			probe.ask = askPdfRange(app, 12).then((r) => probe.picked.push(r));
			adoptLast();
			break;
		}
		case "practice": {
			probe.redo = askRedo(app, { page: redoPage(), attempt: 2, selection: null, canNotebook: true });
			void probe.redo.then((r) => probe.picked.push(r));
			adoptLast();
			break;
		}
		case "attempts": {
			showAttempts(app, "Attempts of this exercise", [
				{ label: "Original", detail: "", open: () => probe.events.push("original") },
				{ label: "Attempt 1", detail: "12 Oct, 18:06 · 14 min", open: () => probe.events.push("attempt 1") },
				{ label: "Attempt 2 ✓", detail: "14 Oct, 09:30 · 9 min", open: () => probe.events.push("attempt 2") },
			]);
			adoptLast();
			break;
		}
		case "lecture": {
			probe.ask = askLectureSetup(app, "Fisiologia – lezione 4").then((r) => probe.picked.push(r));
			adoptLast();
			break;
		}
		case "layout": {
			probe.ask = askLayoutOptions(app).then((r) => probe.picked.push(r));
			adoptLast();
			break;
		}
		case "exercise-paper": {
			probe.ask = askExercisePaper(app).then((r) => probe.picked.push(r));
			adoptLast();
			break;
		}
		case "new-notebook": {
			const m = new NewNotebookModal(app, { size: "a4", landscape: false, paper: "grid" }, (o) => probe.picked.push(o), (done) => done({ name: "Cornell", doc: undefined as never }));
			m.open();
			adopt(m.modalEl, () => m.close());
			break;
		}
		case "pen-test": {
			let seen = false;
			const m = new PenTestModal(app, { seen: () => seen, markSeen: () => (seen = true) });
			m.open();
			adopt(m.modalEl, () => m.close());
			break;
		}
		case "paste": {
			const m = new PasteModal(app, (clip) => probe.picked.push(clip));
			m.open();
			adopt(m.modalEl, () => m.close());
			break;
		}
		case "clips": {
			const now = Date.now();
			const m = new SharedClipModal(app, [
				{ device: "a1b2c3d4", entry: { id: "1", at: now - 60_000, strokes: 12, images: 2, texts: 1, text: "" } },
				{ device: "e5f6a7b8", entry: { id: "2", at: now - 3_600_000, strokes: 40, images: 0, texts: 0, text: "" } },
			], 1, (item) => probe.picked.push(item));
			m.open();
			adopt(m.modalEl, () => m.close());
			break;
		}
		case "find": {
			const m = new FindReplaceModal({ app, doc: () => null, canEdit: () => true, run: () => false, goTo: () => undefined });
			m.open();
			adopt(m.modalEl, () => m.close());
			break;
		}
		case "confirm": {
			confirmDestructive(app, { title: "Delete this stamp", body: "“Check mark” will be removed from the vault. This cannot be undone.", confirm: "Delete" }, () => probe.events.push("confirmed"));
			adoptLast();
			break;
		}
		case "goto": {
			const m = new GotoPageModal(app, {
				gotoContext: () => ({ total: 24, current: 3, bookmarks: [{ index: 4, title: "Cell membrane" }, { index: 11, title: "Cardiac cycle" }] as never }),
				jumpToPage: (i) => probe.picked.push(i),
			});
			m.open();
			adopt(m.modalEl, () => m.close());
			// The stand-in draws no prompt: Obsidian's own markup around the input and the results.
			const input = m.modalEl.createDiv({ cls: "prompt-input-container" }).createEl("input", { cls: "prompt-input", attr: { type: "text", placeholder: "Page number (1-24), p12 or a bookmark" } });
			input.value = "c";
			const results = m.modalEl.createDiv({ cls: "prompt-results harness-prompt-results" });
			for (const target of m.getSuggestions("")) {
				const item = results.createDiv({ cls: "suggestion-item" });
				m.renderSuggestion(target, item);
			}
			results.firstElementChild?.addClass("is-selected");
			m.modalEl.createDiv({ cls: "prompt-instructions" }).setText("↑↓ to navigate · ↵ to use · esc to dismiss");
			break;
		}
		case "colour-picker": {
			const stage = stageFor();
			const picker = new ColourPicker(stage, "#2f80f7", ["#dc2626", "#16c2a3", "#facc15", "#8b5cf6"], {
				change: (hex, commit) => probe.picked.push({ hex, commit }),
				eyedropper: () => probe.events.push("eyedropper"),
				close: () => probe.events.push("close"),
			});
			handle = { root: stage.parentElement!, close: () => picker.destroy() };
			break;
		}
		case "equation": {
			const stage = stageFor();
			const editor = new EquationEditor(stage, equationDraft(), {
				done: (d) => probe.picked.push(d),
				cancel: () => probe.events.push("cancel"),
				remove: () => probe.events.push("remove"),
			});
			editor.place(40, 40);
			handle = { root: stage.parentElement!, close: () => editor.destroy() };
			break;
		}
		case "stamps": {
			const stage = stageFor();
			const palette = new StampPalette(stage, noopStampHost(app));
			palette.open();
			handle = { root: stage.parentElement!, close: () => palette.destroy() };
			break;
		}
	}
	await frames(3);
	return probe;
}

/** Leaves one scenario open for a screenshot. */
export async function modalShot(api: ModalsCheckApi, name: ModalName): Promise<void> {
	await showModal(api, name);
	await frames(2);
	window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- the checks

type Add = (name: string, ok: unknown, detail?: string) => void;

/** The shell: header, title, art band, close; 40 px targets; no overflow; no Obsidian grey buttons. */
function checkShell(add: Add, name: string, root: HTMLElement, opts: { footer?: boolean; art?: boolean } = {}): void {
	const label = `${name}:`;
	add(`${label} on the shell, scoped under .nb-ui`, root.matches(".modal.nb-modal.nb-ui"), root.className);
	add(`${label} a header with a title`, !!root.querySelector(".nb-modal-head .nb-modal-title")?.textContent, root.querySelector(".nb-modal-title")?.textContent ?? "");
	if (opts.art !== false) add(`${label} the art band is behind the header`, !!root.querySelector(".nb-modal-head > .nb-modal-band"));
	add(`${label} a close button of at least 40 px`, (() => {
		const x = root.querySelector<HTMLElement>(".nb-modal-close");
		const r = x?.getBoundingClientRect();
		return !!r && r.width >= 39.5 && r.height >= 39.5;
	})());
	if (opts.footer !== false) add(`${label} a footer with a secondary and a primary button`, !!root.querySelector(".nb-modal-foot .is-secondary") || !!root.querySelector(".nb-modal-foot .is-primary") || !!root.querySelector(".nb-modal-foot .is-danger"));
	const small = [...root.querySelectorAll<HTMLElement>("button, select, input:not([type='checkbox']), textarea")].filter(visible).filter((el) => {
		const r = el.getBoundingClientRect();
		return Math.min(r.width, r.height) < 39.5 && !el.classList.contains("notebook-colour-recent-swatch") && el.closest(".notebook-practice-chip") === null;
	});
	add(`${label} every target is at least 40 px`, small.length === 0, small.slice(0, 4).map((el) => `${el.className || el.tagName} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`).join(", "));
	const body = root.querySelector<HTMLElement>(".nb-modal-body");
	add(`${label} nothing overflows sideways`, !body || body.scrollWidth <= body.clientWidth + 1, `${body?.scrollWidth} > ${body?.clientWidth}`);
	const r = root.getBoundingClientRect();
	add(`${label} fits the screen`, r.left >= -0.5 && r.right <= window.innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5, `${Math.round(r.left)}..${Math.round(r.right)} x ${Math.round(r.top)}..${Math.round(r.bottom)} in ${window.innerWidth}x${window.innerHeight}`);
	const grey = obsidianStyledButtons(root);
	add(`${label} no button shows Obsidian's default look`, grey.length === 0, grey.slice(0, 3).map((el) => el.className || el.tagName).join(", "));
}

export async function checkModals(api: ModalsCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add: Add = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
	const open = async (name: ModalName) => {
		const probe = await showModal(api, name);
		return { probe, root: handle!.root.querySelector<HTMLElement>(".modal") ?? handle!.root };
	};
	const closeWithX = async (root: HTMLElement) => {
		root.querySelector<HTMLElement>(".nb-modal-close")?.click();
		await frames(1);
	};
	/** One section's failure (a throw) is reported as a failed check and the others still run. */
	const guard = async (title: string, run: () => Promise<void>) => {
		try {
			await run();
		} catch (e) {
			add(`${title}: the check ran`, false, String((e as Error).stack ?? e).slice(0, 300));
			closeModal();
		}
	};
	const modalCount = () => document.querySelectorAll("body > .modal, .harness-modal-container .modal").length;

	// --- resize: the lock, Apply, Enter, Cancel, ×
	await guard("resize", async () => {
		const { probe, root } = await open("resize");
		checkShell(add, "resize", root);
		const w = root.querySelector<HTMLInputElement>("#notebook-resize-width")!;
		const h = root.querySelector<HTMLInputElement>("#notebook-resize-height")!;
		add("resize: opens with the current size", w.value === "240.5" && h.value === "120.25", `${w.value} x ${h.value}`);
		type(w, "120.25");
		add("resize: with the lock on the height follows", Math.abs(Number(h.value) - 60.13) < 0.02, h.value);
		tap(buttonByText(root, "Apply"));
		await frames(1);
		const got = probe.picked[0] as { width: number; height: number } | undefined;
		add("resize: Apply gives the size back and closes", !!got && Math.abs(got.width - 120.25) < 0.01 && !document.body.contains(root), JSON.stringify(got));
		const again = await open("resize");
		type(again.root.querySelector<HTMLInputElement>("#notebook-resize-width"), "0");
		tap(buttonByText(again.root, "Apply"));
		add("resize: a zero size shows the problem and does not apply", !again.root.querySelector(".notebook-resize-error")?.classList.contains("notebook-hidden") && again.probe.picked.length === 0);
		tap(buttonByText(again.root, "Cancel"));
		await frames(1);
		add("resize: Cancel applies nothing", again.probe.picked.length === 0);
		closeModal();
		const third = await open("resize");
		await closeWithX(third.root);
		add("resize: × closes without applying", third.probe.picked.length === 0);
		closeModal();
	});

	// --- style picker
	await guard("style picker", async () => {
		const { probe, root } = await open("style");
		checkShell(add, "style", root, { footer: false });
		const rows = [...root.querySelectorAll<HTMLElement>("button.notebook-style-row")];
		add("style: lists tools, colours and pairs with their counts", rows.length === 8 && rows[0]?.querySelector(".nb-modal-row-count")?.textContent === "12", `${rows.length} rows`);
		add("style: colour rows carry their colour", root.querySelectorAll(".nb-modal-dot").length === 6);
		const hl = rows.find((r) => r.textContent?.startsWith("Highlighter"));
		tap(hl ?? null);
		await frames(1);
		add("style: a row selects at once and closes", JSON.stringify(probe.picked[0]) === JSON.stringify({ tool: "highlighter" }), JSON.stringify(probe.picked));
		closeModal();
	});

	// --- export
	await guard("export", async () => {
		const { probe, root } = await open("export");
		checkShell(add, "export", root);
		const selects = [...root.querySelectorAll("select")] as HTMLSelectElement[];
		add("export: format, pages, layers and scale choices are there", selects.length === 4, String(selects.length));
		add("export: the primary button exports", !!buttonByText(root, "Export"));
		tap(buttonByText(root, "Export"));
		await frames(1);
		const req = probe.picked[0] as ExportRequest | undefined;
		add("export: Export runs the request and closes", req?.format === "pdf" && req.scope === "notebook" && req.pageIndex === 1, JSON.stringify(req));
		closeModal();
		const png = await open("export-png");
		checkShell(add, "export (PNG)", png.root);
		const rows = [...png.root.querySelectorAll<HTMLElement>(".setting-item")];
		const shown = (re: RegExp) => rows.some((r) => re.test(r.querySelector(".setting-item-name")?.textContent ?? "") && r.style.display !== "none");
		add("export (PNG): the folder and the scale are shown, the range is not", shown(/^Folder/) && shown(/^Scale/) && !shown(/^Pages/));
		const scope = png.root.querySelectorAll("select")[1] as HTMLSelectElement;
		scope.value = "range";
		scope.dispatchEvent(new Event("change"));
		type(rows.find((r) => /^Pages/.test(r.querySelector(".setting-item-name")?.textContent ?? ""))?.querySelector("input") ?? null, "9");
		tap(buttonByText(png.root, "Export"));
		add("export (PNG): a missing page is refused in the dialog", /Page 9 does not exist/.test(png.root.querySelector(".notebook-export-problem")?.textContent ?? "") && png.probe.picked.length === 0, png.root.querySelector(".notebook-export-problem")?.textContent ?? "");
		tap(buttonByText(png.root, "Cancel"));
		await frames(1);
		add("export (PNG): Cancel closes", !png.root.isConnected || !document.body.contains(png.root));
		closeModal();
		const md = await open("markdown");
		checkShell(add, "markdown", md.root);
		tap(buttonByText(md.root, "Export"));
		await frames(1);
		add("markdown: Export runs with the folder and the resolution", (md.probe.picked[0] as { folder?: string } | undefined)?.folder === "Notebooks/Demo (MD)", JSON.stringify(md.probe.picked));
		closeModal();
	});

	// --- PDF range
	await guard("PDF range", async () => {
		const { probe, root } = await open("pdf-range");
		checkShell(add, "pdf-range", root);
		const toggle = root.querySelector<HTMLElement>(".checkbox-container");
		tap(toggle);
		const inputs = [...root.querySelectorAll<HTMLInputElement>("input[type='number']")];
		add("pdf-range: the range fields wake up when All pages is off", inputs.length === 2 && inputs.every((i) => !i.disabled));
		type(inputs[0] ?? null, "3");
		type(inputs[1] ?? null, "5");
		const insert = [...root.querySelectorAll<HTMLButtonElement>(".nb-modal-foot button")].find((b) => b.classList.contains("is-primary"));
		tap(insert ?? null);
		await probe.ask;
		add("pdf-range: Insert resolves the range", JSON.stringify(probe.picked[0]) === JSON.stringify({ from: 3, to: 5 }), JSON.stringify(probe.picked[0]));
		closeModal();
		const second = await open("pdf-range");
		await closeWithX(second.root);
		await second.probe.ask;
		add("pdf-range: × resolves null", second.probe.picked[0] === null, JSON.stringify(second.probe.picked));
		closeModal();
	});

	// --- practice
	await guard("practice", async () => {
		const { probe, root } = await open("practice");
		checkShell(add, "practice", root);
		const create = [...root.querySelectorAll<HTMLButtonElement>(".nb-modal-foot button")].find((b) => b.classList.contains("is-primary"))!;
		add("practice: Create is on for hiding all the ink", !create.disabled);
		const select = root.querySelector<HTMLSelectElement>("select")!;
		select.value = "some";
		select.dispatchEvent(new Event("change"));
		add("practice: hiding some ink needs a choice first", create.disabled && !root.querySelector(".notebook-practice-filters")?.classList.contains("notebook-hidden"));
		const chip = root.querySelector<HTMLElement>(".notebook-practice-chip");
		const box = chip?.querySelector<HTMLInputElement>("input");
		if (box) {
			box.checked = true;
			box.dispatchEvent(new Event("change"));
		}
		add("practice: a chip turns on and wakes Create", chip?.classList.contains("is-on") === true && !create.disabled);
		tap(create);
		await probe.redo;
		const choice = probe.picked[0] as RedoChoice | null | undefined;
		add("practice: Create resolves what to hide", !!choice && !!choice.spec.colors?.length, JSON.stringify(choice?.spec));
		closeModal();
		const att = await open("attempts");
		checkShell(add, "attempts", att.root, { footer: false });
		tap(att.root.querySelectorAll<HTMLElement>("button.notebook-practice-row")[1] ?? null);
		await frames(1);
		add("attempts: a row opens that attempt and closes", att.probe.events[0] === "attempt 1", att.probe.events.join());
		closeModal();
	});

	// --- lecture
	await guard("lecture", async () => {
		const { probe, root } = await open("lecture");
		checkShell(add, "lecture", root);
		tap([...root.querySelectorAll<HTMLButtonElement>(".nb-modal-foot button")].find((b) => b.classList.contains("is-primary")) ?? null);
		await probe.ask;
		const setup = probe.picked[0] as { title?: string } | null | undefined;
		add("lecture: Create resolves the setup", !!setup && setup.title === "Fisiologia – lezione 4", JSON.stringify(setup));
		closeModal();
		const layout = await open("layout");
		checkShell(add, "layout", layout.root);
		tap([...layout.root.querySelectorAll<HTMLButtonElement>(".nb-modal-foot button")].find((b) => b.classList.contains("is-primary")) ?? null);
		await layout.probe.ask;
		add("layout: Apply resolves the layout", !!layout.probe.picked[0]);
		closeModal();
		const paper = await open("exercise-paper");
		checkShell(add, "exercise-paper", paper.root);
		await closeWithX(paper.root);
		await paper.probe.ask;
		add("exercise-paper: × resolves null", paper.probe.picked[0] === null);
		closeModal();
	});

	// --- new notebook (kept dialog)
	await guard("new notebook (kept dialog)", async () => {
		const { probe, root } = await open("new-notebook");
		checkShell(add, "new-notebook", root);
		tap([...root.querySelectorAll<HTMLButtonElement>(".nb-modal-foot button")].find((b) => b.classList.contains("is-primary")) ?? null);
		await frames(1);
		add("new-notebook: Create hands the options back", probe.picked.length === 1);
		closeModal();
	});

	// --- pen test, paste, clips
	await guard("pen test, paste, clips", async () => {
		const { root } = await open("pen-test");
		checkShell(add, "pen-test", root);
		add("pen-test: the test area, the log and the Copy / Clear buttons are there", !!root.querySelector(".notebook-pentest-area") && !!root.querySelector("textarea.notebook-pentest-log") && !!buttonByText(root, "Clear log") && !!buttonByText(root, "Copy log"));
		closeModal();
		const paste = await open("paste");
		checkShell(add, "paste", paste.root);
		const box = paste.root.querySelector<HTMLElement>(".notebook-paste-box");
		add("paste: the paste box is a real, labelled textbox", box?.getAttribute("role") === "textbox" && !!box.getAttribute("aria-label"));
		tap(buttonByText(paste.root, "Cancel"));
		await frames(1);
		add("paste: Cancel closes", !document.body.contains(paste.root));
		closeModal();
		const clips = await open("clips");
		checkShell(add, "clips", clips.root, { footer: false });
		add("clips: one row per clipboard, newest first", clips.root.querySelectorAll("button.notebook-clipshare-row").length === 2);
		tap(clips.root.querySelector("button.notebook-clipshare-row"));
		await frames(1);
		add("clips: a row pastes that clipboard", clips.probe.picked.length === 1);
		closeModal();
	});

	// --- find, confirm
	await guard("find, confirm", async () => {
		const { root } = await open("find");
		checkShell(add, "find", root);
		const find = root.querySelector<HTMLInputElement>("#notebook-find-input");
		add("find: the Find and Replace fields and both options are there", !!find && !!root.querySelector("#notebook-replace-input") && root.querySelectorAll(".nb-modal-check").length === 2);
		add("find: Replace and Replace all wait for a match", [...root.querySelectorAll<HTMLButtonElement>(".nb-modal-foot button")].every((b) => b.disabled));
		closeModal();
		const confirm = await open("confirm");
		checkShell(add, "confirm", confirm.root);
		add("confirm: a danger button names the action", !!confirm.root.querySelector(".nb-modal-foot .is-danger")?.textContent);
		tap(buttonByText(confirm.root, "Cancel"));
		await frames(1);
		add("confirm: Cancel does nothing", confirm.probe.events.length === 0 && !document.body.contains(confirm.root));
		closeModal();
		const again = await open("confirm");
		tap(again.root.querySelector(".nb-modal-foot .is-danger"));
		await frames(1);
		add("confirm: the danger button confirms once", again.probe.events.join() === "confirmed");
		closeModal();
	});

	// --- prompt
	await guard("prompt", async () => {
		const { root } = await open("goto");
		add("goto: the prompt is on the shell with a header", root.matches(".modal.nb-prompt.nb-ui") && !!root.querySelector(".nb-modal-head.is-prompt .nb-modal-title")?.textContent, root.className);
		add("goto: the header is above the input", root.firstElementChild?.classList.contains("nb-modal-head") === true);
		add("goto: the bookmarks are listed with their page", root.querySelectorAll(".suggestion-item").length >= 2);
		const grey = obsidianStyledButtons(root);
		add("goto: no button shows Obsidian's default look", grey.length === 0);
		closeModal();
	});

	// --- cards
	await guard("cards", async () => {
		const picker = await open("colour-picker");
		const card = picker.root.querySelector<HTMLElement>(".notebook-colour-picker")!;
		add("colour-picker: a design-system card", card.matches(".nb-ui.nb-card"));
		const recent = card.querySelectorAll<HTMLElement>(".notebook-colour-recent-swatch");
		add("colour-picker: the recent colours are 32 px round swatches", recent.length === 4 && recent[0]!.getBoundingClientRect().width >= 31.5);
		tap(recent[1] ?? null);
		add("colour-picker: a recent colour is picked", (picker.probe.picked[picker.probe.picked.length - 1] as { hex?: string } | undefined)?.hex === "#16c2a3", JSON.stringify(picker.probe.picked[picker.probe.picked.length - 1]));
		const buttons = [...card.querySelectorAll<HTMLElement>(".notebook-colour-button")];
		add("colour-picker: the eyedropper and close buttons are 40 px", buttons.length === 2 && buttons.every((b) => b.getBoundingClientRect().width >= 39.5));
		tap(buttons[1] ?? null);
		add("colour-picker: close asks to close", picker.probe.events.includes("close"));
		add("colour-picker: no button shows Obsidian's default look", obsidianStyledButtons(card).length === 0);
		closeModal();
		const eq = await open("equation");
		const ec = eq.root.querySelector<HTMLElement>(".notebook-eq-editor")!;
		add("equation: a design-system card", ec.matches(".nb-ui.nb-card.nb-eq-card"));
		add("equation: Cancel, Done and Delete are there", !!buttonByText(ec, "Cancel") && !!buttonByText(ec, "Done") && !!ec.querySelector(".notebook-eq-delete"));
		const small = [...ec.querySelectorAll<HTMLElement>("button")].filter((b) => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height) < 39.5);
		add("equation: every button is at least 40 px", small.length === 0, small.map((b) => b.className).join(", "));
		add("equation: no button shows Obsidian's default look", obsidianStyledButtons(ec).length === 0);
		tap(ec.querySelectorAll<HTMLElement>(".notebook-eq-toggle")[1] ?? null);
		tap(buttonByText(ec, "Done"));
		add("equation: Done gives the draft with Numbered on", (eq.probe.picked[0] as EquationDraft | undefined)?.numbered === true, JSON.stringify(eq.probe.picked[0]));
		closeModal();
		const st = await open("stamps");
		const sp = st.root.querySelector<HTMLElement>(".notebook-stamp-panel")!;
		add("stamps: a design-system card with the built-in stamps", sp.matches(".nb-ui.nb-card") && sp.querySelectorAll(".notebook-stamp-tile").length === 3, String(sp.querySelectorAll(".notebook-stamp-tile").length));
		const headButtons = [...sp.querySelectorAll<HTMLElement>(".notebook-stamp-head button")];
		add("stamps: Save and Close are 40 px round buttons", headButtons.length === 2 && headButtons.every((b) => b.getBoundingClientRect().width >= 39.5));
		tap(headButtons[1] ?? null);
		add("stamps: Close hides the palette", sp.classList.contains("notebook-hidden"));
		closeModal();
	});

	add("nothing is left open", modalCount() === 0, String(modalCount()));
	closeModal();
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio } };
}

/** What the harness page exposes (wired in harness.ts with one line). */
export function modalsApi(api: ModalsCheckApi): Record<string, unknown> {
	return {
		checkModals: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkModals(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`modals check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		modalShot: (name: ModalName) => modalShot(api, name),
		closeModal,
		modalNames: [...MODAL_NAMES],
	};
}
