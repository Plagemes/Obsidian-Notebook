/**
 * Smoke check of macros (0.27, roadmap #170) on the `doc=macros` notebook (the blank "New" notebook; npm run harness:check): the real
 * view and the real manager. A macro is made through the dialog (name, icon, steps from the picker, a value, the order of the steps, the
 * toolbar switch), its button appears in the toolbar and its entry in "All actions", one tap runs the steps in order as ONE undo step,
 * a locked page stops it at the right step with a single notice and the earlier steps kept, a step of a newer version is shown as
 * unavailable and skipped, and deleting the macro takes the button away. The picker offers allow-listed actions only. `macrosShot`
 * leaves the toolbar / the manager / the editor / the sheet for the screenshots (dist/shots/design/macros-<state>-<theme>-<device>.png).
 */
import { SuggestModal } from "obsidian";
import { t } from "../../src/i18n";
import type { Page } from "../../src/model/types";
import type { ActionDef } from "../../src/ui/actions";
import { MACRO_SAFE, macroActionId, setMacros, type Macro } from "../../src/ui/macros";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface MacrosCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface MacrosView extends HarnessView {
	host: { settings: HarnessView["host"]["settings"] & { macros: Macro[]; pinnedQuick: string[] } };
	setPageLocked(page: Page, value: boolean): boolean;
}

