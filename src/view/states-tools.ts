/**
 * Drawings with states, view side (0.15, roadmap 241). The model is in model/states.ts (parts of strokes, states, the
 * render-time transform); this is the small strip under the page that lists the states, switches and plays them, and the
 * part editor: a part is moved, turned and scaled in the state in view with the ordinary selection handles. The strokes
 * are never changed by a state; the renderer and the exports get `viewPages()` (live views of the pages) instead.
 *
 * How a part is edited: the part's strokes, as the state shows them, are selected (the lasso's own handles); when the drag
 * ends `commitTransform` turns the selection's matrix into the part's pose in that state (one `SetPageStates`, one undo
 * step) instead of rewriting the strokes. The ink tools skip the strokes a state has moved (`displaced`), because a hit at
 * the drawn spot would hit nothing the reader sees: switch to "As drawn" to edit the drawing itself.
 */
import { Menu, setIcon, type App } from "obsidian";
import { isIdentity, multiply, type Matrix } from "../ink/transform";
import { t } from "../i18n";
import { PromptModal } from "../library/library-modals";
import type { Command } from "../model/history";
import {
	addState, deleteState, displacedStrokeIds, dissolvePart, freshStateName, livingParts, makePart, partById, poseFromMatrix, poseIn, poseMatrix,
	renamePart, renameState, SetPageStates, shownStateId, stateById, stateView, steppedState, viewPages, withActive, withPose, type ShownStates,
} from "../model/states";
import type { NotebookDocument, Page, PageStates, PartPose, Stroke } from "../model/types";
import { showNotice } from "./notice";
import { PEN_COLORS } from "./toolbar";

/** What the tools need of the notebook view. */
export interface StatesHost {
	app: App;
	/** The element the strip floats in (the notebook body). */
	parent(): HTMLElement;
	doc(): NotebookDocument | null;
	/** The notebook can take changes (not read-only by the user, by sync safety or by a newer format). */
	editable(): boolean;
	pageIndex(): number;
	/** Runs a command as one undo step (clears the selection). */
	execute(cmd: Command): boolean;
	/** The renderer shows the pages again (a state was switched without a command). */
	repaint(): void;
	/** A change that is not an undo step (the state in view) has to be saved. */
	changed(): void;
	/** The ink in the selection that is on a page of the document. */
	selection(): { pageIndex: number; strokes: readonly Stroke[] } | null;
	select(pageIndex: number, strokes: Stroke[]): void;
	deselect(): void;
	refreshUi(): void;
}

/** Time a state stays on screen while the states play, ms. */
export const PLAY_STEP_MS = 1400;

interface PartEdit {
	pageId: string;
	partId: string;
	/** The part's strokes as the state shows them (the objects the renderer draws). */
	strokes: Stroke[];
}

export class StatesTools {
	private el: HTMLElement | null = null;
	private opened = false;
	private editing: PartEdit | null = null;
	/** The state each page is shown in when the view has chosen one (a read-only view, or while the states play). */
	private readonly shown = new Map<string, string | null>();
	private timer: number | null = null;
	/** The states still to show while playing (null: the drawing as drawn). */
	private queue: Array<string | null> | null = null;

	constructor(private readonly host: StatesHost) {}

	get open(): boolean {
		return this.opened;
	}

	get playingNow(): boolean {
		return this.timer !== null;
	}

	/** The state each page is shown in, for the renderer and the exports (`viewPages`). */
	get shownStates(): ShownStates {
		return this.shown;
	}

	/** The pages the renderer and the exports draw: live views of the pages that have states, the pages themselves otherwise. */
	viewPages(pages: readonly Page[]): readonly Page[] {
		return viewPages(pages, this.shown);
	}

	/** Strokes of `page` that the ink tools leave alone (a shown state moved them away from where they were drawn), or null. */
	displaced(page: Page): ReadonlySet<string> | null {
		return displacedStrokeIds(page, this.shown);
	}

	/** Whether this selection is the part editor's (its handles change the pose, not the strokes). */
	ownsSelection(sel: { strokes: readonly Stroke[] } | null): boolean {
		const e = this.editing;
		return !!e && !!sel && sel.strokes.length > 0 && sel.strokes.every((s) => e.strokes.includes(s));
	}

	// --- the strip ---

	toggle(): void {
		if (this.opened) this.close();
		else this.show();
	}

