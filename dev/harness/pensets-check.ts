/**
 * Smoke check of the pen sets (0.15, roadmap 134) on the `doc=pensets` notebook (npm run harness:check): the real view and
 * toolbar. A folder set (Languages) fills the pen strip when the notebook opens, the notebook's own set (Science) wins over
 * the folder, a set that no longer exists falls back to the favourite pens, a set never rewrites the favourites, the
 * switcher chip shows in the pen options (not for the eraser) and the manager lists the sets. `pensetsShot` draws the
 * options and the manager for the screenshots (dev/harness/dist/shots/pensets-*.png).
 */

import type { App } from "obsidian";
import { DEFAULT_SETTINGS, type NotebookSettings } from "../../src/settings";
import { PenSetsModal } from "../../src/view/pen-sets-modal";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

/** Settings the harness merges into the next view it opens (the check changes them between reopenings). */
export const pensetsOverride: Partial<NotebookSettings> = {};

export interface PensetsCheckApi {
	/** The notebook view (a `HarnessView`); read it again after every `open`. */
	readonly view: unknown;
	open: (doc?: string) => Promise<void>;
	openOptions: (tool: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface PensView extends HarnessView {
	host: { settings: NotebookSettings & HarnessView["host"]["settings"] };
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const slotColours = (): string[] => [...document.querySelectorAll<HTMLElement>(".notebook-favs .notebook-fav-dot")].map((d) => d.style.getPropertyValue("--notebook-swatch-color").trim().toLowerCase());
const chip = (): HTMLElement | null => document.querySelector(".notebook-options .notebook-penset-chip");
const visible = (el: Element | null): boolean => !!el && (el as HTMLElement).offsetWidth > 0 && (el as HTMLElement).offsetHeight > 0;

export async function checkPenSets(api: PensetsCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const v = (): PensView => api.view as PensView;
	const reopen = async (over: Partial<NotebookSettings>) => {
		for (const k of Object.keys(pensetsOverride)) delete (pensetsOverride as Record<string, unknown>)[k];
		Object.assign(pensetsOverride, over);
		await api.open("pensets");
		await api.frames(3);
		await sleep(60);
	};
	const defaults = DEFAULT_SETTINGS.favouritePens.map((f) => f.color);

	await reopen({});
	add("no assignment: the strip shows the favourite pens", JSON.stringify(slotColours()) === JSON.stringify(defaults), slotColours().join(","));
	const id = v().document.id;
	add("the notebook has a document id", typeof id === "string" && id.length > 0, String(id));

	await reopen({ penSetFolders: { Notebooks: "starter-languages" } });
	add("a folder set fills the strip (Languages: second pen is red)", slotColours()[1] === "#dc2626", slotColours().join(","));
	add("the favourite pens are untouched by the set", JSON.stringify(v().host.settings.favouritePens) === JSON.stringify(DEFAULT_SETTINGS.favouritePens));

	await reopen({ penSetFolders: { Notebooks: "starter-languages" }, penSetNotebooks: { [id]: "starter-science" } });
	add("the notebook's own set wins over the folder (Science: fourth pen is violet)", slotColours()[3] === "#7c3aed", slotColours().join(","));

	await reopen({ penSetFolders: { Notebooks: "no-such-set" }, penSetNotebooks: { [id]: "gone" } });
	add("assignments to a deleted set fall back to the favourite pens", JSON.stringify(slotColours()) === JSON.stringify(defaults), slotColours().join(","));

	await reopen({ penSetFolders: { Notebooks: "starter-maths" } });
	await api.openOptions("pen");
	const c = chip();
	add("the switcher chip shows in the pen options", visible(c), c ? "present, hidden" : "missing");
	add("the chip names the active set", (c?.textContent ?? "").includes("Maths"), c?.textContent ?? "");
	add("the chip is a labelled button", !!c?.getAttribute("aria-label") && c.tagName === "BUTTON", c?.getAttribute("aria-label") ?? "");
	await api.openOptions("eraser");
	add("the chip is hidden for the eraser", !visible(chip()), "");
	await api.openOptions("pen");

	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: {} };
}

/** Draws one state for the screenshots: the pen options with the chip, or the manager. "close" tidies up. */
export async function pensetsShot(api: PensetsCheckApi & { app: unknown }, state: "options" | "manager" | "close"): Promise<void> {
	document.querySelectorAll("body > .modal, body > .harness-modal-layer").forEach((m) => m.remove());
	if (state === "close") return;
	if (state === "options") {
		await api.openOptions("pen");
	} else {
		const s = (api.view as PensView).host.settings;
		new PenSetsModal(api.app as App, {
			get: () => ({ sets: s.penSets, folders: { Notebooks: "starter-maths", "Notebooks/Languages": "starter-languages" }, notebooks: { a: "starter-science" } }),
			update: () => undefined,
			currentPens: () => s.favouritePens,
		}).open();
		const modal = document.querySelector<HTMLElement>("body > .modal");
		if (modal) {
			const layer = document.body.createDiv({ cls: "harness-modal-layer" });
			layer.setAttribute("style", "position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4)");
			layer.appendChild(modal);
		}
	}
	await api.frames(3);
	await sleep(250);
}