export async function checkMacros(api: MacrosCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as MacrosView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const kit = tools(api);
	const { q, qa, show, closeAll, click } = kit;
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const macros = (): Macro[] => v.host.settings.macros;
	const button = (): HTMLButtonElement | null => q<HTMLButtonElement>('.notebook-quick [data-action^="macro-"]');

	// --- the manager, empty ---
	v.addPage();
	await frames(3);
	add("no macro, no button in the toolbar and none in All actions", !button() && macros().length === 0);
	v.runAction("macros-open");
	await show();
	add("the manager opens from the registry action", !!q(".nb-macro-modal"));
	add("it says there are no macros yet", qa(".nb-macro-list .nb-modal-note").length === 1);

	// --- making one ---
	await click(kit.byLabel(t("macros.new")));
	const nameInput = q<HTMLInputElement>("#nb-macro-name-input");
	add("the editor opens on a new macro with a name field, icons, the toolbar switch and no steps", !!nameInput && qa(".nb-macro-icon-choice").length >= 12 && !!q(".nb-modal-check input") && qa(".nb-macro-step").length === 0);
	kit.type(nameInput, "Maths page");
	await click(qa<HTMLButtonElement>(".nb-macro-icon-choice")[2]);
	add("an icon can be chosen", qa(".nb-macro-icon-choice")[2]!.classList.contains("is-active") && qa(".nb-macro-icon-choice.is-active").length === 1);
	await click(q<HTMLInputElement>(".nb-modal-check input"));
	await click(kit.byLabel(t("macros.save")));
	add("Save with no step says so and does not save", q(".nb-macro-modal .nb-modal-error")?.textContent === t("macros.needStep") && macros().length === 0);

	// the picker: only allow-listed actions
	const cap: { picker: SuggestModal<ActionDef> | null } = { picker: null };
	const proto = SuggestModal.prototype as unknown as { open: (this: SuggestModal<ActionDef>) => void };
	const open = proto.open;
	proto.open = function (this: SuggestModal<ActionDef>) {
		cap.picker = this;
		open.call(this);
	};
	/** What the open picker lists for a search (the picker answers at once; the type allows a promise). */
	const suggest = (query: string): ActionDef[] => (cap.picker?.getSuggestions(query) ?? []) as ActionDef[];
	const pick = async (id: string): Promise<void> => {
		await click(kit.byLabel(t("macros.addStep")));
		const p = cap.picker;
		const a = suggest("").find((x) => x.id === id);
		if (p && a) p.onChooseSuggestion(a, new MouseEvent("click"));
		p?.close();
		cap.picker = null;
		await frames(2);
	};
	await click(kit.byLabel(t("macros.addStep")));
	const offered = suggest("");
	add("the picker offers allow-listed actions only", offered.length > 20 && offered.every((a) => MACRO_SAFE.has(a.id)) && !offered.some((a) => /delete|export|sync/.test(a.id)), `${offered.length} actions`);
	add("it can be searched", suggest("paper").some((a) => a.id === "page-paper"));
	cap.picker?.close();
	cap.picker = null;
	await pick("tool-pen");
	await pick("page-paper");
	await pick("page-bookmark");
	await pick("add-page");
	proto.open = open;
	add("four steps were added, in order", qa(".nb-macro-step-label").map((e) => e.textContent).join("|") === [t("tool.pen"), t("ui.paper"), t("page.bookmark"), t("tool.addPage")].join("|"), qa(".nb-macro-step-label").map((e) => e.textContent).join("|"));
	const select = q<HTMLSelectElement>(".nb-macro-select");
	add("the paper step has a value, first choice by default", !!select && select.value.length > 0, select?.value ?? "");
	kit.choose(select, "dotted");
	// move the bookmark step up above the paper step, then back
	const stepButton = (step: number, which: 0 | 1 | 2): HTMLButtonElement | null => qa(".nb-macro-step")[step]?.querySelectorAll<HTMLButtonElement>(".nb-macro-tools .nb-icon-btn")[which] ?? null;
	await click(stepButton(2, 0));
	add("a step can move up", qa(".nb-macro-step-label")[1]?.textContent === t("page.bookmark"));
	await click(stepButton(1, 1));
	add("and down again", qa(".nb-macro-step-label")[1]?.textContent === t("ui.paper"));
	add("every step button is a real 40 px target or more", qa(".nb-macro-step .nb-icon-btn").every((b) => b.getBoundingClientRect().width >= 38 && b.getBoundingClientRect().height >= 38));
	add("the first step cannot move up and the last cannot move down", !!stepButton(0, 0)?.disabled && !!stepButton(3, 1)?.disabled);
	add("the dialog does not scroll sideways", (q(".nb-macro-modal .nb-modal-body")?.scrollWidth ?? 0) <= (q(".nb-macro-modal .nb-modal-body")?.clientWidth ?? 0) + 1);
	await click(kit.byLabel(t("macros.save")));
	add("Save adds the macro: name, icon and the four steps with the value", macros().length === 1 && macros()[0]!.name === "Maths page" && macros()[0]!.icon === "play" && macros()[0]!.steps.length === 4 && macros()[0]!.steps.some((s) => s.action === "page-paper" && s.value === "dotted"), JSON.stringify(macros()[0]));
	const id = macros()[0]!.id;
	add("it is pinned to the toolbar", v.host.settings.pinnedQuick.includes(macroActionId(id)));
	add("the list shows it with its steps and the toolbar", qa(".nb-macro-row").length === 1 && (q(".nb-macro-detail")?.textContent ?? "").includes(t("macros.steps.n", { n: "4" })) && (q(".nb-macro-detail")?.textContent ?? "").includes(t("macros.onToolbar")));
	await closeAll();

	// --- the button and the sheet ---
	await frames(3);
	const b = button();
	add("the toolbar has the macro's button, named by the macro", !!b && b.getAttribute("aria-label") === "Maths page" && v.toolbar.quickIds.includes(macroActionId(id)), b?.getAttribute("aria-label") ?? "none");
	add("the button is a real target", !!b && b.getBoundingClientRect().width >= 36 && b.getBoundingClientRect().height >= 36 && !b.disabled);
	v.ui.sheet.close();
	document.querySelector<HTMLElement>('[aria-label="All actions"]')?.click();
	await frames(8);
	const row = q<HTMLElement>(`.notebook-sheet [data-action="${macroActionId(id)}"]`);
	add("All actions lists it in the Macros section, beside the manager's entry", !!row && !!q('.notebook-sheet [data-action="macros-open"]') && qa(".notebook-sheet-section-title").some((e) => e.textContent === t("ui.group.macros")));
	v.ui.sheet.close();
	await frames(2);

	// --- one tap, one undo step ---
	const pages = v.document.pages.length;
	const paper = page().paper.kind;
	const marked = v.document.meta?.bookmarks.includes(page().id) ?? false;
	const n0 = api.notices.length;
	button()!.click();
	await frames(5);
	add("one tap ran every step: pen in hand, the paper changed, the page bookmarked, a page added", v.uiContext().tool === "pen" && page().paper.kind === "dotted" && (v.document.meta?.bookmarks.length ?? 0) > 0 && v.document.pages.length === pages + 1, `${page().paper.kind}, ${v.document.pages.length} pages`);
	add("one notice says what was done", api.notices.slice(n0).length === 1 && api.notices.slice(n0)[0] === t("macros.ran", { name: "Maths page", n: "4" }), api.notices.slice(n0).join(" | "));
	v.undo();
	await frames(4);
	add("ONE undo takes everything back", v.document.pages.length === pages && page().paper.kind === paper && (v.document.meta?.bookmarks.includes(page().id) ?? false) === marked, `${v.document.pages.length} pages, ${page().paper.kind}`);
	v.redo();
	await frames(4);
	add("and one redo does it all again", v.document.pages.length === pages + 1 && page().paper.kind === "dotted");
	v.undo();
	await frames(3);

	// --- a locked page stops it ---
	v.setPageLocked(page(), true);
	await frames(3);
	const locked = page();
	const n1 = api.notices.length;
	const bookmarksBefore = v.document.meta?.bookmarks.length ?? 0;
	button()!.click();
	await frames(5);
	const said = api.notices.slice(n1);
	add("a locked page stops the macro with ONE notice naming the step", said.length === 1 && said[0]!.startsWith(`Maths page stopped at step 2 (${t("ui.paper")}: ${t("paper.dotted")})`), said.join(" | "));
	add("the locked page and the page count are untouched, the bookmark step never ran", locked.paper.kind === paper && v.document.pages.length === pages && (v.document.meta?.bookmarks.length ?? 0) === bookmarksBefore);
	add("the notice says the earlier step is done", (said[0] ?? "").includes(t("macros.failed.tail.some", { done: "1" })), said[0] ?? "");
	v.setPageLocked(locked, false); // (the lock and the unlock are history steps of their own; the stopped macro left none)
	await frames(3);

	// --- a step of a newer version is shown as unavailable and skipped ---
	macros()[0]!.steps.push({ action: "from-a-newer-version" });
	setMacros(macros());
	v.refreshUi();
	await frames(3);
	v.runAction("macros-open");
	await show();
	await click(qa(".nb-macro-row .nb-macro-tools .nb-icon-btn")[1]);
	const bad = qa(".nb-macro-step.is-unavailable");
	add("the editor shows the step of a newer version as unavailable and keeps it", bad.length === 1 && (bad[0]!.textContent ?? "").includes(t("macros.step.unavailable")) && qa(".nb-macro-step").length === 5);
	await click(kit.byLabel(t("macros.save")));
	add("saving keeps it in the macro", macros()[0]!.steps.length === 5 && macros()[0]!.steps[4]!.action === "from-a-newer-version");
	await closeAll();
	const n2 = api.notices.length;
	button()!.click();
	await frames(5);
	add("running it skips that step and says so", api.notices.slice(n2).length === 1 && api.notices.slice(n2)[0] === t("macros.ran.skipped", { name: "Maths page", n: "4", skipped: "1" }), api.notices.slice(n2).join(" | "));
	v.undo();
	await frames(3);

	// --- deleting ---
	v.runAction("macros-open");
	await show();
	await click(qa(".nb-macro-row .nb-macro-tools .nb-icon-btn")[2]);
	await frames(3);
	const confirm = q<HTMLElement>(".nb-confirm");
	add("deleting asks first", !!confirm && macros().length === 1);
	await click(q<HTMLButtonElement>(".nb-confirm .is-danger"));
	await closeAll();
	await frames(3);
	add("deleting removes the macro, its pin and its button", macros().length === 0 && !v.host.settings.pinnedQuick.some((p) => p.startsWith("macro-")) && !button());
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { pages: v.document.pages.length } };
}

