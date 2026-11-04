import { normalizePath, type App } from "obsidian";
import { t } from "../i18n";
import { checkboxAt, checkboxFromStroke, checkboxLabelBounds, checkboxLabelInk, type DetectedSquare } from "../ink/checklist";
import type { BBox } from "../ink/hit-test";
import {
	blockIdFor, CHECKBOX_DEFAULT_COLOR, checkboxesOf, createCheckbox, setTaskLineChecked,
} from "../model/checklist";
import { setCheckboxLabel, setCheckboxTask, toggleCheckbox } from "../model/checklist-commands";
import { createId } from "../model/document";
import { AddElement, Batch, ReplaceStroke, type Command } from "../model/history";
import type { CheckboxElement, CheckboxTask, NotebookDocument, Page, PageElement, Stroke } from "../model/types";
import type { NotebookSettings } from "../settings";
import { chip } from "../ui/components/chip";
import { ChecklistLabelModal } from "./checklist-modal";
import { showNotice } from "./notice";
import { MakeTaskModal, type TaskRequest } from "./selection-task";

/**
 * View side of handwritten checklists (0.19, roadmap #103): a tap on a checkbox ticks it, a small square drawn with the pen is offered
 * (or turned) into a checkbox, a checkbox can be inserted from the sheet, labelled, sent to the tasks of a note and unlinked, and the
 * ticks of linked checkboxes follow into the task lines of their notes. The rules are in model/checklist.ts and ink/checklist.ts
 * (pure); every change here is one undo step through the view's history, which also refuses it on a locked page. The view passes
 * itself as a ChecklistHost.
 *
 * The link to a task: a ticked or unticked checkbox with a `task` link is written into the one line of that note that ends with the
 * block id the plugin added (`setTaskLineChecked`, through `vault.process`); no other line is ever touched, and when the line is
 * gone the checkbox is unlinked. The line follows the checkbox whatever changed it (a tap, undo, redo, a merge): `reconcile` compares
 * each linked checkbox with what was last written.
 */
export interface ChecklistHost {
	readonly app: App;
	stage(): HTMLElement;
	doc(): NotebookDocument | null;
	/** The document can be edited now (not read-only, not being drawn on). */
	editable(): boolean;
	/** Runs a command as one undo step (false when it was refused: a locked page, a read-only notebook). */
	execute(cmd: Command): boolean;
	settings(): NotebookSettings;
	/** The active tool name. */
	tool(): string;
	/** CSS px per pt. */
	scale(): number;
	/** Page-local point to stage pixels; null when the page is not laid out. */
	toStage(pageIndex: number, x: number, y: number): [number, number] | null;
	/** The page and page-local point under a client position; null off the pages. */
	pageAt(clientX: number, clientY: number): { pageIndex: number; local: [number, number] } | null;
	/** A finger tap would pan, not draw (so it can tick a checkbox). */
	fingerNavigates(e: PointerEvent): boolean;
	/** Page in view and the page point at the centre of the view. */
	insertTarget(): { pageIndex: number; x: number; y: number } | null;
	selection(): { pageIndex: number; strokes: readonly Stroke[]; elements: readonly PageElement[] } | null;
	/** Selects these items (the lasso tool, so the contextual bar and the handles appear). */
	select(pageIndex: number, strokes: Stroke[], elements: PageElement[]): void;
	penColor(): string;
	/** The strokes of the page that are in view (invisible ink and the ink of collapsed notes left out). */
	inkOf(page: Page): readonly Stroke[];
	/** Writes the task line (with a picture of `bounds` and a link to the page) and returns the note's path; null when nothing was written. */
	sendTask(pageIndex: number, bounds: BBox, request: TaskRequest): Promise<string | null>;
	refresh(): void;
}

