// 0.27 macros (#170): the macro manager on the modal shell. A list (name, icon, number of steps, run, edit, delete) and an editor (name, icon,
// steps with their values, a switch for the toolbar button). It edits a copy and saves once, through the store: the settings tab gives it the
// plugin settings, the notebook view the same. The steps offered are the allow-list of ui/macros.ts only.
import { Modal, SuggestModal, type App } from "obsidian";
import { t } from "../i18n";
import { actionLabel, groupLabel } from "../ui/action-sheet";
import { ACTIONS, GROUP_ORDER, actionById, type ActionDef } from "../ui/actions";
import { MAX_PINNED } from "../ui/adapt";
import { iconButton, setIconSafe } from "../ui/components/dom";
import { iconSquare } from "../ui/components/icon-square";
import { modalShell, promptShell, shellButton, shellCheck, shellField, shellNote, type ModalShell } from "../ui/components/modal-shell";
import { confirmDestructive } from "../ui/destructive";
import { attachLongPressHelp, resolveHelp } from "../ui/long-press-help";
import {
	allowedActions, cleanName, cloneMacro, DEFAULT_MACRO_ICON, MACRO_ICONS, macroActionId, MAX_MACROS, MAX_NAME, MAX_STEPS, newMacroId, stepChoices, stepName,
	stepState, usableSteps, withoutMissingMacros, type Macro, type MacroStep,
} from "../ui/macros";
import type { PageSizeName, PaperKind } from "../model/types";

/** Where the manager reads and saves the macros (the plugin settings; the settings tab and the notebook view each provide it). */
export interface MacrosStore {
	get(): { macros: readonly Macro[]; pinned: readonly string[] };
	/** Saves the macros and the toolbar pins together (the caller refreshes the registry, the commands and the toolbars). */
	update(macros: Macro[], pinned: string[]): void;
	/** Runs a macro on the open notebook; absent when no notebook view is there (the settings tab). */
	run?(macro: Macro): void;
}

/** The label of a value of a step: a paper kind or a page size. */
export function choiceLabel(a: ActionDef, value: string): string {
	return a.choices === "paper" ? t(`paper.${value as PaperKind}`) : t(`size.${value as PageSizeName}`);
}

/** A step as a line of text ("Paper: Grid"). */
export function stepText(step: MacroStep): string {
	return stepName(step, actionLabel, choiceLabel);
}

/** The searchable list of the actions a macro may use; the one chosen is added as a step. */
class StepPicker extends SuggestModal<ActionDef> {
	constructor(app: App, private readonly onPick: (a: ActionDef) => void) {
		super(app);
		promptShell(this, { title: t("macros.addStep"), icon: "plus", cls: "nb-macro-picker" });
		this.setPlaceholder(t("macros.addStep"));
	}

	getSuggestions(query: string): ActionDef[] {
		const q = query.trim().toLowerCase();
		const rows = allowedActions(ACTIONS);
		const text = (a: ActionDef): string => `${actionLabel(a)} ${groupLabel(a.group)} ${a.keywords ?? ""}`.toLowerCase();
		const order = (a: ActionDef): number => GROUP_ORDER.indexOf(a.group);
		return rows.filter((a) => q.split(/\s+/).every((w) => text(a).includes(w))).sort((x, y) => order(x) - order(y));
	}

	renderSuggestion(a: ActionDef, el: HTMLElement): void {
		el.addClass("nb-macro-pick");
		setIconSafe(el.createSpan({ cls: "nb-macro-pick-icon", attr: { "aria-hidden": "true" } }), a.icon);
		el.createSpan({ cls: "nb-macro-pick-label", text: actionLabel(a) });
		el.createSpan({ cls: "nb-macro-pick-group", text: groupLabel(a.group) });
	}

	onChooseSuggestion(a: ActionDef): void {
		this.onPick(a);
	}
}

interface Draft {
	macro: Macro;
	isNew: boolean;
	toolbar: boolean;
}