/** Leaves the harness notebook with two macros and the surface for a screenshot: `toolbar`, `list`, `editor` or `sheet`. */
export async function macrosShot(api: MacrosCheckApi, state: "toolbar" | "list" | "editor" | "sheet"): Promise<void> {
	await api.open("macros");
	const v = api.view as MacrosView;
	const kit = tools(api);
	await kit.closeAll();
	v.ui.sheet.close();
	const made: Macro[] = [
		{ id: "shot1", name: "Maths page", icon: "play", steps: [{ action: "tool-pen" }, { action: "page-paper", value: "grid" }, { action: "page-bookmark" }, { action: "add-page" }] },
		{ id: "shot2", name: "Copy and flip", icon: "layers", steps: [{ action: "selection-duplicate" }, { action: "selection-mirror-h" }, { action: "from-a-newer-version" }] },
		{ id: "shot3", name: "Dotted notes", icon: "pencil", steps: [{ action: "page-paper", value: "dotted" }, { action: "tool-highlighter" }] },
	];
	v.host.settings.macros = made;
	v.host.settings.pinnedQuick = [macroActionId("shot1"), macroActionId("shot3")];
	setMacros(made);
	v.refreshUi();
	await api.frames(4);
	if (state === "toolbar") return;
	if (state === "sheet") {
		document.querySelector<HTMLElement>('[aria-label="All actions"]')?.click();
		await api.frames(8);
		const section = Array.from(document.querySelectorAll<HTMLElement>(".notebook-sheet-section")).find((s) => s.querySelector(".notebook-sheet-section-title")?.textContent === t("ui.group.macros"));
		section?.scrollIntoView({ block: "center" });
		await api.frames(3);
		return;
	}
	v.runAction("macros-open");
	await kit.show();
	if (state === "list") return;
	await kit.click(kit.qa(".nb-macro-row")[1]?.querySelectorAll(".nb-macro-tools .nb-icon-btn")[1]);
	await api.frames(3);
}

