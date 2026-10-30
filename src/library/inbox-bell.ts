/**
 * 0.12: the inbox bell of the Home and library headers (DESIGN.md §3 page header). Its badge counts the Zettelkasten
 * Inbox items still to process (zettel/inbox-service.ts); tapping it shows them in a popover (a sheet on a phone) with the
 * Inbox's own actions, and "Open inbox" opens the full Inbox view. Uses the Inbox only through its public service.
 */
import { Menu } from "obsidian";
import { t } from "../i18n";
import type { InboxItem } from "../zettel/inbox";
import { iconButton, pressable, setIconSafe, subjectVars } from "../ui/components/dom";
import { iconSquare } from "../ui/components/icon-square";
import { sectionHeader } from "../ui/components/section-header";

/** What the bell needs from the Inbox (built in main.ts from the Inbox service). */
export interface InboxPort {
	/** Items still to process, from the last scan, in reading order. */
	open(): InboxItem[];
	/** True once a scan has run in this session. */
	scanned(): boolean;
	/** Looks through the notebooks again (read only). */
	scan(): Promise<void>;
	/** Called after a scan and after every action that changes an item. Returns the unsubscribe function. */
	onChange(fn: () => void): () => void;
	openItem(item: InboxItem): void;
	discard(item: InboxItem): Promise<boolean>;
	/** Opens the Inbox view. */
	openInbox(): void;
	/** Opens the Inbox view on the first open item (to make a card or link it). */
	processInInbox(): void;
}

export interface InboxBellContext {
	/** The element the popover is placed in (the view's root, `position: relative`). */
	container: HTMLElement;
	/** Phone layout: a bottom sheet instead of a popover. */
	phone(): boolean;
	/** Subject colour of a notebook, or null. */
	colorOf(path: string): string | null;
	/** "Today, 10:24" of the notebook's last change, or "". */
	when(path: string): string;
}

/** Rows shown in the popover; the Inbox view has the rest. */
const MAX_ROWS = 8;
/** Scan again when the bell opens if the last scan is older than this. */
const STALE_MS = 2 * 60 * 1000;

const KIND_LOOK: Record<InboxItem["kind"], { icon: string; color: string; label: "bell.kind.block" | "bell.kind.highlight" | "bell.kind.comment" | "bell.kind.marker" }> = {
	"block": { icon: "pencil", color: "#2F80F7", label: "bell.kind.block" },
	"pdf-highlight": { icon: "highlighter", color: "#F59E0B", label: "bell.kind.highlight" },
	"pdf-comment": { icon: "message-square", color: "#EC4899", label: "bell.kind.comment" },
	"marker": { icon: "flag", color: "#8B5CF6", label: "bell.kind.marker" },
};

function titleOf(item: InboxItem): string {
	const line = item.text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
	if (line) return line.length > 70 ? `${line.slice(0, 69)}…` : line;
	return `${t(KIND_LOOK[item.kind].label)}, ${t("bell.page", { page: String(item.pageIndex + 1) })}`;
}