/** Contact moved further than this (CSS px): a drag, not a tap. */
const TAP_SLOP_PX = 8;
/** Longest contact that still counts as a tap, ms. */
const TAP_MS = 500;
/** A finger that moves farther than this (CSS px) or stays longer (ms) is not tapping. */
const FINGER_SLOP = 10;
const FINGER_MS = 450;
/** How long the chip offering a checkbox stays, ms. */
const OFFER_MS = 9000;
/** A square drawn with "make it a checkbox" waits this long, so a side-button retraction or the next stroke can come first, ms. */
const AUTO_DELAY_MS = 450;
/** After this many offers in a row that nobody took, none is made until a checkbox is made or the notebook is opened again. */
const MAX_IGNORED = 3;
/** The task lines are brought up to date this long after the last change, ms. */
const SYNC_MS = 700;
/** Events a floating control must not leak to the page below: they would start strokes or pans. */
const ISOLATED = ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "wheel", "contextmenu", "mousedown"] as const;

/** A contact that started on a checkbox: a tap if it lifts soon without moving, otherwise ordinary ink (never taken). */
interface Contact {
	pageId: string;
	target: CheckboxElement;
	sx: number;
	sy: number;
	t: number;
}

interface Offer {
	pageIndex: number;
	pageId: string;
	strokeId: string;
	square: DetectedSquare;
}

export type SyncResult = "ok" | "missing" | "error";

export class ChecklistTools {
	private contact: Contact | null = null;
	private offer: Offer | null = null;
	private chipEl: HTMLElement | null = null;
	private chipTimer: number | null = null;
	private autoTimer: number | null = null;
	private ignored = 0;
	/** The tick last written to the task line of each linked checkbox (by element id). */
	private readonly synced = new Map<string, boolean>();
	private syncTimer: number | null = null;
	private syncing = false;
	private syncAgain = false;
	private fingerTap: { id: number; x: number; y: number; t: number } | null = null;
	private readonly off: Array<() => void> = [];

	constructor(private readonly host: ChecklistHost) {
		const stage = host.stage();
		this.listen(stage, "pointerdown", (e) => this.onFingerDown(e as PointerEvent), true);
		this.listen(stage, "pointerup", (e) => this.onFingerUp(e as PointerEvent));
		this.listen(stage, "pointercancel", () => (this.fingerTap = null));
		this.baseline();
	}

	private listen(el: HTMLElement, type: string, fn: (e: Event) => void, capture = false): void {
		el.addEventListener(type, fn, capture);
		this.off.push(() => el.removeEventListener(type, fn, capture));
	}

	destroy(): void {
		for (const o of this.off.splice(0)) o();
		this.hideOffer();
		if (this.autoTimer !== null) window.clearTimeout(this.autoTimer);
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
		this.autoTimer = null;
		this.syncTimer = null;
		this.contact = null;
		this.synced.clear();
	}

	/** Another document was loaded: forget what belonged to the previous one, and take the ticks of this one as already written. */
	reset(): void {
		this.hideOffer();
		if (this.autoTimer !== null) window.clearTimeout(this.autoTimer);
		this.autoTimer = null;
		this.contact = null;
		this.ignored = 0;
		this.baseline();
	}

	private baseline(): void {
		this.synced.clear();
		for (const page of this.host.doc()?.pages ?? []) for (const c of checkboxesOf(page)) if (c.task) this.synced.set(c.id, c.checked === true);
	}

	// ------------------------------------------------------------------ taps

	/**
	 * Pen, mouse or finger-that-draws down at `local` on page `pageIndex`. A contact on a checkbox (any tool but the lasso, the eraser,
	 * text, shapes and space, which have their own taps) is only noted: it goes on as ink, and `takeTap` says at the end whether it was
	 * a tap. Always false: the contact is never ours until it is over.
	 */
	begin(page: Page, local: [number, number], screen: { x: number; y: number; t: number }, tool: string): boolean {
		this.contact = null;
		if ((tool !== "pen" && tool !== "highlighter") || !this.host.editable()) return false;
		const hit = checkboxAt(page.elements ?? [], local[0], local[1], this.host.scale());
		if (hit) this.contact = { pageId: page.id, target: hit, sx: screen.x, sy: screen.y, t: screen.t };
		return false;
	}