/** The manager: a list of the macros, and an editor for one of them. */
export class MacrosModal extends Modal {
	private draft: Draft | null = null;
	private stopHelp: (() => void) | null = null;

	constructor(app: App, private readonly store: MacrosStore, private readonly changed: () => void = () => undefined) {
		super(app);
	}

	onOpen(): void {
		this.draw();
	}

	onClose(): void {
		this.stopHelp?.();
		this.stopHelp = null;
		this.contentEl.empty();
	}

	private draw(): void {
		this.stopHelp?.();
		const editing = this.draft;
		const shell = modalShell(this, {
			title: editing ? t(editing.isNew ? "macros.new.title" : "macros.edit.title") : t("macros.title"),
			subtitle: t("macros.subtitle"), icon: "workflow", size: "medium", cls: "nb-macro-modal",
		});
		this.stopHelp = attachLongPressHelp(this.modalEl, (b) => (b.dataset.help ? resolveHelp(b) : null));
		if (editing) this.drawEditor(shell, editing);
		else this.drawList(shell);
	}

	// ------------------------------------------------------------------------------------------------------------------ the list

	private drawList(shell: ModalShell): void {
		const { macros, pinned } = this.store.get();
		shell.body.createDiv({ cls: "nb-modal-section-title", text: t("macros.list") });
		const list = shell.body.createDiv({ cls: "nb-modal-list nb-macro-list" });
		if (macros.length === 0) shellNote(list, t("macros.empty"));
		for (const m of macros) {
			const row = list.createDiv({ cls: "nb-macro-row" });
			iconSquare(row, m.icon, undefined, "nb-macro-icon");
			const text = row.createDiv({ cls: "nb-macro-text" });
			text.createSpan({ cls: "nb-macro-name", text: m.name });
			const on = pinned.includes(macroActionId(m.id));
			const steps = m.steps.length === 1 ? t("macros.steps.one") : t("macros.steps.n", { n: String(m.steps.length) });
			text.createSpan({ cls: "nb-macro-detail", text: on ? `${steps} · ${t("macros.onToolbar")}` : steps });
			const tools = row.createDiv({ cls: "nb-macro-tools" });
			if (this.store.run) {
				iconButton(tools, "play", t("macros.run", { name: m.name }), () => {
					this.close();
					this.store.run?.(cloneMacro(m));
				}, "", "help.macroRun").disabled = usableSteps(m) === 0;
			}
			iconButton(tools, "pencil", t("macros.edit", { name: m.name }), () => {
				this.draft = { macro: cloneMacro(m), isNew: false, toolbar: on };
				this.draw();
			}, "", "help.macroEdit");
			iconButton(tools, "trash-2", t("macros.delete", { name: m.name }), () => {
				confirmDestructive(this.app, { title: t("macros.delete.title"), body: t("macros.delete.body", { name: m.name }), confirm: t("macros.delete.cta") }, () => this.remove(m.id));
			}, "", "help.macroDelete");
		}
		const full = macros.length >= MAX_MACROS;
		shellButton(shell.body, "secondary", t("macros.new"), () => {
			const taken = this.store.get().macros;
			this.draft = { macro: { id: newMacroId(taken), name: "", icon: DEFAULT_MACRO_ICON, steps: [] }, isNew: true, toolbar: false };
			this.draw();
		}, { icon: "plus", disabled: full });
		if (full) shellNote(shell.body, t("macros.limit", { n: String(MAX_MACROS) }));
		shellButton(shell.foot, "primary", t("macros.done"), () => this.close());
	}

	private remove(id: string): void {
		const { macros, pinned } = this.store.get();
		const next = macros.filter((m) => m.id !== id);
		this.save([...next], withoutMissingMacros(pinned, next));
	}

	private save(macros: Macro[], pinned: string[]): void {
		this.store.update(macros, pinned);
		this.changed();
		this.draw();
	}

	// ----------------------------------------------------------------------------------------------------------------- the editor