export class InboxBell {
	private button: HTMLButtonElement | null = null;
	private pop: HTMLElement | null = null;
	private backdrop: HTMLElement | null = null;
	private scanning = false;
	private lastScan = 0;
	private readonly unsubscribe: () => void;
	private readonly onDocDown = (e: PointerEvent) => {
		const target = e.target instanceof Node ? e.target : null;
		if (this.pop?.contains(target) || this.button?.contains(target)) return;
		// A menu opened from a row (Obsidian's menus live outside the popover).
		if (target instanceof Element && target.closest(".menu")) return;
		this.close();
	};
	private readonly onKey = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			this.close();
			this.button?.focus();
		}
	};

	constructor(private readonly port: InboxPort, private readonly ctx: InboxBellContext) {
		this.unsubscribe = port.onChange(() => {
			this.lastScan = Date.now();
			this.updateBadge();
			if (this.pop) this.fill();
		});
	}

	dispose(): void {
		this.unsubscribe();
		this.close();
	}

	/** The bell button with its badge, in the header tools (redrawn with the header). */
	mount(parent: HTMLElement): void {
		const b = iconButton(parent, "bell", t("bell.labelNone"), () => (this.pop ? this.close() : this.openPopover()), "nb-bell");
		b.setAttribute("aria-haspopup", "dialog");
		b.setAttribute("aria-expanded", String(!!this.pop));
		b.createSpan({ cls: "nb-badge", attr: { "aria-hidden": "true" } });
		this.button = b;
		this.updateBadge();
	}

	/** First scan of the session (the library calls it once the pen is idle), or a scan when the last one is old. */
	scanIfStale(): void {
		if (this.scanning || (this.port.scanned() && Date.now() - this.lastScan < STALE_MS)) return;
		this.scanning = true;
		if (this.pop) this.fill();
		this.port.scan().catch((e) => console.error("[notebook] inbox scan failed", e)).finally(() => {
			this.scanning = false;
			this.lastScan = Date.now();
			this.updateBadge();
			if (this.pop) this.fill();
		});
	}

	private updateBadge(): void {
		const b = this.button;
		if (!b) return;
		const n = this.port.open().length;
		const badge = b.querySelector<HTMLElement>(".nb-badge");
		badge?.setText(n > 99 ? "99+" : String(n));
		badge?.toggleClass("is-hidden", n === 0);
		const label = n > 0 ? t("bell.label", { n: String(n) }) : t("bell.labelNone");
		b.setAttribute("aria-label", label);
		b.setAttribute("title", label);
	}

	private openPopover(): void {
		const phone = this.ctx.phone();
		const container = this.ctx.container;
		if (phone) {
			this.backdrop = container.createDiv({ cls: "nb-sheet-backdrop" });
			this.backdrop.addEventListener("click", () => this.close());
		}
		const pop = container.createDiv({ cls: `nb-popover nb-inbox-pop${phone ? " is-sheet" : ""}`, attr: { role: "dialog", "aria-label": t("bell.title") } });
		this.pop = pop;
		if (!phone && this.button) {
			const r = this.button.getBoundingClientRect();
			const c = container.getBoundingClientRect();
			pop.setCssProps({ "--nb-pop-top": `${Math.round(r.bottom - c.top + 8)}px`, "--nb-pop-right": `${Math.max(8, Math.round(c.right - r.right))}px` });
		}
		this.button?.setAttribute("aria-expanded", "true");
		this.fill();
		activeDocument.addEventListener("pointerdown", this.onDocDown, true);
		activeDocument.addEventListener("keydown", this.onKey, true);
		this.scanIfStale();
		pop.querySelector<HTMLElement>("[tabindex], button")?.focus({ preventScroll: true });
	}

	close(): void {
		activeDocument.removeEventListener("pointerdown", this.onDocDown, true);
		activeDocument.removeEventListener("keydown", this.onKey, true);
		this.pop?.remove();
		this.backdrop?.remove();
		this.pop = null;
		this.backdrop = null;
		this.button?.setAttribute("aria-expanded", "false");
	}

	private fill(): void {
		const pop = this.pop;
		if (!pop) return;
		pop.empty();
		const items = this.port.open();
		const head = sectionHeader(pop, { icon: "inbox", title: t("bell.title") });
		if (items.length > 0) head.querySelector(".nb-section-tools")?.createSpan({ cls: "nb-count-pill", text: String(items.length) });
		if (this.scanning) pop.createDiv({ cls: "nb-pop-status", text: t("bell.scanning") });
		const list = pop.createDiv({ cls: "nb-list nb-inbox-list" });
		if (items.length === 0 && !this.scanning) list.createDiv({ cls: "nb-pop-empty", text: t("bell.empty") });
		for (const item of items.slice(0, MAX_ROWS)) this.row(list, item);
		const open = pop.createEl("button", { cls: "nb-pill-btn mod-cta nb-pop-footer", attr: { type: "button" } });
		setIconSafe(open.createSpan({ attr: { "aria-hidden": "true" } }), "inbox");
		open.createSpan({ text: items.length > MAX_ROWS ? `${t("bell.openInbox")} (${items.length})` : t("bell.openInbox") });
		open.addEventListener("click", () => {
			this.close();
			this.port.openInbox();
		});
	}

	private row(list: HTMLElement, item: InboxItem): void {
		const look = KIND_LOOK[item.kind];
		const title = titleOf(item);
		const row = list.createDiv({ cls: "nb-list-row nb-inbox-row" });
		row.dataset.key = `inbox:${item.key}`;
		pressable(row, () => {
			this.close();
			this.port.openItem(item);
		}, title);
		iconSquare(row, look.icon, look.color, "is-small");
		const text = row.createDiv({ cls: "nb-row-text" });
		text.createDiv({ cls: "nb-row-title", text: title, attr: { title } });
		const meta = text.createDiv({ cls: "nb-row-meta nb-inbox-meta" });
		const pill = meta.createSpan({ cls: "nb-pill", text: item.notebookName, attr: { title: item.notebookPath } });
		const color = this.ctx.colorOf(item.notebookPath);
		if (color) {
			pill.addClass("is-subject");
			subjectVars(pill, color);
		}
		const when = this.ctx.when(item.notebookPath);
		if (when) meta.createSpan({ text: when });
		iconButton(row, "more-vertical", t("bell.more"), (b) => {
			const menu = new Menu();
			menu.addItem((i) => i.setTitle(t("inbox.action.open")).setIcon("book-open").onClick(() => {
				this.close();
				this.port.openItem(item);
			}));
			menu.addItem((i) => i.setTitle(t("bell.process")).setIcon("list-checks").onClick(() => {
				this.close();
				this.port.processInInbox();
			}));
			menu.addItem((i) => i.setTitle(t("inbox.action.discard")).setIcon("x").onClick(() => void this.port.discard(item)));
			const r = b.getBoundingClientRect();
			menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
		}, "nb-kebab");
	}
}
