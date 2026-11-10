import { Modal, Platform, setIcon, type App } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { typesetKey, storeTypeset } from "../ink/math-render";
import { CalcSession, evaluate, type CalcResult } from "../math/calc";
import { assignLatex, equationLatex, formatValue, SIG_MAX, SIG_MIN, type Formatted, type FormatOptions } from "../math/calc-format";
import { graphLink, type GraphLink } from "../math/calc-graph";
import { restoreSession, saveSession } from "../math/calc-state";
import { createId } from "../model/document";
import { AddElement } from "../model/history";
import { createEquation, createGraph, isParamName } from "../model/math-elements";
import { isLocked } from "../model/page-lock";
import { freezeElement } from "../model/serialize";
import type { GraphElement, NotebookDocument, Page, PageElement, TextElement } from "../model/types";
import { EXAMPLES, GROUPS, PAD, type KeyGroupId } from "../ui/calc-keys";
import { answerOf, booksVars, loadCalcStore, pushTape, saveCalcStore, withBook, type CalcStore, type TapeRow } from "../ui/calc-store";
import { modalShell, shellButton } from "../ui/components/modal-shell";
import { attachLongPressHelp, resolveHelp } from "../ui/long-press-help";
import { TypesetError, typesetEquation } from "./math-typeset";
import { showNotice } from "./notice";
import type { MathHost } from "./math-tools";

/**
 * View side of the advanced calculator (0.29, roadmap #182). The maths is pure (math/calc*.ts); this file is the dialog
 * (an expression line, a big answer, large pen-friendly keys, the tape, the variables) and the three ways a result gets onto the
 * page: as a text box, as a formula element carrying the expression with its result, and as a function graph. Each goes through
 * the history as an ordinary AddElement (one undo step); a locked page refuses them. The tape, the display preferences and the
 * variables of each notebook are kept per device (ui/calc-store.ts), never in the notebook file.
 */
export type CalcHost = Pick<MathHost, "doc" | "editable" | "execute" | "insertTarget" | "pen" | "select" | "refresh" | "selection"> & { app: App };

/** The error sentence for a code (translated; the generic one when a code has no message). */
export function calcErrorText(code: string, vars: Readonly<Record<string, string>> = {}): string {
	const key = `calc.err.${code}` as MessageKey;
	const text = t(key, { ...vars });
	return text === key ? t("calc.err.generic") : text;
}

/** A copy of a session, so an expression can be tried without defining anything. */
function cloneSession(s: CalcSession): CalcSession {
	const c = new CalcSession();
	for (const [k, v] of s.vars) c.vars.set(k, v);
	for (const [k, v] of s.fns) c.fns.set(k, v);
	c.ans = s.ans;
	c.angle = s.angle;
	return c;
}

