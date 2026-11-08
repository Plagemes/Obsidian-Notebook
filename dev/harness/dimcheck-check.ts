/**
 * Smoke check of the units hint of the equation editor (0.23, roadmap #293) on the blank "New" notebook
 * (HARNESS_DOC=dimcheck npm run harness:check): the real view and the real editor card. A formula that adds length to time
 * shows one muted sentence under the preview; a consistent one shows the tick line; text without units shows nothing; the
 * setting turns the hint off; the card stays inside the page area; the editor adds nothing to the document until Done.
 * `dimcheckShot` leaves the editor open with one of the formulas for the screenshots
 * (dist/shots/design/dimcheck-<state>-<theme>-<device>.png).
 */
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface DimcheckCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface DimcheckView extends HarnessView {
	host: HarnessView["host"] & { settings: HarnessView["host"]["settings"] & { dimensionHint: boolean } };
	runAction(id: string): void;
}

export type DimcheckState = "bad" | "good" | "many";

const FORMULAS: Record<DimcheckState, string> = {
	bad: "5\\,\\mathrm{m} + 3\\,\\mathrm{s}",
	good: "m = 2\\,\\mathrm{kg} \\\\ a = 3\\,\\mathrm{m/s^2} \\\\ F = m a = 6\\,\\mathrm{N}",
	many: "1\\,\\mathrm{N} = 1\\,\\mathrm{J} \\\\ 2\\,\\mathrm{m} + 1\\,\\mathrm{kg} \\\\ \\sin(4\\,\\mathrm{s}) = 0.5",
};

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const card = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-eq-editor");
const hint = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-eq-editor .notebook-eq-dimhint");
const shown = (el: HTMLElement | null): boolean => !!el && !el.classList.contains("notebook-hidden") && el.getBoundingClientRect().height > 0;

async function openEditor(api: DimcheckCheckApi): Promise<DimcheckView> {
	await api.open("new");
	const v = api.view as DimcheckView;
	await api.frames(3);
	v.runAction("insert-equation");
	await api.frames(3);
	return v;
}

async function typeLatex(api: DimcheckCheckApi, latex: string): Promise<void> {
	const ta = card()?.querySelector<HTMLTextAreaElement>("textarea.notebook-eq-source");
	if (!ta) return;
	ta.value = latex;
	ta.dispatchEvent(new Event("input", { bubbles: true }));
	await sleep(350);
	await api.frames(2);
}

function cancel(): void {
	card()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

export async function checkDimcheck(api: DimcheckCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const v = await openEditor(api);
	const pages = v.document.pages;
	const elementsBefore = pages.reduce((n, p) => n + (p.elements?.length ?? 0), 0);

	add("the setting is on by default", v.host.settings.dimensionHint === true);
	add("the equation editor opens", !!card());
	add("the hint is hidden while the editor is empty", !!hint() && !shown(hint()));

	// --- a sum of length and time ---
	await typeLatex(api, FORMULAS.bad);
	const h = hint();
	add("length plus time: the hint shows", shown(h), h?.className ?? "");
	add("the hint says what is wrong", /Cannot add 5 m \(length, m\) and 3 s \(time, s\)/.test(h?.textContent ?? ""), h?.textContent ?? "");
	add("the hint carries the Units label and a ruler icon", /^Units/.test(h?.textContent ?? "") && !!h?.querySelector(".notebook-eq-dimhint-icon svg"));
	add("the hint is a quiet note, not a control", h?.getAttribute("role") === "note" && h.querySelectorAll("button, input, a").length === 0);
	add("the hint is not styled as an error or a tick", !h?.classList.contains("is-ok") && !h?.classList.contains("notebook-eq-error"));

	// --- layout ---
	const c = card()!;
	const stage = c.parentElement!.getBoundingClientRect();
	const cr = c.getBoundingClientRect();
	const hr = h?.getBoundingClientRect();
	add("the card stays inside the page area", cr.left >= stage.left - 1 && cr.right <= stage.right + 1 && cr.top >= stage.top - 1 && cr.bottom <= stage.bottom + 1, `${Math.round(cr.left)},${Math.round(cr.top)} ${Math.round(cr.right)},${Math.round(cr.bottom)} in ${Math.round(stage.right)}x${Math.round(stage.bottom)}`);
	add("the hint fits the card width", !!hr && hr.left >= cr.left - 1 && hr.right <= cr.right + 1 && (h?.scrollWidth ?? 0) <= (h?.clientWidth ?? 0) + 1);
	add("the hint sits under the preview and above the options", !!hr && hr.top >= (c.querySelector(".notebook-eq-preview")?.getBoundingClientRect().bottom ?? 0) - 1 && hr.bottom <= (c.querySelector(".notebook-eq-options")?.getBoundingClientRect().top ?? 1e9) + 1);
	add("the hint text is small and muted", !!h && parseFloat(getComputedStyle(h).fontSize) <= 14 && getComputedStyle(h).borderTopStyle === "dashed");

	// --- consistent units ---
	await typeLatex(api, FORMULAS.good);
	add("consistent units: the tick line shows", shown(hint()) && hint()!.classList.contains("is-ok") && /Units are consistent/.test(hint()!.textContent ?? ""), hint()?.textContent ?? "");

	// --- no units at all ---
	await typeLatex(api, "\\frac{a}{b} = \\sqrt{x}");
	add("text without units: the hint is hidden", !shown(hint()), hint()?.className ?? "");

	// --- several problems ---
	await typeLatex(api, FORMULAS.many);
	const lines = hint()?.querySelectorAll(".notebook-eq-dimhint-line").length ?? 0;
	add("several problems: two sentences and a count of the rest", lines === 2 && /\+1 more/.test(hint()?.textContent ?? ""), `${lines} ${hint()?.textContent ?? ""}`);

	// --- the editor adds nothing until Done ---
	cancel();
	await api.frames(3);
	add("Escape closes the editor", !card());
	add("nothing was added to the notebook", v.document.pages.reduce((n, p) => n + (p.elements?.length ?? 0), 0) === elementsBefore);

	// --- the setting turns it off ---
	v.host.settings.dimensionHint = false;
	v.runAction("insert-equation");
	await api.frames(3);
	await typeLatex(api, FORMULAS.bad);
	add("with the setting off the hint stays hidden", !shown(hint()), hint()?.className ?? "");
	cancel();
	await api.frames(3);
	v.host.settings.dimensionHint = true;

	add("no script errors", api.errors.length === 0, api.errors.join(" | "));
	return { ok: results.every((r) => r.ok), results, errors: [...api.errors], notices: [...api.notices], env: {} };
}

/** Leaves the editor open with one of the formulas, for the screenshots. */
export async function dimcheckShot(api: DimcheckCheckApi, state: DimcheckState): Promise<void> {
	cancel();
	const v = await openEditor(api);
	v.host.settings.dimensionHint = true;
	await typeLatex(api, FORMULAS[state]);
	await api.frames(2);
}