	show(): void {
		this.opened = true;
		this.render();
		this.host.refreshUi();
	}

	close(): void {
		this.stopPlaying(false);
		this.opened = false;
		this.editing = null;
		this.el?.remove();
		this.el = null;
		this.host.refreshUi();
	}

	destroy(): void {
		this.stopPlaying(false);
		this.el?.remove();
		this.el = null;
	}

	private page(): Page | null {
		return this.host.doc()?.pages[this.host.pageIndex()] ?? null;
	}

	/** Called when the document, the page in view or the selection changed. */
	refresh(): void {
		// A view that could not save chose its states itself; once it can edit again the saved ones rule.
		if (this.shown.size > 0 && this.host.editable() && !this.playingNow) {
			this.shown.clear();
			this.host.repaint();
		}
		if (!this.opened) return;
		const page = this.page();
		if (this.editing && this.editing.pageId !== page?.id) this.editing = null;
		this.render();
	}

	private shownId(page: Page): string | null {
		return shownStateId(page, this.shown);
	}

	private render(): void {
		const page = this.page();
		if (!this.opened || !page) {
			this.el?.hide();
			return;
		}
		const el = this.el ?? (this.el = this.host.parent().createDiv({ cls: "nb-states", attr: { role: "group", "aria-label": t("states.title") } }));
		el.show();
		el.empty();
		const states = page.states;
		const current = this.shownId(page);
		const editable = this.host.editable();
		const parts = livingParts(page);

		// States: close, chips, more, transport.
		const top = el.createDiv({ cls: "nb-states-row" });
		this.iconButton(top, "x", t("states.close"), () => this.close(), "nb-states-close");
		const chips = top.createDiv({ cls: "nb-states-chips", attr: { role: "toolbar", "aria-label": t("states.title") } });
		this.chip(chips, t("states.drawn"), current === null, () => this.switchTo(null));
		for (const st of states?.list ?? []) this.chip(chips, st.name, st.id === current, () => this.switchTo(st.id));
		const add = this.iconButton(chips, "plus", parts.length === 0 ? t("states.addNeedPart") : t("states.add"), () => this.addNewState(), "nb-states-add");
		add.disabled = !editable;
		add.toggleClass("is-dim", parts.length === 0);
		const hasStates = (states?.list.length ?? 0) > 0;
		if (current !== null && editable) this.iconButton(top, "more-horizontal", t("states.more"), (e) => this.stateMenu(e), "nb-states-more");
		const transport = top.createDiv({ cls: "nb-states-transport" });
		const prev = this.iconButton(transport, "skip-back", t("states.prev"), () => this.step(-1));
		const play = this.iconButton(transport, this.playingNow ? "square" : "play", this.playingNow ? t("states.stop") : t("states.play"), () => this.togglePlay(), "nb-states-play");
		const next = this.iconButton(transport, "skip-forward", t("states.next"), () => this.step(1));
		for (const b of [prev, play, next]) b.disabled = !hasStates;
		play.toggleClass("is-on", this.playingNow);

		// Parts: chips, and "Make part" for the ink selected now.
		const row = el.createDiv({ cls: "nb-states-row nb-states-parts" });
		row.createSpan({ cls: "nb-states-label", text: t("states.parts") });
		const list = row.createDiv({ cls: "nb-states-chips", attr: { role: "toolbar", "aria-label": t("states.parts") } });
		parts.forEach((part, i) => {
			const b = this.chip(list, part.name ?? t("states.partDefault", { n: String(i + 1) }), this.editing?.partId === part.id, () => this.editPart(part.id));
			b.addClass("nb-states-part");
		});
		if (parts.length === 0) list.createSpan({ cls: "nb-states-hint", text: t("states.noParts") });
		const sel = this.host.selection();
		const ink = sel ? this.inkOf(page, sel) : [];
		if (editable && ink.length > 0 && !this.ownsSelection(sel)) {
			const make = el.createEl("button", { cls: "nb-states-make", attr: { type: "button" } });
			setIcon(make.createSpan({ cls: "nb-states-icon", attr: { "aria-hidden": "true" } }), "group");
			make.createSpan({ text: t("states.makePart") });
			make.addEventListener("click", () => this.makePartFromSelection());
			row.appendChild(make);
		}

		// The part in edit.
		const e = this.editing;
		const part = e ? partById(states, e.partId) : null;
		if (e && part && states) this.renderEdit(el, states, part.id, part.name ?? t("states.partDefault", { n: String(states.parts.indexOf(part) + 1) }), current);
	}

