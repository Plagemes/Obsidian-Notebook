import { Notice, setIcon, type App, type TFile } from "obsidian";
import { t, type MessageKey } from "../i18n";
import type { ClipContent } from "../ink/clipboard";
import { measureText } from "../ink/renderer";
import {
	BUILTIN_STAMPS, builtinStamp, planStampPlacement, stampPreview, type BuiltinStamp, type StampPreview,
} from "../ink/stamps";
import type { Command } from "../model/history";
import type { NotebookDocument, Page, PageElement, Stroke } from "../model/types";
import { deleteStamp, listStampFiles, loadStamp, renameStamp, saveStamp } from "../storage/stamps";
import { ConfirmModal, PromptModal } from "../library/library-modals";
import { resolveAssetFile } from "./media";

/** A page of the open notebook and a point on it (page coordinates). */
export interface StampTarget {
	pageIndex: number;
	page: Page;
	x: number;
	y: number;
}

/** The part of the notebook view the stamp palette needs. */
export interface StampHost {
	app: App;
	folder(): string;
	editable(): boolean;
	doc(): NotebookDocument | null;
	/** Copy of the lasso selection with its assets, or null when nothing is selected. */
	captureSelection(): ClipContent | null;
	/** Colour and width of the current pen (the built-in stamps are drawn with them). */
	penStyle(): { color: string; width: number };
	/** The page in view and the centre of the view on it: where a tap puts a stamp. */
	viewTarget(): StampTarget | null;
	/** The page under a screen point, or null when the point is not over the page area. */
	pageAtClient(clientX: number, clientY: number): StampTarget | null;
	/** Runs the command as one undo step and refreshes everything that depends on the document. */
	execute(cmd: Command): void;
	/** Selects exactly these items of the page (switching to the lasso) so they can be moved right away. */
	select(pageIndex: number, strokes: Stroke[], elements: PageElement[]): void;
}

const BUILTIN_LABELS: Record<BuiltinStamp, MessageKey> = {
	check: "stamps.check",
	star: "stamps.star",
	arrow: "stamps.arrow",
};

/** A tile in the palette: a stamp that can be placed, or a file that could not be read. */
interface Tile {
	key: string;
	name: string;
	clip: ClipContent | null;
	file: TFile | null;
	error: string;
}

/** Finger or pen movement (CSS px) before a press on a stamp becomes a drag. */
const DRAG_PX = 8;

/**
 * The stamp palette (roadmap 142): a panel over the page area with the built-in stamps and the personal ones saved in
 * the vault. Tap a stamp to put it in the middle of the page in view; drag it to put it where it is dropped. A placed
 * stamp is selected, so it can be moved at once. The panel sits outside the stage, so its taps never reach the pen input.
 */
export class StampPalette {
	readonly el: HTMLElement;
	private readonly listEl: HTMLElement;
	private readonly cache = new Map<string, { mtime: number; tile: Tile }>();
	private opened = false;
	private loading = 0;

	constructor(parent: HTMLElement, private readonly host: StampHost) {
		this.el = parent.createDiv({
			cls: "notebook-stamp-panel notebook-hidden",
			attr: { role: "dialog", "aria-label": t("stamps.title") },
		});
		const head = this.el.createDiv({ cls: "notebook-stamp-head" });
		head.createSpan({ cls: "notebook-stamp-title", text: t("stamps.title") });
		this.iconButton(head, "save", "stamps.save", () => this.saveSelection());
		this.iconButton(head, "x", "stamps.close", () => this.close());
		this.el.createDiv({ cls: "notebook-stamp-hint", text: t("stamps.hint") });
		this.listEl = this.el.createDiv({ cls: "notebook-stamp-list" });
	}

	get isOpen(): boolean {
		return this.opened;
	}

	destroy(): void {
		this.el.remove();
	}

	open(): void {
		this.opened = true;
		this.el.removeClass("notebook-hidden");
		this.render();
		void this.refresh();
	}

	close(): void {
		this.opened = false;
		this.el.addClass("notebook-hidden");
	}

	toggle(): void {
		if (this.opened) this.close();
		else this.open();
	}

	// --- list ---

	private personal: Tile[] = [];