	/** The contact moved (stage px): a contact on a checkbox that moves is ink from now on. */
	watch(screen: { x: number; y: number } | null): void {
		const c = this.contact;
		if (c && screen && Math.hypot(screen.x - c.sx, screen.y - c.sy) > TAP_SLOP_PX) this.contact = null;
	}

	/**
	 * The contact ended: the checkbox that was tapped (short, unmoved, not cancelled), or null. The view then discards the dot the tap
	 * would have left and ticks it; any other contact stays the ink it was. `extentPx`: how far what the contact drew reaches.
	 */
	takeTap(cancelled: boolean, now: number, extentPx: () => number): CheckboxElement | null {
		const c = this.contact;
		this.contact = null;
		if (!c || cancelled || now - c.t > TAP_MS || extentPx() > TAP_SLOP_PX) return null;
		const page = this.host.doc()?.pages.find((p) => p.id === c.pageId);
		return page?.elements?.includes(c.target) ? c.target : null;
	}

	/** Ticks or unticks `target` (one undo step). */
	toggle(target: CheckboxElement): void {
		const page = this.host.doc()?.pages.find((p) => p.elements?.includes(target));
		if (!page || !this.host.editable()) return;
		if (this.host.execute(toggleCheckbox(page.id, target.id, Date.now()))) {
			try {
				window.navigator.vibrate?.(8);
			} catch {
				// Vibration is optional.
			}
			this.host.refresh();
		}
	}

	private onFingerDown(e: PointerEvent): void {
		this.fingerTap = null;
		if (e.pointerType !== "touch" || !e.isPrimary || !this.host.editable()) return;
		const tool = this.host.tool();
		if ((tool !== "pen" && tool !== "highlighter") || !this.host.fingerNavigates(e)) return;
		this.fingerTap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
	}

