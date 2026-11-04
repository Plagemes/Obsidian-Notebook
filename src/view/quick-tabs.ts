/**
 * The quick tabs strip (roadmap #227): a slim row under the toolbar (a column at the side of the page on a short landscape
 * view) with the pages pinned in this notebook. A tap shows the page, "Back" returns to where the reader was, a long press
 * (touch, pen) or a right click opens "Move earlier / later / Unpin", and a tab can be dragged to reorder: at once with a
 * mouse, after a long press with a finger or pen. A finger that moves before the long press scrolls the strip.
 * It is hidden when there is nothing to show, and collapses to one small button with the number of tabs.
 * Nothing here writes the notebook: the pins are in `_meta` (library/quicktabs-store.ts).
 */
import { Menu, setIcon } from "obsidian";
import { t } from "../i18n";
import { resolveTab, tabText, type QuickTab } from "../library/quicktabs";

export interface QuickTabsHost {
	/** The tabs of this notebook, in strip order. */
	tabs(): QuickTab[];
	/** The notebook in view: its path and the ids of its pages (to label and to mark the current tab). */
	view(): { path: string | null; pageIds: readonly string[]; currentPageId: string | null };
	/** Where "Back" goes (a short name for the label), or null. */
	back(): { label: string } | null;
	/** The name of the notebook at `path` (for the tooltip of a tab in another notebook). */
	notebookName(path: string): string;
	open(tab: QuickTab): void;
	goBack(): void;
	unpin(id: string): void;
	move(id: string, to: number): void;
	collapsed(): boolean;
	setCollapsed(value: boolean): void;
}

const DRAG_THRESHOLD = 8;
const HOLD_MS = 380;

export class QuickTabsStrip {
	readonly el: HTMLElement;
	private readonly list: HTMLElement;
	private side = false;
	private key = "";
	/** A drag or a scroll just ended: the click that follows must not open the tab. */
	private suppressClick = false;
	/** When a tab menu was last opened: the context menu event that follows a long press must not open a second one. */
	private menuAt = -1e9;

	constructor(private readonly host: QuickTabsHost) {
		this.el = createDiv({ cls: "nb-ui nb-qt", attr: { role: "toolbar", "aria-label": t("quicktabs.strip") } });
		this.list = createDiv({ cls: "nb-qt-list", attr: { role: "tablist" } });
		this.el.hide();
	}

	/** The strip goes beside the page (a column) instead of above it. */
	setSide(side: boolean): void {
		if (this.side === side) return;
		this.side = side;
		this.el.toggleClass("is-side", side);
		this.key = "";
		this.refresh();
	}

	get isSide(): boolean {
		return this.side;
	}

	/** Redraws when something it shows changed. Cheap when nothing did. */
	refresh(): void {
		const tabs = this.host.tabs();
		const back = this.host.back();
		const view = this.host.view();
		const collapsed = this.host.collapsed();
		const key = JSON.stringify([tabs.map((x) => [x.id, x.path, x.pageId, x.num, x.label ?? ""]), view.path, view.pageIds.length, view.currentPageId, back?.label ?? null, collapsed, this.side]);
		if (key === this.key) return;
		this.key = key;
		if (tabs.length === 0 && !back) {
			this.el.hide();
			return;
		}
		this.el.show();
		this.el.empty();
		this.el.toggleClass("is-collapsed", collapsed);
		const toggle = this.el.createEl("button", {
			cls: "nb-qt-toggle", attr: { type: "button", "aria-expanded": String(!collapsed), "aria-label": t(collapsed ? "quicktabs.expand" : "quicktabs.collapse", { n: String(tabs.length) }) },
		});
		setIcon(toggle.createSpan({ cls: "nb-qt-toggle-icon", attr: { "aria-hidden": "true" } }), collapsed ? "pin" : this.side ? "chevrons-up" : "chevrons-left");
		if (collapsed && tabs.length > 0) toggle.createSpan({ cls: "nb-qt-count", text: String(tabs.length) });
		toggle.addEventListener("click", () => {
			this.host.setCollapsed(!this.host.collapsed());
			this.refresh();
		});
		if (back) {
			const b = this.el.createEl("button", { cls: "nb-qt-back", attr: { type: "button", "aria-label": t("quicktabs.backAria", { place: back.label }), title: t("quicktabs.backAria", { place: back.label }) } });
			setIcon(b.createSpan({ cls: "nb-qt-back-icon", attr: { "aria-hidden": "true" } }), "corner-up-left");
			b.createSpan({ cls: "nb-qt-label", text: t("quicktabs.back") });
			b.addEventListener("click", () => this.host.goBack());
		}
		if (collapsed) return;
		this.el.appendChild(this.list);
		this.list.empty();
		for (const tab of tabs) this.renderTab(tab, tabs, view);
	}

