/**
 * Smoke check of the settings tab (DESIGN.md §6, docs/design-ui.md "Settings") on the `doc=settings` scenario
 * (npm run harness:check): the real NotebookSettingTab, drawn by its hand-drawn path (the stub has no declarative
 * renderer), on top of the page. Sections and their order, a dependent option, the Advanced group, the search in both
 * languages, the Style setting, target sizes and horizontal overflow at the scenario's width.
 */
import { DEFAULT_SETTINGS, readSettings } from "../../src/settings";
import { NotebookSettingTab, type SettingsHost } from "../../src/view/settings-tab";
import type { App } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

export interface SettingsCheckApi {
	app: App;
	errors: string[];
	notices: string[];
}

export async function checkSettings(api: SettingsCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const tick = () => new Promise((r) => window.requestAnimationFrame(() => r(null)));

	let saves = 0;
	const host = {
		app: api.app,
		settings: { ...DEFAULT_SETTINGS },
		saveSettings: () => {
			saves++;
			return Promise.resolve();
		},
		runGlobal: () => undefined,
	};
	const tab = new NotebookSettingTab(api.app as never, host as unknown as SettingsHost);
	const root = tab.containerEl;
	root.addClass("harness-settings");
	document.body.appendChild(root);
	// The stub draws no declarative definitions: the tab's hand-drawn path (Obsidian older than 1.13).
	const legacy: { display(): void } = tab;
	legacy.display();
	await tick();

	const visible = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).offsetParent !== null && (el as HTMLElement).offsetHeight > 0;
	const headers = () => [...root.querySelectorAll(".notebook-settings-header-title")].filter((el) => visible(el)).map((el) => el.textContent ?? "");
	const row = (name: string): HTMLElement | null => [...root.querySelectorAll<HTMLElement>(".setting-item")].find((el) => el.querySelector(".setting-item-name")?.textContent === name) ?? null;
	const search = root.querySelector<HTMLInputElement>(".notebook-settings-search-pill input");
	const type = async (q: string) => {
		if (!search) return;
		search.value = q;
		search.dispatchEvent(new Event("input"));
		await tick();
	};

	// Sections in order; Sync & safety needs its service and Export has nothing yet, so neither is drawn.
	const expected = ["Writing", "Pen & input", "Pages & navigation", "PDF & reading", "Library & files", "Obsidian integration", "Study", "Appearance & language", "Diagnostics"];
	add("sections are shown in the designed order", JSON.stringify(headers()) === JSON.stringify(expected), headers().join(" · "));

	// A dependent option appears when its parent is switched on (and the change is saved).
	add("the companion location is hidden while companion notes are off", !visible(row("Note location")));
	row("Companion notes")?.querySelector<HTMLElement>(".checkbox-container")?.click();
	await tick();
	await tick();
	add("switching companion notes on saves it", host.settings.companionNotes && saves > 0, `saves ${saves}`);
	add("the companion location appears when companion notes are on", visible(row("Note location")));

	// Advanced is closed until it is opened.
	const inputSection = [...root.querySelectorAll<HTMLElement>(".notebook-settings-section")].find((s) => s.querySelector(".notebook-settings-header-title")?.textContent === "Pen & input");
	const advancedRow = [...(inputSection?.querySelectorAll<HTMLElement>(".notebook-settings-disclosure") ?? [])].find((el) => el.querySelector(".setting-item-name")?.textContent === "Advanced") ?? null;
	add("an advanced option is hidden at first", !visible(row("Ignore large touches (px)")));
	advancedRow?.click();
	await tick();
	add("opening Advanced shows its options", visible(row("Ignore large touches (px)")) && advancedRow?.getAttribute("aria-expanded") === "true");
	advancedRow?.click();
	await tick();

	// Search: names and sections, Italian, accents, nothing found.
	await type("palm");
	add("a search keeps only the matching section", JSON.stringify(headers()) === JSON.stringify(["Pen & input"]), headers().join(" · "));
	add("a search finds options inside a closed Advanced group", visible(row("Palm rejection (ms)")) && visible(row("Ignore large touches (px)")));
	await type("modalità notte");
	add("an Italian query finds the English row", visible(row("Night mode")));
	await type("zzzz");
	add("a search with no match says so", visible(root.querySelector(".notebook-settings-empty")) && headers().length === 0);
	await type("");
	add("clearing the search brings every section back", headers().length === expected.length);

	// The Style setting re-maps the tokens.
	const style = row("Style")?.querySelector<HTMLSelectElement>("select");
	if (style) {
		style.value = "obsidian";
		style.dispatchEvent(new Event("change"));
		await tick();
		await tick();
	}
	add("Style: Follow Obsidian theme applies its class", activeDocument.body.hasClass("notebook-style-obsidian") && host.settings.appearanceStyle === "obsidian");
	if (style) {
		style.value = "notebook";
		style.dispatchEvent(new Event("change"));
		await tick();
		await tick();
	}
	add("Style: Notebook is the default look", !activeDocument.body.hasClass("notebook-style-obsidian"));
	add("settings survive a reload", readSettings(JSON.parse(JSON.stringify(host.settings))).companionNotes);

	// Targets of at least 40 px, and nothing wider than the screen.
	const controls = [...root.querySelectorAll<HTMLElement>("button, select, input[type=text], .notebook-settings-search-pill, .notebook-settings-disclosure")].filter((el) => visible(el));
	const small = controls.filter((el) => el.getBoundingClientRect().height < 40).map((el) => `${el.tagName.toLowerCase()}.${el.className} ${Math.round(el.getBoundingClientRect().height)}px`);
	add("controls are at least 40 px tall", controls.length > 0 && small.length === 0, small.slice(0, 4).join("; "));
	add("no horizontal overflow", root.scrollWidth <= root.clientWidth + 1, `${root.scrollWidth} > ${root.clientWidth}`);

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio, width: window.innerWidth } };
}
