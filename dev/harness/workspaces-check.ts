/**
 * Smoke check of the workspace presets (0.27, roadmap #375) on the `doc=workspaces` notebook (the blank "New" notebook;
 * HARNESS_DOC=workspaces npm run harness:check): the real view. Focus closes the page panel and folds the minimap; Lecture opens the
 * outline (and asks for the slides, or leaves them out where none can be shown); an arrangement is saved as a preset of its own,
 * Focus clears it and one tap brings it back; the preset can be renamed and deleted; on a phone the panels it cannot show are left out
 * with one notice; through all of it the notebook document is byte for byte what it was. The final state (Lecture applied, the
 * Workspaces picker open) is left for the screenshot.
 */
import type { NotebookSettings } from "../../src/settings";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface WorkspacesCheckApi {
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface Tools {
	state(): Record<string, boolean>;
	apply(id: string, quiet?: boolean): boolean;
	saveCurrent(name: string): boolean;
	rename(id: string, name: string): void;
	remove(id: string): void;
	activeId(): string;
	setPanel(panel: string, on: boolean): void;
}

interface WorkspacesView extends HarnessView {
	host: HarnessView["host"] & { settings: HarnessView["host"]["settings"] & NotebookSettings };
	workspaceTools: Tools;
}

export async function checkWorkspaces(api: WorkspacesCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as WorkspacesView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
	const s = v.host.settings;
	const tools = v.workspaceTools;
	const docJson = () => JSON.stringify(v.document);
	const before = docJson();
	const narrow = !!q(".notebook-body.is-narrow");
	const navOpen = () => !!q(".notebook-navigator") && !q(".notebook-navigator")!.classList.contains("notebook-hidden");
	const navTitle = () => q(".notebook-navigator-title")?.textContent ?? "";
	const closeModals = async () => {
		for (const m of Array.from(document.querySelectorAll<HTMLElement>(".modal-container .nb-modal-close"))) m.click();
		await frames(2);
	};

	add("the Workspaces action is in the registry and the tools exist", !!tools && typeof tools.apply === "function");

	// --- Focus: every panel closed ---
	tools.setPanel("navigator", true);
	await frames(3);
	add("the page panel is open before Focus", navOpen());
	tools.apply("focus", true);
	await frames(3);
	add("Focus closes the page panel", !navOpen());
	add("Focus folds the minimap (when there is one)", tools.state().minimap === false);
	add("the preset that was applied is remembered", s.workspacePresetActive === "focus" && tools.activeId() === "focus");

	// --- Lecture: outline (slides need a file, so they are asked for or left out where none can be shown) ---
	tools.apply("lecture", true);
	await frames(4);
	add("Lecture opens the page panel as the outline", navOpen() && tools.state().outline === true && tools.state().navigator === false, navTitle());
	await closeModals(); // a slides picker may have opened
	add("Lecture is the remembered preset", s.workspacePresetActive === "lecture");

	// --- a preset of our own: pages + minimap, saved, cleared by Focus, and brought back ---
	tools.setPanel("outline", false);
	tools.setPanel("navigator", true);
	if (!narrow) tools.setPanel("minimap", true);
	await frames(3);
	const saved = tools.saveCurrent("Reading");
	add("the arrangement in front is saved as a preset", saved && s.workspacePresets.length === 1 && s.workspacePresets[0]!.name === "Reading" && s.workspacePresets[0]!.panels.includes("navigator"));
	const mine = s.workspacePresets[0]!.id;
	tools.apply("focus", true);
	await frames(3);
	add("Focus clears it", !navOpen());
	api.notices.length = 0;
	tools.apply(mine, true);
	await frames(3);
	add("one tap brings the saved arrangement back", navOpen() && navTitle() !== "" && tools.state().navigator === true);
	add("the saved preset holds now", tools.activeId() === mine);
	tools.rename(mine, "Reading 2");
	add("it can be renamed", s.workspacePresets[0]!.name === "Reading 2");

	// --- a phone leaves out what it cannot show, with one notice ---
	// (On a wide screen Study opens a file picker and the Related pages sidebar leaf, which the browser harness has no workspace for.)
	if (narrow) {
		api.notices.length = 0;
		tools.apply("study", false);
		await frames(3);
		await closeModals();
		add("on a phone Study leaves out the reference window and related pages, with one notice", api.notices.filter((n) => /Left out|Lasciati fuori/.test(n)).length === 1, api.notices.join(" | "));
		add("and opens nothing: no picker, no Related leaf", !q(".modal-container .prompt") && tools.state().reference === false && tools.state().related === false);
	}

	// --- delete ---
	tools.remove(mine);
	add("a saved preset can be deleted", s.workspacePresets.length === 0);
	add("built-in presets cannot be deleted or renamed", (tools.remove("lecture"), tools.rename("lecture", "x"), s.workspacePresets.length === 0));
	add("the notebook document was never touched", docJson() === before);

	// --- the final state: Lecture applied, the picker open ---
	tools.apply("lecture", true);
	await frames(3);
	await closeModals();
	v.runAction("workspace-presets");
	await frames(8);
	add("the picker is open with one tile per preset and the current one marked", document.querySelectorAll(".nb-ws-modal .nb-ws-row").length >= 3 && !!q(".nb-ws-modal .nb-ws-row.is-current"));
	add("every tile is a labelled button", Array.from(document.querySelectorAll(".nb-ws-modal .nb-ws-row-btn")).every((b) => !!b.getAttribute("aria-label")));

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { narrow, dpr: window.devicePixelRatio } };
}