	private renderEdit(el: HTMLElement, states: PageStates, partId: string, name: string, current: string | null): void {
		const row = el.createDiv({ cls: "nb-states-row nb-states-edit" });
		const label = row.createEl("button", { cls: "nb-states-name", attr: { type: "button", "aria-label": t("states.rename") } });
		label.createSpan({ text: name });
		setIcon(label.createSpan({ cls: "nb-states-icon", attr: { "aria-hidden": "true" } }), "pencil");
		label.addEventListener("click", () => this.renamePartPrompt(partId, name));
		const state = stateById(states, current);
		const pose = poseIn(state, partId);
		const editable = this.host.editable();
		if (!state) {
			row.createSpan({ cls: "nb-states-hint", text: t("states.pickState") });
		} else {
			row.createSpan({ cls: "nb-states-hint", text: t("states.editHint", { state: state.name }) });
			const hidden = pose?.hidden === true;
			const toggle = this.iconButton(row, hidden ? "eye" : "eye-off", hidden ? t("states.partShow") : t("states.partHide"), () => this.setPose(partId, { hidden: !hidden }), "nb-states-eye");
			toggle.toggleClass("is-on", hidden);
			const reset = this.iconButton(row, "rotate-ccw", t("states.partReset"), () => this.resetPose(partId));
			reset.disabled = !pose;
			const colours = row.createDiv({ cls: "nb-states-colours", attr: { role: "group", "aria-label": t("states.partColour") } });
			const orig = colours.createEl("button", { cls: "nb-states-swatch is-original", attr: { type: "button", "aria-label": t("states.partOriginal"), title: t("states.partOriginal") } });
			orig.toggleClass("is-active", pose?.color === undefined);
			orig.addEventListener("click", () => this.setPose(partId, { color: null }));
			for (const c of PEN_COLORS) {
				const sw = colours.createEl("button", { cls: "nb-states-swatch", attr: { type: "button", "aria-label": c, title: c } });
				sw.style.setProperty("--nb-states-swatch", c);
				sw.toggleClass("is-active", pose?.color === c);
				sw.addEventListener("click", () => this.setPose(partId, { color: c }));
			}
			for (const b of row.querySelectorAll<HTMLButtonElement>("button")) if (!editable && !b.classList.contains("nb-states-name")) b.disabled = true;
		}
		const dissolve = this.iconButton(row, "ungroup", t("states.partDissolve"), () => this.dissolve(partId), "nb-states-dissolve");
		dissolve.disabled = !editable;
		this.iconButton(row, "check", t("states.done"), () => this.finishEdit(), "nb-states-done");
	}

	private chip(parent: HTMLElement, label: string, active: boolean, onClick: () => void): HTMLButtonElement {
		const b = parent.createEl("button", { cls: "nb-states-chip", attr: { type: "button", "aria-pressed": String(active) } });
		b.toggleClass("is-active", active);
		b.createSpan({ cls: "nb-states-chip-label", text: label });
		b.addEventListener("click", onClick);
		return b;
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: (e: MouseEvent) => void, cls = ""): HTMLButtonElement {
		const b = parent.createEl("button", { cls: `nb-states-button ${cls}`.trim(), attr: { type: "button", "aria-label": label, title: label } });
		setIcon(b, icon);
		b.addEventListener("click", onClick);
		return b;
	}

	// --- switching and playing ---

	/** Shows state `id` (null: the drawing as drawn). Saved with the notebook when it can be edited, else only for this view. */
	switchTo(id: string | null): void {
		const page = this.page();
		if (!page) return;
		this.stopPlaying(false);
		this.editing = null;
		this.host.deselect();
		this.show1(page, id, true);
	}

	private show1(page: Page, id: string | null, persist: boolean): void {
		const doc = this.host.doc();
		const states = page.states;
		if (persist && this.host.editable() && doc && states) {
			this.shown.delete(page.id);
			if ((states.active ?? null) !== id) {
				new SetPageStates(page.id, states, withActive(states, id)).apply(doc);
				this.host.changed();
			}
		} else {
			this.shown.set(page.id, id);
		}
		this.host.repaint();
		this.render();
	}

	private step(dir: 1 | -1): void {
		const page = this.page();
		if (page?.states) this.switchTo(steppedState(page.states, dir, this.shownId(page)));
	}

