import { Notice, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import type { ClipContent } from "../ink/clipboard";
import { measureText } from "../ink/renderer";
import { stampPreview, type StampPreview } from "../ink/stamps";
import type { InputPolicy } from "../ink/input-policy";
import { isSymbolSized, planGlyphPlacement, planSymbolPlacement, symbolTapPlaces, type SymbolStyle } from "../ink/symbols";
import type { Command } from "../model/history";
import type { NotebookDocument, PageElement, Stroke } from "../model/types";
import { listStampFiles, loadStamp, saveStamp } from "../storage/stamps";
import { PromptModal } from "../library/library-modals";
import {
	glyphId, normaliseSymbolUsage, personalId, rankSymbols, recordSymbolUse, SYMBOL_USAGE_KEY, TYPO_SYMBOLS, type SymbolCandidate,
} from "../ui/symbol-rank";
import type { UsageMap } from "../ui/usage";
import type { StampTarget } from "./stamp-palette";

/** The part of the notebook view the strip needs. */
export interface SymbolHost {
	app: App;
	folder(): string;
	editable(): boolean;
	doc(): NotebookDocument | null;
	/** Settings: whether the strip is shown and how many buttons it has. */
	options(): { show: boolean; count: number };
	/** Colour and width of the pen and the text size: a placed symbol is drawn at their scale. */
	style(): SymbolStyle;
	pageAtClient(clientX: number, clientY: number): StampTarget | null;
	/** The view's input policy (palm rejection): the catcher asks it before a tap places a symbol and tells it about the pen. */
	policy(): InputPolicy;
	/** Copy of the lasso selection, or null when nothing is selected. */
	captureSelection(): ClipContent | null;
	execute(cmd: Command): void;
	select(pageIndex: number, strokes: Stroke[], elements: PageElement[]): void;
}

interface Personal {
	name: string;
	clip: ClipContent;
}

/** Finger or pen movement (CSS px) after which a press on the page is a drag, not a tap. */
const TAP_SLOP = 12;

/**
 * Recent symbols (roadmap 212): a compact strip over the page area with the symbols used most (personal ones saved as
 * stamps, and typographic ones such as the universal quantifier or the integral sign). Tap one, then tap the page: it is
 * placed there at the size of the pen. Counts are kept on this device only. The strip and the catcher sit outside the stage.
 */
export class SymbolStrip {
	readonly el: HTMLElement;
	private readonly catcher: HTMLElement;
	private readonly cache = new Map<string, { mtime: number; item: Personal | null }>();
	private personal: Array<{ id: string; item: Personal }> = [];
	private armed: SymbolCandidate | null = null;
	private signature = "";
	private loading = 0;
	private down: { id: number; x: number; y: number } | null = null;
	private keyHandler: ((e: KeyboardEvent) => void) | null = null;

	constructor(parent: HTMLElement, private readonly host: SymbolHost) {
		this.el = parent.createDiv({ cls: "notebook-symbol-strip notebook-hidden", attr: { role: "toolbar", "aria-label": t("symbols.title") } });
		this.catcher = parent.createDiv({ cls: "notebook-symbol-catcher notebook-hidden" });
		// The pen hovering over the catcher never reaches the page's own pointer handlers: tell the palm rejection about it, so a
		// hand resting beside the pen does not place a symbol.
		this.catcher.addEventListener("pointermove", (e) => {
			if (e.pointerType === "pen") this.host.policy().notePen(e.timeStamp);
		});
		this.catcher.addEventListener("pointerdown", (e) => {
			const policy = this.host.policy();
			if (e.pointerType === "pen") policy.setPenDown(true, e.timeStamp);
			if (!e.isPrimary || this.down) return;
			e.preventDefault();
			e.stopPropagation();
			// Palm rejection: a touch while the pen is active (or was, within the rejection time), a palm-sized or edge touch, and a
			// finger in pen-only mode do not place anything; the pen's side button does not either (it opens the radial menu).
			const rect = this.catcher.getBoundingClientRect();
			if (!symbolTapPlaces(policy, {
				pointerType: e.pointerType, timeStamp: e.timeStamp, button: e.button, buttons: e.buttons, pressure: e.pressure,
				contact: Math.max(e.width, e.height), x: e.clientX - rect.left, y: e.clientY - rect.top, width: rect.width, height: rect.height,
			})) return;
			this.down = { id: e.pointerId, x: e.clientX, y: e.clientY };
		});
		this.catcher.addEventListener("pointerup", (e) => {
			if (e.pointerType === "pen") this.host.policy().setPenDown(false, e.timeStamp);
			const d = this.down;
			if (!d || e.pointerId !== d.id) return;
			this.down = null;
			e.preventDefault();
			e.stopPropagation();
			if (Math.hypot(e.clientX - d.x, e.clientY - d.y) <= TAP_SLOP) this.placeAt(e.clientX, e.clientY);
		});
		this.catcher.addEventListener("pointercancel", (e) => {
			if (e.pointerType === "pen") this.host.policy().setPenDown(false, e.timeStamp);
			this.down = null;
		});
		this.sync();
		void this.refresh();
	}

	destroy(): void {
		this.disarm();
		this.el.remove();
		this.catcher.remove();
	}

	get isArmed(): boolean {
		return this.armed !== null;
	}

	/** The symbols the strip shows now, best first (for tests and the screenshots). */
	get shown(): SymbolCandidate[] {
		return this.ranked();
	}

	// --- data ---

	private usage(): UsageMap {
		try {
			return normaliseSymbolUsage(this.host.app.loadLocalStorage(SYMBOL_USAGE_KEY));
		} catch {
			return {};
		}
	}

	private count(id: string): void {
		try {
			this.host.app.saveLocalStorage(SYMBOL_USAGE_KEY, recordSymbolUse(this.usage(), id, Date.now()));
		} catch (e) {
			console.error("[notebook] could not store the symbol counts", e);
		}
	}

	private candidates(): SymbolCandidate[] {
		const out: SymbolCandidate[] = this.personal.map((p) => ({ id: p.id, kind: "personal", label: p.item.name }));
		for (const g of TYPO_SYMBOLS) out.push({ id: glyphId(g), kind: "glyph", label: g });
		return out;
	}

	private ranked(): SymbolCandidate[] {
		return rankSymbols(this.candidates(), this.usage(), Date.now(), this.host.options().count);
	}

	/** Reads the saved symbols (the stamps small enough to be one); only the files that changed are read. */
	async refresh(): Promise<void> {
		const ticket = ++this.loading;
		const files: TFile[] = listStampFiles(this.host.app, this.host.folder());
		const seen = new Set<string>();
		const found: Array<{ id: string; item: Personal }> = [];
		for (const file of files) {
			seen.add(file.path);
			let entry = this.cache.get(file.path);
			if (!entry || entry.mtime !== file.stat.mtime) {
				const loaded = await loadStamp(this.host.app, file);
				entry = { mtime: file.stat.mtime, item: loaded.ok && isSymbolSized(loaded.clip) ? { name: file.basename, clip: loaded.clip } : null };
				this.cache.set(file.path, entry);
				if (ticket !== this.loading) return;
			}
			if (entry.item) found.push({ id: personalId(entry.item.name), item: entry.item });
		}
		for (const path of this.cache.keys()) if (!seen.has(path)) this.cache.delete(path);
		if (ticket !== this.loading) return;
		this.personal = found;
		this.render(true);
	}

	// --- display ---

	/** Shows or hides the strip (setting, editable view) and redraws it when its content changed. */
	sync(): void {
		this.render(false);
	}

	private render(force: boolean): void {
		const { show, count } = this.host.options();
		const visible = show && this.host.editable();
		if (!visible) this.disarm();
		const list = visible ? this.ranked() : [];
		const signature = `${visible}|${count}|${this.armed?.id ?? ""}|${list.map((c) => c.id).join(",")}`;
		this.el.toggleClass("notebook-hidden", !visible || list.length === 0);
		if (signature === this.signature && !force) return;
		this.signature = signature;
		this.el.empty();
		for (const c of list) this.button(c);
		if (this.armed) this.el.createSpan({ cls: "notebook-symbol-hint", text: t("symbols.hint") });
	}

	private button(c: SymbolCandidate): void {
		const armed = this.armed?.id === c.id;
		const b = this.el.createEl("button", {
			cls: "notebook-symbol-btn", attr: { type: "button", "aria-label": c.kind === "glyph" ? t("symbols.insert", { name: c.label }) : t("symbols.place", { name: c.label }), "aria-pressed": armed ? "true" : "false" },
		});
		if (armed) b.addClass("is-armed");
		const item = c.kind === "personal" ? this.personal.find((p) => p.id === c.id)?.item : undefined;
		if (item) this.drawPreview(b.createSpan({ cls: "notebook-symbol-art" }), stampPreview(item.clip, measureText));
		else b.createSpan({ cls: "notebook-symbol-glyph", text: c.label });
		b.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (this.armed?.id === c.id) this.disarm();
			else this.arm(c);
		});
	}

	private drawPreview(parent: HTMLElement, p: StampPreview): void {
		const svg = parent.createSvg("svg", {
			attr: { viewBox: `${p.box.x} ${p.box.y} ${p.box.w} ${p.box.h}`, preserveAspectRatio: "xMidYMid meet", "aria-hidden": "true" },
		});
		for (const s of p.strokes) {
			svg.createSvg("path", {
				attr: { d: s.d, fill: "none", stroke: "currentColor", "stroke-width": String(s.width), "stroke-linecap": "round", "stroke-linejoin": "round" },
			});
		}
	}

	// --- saving ---

	/** Saves the lasso selection as a symbol (a small personal stamp; asks for a name). */
	saveSelection(): void {
		const clip = this.host.captureSelection();
		if (!clip) {
			new Notice(t("stamps.saveNone"));
			return;
		}
		if (!isSymbolSized(clip)) {
			new Notice(t("symbols.tooLarge"), 8000);
			return;
		}
		new PromptModal(
			this.host.app,
			{ title: t("symbols.nameTitle"), label: t("symbols.name"), value: t("symbols.defaultName"), cta: t("stamps.saveConfirm") },
			(name) => void this.doSave(name, clip),
		).open();
	}

	private async doSave(name: string, clip: ClipContent): Promise<void> {
		try {
			const file = await saveStamp(this.host.app, this.host.folder(), name, clip);
			new Notice(t("symbols.saved", { name: file.basename }));
			await this.refresh();
		} catch (e) {
			console.error("[notebook] save symbol", e);
			new Notice(t("symbols.saveFailed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		}
	}

	// --- placing ---

	private arm(c: SymbolCandidate): void {
		this.armed = c;
		this.catcher.removeClass("notebook-hidden");
		if (!this.keyHandler) {
			this.keyHandler = (e) => {
				if (e.key === "Escape") this.disarm();
			};
			activeWindow.addEventListener("keydown", this.keyHandler);
		}
		this.render(false);
	}

	/** Cancels a pending placement. */
	disarm(): void {
		if (!this.armed && !this.keyHandler) return;
		this.armed = null;
		this.down = null;
		this.catcher.addClass("notebook-hidden");
		if (this.keyHandler) activeWindow.removeEventListener("keydown", this.keyHandler);
		this.keyHandler = null;
		this.render(false);
	}

	private placeAt(clientX: number, clientY: number): void {
		const c = this.armed;
		const target = this.host.pageAtClient(clientX, clientY);
		const doc = this.host.doc();
		if (!c || !target || !doc || !this.host.editable()) {
			this.disarm();
			return;
		}
		this.place(c, doc, target, [target.x, target.y]);
		this.disarm();
	}

	/** Places `c` on the page of `target` centred at `centre`, counts the use, selects the result. Returns whether something was placed. */
	place(c: SymbolCandidate, doc: NotebookDocument, target: StampTarget, centre: readonly [number, number]): boolean {
		const style = this.host.style();
		try {
			if (c.kind === "glyph") {
				const plan = planGlyphPlacement(c.label, target.page, centre, style, measureText);
				if (!plan) return false;
				this.host.execute(plan.command);
				this.host.select(target.pageIndex, [], [plan.element]);
			} else {
				const item = this.personal.find((p) => p.id === c.id)?.item;
				const plan = item ? planSymbolPlacement(item.clip, doc, target.page, centre, style, measureText) : null;
				if (!plan) return false;
				this.host.execute(plan.command);
				this.host.select(target.pageIndex, plan.strokes, plan.elements);
			}
		} catch (e) {
			console.error("[notebook] place symbol", e);
			new Notice(t("symbols.placeFailed", { error: e instanceof Error ? e.message : String(e) }), 8000);
			return false;
		}
		this.count(c.id);
		this.render(false);
		return true;
	}
}