/** Small helpers shared by the check and the screenshots. */
function tools(api: MacrosCheckApi) {
	const { frames } = api;
	const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
	const qa = <T extends Element = HTMLElement>(sel: string): T[] => Array.from(document.querySelectorAll<T>(sel));
	/** The harness stands in for Obsidian's modal container: the dialog is moved in so the screenshot shows it. */
	const show = async (): Promise<void> => {
		await frames(3);
		for (const m of qa(".modal")) if (!m.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(m);
		await frames(3);
	};
	const closeAll = async (): Promise<void> => {
		q<HTMLButtonElement>(".nb-macro-modal .nb-modal-close")?.click();
		for (const m of qa(".harness-modal-container")) m.remove();
		for (const m of qa("body > .modal")) m.remove();
		await frames(2);
	};
	const click = async (el: Element | null | undefined): Promise<void> => {
		(el as HTMLElement | null | undefined)?.click();
		await frames(3);
		await show();
	};
	const byLabel = (label: string): HTMLButtonElement | null =>
		qa<HTMLButtonElement>(".nb-macro-modal button, .nb-confirm button").find((b) => b.querySelector(".nb-modal-btn-label")?.textContent === label) ?? null;
	const type = (input: HTMLInputElement | null, value: string): void => {
		if (!input) return;
		input.value = value;
		input.dispatchEvent(new Event("input", { bubbles: true }));
	};
	const choose = (select: HTMLSelectElement | null, value: string): void => {
		if (!select) return;
		select.value = value;
		select.dispatchEvent(new Event("change", { bubbles: true }));
	};
	return { q, qa, show, closeAll, click, byLabel, type, choose };
}