	private onFingerUp(e: PointerEvent): void {
		const tap = this.fingerTap;
		this.fingerTap = null;
		if (!tap || tap.id !== e.pointerId || e.timeStamp - tap.t > FINGER_MS) return;
		if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > FINGER_SLOP) return;
		const at = this.host.pageAt(e.clientX, e.clientY);
		const page = at ? this.host.doc()?.pages[at.pageIndex] : undefined;
		if (!at || !page) return;
		const hit = checkboxAt(page.elements ?? [], at.local[0], at.local[1], this.host.scale());
		if (hit) this.toggle(hit);
	}

	// ------------------------------------------------------------------ a square drawn by hand

	/** The pen went down: the chip offered for the last square goes away (writing on is how its label gets written). */
	strokeStarted(): void {
		if (this.offer) this.noteIgnored();
		this.hideOffer();
	}

	/** The view moved or zoomed: the chip would point at the wrong place. */
	viewChanged(): void {
		if (this.chipEl) this.hideOffer();
	}

	/** A page was left, or another document opened. */
	cancelOffer(): void {
		this.hideOffer();
	}

	/**
	 * Strokes were added to page `pageIndex` by the pen. A single closed stroke that is clearly a small square is offered as a
	 * checkbox (a chip near it) or, with the setting "make it a checkbox", turned into one after a moment. `tool` strokes of the shape
	 * tool and invisible ink are left alone: they are drawn on purpose.
	 */
	strokesAdded(pageIndex: number, strokes: readonly Stroke[]): void {
		const mode = this.host.settings().checklistDraw;
		if (mode === "off" || strokes.length !== 1 || !this.host.editable()) return;
		const stroke = strokes[0]!;
		const page = this.host.doc()?.pages[pageIndex];
		if (!page || stroke.hidden || stroke.tool === "highlighter" || !page.strokes.includes(stroke)) return;
		if (this.ignored >= MAX_IGNORED) return;
		const square = checkboxFromStroke(stroke.points);
		if (!square) return;
		const offer: Offer = { pageIndex, pageId: page.id, strokeId: stroke.id, square };
		if (mode === "auto") {
			this.hideOffer();
			if (this.autoTimer !== null) window.clearTimeout(this.autoTimer);
			this.autoTimer = window.setTimeout(() => {
				this.autoTimer = null;
				this.convert(offer, false);
			}, AUTO_DELAY_MS);
			return;
		}
		this.offer = offer;
		this.showChip();
	}

	private showChip(): void {
		const o = this.offer;
		if (!o) return;
		const at = this.host.toStage(o.pageIndex, o.square.x + o.square.size / 2, o.square.y + o.square.size);
		if (!at) return;
		if (!this.chipEl) {
			const holder = this.host.stage().createDiv({ cls: "nb-ui nb-chk-offer", attr: { role: "group", "aria-label": t("checklist.offer.aria") } });
			for (const type of ISOLATED) holder.addEventListener(type, (e) => e.stopPropagation());
			chip(holder, { label: t("checklist.offer"), icon: "square-check", key: "checklist-offer", title: t("checklist.offer.aria"), onClick: () => this.accept() });
			this.chipEl = holder;
		}
		this.chipEl.setCssProps({ "--nb-chk-x": `${Math.round(at[0])}px`, "--nb-chk-y": `${Math.round(at[1]) + 10}px` });
		if (this.chipTimer !== null) window.clearTimeout(this.chipTimer);
		this.chipTimer = window.setTimeout(() => {
			this.chipTimer = null;
			if (this.offer) this.noteIgnored();
			this.hideOffer();
		}, OFFER_MS);
	}

	private noteIgnored(): void {
		this.ignored++;
	}

	private hideOffer(): void {
		if (this.chipTimer !== null) window.clearTimeout(this.chipTimer);
		this.chipTimer = null;
		this.chipEl?.remove();
		this.chipEl = null;
		this.offer = null;
	}

	private accept(): void {
		const o = this.offer;
		this.hideOffer();
		if (o) this.convert(o, true);
	}

	/**
	 * Replaces the square stroke with a checkbox of its place, size and colour, in one undo step. Nothing happens when the stroke is
	 * gone, the page changed, or (automatic mode) ink was drawn inside the square since: a tick across it is not a checkbox.
	 */
	private convert(o: Offer, said: boolean): void {
		const doc = this.host.doc();
		const page = doc?.pages[o.pageIndex];
		if (!doc || !page || page.id !== o.pageId || !this.host.editable()) return;
		const index = page.strokes.findIndex((s) => s.id === o.strokeId);
		const stroke = page.strokes[index];
		if (!stroke) return;
		if (!said && page.strokes.slice(index + 1).some((s) => this.inside(s, o.square))) return;
		const color = /^#[0-9a-fA-F]{6}$/.test(stroke.color) ? stroke.color : CHECKBOX_DEFAULT_COLOR;
		const box: CheckboxElement = { id: createId(), type: "checkbox", x: o.square.x, y: o.square.y, size: o.square.size, color };
		const cmd = new Batch("Make checkbox", [new ReplaceStroke(page.id, stroke, [], index), new AddElement(page.id, box, page.elements?.length ?? 0)]);
		if (!this.host.execute(cmd)) return;
		this.ignored = 0;
		this.host.refresh();
		if (said) showNotice(t("checklist.made"), 2500);
	}

	/** Whether any point of `stroke` lies inside the square (grown a little). */
	private inside(stroke: Stroke, sq: DetectedSquare): boolean {
		const pad = sq.size * 0.15;
		return stroke.points.some(([x, y]) => x >= sq.x - pad && x <= sq.x + sq.size + pad && y >= sq.y - pad && y <= sq.y + sq.size + pad);
	}

	// ------------------------------------------------------------------ the actions

	/** "Insert checkbox": an unticked checkbox at the centre of the view, selected, ready to be moved or scaled. */
	insert(): void {
		if (!this.host.editable()) return;
		const target = this.host.insertTarget();
		const page = target ? this.host.doc()?.pages[target.pageIndex] : undefined;
		if (!target || !page) return;
		const color = /^#[0-9a-fA-F]{6}$/.test(this.host.penColor()) ? this.host.penColor() : CHECKBOX_DEFAULT_COLOR;
		const box = createCheckbox(target.x, target.y, page, color);
		if (!this.host.execute(new AddElement(page.id, box, page.elements?.length ?? 0))) return;
		this.ignored = 0;
		this.host.select(target.pageIndex, [], [box]);
		this.host.refresh();
	}

	/** The checkboxes of the selection and their page (null when it holds none, or the page is gone). */
	private selected(): { pageIndex: number; page: Page; boxes: CheckboxElement[] } | null {
		const sel = this.host.selection();
		const page = sel ? this.host.doc()?.pages[sel.pageIndex] : undefined;
		if (!sel || !page) return null;
		const boxes = sel.elements.filter((e): e is CheckboxElement => e.type === "checkbox" && !!page.elements?.includes(e));
		return boxes.length > 0 ? { pageIndex: sel.pageIndex, page, boxes } : null;
	}

	/** Ticks or unticks every selected checkbox (each is its own undo step... as one: a batch). */
	toggleSelected(): void {
		const s = this.selected();
		if (!s || !this.host.editable()) return;
		const at = Date.now();
		const steps = s.boxes.map((b) => toggleCheckbox(s.page.id, b.id, at));
		this.host.execute(steps.length === 1 ? steps[0]! : new Batch("Toggle checkboxes", steps));
		this.reselect(s.pageIndex, s.page, s.boxes.map((b) => b.id));
		this.host.refresh();
	}

	/** Selects again, by id, the checkboxes a command replaced (they are new objects). */
	private reselect(pageIndex: number, page: Page, ids: readonly string[]): void {
		const boxes = checkboxesOf(page).filter((c) => ids.includes(c.id));
		if (boxes.length > 0) this.host.select(pageIndex, [], boxes);
	}

	/** "Select with text": the checkbox together with the handwriting on its line. */
	selectWithLabel(): void {
		const s = this.selected();
		if (!s || s.boxes.length !== 1) return;
		const box = s.boxes[0]!;
		const ink = checkboxLabelInk(box, this.host.inkOf(s.page), checkboxesOf(s.page));
		this.host.select(s.pageIndex, [...ink], [box]);
	}

	/** "Label…": the typed name of the one selected checkbox. */
	editLabel(): void {
		const s = this.selected();
		if (!s || s.boxes.length !== 1 || !this.host.editable()) return;
		const box = s.boxes[0]!;
		new ChecklistLabelModal(this.host.app, box.label ?? "", (label) => {
			if (!this.host.execute(setCheckboxLabel(s.page.id, box.id, label))) return;
			this.reselect(s.pageIndex, s.page, [box.id]);
			this.host.refresh();
		}).open();
	}

	/** "Send to tasks…": the one selected checkbox becomes a task line in a note; ticking either one ticks the other. */
	sendTask(): void {
		const s = this.selected();
		if (!s || s.boxes.length !== 1) {
			showNotice(t("checklist.task.none"), 4000);
			return;
		}
		if (!this.host.editable()) return;
		const box = s.boxes[0]!;
		if (box.task) {
			showNotice(t("checklist.task.already", { path: box.task.path }), 6000);
			return;
		}
		const bounds = checkboxLabelBounds(box, this.host.inkOf(s.page), checkboxesOf(s.page));
		const block = blockIdFor(box, Date.now().toString(36));
		new MakeTaskModal(
			this.host.app, this.host.settings(), s.pageIndex + 1,
			(request) => void this.finishSend(s.pageIndex, s.page.id, box.id, bounds, request, block),
			{ allowEmpty: true, title: t("checklist.task.title"), desc: t("checklist.task.desc", { page: String(s.pageIndex + 1) }), text: box.label ?? "", buttonLabel: t("checklist.task.make"), block },
		).open();
	}

	private async finishSend(pageIndex: number, pageId: string, id: string, bounds: BBox, request: TaskRequest, block: string): Promise<void> {
		const path = await this.host.sendTask(pageIndex, bounds, request);
		if (!path) return;
		const page = this.host.doc()?.pages.find((p) => p.id === pageId);
		const box = page ? checkboxesOf(page).find((c) => c.id === id) : undefined;
		if (!page || !box || !this.host.editable()) return;
		const link: CheckboxTask = { path, block };
		const steps: Command[] = [setCheckboxTask(page.id, id, link)];
		if (request.text !== "" && box.label === undefined) steps.push(setCheckboxLabel(page.id, id, request.text));
		// The line was written unticked: a checkbox that is ticked already brings it up to date at the next sync.
		this.synced.set(id, false);
		if (!this.host.execute(steps.length === 1 ? steps[0]! : new Batch("Link checkbox to task", steps))) {
			this.synced.delete(id);
			return;
		}
		this.host.refresh();
	}

	/** "Unlink task": the selected checkboxes stop following their task lines (the lines stay in their notes as they are). */
	unlinkSelected(): void {
		const s = this.selected();
		if (!s || !this.host.editable()) return;
		const linked = s.boxes.filter((b) => b.task);
		if (linked.length === 0) return;
		const steps = linked.map((b) => setCheckboxTask(s.page.id, b.id, null));
		if (!this.host.execute(steps.length === 1 ? steps[0]! : new Batch("Unlink checkboxes", steps))) return;
		for (const b of linked) this.synced.delete(b.id);
		this.reselect(s.pageIndex, s.page, s.boxes.map((b) => b.id));
		this.host.refresh();
		showNotice(t("checklist.unlinked"), 3500);
	}

	// ------------------------------------------------------------------ the task lines

	/** The document changed (a tap, undo, redo, a merge, a reload): the task lines are brought up to date a moment later. */
	docChanged(): void {
		if (this.syncTimer !== null) return;
		this.syncTimer = window.setTimeout(() => {
			this.syncTimer = null;
			void this.reconcile();
		}, SYNC_MS);
	}

	/**
	 * Writes the tick of every linked checkbox that differs from what was last written into its task line. A line that is gone
	 * unlinks the checkbox (one undo step, and a notice); a note that cannot be written is retried at the next change. Never throws.
	 */
	async reconcile(): Promise<void> {
		if (this.syncing) {
			this.syncAgain = true;
			return;
		}
		this.syncing = true;
		try {
			do {
				this.syncAgain = false;
				const doc = this.host.doc();
				if (!doc) break;
				for (const page of doc.pages) {
					for (const box of checkboxesOf(page)) {
						if (!box.task) continue;
						const want = box.checked === true;
						const had = this.synced.get(box.id);
						if (had === undefined) {
							// Linked after the document was opened (a merge, an undo): what the line says is not known, so it is left alone.
							this.synced.set(box.id, want);
							continue;
						}
						if (had === want) continue;
						const result = await this.writeLine(box.task, want);
						if (result === "ok") this.synced.set(box.id, want);
						else if (result === "missing") this.lineGone(page.id, box);
					}
				}
			} while (this.syncAgain);
		} catch (e) {
			console.error("[notebook] checklist sync", e);
		} finally {
			this.syncing = false;
		}
	}

	private lineGone(pageId: string, box: CheckboxElement): void {
		this.synced.delete(box.id);
		const path = box.task?.path ?? "";
		if (this.host.editable() && this.host.execute(setCheckboxTask(pageId, box.id, null))) this.host.refresh();
		showNotice(t("checklist.task.lineGone", { path }), 7000);
	}

	/** Sets the tick of the one task line of the note that ends with the block id; the rest of the note is never touched. */
	private async writeLine(task: CheckboxTask, checked: boolean): Promise<SyncResult> {
		const { app } = this.host;
		try {
			const file = app.vault.getFileByPath(normalizePath(task.path));
			if (!file) return "missing";
			const probe = setTaskLineChecked(await app.vault.read(file), task.block, checked);
			if (!probe.found) return "missing";
			if (!probe.changed) return "ok";
			let found = true;
			await app.vault.process(file, (current) => {
				const r = setTaskLineChecked(current, task.block, checked);
				found = r.found;
				return r.text;
			});
			return found ? "ok" : "missing";
		} catch (e) {
			console.error("[notebook] checklist task line", e);
			showNotice(t("checklist.task.syncFailed", { path: task.path, error: e instanceof Error ? e.message : String(e) }), 6000);
			return "error";
		}
	}
}