/** Functions that may take long: not run while typing, only on "=". */
const HEAVY = /\b(solve|integrate|integral|diff|derivative)\s*\(/;

type Good = Extract<CalcResult, { ok: true }>;

interface Shown {
	src: string;
	result: Good;
	formatted: Formatted | null;
	preview: boolean;
}

export class CalculatorTools {
	constructor(private readonly host: CalcHost) {}

	/** Opens the calculator (the text of a selected text box, when one is selected, is the first expression). */
	open(): void {
		const sel = this.host.selection();
		const only = sel && sel.elements.length === 1 ? sel.elements[0] : undefined;
		const first = only?.type === "text" ? only.text.split(/\r?\n/)[0]?.trim() ?? "" : "";
		new CalculatorModal(this.host.app, this.host, first.length > 0 && first.length <= 200 ? first : "").open();
	}
}

export class CalculatorModal extends Modal {
	private store: CalcStore;
	private session = new CalcSession();
	private input!: HTMLInputElement;
	private answerBox!: HTMLElement;
	private prefsBox!: HTMLElement;
	private varsBox!: HTMLElement;
	private tapeBox!: HTMLElement;
	private groupRow!: HTMLElement;
	private groupKeys!: HTMLElement;
	private shown: Shown | null = null;
	private error: { text: string; at: number } | null = null;
	private group: KeyGroupId = "functions";
	private readonly bookId: string | null;
	private closed = false;
	private stopHelp: (() => void) | null = null;

	constructor(app: App, private readonly host: CalcHost, private readonly prefill: string) {
		super(app);
		this.store = loadCalcStore(app);
		this.bookId = host.doc()?.id ?? null;
		this.session.angle = this.store.angle;
		restoreSession(this.session, booksVars(this.store, this.bookId));
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("calc.title"), subtitle: t("calc.subtitle"), icon: "calculator", size: "wide", cls: "nb-calc-modal", footer: false });
		const root = shell.body.createDiv({ cls: "nb-calc" });
		const main = root.createDiv({ cls: "nb-calc-main" });
		this.prefsBox = main.createDiv({ cls: "nb-calc-prefs" });
		const row = main.createDiv({ cls: "nb-calc-inputrow" });
		this.input = row.createEl("input", {
			cls: "nb-calc-input",
			attr: { type: "text", placeholder: t("calc.placeholder"), "aria-label": t("calc.input"), autocomplete: "off", autocapitalize: "off", spellcheck: "false", enterkeyhint: "go" },
		});
		// On a tablet the on-screen keys are the keyboard: the system one stays away until asked for.
		if (Platform.isMobile) this.input.setAttribute("inputmode", "none");
		if (Platform.isMobile) {
			const kb = row.createEl("button", { cls: "nb-calc-iconbtn", attr: { type: "button", "aria-label": t("calc.keyboard"), title: t("calc.keyboard") } });
			setIcon(kb, "keyboard");
			kb.addEventListener("click", () => {
				const none = this.input.getAttribute("inputmode") === "none";
				this.input.setAttribute("inputmode", none ? "text" : "none");
				this.input.blur();
				this.input.focus();
			});
		}
		this.answerBox = main.createDiv({ cls: "nb-calc-answer", attr: { "aria-live": "polite" } });
		this.varsBox = main.createDiv({ cls: "nb-calc-vars" });
		this.tapeBox = main.createDiv({ cls: "nb-calc-tape" });
		const keys = root.createDiv({ cls: "nb-calc-keys" });
		this.buildPad(keys);
		this.groupRow = keys.createDiv({ cls: "nb-calc-groups", attr: { role: "tablist" } });
		this.groupKeys = keys.createDiv({ cls: "nb-calc-groupkeys" });
		this.buildExamples(keys);

		this.input.addEventListener("input", () => this.preview());
		this.input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.commit();
			}
		});
		this.renderPrefs();
		this.renderGroups();
		this.renderVars();
		this.renderTape();
		this.renderAnswer();
		if (this.prefill) {
			this.input.value = this.prefill;
			this.preview();
		}
		this.stopHelp = attachLongPressHelp(this.modalEl, (b) => (b.dataset.help ? resolveHelp(b) : null));
		if (!Platform.isMobile) this.input.focus();
	}

	onClose(): void {
		this.closed = true;
		this.stopHelp?.();
		this.stopHelp = null;
		this.persist();
		this.contentEl.empty();
	}

	// -------------------------------------------------------------------------------------------- state

	private persist(): void {
		const base: CalcStore = { ...this.store, angle: this.session.angle };
		this.store = withBook(base, this.bookId, saveSession(this.session));
		saveCalcStore(this.host.app, this.store);
	}

	private get format(): FormatOptions {
		return this.store.format;
	}

	private setFormat(patch: Partial<FormatOptions>): void {
		this.store = { ...this.store, format: { ...this.store.format, ...patch } };
		this.persist();
		this.renderPrefs();
		// The same answer in the new notation (nothing is evaluated again).
		if (this.shown) this.shown = { ...this.shown, formatted: this.shown.result.kind === "defn" ? null : formatValue(this.shown.result.value, this.format) };
		this.renderAnswer();
		this.renderVars();
	}

	private setAngle(angle: "deg" | "rad"): void {
		this.session.angle = angle;
		this.persist();
		this.renderPrefs();
		this.preview();
	}

	// -------------------------------------------------------------------------------------------- evaluation

	private preview(): void {
		this.error = null;
		const src = this.input.value.trim();
		if (src === "") {
			this.shown = null;
			this.renderAnswer();
			return;
		}
		if (HEAVY.test(src)) {
			this.shown = null;
			this.renderAnswer(t("calc.pressEquals"));
			return;
		}
		const r = evaluate(src, cloneSession(this.session));
		this.shown = r.ok ? { src, result: r, formatted: r.kind === "defn" ? null : formatValue(r.value, this.format), preview: true } : null;
		this.renderAnswer();
	}

	/** "=": evaluates for real (assignments take effect), puts the line on the tape and shows the answer. */
	private commit(): Shown | null {
		const src = this.input.value.trim();
		if (src === "") return null;
		const r = evaluate(src, this.session);
		if (!r.ok) {
			this.shown = null;
			this.error = { text: calcErrorText(r.code, r.vars), at: r.at };
			if (r.at >= 0) this.input.setSelectionRange(Math.min(r.at, src.length), Math.min(r.at + 1, src.length));
			this.renderAnswer();
			return null;
		}
		this.error = null;
		const formatted = r.kind === "defn" ? null : formatValue(r.value, this.format);
		const shown: Shown = { src, result: r, formatted, preview: false };
		this.shown = shown;
		const text = r.kind === "defn" ? t("calc.defined", { name: `${r.name}(${r.params.join(", ")})` }) : r.kind === "assign" ? `${r.name} = ${formatted!.text}` : formatted!.text;
		const latex = r.kind === "defn" ? "" : r.kind === "assign" ? assignLatex(r.name, r.node, formatted!) : equationLatex(r.node, formatted!);
		const row: TapeRow = { expr: src, text, latex };
		this.store = { ...this.store, tape: pushTape(this.store.tape, row) };
		this.persist();
		this.renderAnswer();
		this.renderVars();
		this.renderTape();
		this.input.select();
		return shown;
	}

	// -------------------------------------------------------------------------------------------- rendering

	private segmented<T extends string>(parent: HTMLElement, label: string, help: MessageKey, options: ReadonlyArray<{ id: T; label: string }>, current: T, onPick: (id: T) => void): void {
		const wrap = parent.createDiv({ cls: "nb-calc-pref" });
		wrap.createSpan({ cls: "nb-calc-preflabel", text: label });
		const seg = wrap.createDiv({ cls: "nb-calc-seg", attr: { role: "group", "aria-label": label } });
		for (const o of options) {
			const b = seg.createEl("button", { cls: "nb-calc-segbtn", text: o.label, attr: { type: "button", "aria-pressed": String(o.id === current), "aria-label": `${label}: ${o.label}`, "data-help": help } });
			b.toggleClass("is-active", o.id === current);
			b.addEventListener("click", () => onPick(o.id));
		}
	}

	private renderPrefs(): void {
		const box = this.prefsBox;
		box.empty();
		this.segmented(box, t("calc.angle"), "calc.help.angle", [{ id: "deg", label: t("calc.deg") }, { id: "rad", label: t("calc.rad") }], this.session.angle, (id) => this.setAngle(id));
		this.segmented(
			box, t("calc.notation"), "calc.help.notation",
			[{ id: "auto", label: t("calc.notation.auto") }, { id: "sci", label: t("calc.notation.sci") }, { id: "eng", label: t("calc.notation.eng") }],
			this.format.notation, (id) => this.setFormat({ notation: id }),
		);
		this.segmented(
			box, t("calc.fractions"), "calc.help.fractions",
			[{ id: "exact", label: t("calc.fractions.exact") }, { id: "decimal", label: t("calc.fractions.decimal") }],
			this.format.fractions, (id) => this.setFormat({ fractions: id }),
		);
		const sig = box.createDiv({ cls: "nb-calc-pref" });
		sig.createSpan({ cls: "nb-calc-preflabel", text: t("calc.sig") });
		const step = sig.createDiv({ cls: "nb-calc-seg nb-calc-stepper", attr: { role: "group", "aria-label": t("calc.sig") } });
		const minus = step.createEl("button", { cls: "nb-calc-segbtn", text: "−", attr: { type: "button", "aria-label": t("calc.sig.less"), "data-help": "calc.help.sig" } });
		step.createSpan({ cls: "nb-calc-sigvalue", text: this.format.sig === 0 ? t("calc.sig.auto") : String(this.format.sig) });
		const plus = step.createEl("button", { cls: "nb-calc-segbtn", text: "+", attr: { type: "button", "aria-label": t("calc.sig.more"), "data-help": "calc.help.sig" } });
		// Auto, then 15 down to 3 significant figures.
		minus.addEventListener("click", () => this.setFormat({ sig: this.format.sig === 0 ? SIG_MAX : this.format.sig <= SIG_MIN ? SIG_MIN : this.format.sig - 1 }));
		plus.addEventListener("click", () => this.setFormat({ sig: this.format.sig >= SIG_MAX ? 0 : this.format.sig === 0 ? 0 : this.format.sig + 1 }));
	}

	private renderAnswer(hint?: string): void {
		const box = this.answerBox;
		box.empty();
		const s = this.shown;
		if (this.error) {
			box.createDiv({ cls: "nb-calc-error", text: this.error.text, attr: { role: "alert" } });
			return;
		}
		if (!s) {
			box.createDiv({ cls: "nb-calc-hint", text: hint ?? t("calc.empty") });
			return;
		}
		const r = s.result;
		const card = box.createDiv({ cls: "nb-calc-card" });
		card.toggleClass("is-preview", s.preview);
		if (r.kind === "defn") {
			card.createDiv({ cls: "nb-calc-result", text: t("calc.defined", { name: `${r.name}(${r.params.join(", ")})` }) });
		} else if (s.formatted?.grid) {
			const table = card.createEl("table", { cls: "nb-calc-grid" });
			for (const rowCells of s.formatted.grid) {
				const tr = table.createEl("tr");
				for (const cell of rowCells) tr.createEl("td", { text: cell });
			}
		} else if (s.formatted) {
			card.createDiv({ cls: "nb-calc-result", text: (s.preview ? "= " : r.kind === "assign" ? `${r.name} = ` : "= ") + s.formatted.text });
			if (s.formatted.approx) card.createDiv({ cls: "nb-calc-approx", text: `≈ ${s.formatted.approx}` });
		}
		if (s.preview) {
			card.createDiv({ cls: "nb-calc-hint", text: t("calc.previewHint") });
		}
		this.renderActions(box, s);
	}

	private renderActions(box: HTMLElement, s: Shown): void {
		const row = box.createDiv({ cls: "nb-calc-actions" });
		const target = this.host.editable() ? this.host.insertTarget() : null;
		const insertable = s.result.kind !== "defn" && !!target;
		const link = this.linkFor(s);
		const title = target ? "" : t("calc.noPage");
		const mk = (label: string, icon: string, help: MessageKey, enabled: boolean, run: () => void, why = title): void => {
			const b = shellButton(row, "secondary", label, run, { icon, disabled: !enabled });
			b.dataset.help = help;
			if (!enabled && why) b.title = why;
		};
		mk(t("calc.insertText"), "text", "calc.help.insertText", insertable, () => this.insertText());
		mk(t("calc.insertFormula"), "sigma", "calc.help.insertFormula", insertable, () => void this.insertFormula());
		mk(t("calc.insertGraph"), "chart-spline", "calc.help.insertGraph", !!target && !!link, () => this.insertGraph(), link ? title : t("calc.noGraph"));
		mk(t("calc.copy"), "copy", "calc.help.copy", s.result.kind !== "defn", () => void this.copy(), "");
	}

	private linkFor(s: Shown): GraphLink | null {
		const link = graphLink(s.src, s.preview ? cloneSession(this.session) : this.session);
		return link && link.params.every((p) => isParamName(p.name)) ? link : null;
	}

	private renderVars(): void {
		const box = this.varsBox;
		box.empty();
		const names = [...this.session.vars.keys(), ...this.session.fns.keys()];
		if (names.length === 0) return;
		box.createDiv({ cls: "nb-calc-sectiontitle", text: t("calc.variables") });
		const list = box.createDiv({ cls: "nb-calc-chips" });
		for (const name of names) {
			const v = this.session.vars.get(name);
			const fnDef = this.session.fns.get(name);
			const label = v ? `${name} = ${formatValue(v, this.format).text}` : `${name}(${fnDef!.params.join(", ")})`;
			const chip = list.createDiv({ cls: "nb-calc-varchip" });
			const use = chip.createEl("button", { cls: "nb-calc-varuse", text: label, attr: { type: "button", title: t("calc.variable.use", { name }) } });
			use.addEventListener("click", () => this.insertAtCursor(fnDef ? `${name}(` : name));
			const del = chip.createEl("button", { cls: "nb-calc-vardel", attr: { type: "button", "aria-label": t("calc.variable.forget", { name }), title: t("calc.variable.forget", { name }) } });
			setIcon(del, "x");
			del.addEventListener("click", () => {
				this.session.vars.delete(name);
				this.session.fns.delete(name);
				this.persist();
				this.renderVars();
				this.preview();
			});
		}
	}

	private renderTape(): void {
		const box = this.tapeBox;
		box.empty();
		const tape = this.store.tape;
		const head = box.createDiv({ cls: "nb-calc-tapehead" });
		head.createSpan({ cls: "nb-calc-sectiontitle", text: t("calc.tape") });
		if (tape.length === 0) {
			box.createDiv({ cls: "nb-calc-hint", text: t("calc.tape.empty") });
			return;
		}
		const clear = head.createEl("button", { cls: "nb-calc-link", text: t("calc.tape.clear"), attr: { type: "button" } });
		clear.addEventListener("click", () => {
			this.store = { ...this.store, tape: [] };
			this.persist();
			this.renderTape();
		});
		const list = box.createDiv({ cls: "nb-calc-tapelist", attr: { role: "list" } });
		for (const row of tape.slice(0, 40)) {
			const line = list.createDiv({ cls: "nb-calc-taperow", attr: { role: "listitem" } });
			const expr = line.createEl("button", { cls: "nb-calc-tapeexpr", text: row.expr, attr: { type: "button", title: t("calc.tape.reuse") } });
			expr.addEventListener("click", () => {
				this.input.value = row.expr;
				this.input.focus();
				this.preview();
			});
			const ans = line.createEl("button", { cls: "nb-calc-tapeans", text: row.text, attr: { type: "button", title: t("calc.tape.insertAnswer") } });
			ans.addEventListener("click", () => this.insertAtCursor(answerOf(row)));
		}
	}

	private buildPad(parent: HTMLElement): void {
		const pad = parent.createDiv({ cls: "nb-calc-pad", attr: { role: "group", "aria-label": t("calc.pad") } });
		for (const key of PAD) {
			const help: MessageKey = key.action === "eval" ? "calc.help.equals" : key.action === "clear" ? "calc.help.clear" : key.action === "back" ? "calc.help.back" : "calc.help.key";
			const b = pad.createEl("button", { cls: `nb-calc-key is-${key.kind ?? "digit"}`, text: key.label, attr: { type: "button", "aria-label": t(key.name, { key: key.label }), "data-help": help } });
			// Keep the focus (and the caret) in the expression line.
			b.addEventListener("pointerdown", (e) => e.preventDefault());
			b.addEventListener("click", () => {
				if (key.action === "clear") {
					this.input.value = "";
					this.shown = null;
					this.error = null;
					this.renderAnswer();
				} else if (key.action === "back") this.backspace();
				else if (key.action === "eval") this.commit();
				else this.insertAtCursor(key.text ?? "");
			});
		}
	}

	private renderGroups(): void {
		const row = this.groupRow;
		row.empty();
		for (const g of GROUPS) {
			const b = row.createEl("button", { cls: "nb-calc-tab", text: t(g.title), attr: { type: "button", role: "tab", "aria-selected": String(g.id === this.group) } });
			b.toggleClass("is-active", g.id === this.group);
			b.addEventListener("click", () => {
				this.group = g.id;
				this.renderGroups();
			});
		}
		const keys = this.groupKeys;
		keys.empty();
		const group = GROUPS.find((g) => g.id === this.group) ?? GROUPS[0]!;
		for (const k of group.keys) {
			const b = keys.createEl("button", { cls: "nb-calc-chipkey", text: k.label, attr: { type: "button" } });
			if (k.hint) b.title = k.hint;
			b.addEventListener("pointerdown", (e) => e.preventDefault());
			b.addEventListener("click", () => this.insertAtCursor(k.text));
		}
	}

	private buildExamples(parent: HTMLElement): void {
		const details = parent.createEl("details", { cls: "nb-calc-try" });
		details.createEl("summary", { text: t("calc.try") });
		details.createDiv({ cls: "nb-calc-hint", text: t("calc.try.hint") });
		const list = details.createDiv({ cls: "nb-calc-chips" });
		for (const ex of EXAMPLES) {
			const b = list.createEl("button", { cls: "nb-calc-chipkey is-example", text: ex, attr: { type: "button" } });
			b.addEventListener("click", () => {
				this.input.value = ex;
				this.input.focus();
				this.preview();
			});
		}
	}

	// -------------------------------------------------------------------------------------------- editing the line

	private insertAtCursor(text: string): void {
		const el = this.input;
		const start = el.selectionStart ?? el.value.length;
		const end = el.selectionEnd ?? start;
		// A key typed over the answer that "=" left selected replaces it, except an operator, which continues from `ans`.
		const continuing = this.shown && !this.shown.preview && start === 0 && end === el.value.length && el.value.length > 0 && /^[+\-*/^!]/.test(text);
		const base = continuing ? "ans" : el.value.slice(0, start);
		const rest = continuing ? "" : el.value.slice(end);
		el.value = base + text + rest;
		const caret = base.length + text.length;
		el.setSelectionRange(caret, caret);
		this.preview();
	}

	private backspace(): void {
		const el = this.input;
		const start = el.selectionStart ?? el.value.length;
		const end = el.selectionEnd ?? start;
		if (start === end && start === 0) return;
		const from = start === end ? start - 1 : start;
		el.value = el.value.slice(0, from) + el.value.slice(end);
		el.setSelectionRange(from, from);
		this.preview();
	}

	// -------------------------------------------------------------------------------------------- onto the page

	/** The shown result, committed first when it is only a preview. Null when there is nothing to put on the page. */
	private current(): Shown | null {
		if (this.shown && !this.shown.preview && this.shown.src === this.input.value.trim()) return this.shown;
		return this.commit();
	}

	private pageTarget(): { page: Page; pageIndex: number; x: number; y: number; doc: NotebookDocument } | null {
		if (!this.host.editable()) {
			showNotice(t("calc.noPage"));
			return null;
		}
		const target = this.host.insertTarget();
		const doc = this.host.doc();
		const page = target ? doc?.pages[target.pageIndex] : undefined;
		if (!target || !doc || !page) {
			showNotice(t("calc.noPage"));
			return null;
		}
		if (isLocked(page)) {
			showNotice(t("lock.needsUnlock", { n: String(target.pageIndex + 1) }));
			return null;
		}
		return { page, pageIndex: target.pageIndex, x: target.x, y: target.y, doc };
	}

	private place(page: Page, pageIndex: number, el: PageElement): void {
		if (!this.host.execute(new AddElement(page.id, el, page.elements?.length ?? 0))) return;
		const placed = this.host.doc()?.pages[pageIndex]?.elements?.find((e) => e.id === el.id);
		if (placed) this.host.select(pageIndex, [placed]);
		this.host.refresh();
	}

	private lineOf(s: Shown): string {
		const r = s.result;
		if (r.kind === "assign") return `${r.name} = ${s.formatted!.text}`;
		return `${s.src} = ${s.formatted!.text}`;
	}

	private insertText(): void {
		const s = this.current();
		const where = this.pageTarget();
		if (!s || !s.formatted || !where) return;
		const size = Math.max(12, this.host.pen().textSize);
		const text = this.lineOf(s);
		const width = Math.min(where.page.width * 0.8, Math.max(120, Math.min(420, size * 0.62 * text.length + 8)));
		const x = Math.max(0, Math.min(where.page.width - width, where.x - width / 2));
		const y = Math.max(0, Math.min(where.page.height - size * 1.6, where.y));
		const el: TextElement = freezeElement({ id: createId(), type: "text", x: round2(x), y: round2(y), width: round2(width), text, fontSize: size, color: this.host.pen().color });
		this.place(where.page, where.pageIndex, el);
		showNotice(t("calc.inserted"));
	}

	private async insertFormula(): Promise<void> {
		const s = this.current();
		if (!s || !s.formatted) return;
		const r = s.result;
		const latex = r.kind === "assign" ? assignLatex(r.name, r.node, s.formatted) : r.kind === "value" ? equationLatex(r.node, s.formatted) : "";
		if (latex === "") return;
		const size = Math.max(12, this.host.pen().textSize);
		let typeset: Awaited<ReturnType<typeof typesetEquation>> | null = null;
		try {
			typeset = await typesetEquation(latex, size, false);
		} catch (e) {
			if (e instanceof TypesetError) {
				// The formula could not be typeset: the line goes in as text instead of not at all.
				showNotice(t("calc.formulaFallback"), 6000);
				this.insertText();
				return;
			}
			console.warn("[notebook] typesetting a calculator result failed", e);
		}
		if (this.closed && !this.host.editable()) return;
		const where = this.pageTarget();
		if (!where) return;
		if (typeset) storeTypeset(typesetKey({ latex, inline: undefined, fontSize: size }), typeset);
		const width = typeset?.width ?? Math.max(20, size * Math.min(40, latex.length) * 0.45);
		const height = typeset?.height ?? size * 1.4;
		const x = Math.max(0, Math.min(where.page.width - width, where.x - width / 2));
		const y = Math.max(0, Math.min(where.page.height - height, where.y - height / 2));
		const el = createEquation(x, y, latex, size, this.host.pen().color, { width, height, outline: typeset?.outline });
		this.place(where.page, where.pageIndex, el);
		showNotice(t("calc.inserted"));
	}

	private insertGraph(): void {
		const s = this.current();
		if (!s) return;
		const link = this.linkFor(s);
		const where = this.pageTarget();
		if (!link || !where) return;
		const width = Math.min(260, where.page.width * 0.7);
		const height = Math.round(width * 0.66);
		const x = Math.max(0, Math.min(where.page.width - width, where.x - width / 2));
		const y = Math.max(0, Math.min(where.page.height - height, where.y - height / 2));
		const g: GraphElement = createGraph(x, y, width, height);
		g.functions = [{ ...g.functions[0]!, expr: link.expr }];
		if (link.params.length > 0) {
			g.params = link.params.map((p) => {
				const spread = 2 * Math.max(1, Math.abs(p.value));
				return { name: p.name, value: p.value, min: round2(p.value - spread), max: round2(p.value + spread) };
			});
		}
		if (link.degrees) g.degrees = true;
		this.place(where.page, where.pageIndex, g);
		showNotice(t("calc.graphInserted"));
	}

	private async copy(): Promise<void> {
		const s = this.current();
		if (!s?.formatted) return;
		try {
			await navigator.clipboard.writeText(s.formatted.text);
			showNotice(t("calc.copied"));
		} catch {
			showNotice(t("calc.copyFailed"));
		}
	}
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