	private drawEditor(shell: ModalShell, draft: Draft): void {
		const { macro } = draft;
		const body = shell.body;
		const pinnedNow = this.store.get().pinned;
		const wasPinned = pinnedNow.includes(macroActionId(macro.id));

		const nameField = shellField(body, t("macros.name"), "nb-macro-name-input");
		const input = nameField.createEl("input", { cls: "nb-modal-input", attr: { id: "nb-macro-name-input", type: "text", maxlength: String(MAX_NAME), placeholder: t("macros.name.placeholder"), autocomplete: "off" } });
		input.value = macro.name;
		input.addEventListener("input", () => {
			macro.name = input.value;
		});

		const iconField = shellField(body, t("macros.icon"));
		const icons = iconField.createDiv({ cls: "nb-macro-icons", attr: { role: "radiogroup", "aria-label": t("macros.icon") } });
		const choices = MACRO_ICONS.includes(macro.icon) ? MACRO_ICONS : [macro.icon, ...MACRO_ICONS];
		const buttons: Array<[string, HTMLButtonElement]> = [];
		const markIcons = (): void => {
			for (const [icon, b] of buttons) {
				b.toggleClass("is-active", icon === macro.icon);
				b.setAttribute("aria-checked", String(icon === macro.icon));
			}
		};
		for (const icon of choices) {
			const b = icons.createEl("button", { cls: "nb-macro-icon-choice", attr: { type: "button", role: "radio", "aria-label": t("macros.icon.use", { icon }), title: icon } });
			setIconSafe(b, icon);
			b.addEventListener("click", (e) => {
				e.preventDefault();
				macro.icon = icon;
				markIcons();
			});
			buttons.push([icon, b]);
		}
		markIcons();

		const full = !wasPinned && pinnedNow.length >= MAX_PINNED;
		const check = shellCheck(body, t("macros.toolbar"), draft.toolbar && !full, (on) => {
			draft.toolbar = on;
		});
		check.disabled = full;
		if (full) {
			draft.toolbar = false;
			shellNote(body, t("macros.toolbar.full", { n: String(MAX_PINNED) }));
		}

		body.createDiv({ cls: "nb-modal-section-title", text: t("macros.stepsHeading") });
		const stepsEl = body.createDiv({ cls: "nb-modal-list nb-macro-steps" });
		const error = body.createDiv({ cls: "nb-modal-error", attr: { role: "alert" } });
		const addBtn = shellButton(body, "secondary", t("macros.addStep"), () => {
			if (macro.steps.length >= MAX_STEPS) return;
			new StepPicker(this.app, (a) => {
				const options = stepChoices(a);
				macro.steps.push(options ? { action: a.id, value: options[0]! } : { action: a.id });
				drawSteps();
			}).open();
		}, { icon: "plus" });
		addBtn.dataset.help = "help.macroAddStep";
		const limit = shellNote(body, t("macros.stepsLimit", { n: String(MAX_STEPS) }));
		// Review fix (M6): steps this version cannot hold (stored by a newer one) are kept in the data, shown as unavailable, never run.
		if (macro.extraSteps && macro.extraSteps.length > 0) shellNote(body, t("macros.extraSteps", { n: String(macro.extraSteps.length) }));
		shellNote(body, t("macros.safe"));

		const drawSteps = (): void => {
			stepsEl.empty();
			error.setText("");
			if (macro.steps.length === 0) shellNote(stepsEl, t("macros.stepsEmpty"));
			macro.steps.forEach((step, i) => this.stepRow(stepsEl, macro, step, i, drawSteps));
			const atLimit = macro.steps.length >= MAX_STEPS;
			addBtn.disabled = atLimit;
			limit.toggleClass("is-hidden", !atLimit);
		};
		drawSteps();

		shellButton(shell.foot, "secondary", t("macros.cancel"), () => {
			this.draft = null;
			this.draw();
		});
		shellButton(shell.foot, "primary", t("macros.save"), () => {
			if (usableSteps(macro) === 0) {
				error.setText(t("macros.needStep"));
				return;
			}
			this.commit(draft);
		});
		window.setTimeout(() => {
			if (draft.isNew) input.focus();
		}, 0);
	}

