import type { App } from "obsidian";
import { t } from "../i18n";
import { elementBounds, type MeasureText } from "../ink/elements";
import { Batch, type Command } from "../model/history";
import { groupCommand, lockCommand, lockedElementsOf, ungroupCommand, unlockCommand } from "../model/groups";
import type { NotebookDocument, Page, PageElement, Stroke } from "../model/types";
import { chip } from "../ui/components/chip";
import { setIconSafe } from "../ui/components/dom";
import { LockedElementsModal } from "./locked-elements-modal";
import { showNotice } from "./notice";

/** The items of one page that are selected. */
export interface SelectedPart {
	pageIndex: number;
	strokes: Stroke[];
	elements: PageElement[];
}

/**
 * View side of groups and locked elements (0.20, roadmap #39): Group, Ungroup and Lock on the selection, the small chip that offers
 * Unlock when a locked element is tapped with the lasso, and the page's list of locked elements. Selecting a member takes the whole
 * group and the lasso skips locked elements: that is done where a selection is made (the view and ink/elements.ts); everything here
 * is one undo step through the view's history, which also refuses it on a locked page. The view passes itself as a GroupHost.
 */
export interface GroupHost {
	app: App;
	/** The layer the chip floats over (the stage). */
	stage(): HTMLElement;
	doc(): NotebookDocument | null;
	/** The document can be edited now. */
	editable(): boolean;
	/** Runs a command as one undo step; the selection is dropped (false when it was refused: a locked page, a read-only notebook). */
	execute(cmd: Command): boolean;
	/** The selected items, page by page (the primary page first); null when nothing is selected. */
	selection(): SelectedPart[] | null;
	/** Selects these items (the lasso tool, so the contextual bar and the handles appear). */
	select(pageIndex: number, strokes: Stroke[], elements: PageElement[]): void;
	/** Stage position (px) of a page point. */
	toStage(pageIndex: number, x: number, y: number): [number, number] | null;
	/** Scrolls so that this page point is in view. */
	reveal(pageIndex: number, y: number): void;
	measure: MeasureText;
	refresh(): void;
}

/** How long the Unlock chip stays after a tap, ms. */
const CHIP_MS = 5000;

const ISOLATED = ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "wheel", "contextmenu", "mousedown"] as const;

export class GroupTools {
	private chipEl: HTMLElement | null = null;
	private chipTimer: number | null = null;

	constructor(private readonly host: GroupHost) {}

	/** "Group": the selected items of the page become one group (they then select, move, resize, copy and delete together). */
	group(): void {
		if (!this.host.editable()) return;
		const sel = this.host.selection();
		const part = sel && sel.length === 1 ? sel[0] : undefined;
		const page = part ? this.host.doc()?.pages[part.pageIndex] : undefined;
		if (!part || !page) return;
		const cmd = groupCommand(page, part);
		if (!cmd || !this.host.execute(cmd)) return;
		this.reselect(part.pageIndex, page, part);
		showNotice(t("groups.grouped", { count: String(part.strokes.length + part.elements.length) }), 2200);
	}

	/** "Ungroup": every selected item leaves its group (the whole group is selected, so the group is gone). */
	ungroup(): void {
		if (!this.host.editable()) return;
		const sel = this.host.selection();
		const doc = this.host.doc();
		if (!sel || !doc) return;
		const cmds: Command[] = [];
		for (const part of sel) {
			const page = doc.pages[part.pageIndex];
			const cmd = page ? ungroupCommand(page, part) : null;
			if (cmd) cmds.push(cmd);
		}
		if (cmds.length === 0 || !this.host.execute(cmds.length === 1 ? cmds[0]! : new Batch("Ungroup", cmds))) return;
		const only = sel.length === 1 ? sel[0] : undefined;
		const page = only ? doc.pages[only.pageIndex] : undefined;
		if (only && page) this.reselect(only.pageIndex, page, only);
		showNotice(t("groups.ungrouped"), 2200);
	}