	/** Reads the stamp files (only the ones that changed) and redraws. */
	async refresh(): Promise<void> {
		const ticket = ++this.loading;
		const files = listStampFiles(this.host.app, this.host.folder());
		const tiles: Tile[] = [];
		const seen = new Set<string>();
		for (const file of files) {
			seen.add(file.path);
			const cached = this.cache.get(file.path);
			if (cached && cached.mtime === file.stat.mtime) {
				tiles.push(cached.tile);
				continue;
			}
			const loaded = await loadStamp(this.host.app, file);
			const tile: Tile = loaded.ok
				? { key: file.path, name: file.basename, clip: loaded.clip, file, error: "" }
				: { key: file.path, name: file.basename, clip: null, file, error: loaded.message };
			this.cache.set(file.path, { mtime: file.stat.mtime, tile });
			tiles.push(tile);
			// A newer refresh has started: let it have the last word.
			if (ticket !== this.loading) return;
		}
		for (const path of this.cache.keys()) if (!seen.has(path)) this.cache.delete(path);
		if (ticket !== this.loading) return;
		this.personal = tiles;
		if (this.opened) this.render();
	}

	private render(): void {
		this.listEl.empty();
		const style = this.host.penStyle();
		this.section(t("stamps.builtin"), BUILTIN_STAMPS.map((kind): Tile => ({
			key: `builtin:${kind}`, name: t(BUILTIN_LABELS[kind]),
			clip: builtinStamp(kind, style.color, style.width, measureText), file: null, error: "",
		})));
		const mine = this.section(t("stamps.mine"), this.personal);
		if (this.personal.length === 0) mine.createDiv({ cls: "notebook-stamp-empty", text: t("stamps.empty") });
	}

	private section(title: string, tiles: Tile[]): HTMLElement {
		this.listEl.createDiv({ cls: "notebook-stamp-section", text: title });
		const grid = this.listEl.createDiv({ cls: "notebook-stamp-grid" });
		for (const tile of tiles) this.tile(grid, tile);
		return grid;
	}

	private tile(parent: HTMLElement, tile: Tile): void {
		const clip = tile.clip;
		const el = parent.createDiv({ cls: "notebook-stamp-tile" });
		if (!clip) {
			el.addClass("is-broken");
			el.setAttribute("title", t("stamps.unreadableHint", { error: tile.error }));
			el.createDiv({ cls: "notebook-stamp-preview", text: "?" });
			el.createDiv({ cls: "notebook-stamp-name", text: t("stamps.unreadable", { name: tile.name }) });
			return;
		}
		el.setAttr("role", "button");
		el.setAttr("tabindex", "0");
		el.setAttr("aria-label", t("stamps.place", { name: tile.name }));
		this.drawPreview(el.createDiv({ cls: "notebook-stamp-preview" }), stampPreview(clip, measureText));
		el.createDiv({ cls: "notebook-stamp-name", text: tile.name });
		this.attachDrag(el, clip);
		el.addEventListener("keydown", (e) => {
			if (e.key !== "Enter" && e.key !== " ") return;
			e.preventDefault();
			this.placeAtCentre(clip);
		});
		const file = tile.file;
		if (file) {
			const actions = el.createDiv({ cls: "notebook-stamp-actions" });
			this.iconButton(actions, "pencil", "stamps.rename", () => this.rename(file), "notebook-stamp-action");
			this.iconButton(actions, "trash-2", "stamps.delete", () => this.remove(file), "notebook-stamp-action");
		}
	}

	private drawPreview(parent: HTMLElement, p: StampPreview): void {
		const svg = parent.createSvg("svg", {
			attr: { viewBox: `${p.box.x} ${p.box.y} ${p.box.w} ${p.box.h}`, preserveAspectRatio: "xMidYMid meet", "aria-hidden": "true" },
		});
		for (const b of p.boxes) {
			const attr: Record<string, string> = { x: String(b.x), y: String(b.y), width: String(b.w), height: String(b.h) };
			if (b.rotation !== 0) attr.transform = `rotate(${b.rotation} ${b.x + b.w / 2} ${b.y + b.h / 2})`;
			svg.createSvg("rect", { cls: `notebook-stamp-box is-${b.kind}`, attr });
		}
		for (const s of p.strokes) {
			svg.createSvg("path", {
				attr: {
					d: s.d, fill: "none", stroke: s.color, "stroke-width": String(s.width), "stroke-linecap": "round",
					"stroke-linejoin": "round", "stroke-opacity": s.highlighter ? "0.35" : "1",
				},
			});
		}
	}