	private renderTab(tab: QuickTab, tabs: readonly QuickTab[], view: ReturnType<QuickTabsHost["view"]>): void {
		const target = resolveTab(tab, view);
		const here = target.kind === "here";
		const index = here ? target.index : null;
		const text = tabText(tab, index, (n) => t("quicktabs.page", { n: String(n) }));
		const current = here && view.currentPageId === tab.pageId;
		const other = target.kind === "other";
		const name = other ? this.host.notebookName(tab.path) : "";
		const full = other ? t("quicktabs.tabTitle", { name, n: String(tab.num) }) : text;
		const el = this.list.createEl("button", {
			cls: "nb-qt-tab", attr: { type: "button", role: "tab", "aria-selected": String(current), "aria-label": full, title: target.kind === "gone" ? t("quicktabs.goneTab", { text }) : full },
		});
		el.toggleClass("is-current", current);
		el.toggleClass("is-other", other);
		el.toggleClass("is-gone", target.kind === "gone");
		if (other) setIcon(el.createSpan({ cls: "nb-qt-tab-icon", attr: { "aria-hidden": "true" } }), "book-open");
		el.createSpan({ cls: "nb-qt-label", text });
		el.addEventListener("click", (e) => {
			if (this.suppressClick) {
				this.suppressClick = false;
				e.preventDefault();
				return;
			}
			this.host.open(tab);
		});
		el.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			if (performance.now() - this.menuAt > 900) this.openMenu(tab, tabs, { x: e.clientX, y: e.clientY });
		});
		this.attachGesture(el, tab);
	}

	private openMenu(tab: QuickTab, tabs: readonly QuickTab[], at: { x: number; y: number }): void {
		this.menuAt = performance.now();
		const i = tabs.findIndex((x) => x.id === tab.id);
		const menu = new Menu();
		menu.addItem((m) => m.setTitle(t("quicktabs.moveEarlier")).setIcon(this.side ? "arrow-up" : "arrow-left").setDisabled(i <= 0).onClick(() => this.host.move(tab.id, i - 1)));
		menu.addItem((m) => m.setTitle(t("quicktabs.moveLater")).setIcon(this.side ? "arrow-down" : "arrow-right").setDisabled(i < 0 || i >= tabs.length - 1).onClick(() => this.host.move(tab.id, i + 1)));
		menu.addSeparator();
		menu.addItem((m) => m.setTitle(t("quicktabs.unpin")).setIcon("pin-off").onClick(() => this.host.unpin(tab.id)));
		const dom = (menu as unknown as { dom?: unknown }).dom;
		if (dom instanceof HTMLElement) dom.classList.add("nb-ui", "nb-menu");
		menu.showAtPosition(at);
	}

	/** Tap = click. Mouse: drag at once. Finger or pen: long press then drag (release without moving: the menu); a move first scrolls the strip. */
	private attachGesture(el: HTMLElement, tab: QuickTab): void {
		let startX = 0, startY = 0, lastX = 0, lastY = 0;
		let pointer = -1;
		let timer = 0;
		let dragging = false;
		let scrolling = false;
		let held = false;
		const clear = (): void => {
			if (timer) window.clearTimeout(timer);
			timer = 0;
		};
		const reset = (): void => {
			clear();
			if (pointer >= 0 && el.hasPointerCapture(pointer)) el.releasePointerCapture(pointer);
			pointer = -1;
			dragging = scrolling = held = false;
			el.setCssProps({ transform: "" });
			el.removeClass("is-dragging");
			this.list.querySelectorAll(".is-drop-before, .is-drop-after").forEach((n) => n.classList.remove("is-drop-before", "is-drop-after"));
		};
		const others = (): HTMLElement[] => [...this.list.querySelectorAll<HTMLElement>(".nb-qt-tab")].filter((n) => n !== el);
		const axis = (r: DOMRect): number => (this.side ? r.top + r.height / 2 : r.left + r.width / 2);
		/** The index the dragged tab would have if dropped now. */
		const slot = (): number => {
			const mid = axis(el.getBoundingClientRect());
			return others().filter((n) => axis(n.getBoundingClientRect()) < mid).length;
		};
		const mark = (): void => {
			const list = others();
			list.forEach((n) => n.classList.remove("is-drop-before", "is-drop-after"));
			const i = slot();
			if (i < list.length) list[i]?.classList.add("is-drop-before");
			else list[list.length - 1]?.classList.add("is-drop-after");
		};
		const begin = (): void => {
			dragging = true;
			el.addClass("is-dragging");
		};
		el.addEventListener("pointerdown", (e) => {
			if (pointer >= 0 || (e.pointerType === "mouse" && e.button !== 0)) return;
			pointer = e.pointerId;
			startX = lastX = e.clientX;
			startY = lastY = e.clientY;
			el.setPointerCapture(pointer);
			if (e.pointerType !== "mouse") {
				timer = window.setTimeout(() => {
					timer = 0;
					held = true;
					begin();
				}, HOLD_MS);
			}
		});
		el.addEventListener("pointermove", (e) => {
			if (e.pointerId !== pointer) return;
			const dx = e.clientX - startX, dy = e.clientY - startY;
			const along = this.side ? dy : dx;
			if (!dragging && !scrolling) {
				if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
				if (e.pointerType === "mouse") begin();
				else {
					clear();
					scrolling = true;
				}
			}
			if (scrolling) {
				if (this.side) this.list.scrollTop -= e.clientY - lastY;
				else this.list.scrollLeft -= e.clientX - lastX;
			} else if (dragging) {
				held = false;
				el.setCssProps({ transform: this.side ? `translateY(${along}px)` : `translateX(${along}px)` });
				mark();
			}
			lastX = e.clientX;
			lastY = e.clientY;
		});
		el.addEventListener("pointerup", (e) => {
			if (e.pointerId !== pointer) return;
			const wasDragging = dragging, wasScrolling = scrolling, wasHeld = held;
			const to = wasDragging && !wasHeld ? slot() : -1;
			const tabs = this.host.tabs();
			const from = tabs.findIndex((x) => x.id === tab.id);
			reset();
			if (wasScrolling || (wasDragging && !wasHeld)) this.suppressClick = true;
			if (wasHeld) {
				this.suppressClick = true;
				this.openMenu(tab, tabs, { x: e.clientX, y: e.clientY });
			} else if (to >= 0 && to !== from) this.host.move(tab.id, to);
			if (this.suppressClick) window.setTimeout(() => (this.suppressClick = false), 0);
		});
		el.addEventListener("pointercancel", (e) => {
			if (e.pointerId === pointer) reset();
		});
	}
}

