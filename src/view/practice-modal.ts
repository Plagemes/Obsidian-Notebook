import { Modal, Setting, type App } from "obsidian";
import { t } from "../i18n";
import {
	exercisesName, formatAttemptDate, formatDuration, inkColours, inkTools, MAX_REGION_STROKES, parsePracticePrefs, splitInk,
	type AttemptRecord, type HideSpec, type PracticePrefs, type PracticeTarget,
} from "../model/practice";
import type { Page, Tool } from "../model/types";
import { modalShell, shellButton, shellNote, shellRow } from "../ui/components/modal-shell";

const STORAGE_KEY = "notebook-practice";

/** Choices of the last use on this device (device-local, like the lecture layout). */
export function loadPracticePrefs(app: App): PracticePrefs {
	try {
		return parsePracticePrefs(app.loadLocalStorage(STORAGE_KEY));
	} catch {
		return parsePracticePrefs(null);
	}
}

function savePracticePrefs(app: App, prefs: PracticePrefs): void {
	try {
		app.saveLocalStorage(STORAGE_KEY, prefs);
	} catch {
		// Local storage can be unavailable; the choice is then just not remembered.
	}
}

export interface RedoRequest {
	/** The page whose ink is hidden in the copy (the original exercise). */
	page: Page;
	/** Number the new attempt will have. */
	attempt: number;
	/** Strokes of the lasso selection on this page, or null. */
	selection: readonly string[] | null;
	/** False when the copy cannot go to the exercises notebook (this notebook is it). */
	canNotebook: boolean;
}

export interface RedoChoice {
	spec: HideSpec;
	target: PracticeTarget;
	exercises: string;
}

type Mode = "all" | "some" | "region";

const TOOL_KEYS = { pen: "practice.tool.pen", highlighter: "practice.tool.highlighter", shape: "practice.tool.shape" } as const;

