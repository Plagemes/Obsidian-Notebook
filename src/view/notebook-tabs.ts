// wave 0.10 (363): tabs of the open notebooks. A compact strip (optional, setting `notebookTabs`) lists the Obsidian
// leaves that hold a notebook and switches between them; a two-finger sideways swipe on the toolbar strip (never on the
// page: the pen and one finger are taken there) goes to the next / previous notebook. Only public workspace APIs
// (getLeavesOfType, setActiveLeaf, getDisplayText, getViewState).
import type { EventRef, WorkspaceLeaf, App } from "obsidian";
import { t } from "../i18n";
import { neighbourTab, tabLabels, TabSwipe, type TabEntry } from "../ui/tabs";

export interface TabsHost {
	app: App;
	/** The leaf type of the notebook view. */
	viewType: string;
	/** The leaf of the view that owns this strip. */
	leaf(): WorkspaceLeaf;
	/** The strip is turned on in the settings. */
	enabled(): boolean;
	/** Registers a workspace event for the lifetime of the view. */
	register(ref: EventRef): void;
}

export class NotebookTabs {
	readonly el: HTMLElement;
	private readonly swipe = new TabSwipe();
	private readonly keys = new WeakMap<WorkspaceLeaf, string>();
	private nextKey = 1;
	private signature = "";
	private readonly disposers: Array<() => void> = [];

	/** `before`: the element the strip is placed in front of (the toolbar); `swipeOn`: elements that take the swipe. */
	constructor(parent: HTMLElement, before: HTMLElement | null, private readonly host: TabsHost, swipeOn: HTMLElement[]) {
		this.el = parent.createDiv({ cls: "notebook-tabs notebook-hidden", attr: { role: "tablist", "aria-label": t("tabs.label") } });
		if (before) parent.insertBefore(this.el, before);
		const ws = host.app.workspace;
		for (const ref of [ws.on("layout-change", () => this.refresh()), ws.on("active-leaf-change", () => this.refresh()), ws.on("file-open", () => this.refresh())]) host.register(ref);
		for (const el of [this.el, ...swipeOn]) this.listenSwipe(el);
		this.refresh();
	}

	destroy(): void {
		for (const d of this.disposers) d();
		this.disposers.length = 0;
		this.swipe.reset();
		this.el.remove();
	}

	private entries(): { leaf: WorkspaceLeaf; entry: TabEntry }[] {
		return this.host.app.workspace.getLeavesOfType(this.host.viewType).map((leaf) => {
			let id = this.keys.get(leaf);
			if (!id) this.keys.set(leaf, (id = `tab-${this.nextKey++}`));
			const file = (leaf.getViewState().state as { file?: unknown } | undefined)?.file;
			return { leaf, entry: { id, path: typeof file === "string" ? file : "", title: leaf.getDisplayText() } };
		});
	}

	/** How many notebooks are open (the actions are useless with fewer than two). */
	get count(): number {
		return this.host.app.workspace.getLeavesOfType(this.host.viewType).length;
	}

	/** Rebuilds the strip when the open notebooks, their names or the active one changed. */
	refresh(): void {
		const list = this.entries();
		const mine = this.host.leaf();
		const show = this.host.enabled() && list.length > 1;
		this.el.toggleClass("notebook-hidden", !show);
		const labels = tabLabels(list.map((e) => e.entry));
		const sig = `${show}|${list.map((e, i) => `${e.entry.id}:${labels[i]}:${e.leaf === mine}`).join("|")}`;
		if (sig === this.signature) return;
		this.signature = sig;
		this.el.empty();
		if (!show) return;
		list.forEach(({ leaf, entry }, i) => {
			const current = leaf === mine;
			const tab = this.el.createEl("button", {
				cls: `notebook-tab${current ? " is-active" : ""}`,
				text: labels[i],
				attr: { role: "tab", "aria-selected": String(current), title: entry.path || labels[i] || "" },
			});
			tab.addEventListener("click", () => this.activate(leaf));
		});
	}

	/** Goes to the next (1) or previous (-1) open notebook. `wrap`: from the last to the first (commands); a swipe stops at the ends. */
	step(direction: 1 | -1, wrap = true): boolean {
		const list = this.entries();
		const from = list.findIndex((e) => e.leaf === this.host.leaf());
		const to = neighbourTab(list.length, from, direction, wrap);
		const target = list[to];
		if (!target) return false;
		this.activate(target.leaf);
		return true;
	}

	private activate(leaf: WorkspaceLeaf): void {
		this.host.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	private listenSwipe(el: HTMLElement): void {
		const on = (type: string, fn: (e: PointerEvent) => void) => {
			el.addEventListener(type, fn as EventListener, { passive: true });
			this.disposers.push(() => el.removeEventListener(type, fn as EventListener));
		};
		on("pointerdown", (e) => {
			if (e.pointerType === "touch") this.swipe.down(e.pointerId, e.clientX, e.clientY, e.timeStamp);
		});
		on("pointermove", (e) => {
			if (e.pointerType !== "touch") return;
			const dir = this.swipe.move(e.pointerId, e.clientX, e.clientY, e.timeStamp);
			if (dir !== 0) this.step(dir, false);
		});
		on("pointerup", (e) => this.swipe.up(e.pointerId));
		on("pointercancel", (e) => this.swipe.up(e.pointerId));
	}
}