	private stepRow(parent: HTMLElement, macro: Macro, step: MacroStep, i: number, redraw: () => void): void {
		const state = stepState(step);
		const a = actionById(step.action);
		const row = parent.createDiv({ cls: "nb-macro-step" });
		row.toggleClass("is-unavailable", state !== "ok" && state !== "value");
		row.createSpan({ cls: "nb-macro-step-n", text: String(i + 1), attr: { "aria-hidden": "true" } });
		setIconSafe(row.createSpan({ cls: "nb-macro-step-icon", attr: { "aria-hidden": "true" } }), a && state !== "unknown" ? a.icon : "ban");
		const text = row.createDiv({ cls: "nb-macro-step-text" });
		const options = a ? stepChoices(a) : null;
		if (a && options && state !== "unknown" && state !== "blocked") {
			text.createSpan({ cls: "nb-macro-step-label", text: actionLabel(a) });
			const select = text.createEl("select", { cls: "nb-macro-select", attr: { "aria-label": t("macros.step.value", { n: String(i + 1) }) } });
			for (const value of options) select.createEl("option", { text: choiceLabel(a, value), attr: { value } });
			// A value that is missing is shown as the first choice and saved as such. Review fix (R3): a value this version does not know (a newer version's paper kind) is kept as it is, as an extra entry, until the
			// person picks another value for this step.
			const KEPT = "\u0001kept";
			if (step.value === undefined) step.value = options[0]!;
			const kept = typeof step.value !== "string" || !options.includes(step.value);
			if (kept) select.createEl("option", { text: String(step.value), attr: { value: KEPT } });
			select.value = kept ? KEPT : (step.value as string);
			select.addEventListener("change", () => {
				if (select.value !== KEPT) step.value = select.value;
			});
		} else {
			text.createSpan({ cls: "nb-macro-step-label", text: a && state !== "unknown" ? actionLabel(a) : String(step.action) });
			if (state === "unknown" || state === "blocked") text.createSpan({ cls: "nb-macro-step-badge", text: t("macros.step.unavailable") });
		}
		const tools = row.createDiv({ cls: "nb-macro-tools" });
		iconButton(tools, "chevron-up", t("macros.step.up", { n: String(i + 1) }), () => {
			if (i > 0) [macro.steps[i - 1], macro.steps[i]] = [macro.steps[i]!, macro.steps[i - 1]!];
			redraw();
		}, "", "help.macroStepUp").disabled = i === 0;
		iconButton(tools, "chevron-down", t("macros.step.down", { n: String(i + 1) }), () => {
			if (i < macro.steps.length - 1) [macro.steps[i + 1], macro.steps[i]] = [macro.steps[i]!, macro.steps[i + 1]!];
			redraw();
		}, "", "help.macroStepDown").disabled = i === macro.steps.length - 1;
		iconButton(tools, "x", t("macros.step.remove", { n: String(i + 1) }), () => {
			macro.steps.splice(i, 1);
			redraw();
		}, "", "help.macroStepRemove");
	}

	/** Saves the draft: a new macro is added at the end, an edited one replaces its old self; the toolbar pin follows the switch. */
	private commit(draft: Draft): void {
		const { macros, pinned } = this.store.get();
		const saved: Macro = { ...cloneMacro(draft.macro), name: cleanName(draft.macro.name) };
		const next = draft.isNew ? [...macros, saved] : macros.map((m) => (m.id === saved.id ? saved : m));
		const id = macroActionId(saved.id);
		const without = pinned.filter((p) => p !== id);
		const nextPinned = draft.toolbar && without.length < MAX_PINNED ? [...without, id] : without;
		this.draft = null;
		this.save(next, nextPinned);
	}
}