/** Asks what to hide and where the practice copy goes. Null when cancelled. */
export function askRedo(app: App, req: RedoRequest): Promise<RedoChoice | null> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		const prefs = loadPracticePrefs(app);
		if (!req.canNotebook) prefs.target = "after";
		const strokes = req.page.strokes;
		const colours = inkColours(strokes);
		const tools = inkTools(strokes);
		const pickedColours = new Set<string>();
		const pickedTools = new Set<Tool>();
		let mode: Mode = "all";
		let settled = false;
		const finish = (value: RedoChoice | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		const specNow = (): HideSpec | null => {
			if (mode === "all") return {};
			if (mode === "region") return req.selection && req.selection.length <= MAX_REGION_STROKES ? { strokes: [...req.selection] } : null;
			if (pickedColours.size === 0 && pickedTools.size === 0) return null;
			const spec: HideSpec = {};
			if (pickedColours.size > 0) spec.colors = [...pickedColours];
			if (pickedTools.size > 0) spec.tools = [...pickedTools];
			return spec;
		};

		const shell = modalShell(modal, { title: t("practice.modal.title"), subtitle: t("practice.modal.desc", { n: String(req.attempt) }), icon: "rotate-ccw", size: "medium", cls: "notebook-practice-modal" });
		const body = shell.body;

		let summary: HTMLElement | null = null;
		let confirm: HTMLButtonElement | null = null;
		let filters: HTMLElement | null = null;
		const refresh = () => {
			const spec = specNow();
			filters?.toggleClass("notebook-hidden", mode !== "some");
			if (!summary) return;
			if (!spec) {
				summary.setText(t(mode === "region" ? "practice.summary.regionTooBig" : "practice.summary.pick"));
			} else {
				summary.setText(t("practice.summary.count", { hidden: String(splitInk(strokes, spec).hidden.length), total: String(strokes.length) }));
			}
			if (confirm) confirm.disabled = !spec;
		};

		new Setting(body).setName(t("practice.hide")).addDropdown((dd) => {
			dd.addOption("all", t("practice.hide.all"));
			dd.addOption("some", t("practice.hide.some"));
			if (req.selection && req.selection.length > 0) dd.addOption("region", t("practice.hide.region", { n: String(req.selection.length) }));
			dd.setValue(mode).onChange((v) => {
				mode = v as Mode;
				refresh();
			});
		});

		filters = body.createDiv({ cls: "notebook-practice-filters notebook-hidden" });
		if (strokes.length === 0) shellNote(filters, t("practice.noInk"));
		if (colours.length > 0) {
			filters.createDiv({ cls: "notebook-practice-filter-title", text: t("practice.colours") });
			const row = filters.createDiv({ cls: "notebook-practice-chips" });
			for (const { color, count } of colours) {
				const label = row.createEl("label", { cls: "notebook-practice-chip" });
				const box = label.createEl("input", { attr: { type: "checkbox" } });
				const swatch = label.createSpan({ cls: "notebook-practice-swatch" });
				swatch.setCssProps({ "--notebook-practice-color": color });
				label.createSpan({ text: String(count) });
				label.setAttr("title", color);
				box.addEventListener("change", () => {
					if (box.checked) pickedColours.add(color);
					else pickedColours.delete(color);
					label.toggleClass("is-on", box.checked);
					refresh();
				});
			}
		}
		if (tools.length > 0) {
			filters.createDiv({ cls: "notebook-practice-filter-title", text: t("practice.tools") });
			const row = filters.createDiv({ cls: "notebook-practice-chips" });
			for (const { tool, count } of tools) {
				const label = row.createEl("label", { cls: "notebook-practice-chip" });
				const box = label.createEl("input", { attr: { type: "checkbox" } });
				label.createSpan({ text: `${t(TOOL_KEYS[tool])} ${count}` });
				box.addEventListener("change", () => {
					if (box.checked) pickedTools.add(tool);
					else pickedTools.delete(tool);
					label.toggleClass("is-on", box.checked);
					refresh();
				});
			}
		}
		summary = shellNote(body, "");
		summary.addClass("notebook-practice-summary");

		let nameSetting: Setting | null = null;
		new Setting(body).setName(t("practice.target")).addDropdown((dd) => {
			dd.addOption("after", t("practice.target.after"));
			if (req.canNotebook) dd.addOption("notebook", t("practice.target.notebook"));
			dd.setValue(prefs.target).onChange((v) => {
				prefs.target = v as PracticeTarget;
				nameSetting?.settingEl.toggleClass("notebook-hidden", prefs.target !== "notebook");
			});
		});
		nameSetting = new Setting(body).setName(t("practice.exercises")).setDesc(t("practice.exercises.desc")).addText((text) => {
			text.setPlaceholder(exercisesName(null)).setValue(prefs.exercises).onChange((v) => (prefs.exercises = v));
		});
		nameSetting.settingEl.toggleClass("notebook-hidden", prefs.target !== "notebook");

		const submit = () => {
			const spec = specNow();
			if (!spec) return;
			prefs.exercises = exercisesName(prefs.exercises);
			savePracticePrefs(app, prefs);
			finish({ spec, target: prefs.target, exercises: prefs.exercises });
			modal.close();
		};
		shellButton(shell.foot, "secondary", t("lecture.cancel"), () => modal.close());
		confirm = shellButton(shell.foot, "primary", t("practice.create"), submit);
		modal.onClose = () => {
			finish(null);
			modal.contentEl.empty();
		};
		refresh();
		modal.open();
	});
}

export interface AttemptRow {
	label: string;
	/** Smaller text under the label (when, how long). */
	detail: string;
	open: () => void;
}

/** One row per page of an exercise: the original, then its attempts (numbered, dated, with the time spent). */
export function attemptRows(
	attempts: readonly AttemptRecord[], current: string | null, open: (target: "original" | AttemptRecord) => void,
): AttemptRow[] {
	const rows: AttemptRow[] = [{ label: t("practice.original"), detail: "", open: () => open("original") }];
	for (const a of attempts) {
		const bits = [formatAttemptDate(a.at)];
		if (a.seconds) bits.push(formatDuration(a.seconds));
		rows.push({
			label: `${t("practice.attempt", { n: String(a.n) })}${a.practice.page === current ? " ✓" : ""}`,
			detail: bits.join(" · "),
			open: () => open(a),
		});
	}
	return rows;
}

/** The list of attempts of an exercise. */
export function showAttempts(app: App, title: string, rows: readonly AttemptRow[]): void {
	const modal = new Modal(app);
	const shell = modalShell(modal, { title, icon: "history", size: "narrow", footer: false, cls: "notebook-practice-attempts" });
	const list = shell.body.createDiv({ cls: "nb-modal-list notebook-practice-list" });
	for (const row of rows) {
		shellRow(list, {
			label: row.label, cls: "notebook-practice-row", ...(row.detail ? { detail: row.detail } : {}),
			onClick: () => {
				modal.close();
				row.open();
			},
		});
	}
	modal.onClose = () => modal.contentEl.empty();
	modal.open();
}