	private iconButton(parent: HTMLElement, icon: string, label: MessageKey, onClick: () => void, cls = ""): HTMLButtonElement {
		const b = parent.createEl("button", { cls: `notebook-tool clickable-icon ${cls}`.trim(), attr: { "aria-label": t(label), type: "button" } });
		setIcon(b, icon);
		// A press on a control must not start a drag of the tile it sits on.
		b.addEventListener("pointerdown", (e) => e.stopPropagation());
		b.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			onClick();
		});
		return b;
	}

	// --- placing: tap and drag ---

	private attachDrag(el: HTMLElement, clip: ClipContent): void {
		let start: { id: number; x: number; y: number } | null = null;
		let ghost: HTMLElement | null = null;
		const cleanup = () => {
			ghost?.remove();
			ghost = null;
			start = null;
			el.removeClass("is-dragging");
		};
		el.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 || start) return;
			start = { id: e.pointerId, x: e.clientX, y: e.clientY };
			try {
				el.setPointerCapture(e.pointerId);
			} catch {
				// Capture is a convenience: without it the drag still works while the pointer stays over the tile.
			}
		});
		el.addEventListener("pointermove", (e) => {
			if (!start || e.pointerId !== start.id) return;
			if (!ghost) {
				if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_PX) return;
				el.addClass("is-dragging");
				ghost = el.ownerDocument.body.createDiv({ cls: "notebook-stamp-ghost" });
				this.drawPreview(ghost, stampPreview(clip, measureText));
			}
			ghost.setCssProps({ "--notebook-ghost-x": `${e.clientX}px`, "--notebook-ghost-y": `${e.clientY}px` });
		});
		el.addEventListener("pointerup", (e) => {
			if (!start || e.pointerId !== start.id) return;
			const dragged = ghost !== null;
			cleanup();
			if (dragged) this.placeAt(clip, this.host.pageAtClient(e.clientX, e.clientY));
			else this.placeAtCentre(clip);
		});
		el.addEventListener("pointercancel", cleanup);
		el.addEventListener("lostpointercapture", () => {
			if (ghost) cleanup();
		});
	}

	private placeAtCentre(clip: ClipContent): void {
		this.placeAt(clip, this.host.viewTarget());
	}

	private placeAt(clip: ClipContent, target: StampTarget | null): void {
		const doc = this.host.doc();
		if (!this.host.editable()) {
			new Notice(t("stamps.readOnly"));
			return;
		}
		if (!target || !doc || !doc.pages.includes(target.page)) return;
		try {
			const usable = (id: string): boolean => {
				const record = doc.assets?.[id] ?? clip.assets.find((a) => a.id === id);
				return !!record && resolveAssetFile(this.host.app, record, this.host.folder()) !== null;
			};
			const plan = planStampPlacement(clip, doc, target.page, [target.x, target.y], { usable, measure: measureText });
			if (plan) {
				this.host.execute(plan.command);
				this.host.select(target.pageIndex, plan.strokes, plan.elements);
			}
			if (!plan || plan.skipped > 0) new Notice(t("stamps.skipped"), 8000);
		} catch (e) {
			console.error("[notebook] place stamp", e);
			new Notice(t("stamps.placeFailed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		}
	}

	// --- save, rename, delete ---

	/** Saves the lasso selection as a personal stamp (asks for a name). */
	saveSelection(): void {
		const clip = this.host.captureSelection();
		if (!clip) {
			new Notice(t("stamps.saveNone"));
			return;
		}
		new PromptModal(
			this.host.app,
			{ title: t("stamps.nameTitle"), label: t("stamps.name"), value: t("stamps.defaultName"), cta: t("stamps.saveConfirm") },
			(name) => void this.doSave(name, clip),
		).open();
	}

	private async doSave(name: string, clip: ClipContent): Promise<void> {
		try {
			const file = await saveStamp(this.host.app, this.host.folder(), name, clip);
			new Notice(t("stamps.saved", { name: file.basename }));
			await this.refresh();
		} catch (e) {
			console.error("[notebook] save stamp", e);
			new Notice(t("stamps.saveFailed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		}
	}

	private rename(file: TFile): void {
		new PromptModal(
			this.host.app,
			{ title: t("stamps.rename"), label: t("stamps.name"), value: file.basename, cta: t("stamps.renameConfirm") },
			(name) => {
				void renameStamp(this.host.app, this.host.folder(), file, name).then(
					() => this.refresh(),
					(e: unknown) => {
						console.error("[notebook] rename stamp", e);
						new Notice(t("stamps.renameFailed", { error: e instanceof Error ? e.message : String(e) }), 8000);
					},
				);
			},
		).open();
	}

	private remove(file: TFile): void {
		new ConfirmModal(
			this.host.app,
			{ title: t("stamps.delete"), body: t("stamps.deleteBody", { name: file.basename }), cta: t("library.modal.deleteConfirm") },
			() => {
				void deleteStamp(this.host.app, file).then(
					() => this.refresh(),
					(e: unknown) => {
						console.error("[notebook] delete stamp", e);
						new Notice(t("stamps.deleteFailed", { error: e instanceof Error ? e.message : String(e) }), 8000);
					},
				);
			},
		).open();
	}
}
