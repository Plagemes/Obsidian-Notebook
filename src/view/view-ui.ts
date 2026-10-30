// ui redesign: the self-building part of the notebook view. From the view's context it asks the layout engine
// (ui/layout.ts) what the toolbar quick slots and the contextual bar show, keeps the sheets up to date and counts uses
// on this device. The view calls `refresh()` whenever something the UI depends on changes (cheap: one layout per frame).
import type { App } from "obsidian";
import type { PageSizeName, PaperKind } from "../model/types";
import { actionById, isChecked, isEnabled, type ContextKind, type UiContext } from "../ui/actions";
import { ActionSheet, actionLabel, type SheetKind } from "../ui/action-sheet";
import { ContextBar } from "../ui/context-bar";
import { buildLayout, type SectionId } from "../ui/layout";
import { normaliseUsage, recordUse, USAGE_KEY, type UsageMap } from "../ui/usage";
import type { Toolbar } from "./toolbar";

/** Local storage key of the collapsed contextual bars. */
const COLLAPSED_KEY = "notebook-ui-context-collapsed";
/** Below this width (CSS px) the sheets are bottom sheets. */
const BOTTOM_SHEET_PX = 600;

export interface ViewUiHost {
	app: App;
	/** The view's content element (the sheets are placed in it). */
	root: HTMLElement;
	/** The area below the toolbar (the contextual bar floats at its bottom). */
	body: HTMLElement;
	toolbar: Toolbar;
	context(pageIndex?: number): UiContext;
	run(id: string, arg: { page?: number; value?: string }): void;
	pageValues(pageIndex: number): { paper: PaperKind; size: PageSizeName | null } | null;
	/** The dimming slider (pdf-reading.ts) while dimming is on, else null. */
	dimControl(): HTMLElement | null;
}

export class ViewUi {
	readonly contextBar: ContextBar;
	readonly sheet: ActionSheet;
	private usage: UsageMap;
	private collapsed: Set<ContextKind>;
	private frame = 0;
	private visibleIds = new Set<string>();

	constructor(private readonly host: ViewUiHost) {
		this.usage = normaliseUsage(this.load(USAGE_KEY));
		const stored: unknown = this.load(COLLAPSED_KEY);
		this.collapsed = new Set(Array.isArray(stored) ? stored.filter((k): k is ContextKind => typeof k === "string") : []);
		this.contextBar = new ContextBar(host.body, {
			run: (id) => host.run(id, {}),
			collapsed: (kind) => this.collapsed.has(kind),
			setCollapsed: (kind, on) => {
				if (on) this.collapsed.add(kind);
				else this.collapsed.delete(kind);
				this.save(COLLAPSED_KEY, [...this.collapsed]);
				this.refreshNow();
			},
		});
		this.sheet = new ActionSheet(host.root, {
			context: (pageIndex) => host.context(pageIndex),
			usage: () => this.usage,
			visible: () => this.visibleIds,
			run: (id, arg) => host.run(id, arg),
			pageValues: (i) => host.pageValues(i),
			extra: (section: SectionId) => (section === "reading" ? host.dimControl() : null),
			narrow: () => host.root.clientWidth < BOTTOM_SHEET_PX,
		});
		this.sheet.onToggle = (open, kind) => host.toolbar.setSheetOpen(open ? kind : null);
	}

	destroy(): void {
		if (this.frame) window.cancelAnimationFrame(this.frame);
		this.frame = 0;
		this.sheet.destroy();
		this.contextBar.destroy();
	}

	/** One use of an action (any surface or the palette): ranks it higher next time. */
	record(id: string): void {
		this.usage = recordUse(this.usage, id, Date.now());
		this.save(USAGE_KEY, this.usage);
	}

	openSheet(kind: SheetKind, anchor: HTMLElement | null, pageIndex?: number): void {
		this.sheet.toggle(kind, anchor, pageIndex);
	}

	/** Recomputes the layout at the next frame (several changes in one frame cost one layout). */
	refresh(): void {
		if (this.frame) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = 0;
			this.refreshNow();
		});
	}

	refreshNow(): void {
		const c = this.host.context();
		const width = this.host.root.clientWidth || window.innerWidth;
		const layout = buildLayout(c, width, this.usage, Date.now());
		const tb = this.host.toolbar;
		tb.setSingleRow(layout.singleRow);
		tb.setQuick(layout.quick.map((id) => {
			const a = actionById(id)!;
			return { id, icon: a.icon, label: actionLabel(a), enabled: isEnabled(a, c), checked: a.checked ? isChecked(a, c) : undefined };
		}));
		this.contextBar.render(layout.context, c);
		this.visibleIds = new Set([...layout.quick, ...(layout.context?.actions ?? [])]);
		this.sheet.refresh();
	}

	private load(key: string): unknown {
		try {
			return this.host.app.loadLocalStorage(key) as unknown;
		} catch {
			return null;
		}
	}

	private save(key: string, value: unknown): void {
		try {
			this.host.app.saveLocalStorage(key, value);
		} catch (e) {
			console.error("[notebook] could not store the UI preferences", e);
		}
	}
}