/** Long press (touch, pen) or right click on the page number: a one-item menu that pins the page in view as a quick tab, or unpins it. */
export function attachQuickTabGesture(el: HTMLElement, target: { pinned(): boolean; toggle(): void }): { justOpened(): boolean } {
	const HOLD = 550;
	let timer = 0;
	let last = -1e9;
	const cancel = (): void => {
		if (timer) window.clearTimeout(timer);
		timer = 0;
	};
	const open = (): void => {
		last = performance.now();
		const pinned = target.pinned();
		const menu = new Menu();
		menu.addItem((i) => i.setTitle(t(pinned ? "quicktabs.unpin" : "quicktabs.pin")).setIcon(pinned ? "pin-off" : "pin").onClick(() => target.toggle()));
		const dom = (menu as unknown as { dom?: unknown }).dom;
		if (dom instanceof HTMLElement) dom.classList.add("nb-ui", "nb-menu");
		const r = el.getBoundingClientRect();
		menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
	};
	el.addEventListener("pointerdown", (e) => {
		if (e.pointerType === "mouse") return;
		cancel();
		timer = window.setTimeout(() => {
			timer = 0;
			open();
		}, HOLD);
	});
	for (const type of ["pointerup", "pointerleave", "pointercancel"] as const) el.addEventListener(type, cancel);
	el.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		if (performance.now() - last < 900) return;
		open();
	});
	return { justOpened: () => performance.now() - last < 700 };
}