	/** "Lock": the selected elements stay where they are until they are unlocked (the selection is dropped: it cannot hold them). */
	lockSelected(): void {
		if (!this.host.editable()) return;
		const sel = this.host.selection();
		const doc = this.host.doc();
		if (!sel || !doc) return;
		const cmds: Command[] = [];
		let count = 0;
		for (const part of sel) {
			const page = doc.pages[part.pageIndex];
			const cmd = page ? lockCommand(page, part.elements) : null;
			if (!cmd) continue;
			cmds.push(cmd);
			count += part.elements.length;
		}
		if (cmds.length === 0 || !this.host.execute(cmds.length === 1 ? cmds[0]! : new Batch("Lock", cmds))) return;
		showNotice(t("groups.locked", { count: String(count) }), 3500);
	}

	/** Unlocks these elements of page `pageIndex` as one undo step. False when it could not be done. */
	unlock(pageIndex: number, ids: readonly string[]): boolean {
		if (!this.host.editable()) return false;
		const page = this.host.doc()?.pages[pageIndex];
		if (!page) return false;
		const wanted = new Set(ids);
		const cmd = unlockCommand(page, (page.elements ?? []).filter((e) => wanted.has(e.id)));
		if (!cmd) return false;
		const done = this.host.execute(cmd);
		if (done) this.hideChip();
		return done;
	}

	/** The page's locked elements, in a list that unlocks them (the page menu's "Locked elements…"). */
	openList(pageIndex: number): void {
		const doc = this.host.doc();
		const page = doc?.pages[pageIndex];
		if (!page) return;
		const entriesOf = () => {
			const now = this.host.doc()?.pages[pageIndex];
			return now ? lockedElementsOf(now).map((element) => ({ id: element.id, element })) : [];
		};
		new LockedElementsModal(this.host.app, pageIndex + 1, {
			entries: entriesOf,
			unlock: (ids) => this.unlock(pageIndex, ids),
			reveal: (id) => {
				const el = this.host.doc()?.pages[pageIndex]?.elements?.find((e) => e.id === id);
				if (el) this.host.reveal(pageIndex, Math.max(0, elementBounds(el, this.host.measure).minY - 24));
			},
		}).open();
	}

	/**
	 * A tap with the lasso landed on a locked element: a small chip says so near the finger and offers Unlock (and only that: the
	 * element itself is not selected). It goes by itself after a few seconds.
	 */
	showLocked(pageIndex: number, element: PageElement, at: readonly [number, number]): void {
		const stage = this.host.stage();
		const pos = this.host.toStage(pageIndex, at[0], at[1]);
		if (!pos) return;
		this.hideChip();
		const holder = stage.createDiv({ cls: "nb-ui nb-grp-chip", attr: { role: "group", "aria-label": t("groups.chip.aria") } });
		for (const type of ISOLATED) holder.addEventListener(type, (e) => e.stopPropagation());
		const label = holder.createSpan({ cls: "nb-grp-chip-label" });
		setIconSafe(label.createSpan({ cls: "nb-grp-chip-icon", attr: { "aria-hidden": "true" } }), "lock");
		label.createSpan({ text: t("groups.chip.locked") });
		chip(holder, {
			label: t("groups.unlock"), icon: "lock-open", key: "groups-chip-unlock", title: t("groups.chip.unlockAria"),
			onClick: () => {
				if (!this.unlock(pageIndex, [element.id])) this.hideChip();
			},
		});
		// Kept inside the stage: the chip is centred on the tap, a little below it.
		const half = 110;
		const x = Math.min(Math.max(pos[0], half), Math.max(half, stage.clientWidth - half));
		holder.setCssProps({ "--nb-grp-x": `${Math.round(x)}px`, "--nb-grp-y": `${Math.round(pos[1]) + 14}px` });
		this.chipEl = holder;
		this.chipTimer = window.setTimeout(() => this.hideChip(), CHIP_MS);
	}

	hideChip(): void {
		if (this.chipTimer !== null) window.clearTimeout(this.chipTimer);
		this.chipTimer = null;
		this.chipEl?.remove();
		this.chipEl = null;
	}

	destroy(): void {
		this.hideChip();
	}

	/** After a change the selected objects are new ones: the same items (by id) are selected again. */
	private reselect(pageIndex: number, page: Page, was: SelectedPart): void {
		const strokes = new Set(was.strokes.map((s) => s.id));
		const elements = new Set(was.elements.map((e) => e.id));
		this.host.select(pageIndex, page.strokes.filter((s) => strokes.has(s.id)), (page.elements ?? []).filter((e) => elements.has(e.id)));
	}
}