	private togglePlay(): void {
		if (this.playingNow) {
			this.stopPlaying(true);
			this.render();
			return;
		}
		const page = this.page();
		const list = page?.states?.list ?? [];
		if (!page || list.length === 0) return;
		this.editing = null;
		this.host.deselect();
		// From the state in view to the last one; from the last one it plays again from "as drawn".
		const order: Array<string | null> = [null, ...list.map((st) => st.id)];
		const at = order.indexOf(this.shownId(page));
		this.queue = order.slice(at < 0 || at >= order.length - 1 ? 0 : at);
		this.playStep(page.id);
		this.timer = window.setInterval(() => this.playStep(page.id), PLAY_STEP_MS);
		this.render();
	}

	private playStep(pageId: string): void {
		const page = this.page();
		const queue = this.queue;
		if (!page || page.id !== pageId || !queue) {
			this.stopPlaying(false);
			return;
		}
		if (queue.length === 0) {
			// The last state has had its time: the playback ends where it stopped, and that state is saved.
			this.stopPlaying(true);
			this.render();
			return;
		}
		this.show1(page, queue.shift() ?? null, false);
	}

	/** Ends the playback. `save`: the state it stopped on becomes the saved one (when the notebook can be edited). */
	private stopPlaying(save: boolean): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		this.queue = null;
		const page = this.page();
		if (save && page) this.show1(page, this.shownId(page), true);
	}

	// --- editing ---

	private addNewState(): void {
		const page = this.page();
		if (!page || !this.host.editable()) return;
		if (livingParts(page).length === 0) {
			showNotice(t("states.addNeedPart"), 5000);
			return;
		}
		this.stopPlaying(false);
		const name = freshStateName(page.states, t("states.stateDefault"));
		const added = addState(page.states, name, this.shownId(page));
		if (!added) {
			showNotice(t("states.limitStates"), 5000);
			return;
		}
		this.shown.delete(page.id);
		this.run(page, added.states, "Add state");
	}

	/** Groups the selected ink into a part (the strokes leave the parts they were in). */
	makePartFromSelection(): void {
		const page = this.page();
		const sel = this.host.selection();
		if (!page || !sel || !this.host.editable()) return;
		const strokes = this.inkOf(page, sel);
		if (strokes.length === 0) {
			showNotice(t("states.selectInk"), 5000);
			return;
		}
		const n = livingParts(page).length + 1;
		const made = makePart(page.states, strokes, t("states.partDefault", { n: String(n) }));
		if (!made) {
			showNotice(t("states.limitParts"), 5000);
			return;
		}
		this.opened = true;
		this.run(page, made.states, "Make part");
		showNotice(t("states.madePart", { name: t("states.partDefault", { n: String(n) }) }), 4000);
	}

	/** The selected strokes that are ink of this page (not copies a state made). */
	private inkOf(page: Page, sel: { pageIndex: number; strokes: readonly Stroke[] }): Stroke[] {
		if (sel.pageIndex !== this.host.pageIndex()) return [];
		const own = new Set(page.strokes);
		return sel.strokes.filter((s) => own.has(s));
	}

	private run(page: Page, next: PageStates | undefined, label: string): boolean {
		return this.host.execute(new SetPageStates(page.id, page.states, next, label));
	}

	private editPart(partId: string): void {
		const page = this.page();
		if (!page?.states) return;
		const current = this.shownId(page);
		if (!this.host.editable()) {
			showNotice(t("states.readOnly"), 4000);
			return;
		}
		if (current === null) {
			showNotice(t("states.pickState"), 5000);
			return;
		}
		this.stopPlaying(false);
		const part = partById(page.states, partId);
		if (!part) return;
		const items = new Set(part.items);
		const strokes = stateView(page, current).strokes.filter((s) => items.has(s.id));
		this.editing = { pageId: page.id, partId, strokes };
		if (strokes.length > 0) this.host.select(this.host.pageIndex(), strokes);
		else this.host.deselect();
		this.render();
	}

	/** Selects the edited part again with its new look (after a pose changed). */
	private reselect(): void {
		const e = this.editing;
		const page = this.page();
		if (!e || !page?.states) return;
		const current = this.shownId(page);
		const part = partById(page.states, e.partId);
		if (!part || current === null) return;
		const items = new Set(part.items);
		e.strokes = stateView(page, current).strokes.filter((s) => items.has(s.id));
		if (e.strokes.length > 0) this.host.select(this.host.pageIndex(), e.strokes);
		this.render();
	}

	/**
	 * A drag on the selection ended. When the selection is the edited part's, its matrix becomes the part's pose in the
	 * state in view (one undo step) and true is returned: the strokes are not rewritten.
	 */
	commitTransform(sel: { strokes: readonly Stroke[]; matrix: Matrix }): boolean {
		if (!this.ownsSelection(sel)) return false;
		const e = this.editing!;
		const page = this.page();
		const current = page ? this.shownId(page) : null;
		const part = page?.states ? partById(page.states, e.partId) : null;
		if (!page?.states || !part || current === null) return true;
		if (isIdentity(sel.matrix)) return true;
		const pose = poseIn(stateById(page.states, current), part.id);
		const total = multiply(sel.matrix, poseMatrix(pose, part.pivot));
		const next = poseFromMatrix(total, part.pivot);
		const keep: Omit<PartPose, "part"> = { ...next, ...(pose?.hidden ? { hidden: true as const } : {}), ...(pose?.color !== undefined ? { color: pose.color } : {}) };
		this.run(page, withPose(page.states, current, part.id, keep), "Change part");
		this.reselect();
		return true;
	}

	private setPose(partId: string, patch: { hidden?: boolean; color?: string | null }): void {
		const page = this.page();
		const current = page ? this.shownId(page) : null;
		if (!page?.states || current === null || !this.host.editable()) return;
		const pose = poseIn(stateById(page.states, current), partId);
		const next: Omit<PartPose, "part"> = { dx: pose?.dx, dy: pose?.dy, rot: pose?.rot, scale: pose?.scale };
		const hidden = patch.hidden ?? pose?.hidden === true;
		if (hidden) next.hidden = true;
		const color = patch.color === undefined ? pose?.color : patch.color ?? undefined;
		if (color !== undefined) next.color = color;
		this.run(page, withPose(page.states, current, partId, next), "Change part");
		this.reselect();
	}

	private resetPose(partId: string): void {
		const page = this.page();
		const current = page ? this.shownId(page) : null;
		if (!page?.states || current === null || !this.host.editable()) return;
		this.run(page, withPose(page.states, current, partId, null), "Change part");
		this.reselect();
	}

	private dissolve(partId: string): void {
		const page = this.page();
		if (!page?.states || !this.host.editable()) return;
		this.editing = null;
		this.run(page, dissolvePart(page.states, partId), "Dissolve part");
	}

	private finishEdit(): void {
		this.editing = null;
		this.host.deselect();
		this.render();
	}

	private renamePartPrompt(partId: string, name: string): void {
		const page = this.page();
		if (!page?.states || !this.host.editable()) return;
		new PromptModal(this.host.app, { title: t("states.renamePart"), label: t("states.name"), value: name, cta: t("states.save") }, (value) => {
			const now = this.page();
			if (now?.states) this.run(now, renamePart(now.states, partId, value), "Rename part");
		}).open();
	}

	private stateMenu(e: MouseEvent): void {
		const page = this.page();
		const current = page ? this.shownId(page) : null;
		const state = stateById(page?.states, current);
		if (!page?.states || !state) return;
		const menu = new Menu();
		menu.addItem((i) => i.setTitle(t("states.rename")).setIcon("pencil").onClick(() => {
			new PromptModal(this.host.app, { title: t("states.renameState"), label: t("states.name"), value: state.name, cta: t("states.save") }, (value) => {
				const now = this.page();
				if (now?.states) this.run(now, renameState(now.states, state.id, value), "Rename state");
			}).open();
		}));
		menu.addItem((i) => i.setTitle(t("states.duplicate")).setIcon("copy").onClick(() => {
			const now = this.page();
			const added = now ? addState(now.states, freshStateName(now.states, t("states.stateDefault")), state.id) : null;
			if (now && added) this.run(now, added.states, "Duplicate state");
			else showNotice(t("states.limitStates"), 5000);
		}));
		menu.addItem((i) => i.setTitle(t("states.delete")).setIcon("trash-2").onClick(() => {
			const now = this.page();
			if (now?.states) this.run(now, deleteState(now.states, state.id), "Delete state");
		}));
		menu.showAtMouseEvent(e);
	}
}
