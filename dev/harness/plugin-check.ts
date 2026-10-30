/**
 * 0.12.1: the whole plugin started against the stub (doc=plugin, npm run harness:check). 0.12.0 lost its settings tab in
 * Obsidian because nothing outside Obsidian ever ran `NotebookPlugin.onload`: the other scenarios build their views
 * directly. This check runs the real `onload` and checks what it registers, draws the settings tab through both of
 * Obsidian's paths (1.13+ definitions, older `display()`), and injects failures: a start-up step that throws, settings
 * definitions that throw, and an unreadable data.json (never written over).
 */
import NotebookPlugin from "../../src/main";
import { HOME_VIEW_TYPE } from "../../src/library/home-view";
import { LIBRARY_VIEW_TYPE } from "../../src/library/library-view";
import { VIEW_TYPE } from "../../src/view/notebook-view";
import { NotebookSettingTab } from "../../src/view/settings-tab";
import { SECTIONS, settingSpecs } from "../../src/view/settings-schema";
import { t } from "../../src/i18n";
import { App, type Plugin as StubPlugin, type PluginSettingTab } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

export interface PluginCheckApi {
	errors: string[];
	notices: string[];
}

const MANIFEST = { id: "notebook", name: "Notebook", version: "0.0.0-harness", dir: "plugins/notebook" };

/** A plugin on a fresh stub app; `prepare` can break one of its methods before `onload` runs. */
async function startPlugin(prepare?: (plugin: NotebookPlugin & StubPlugin) => void): Promise<NotebookPlugin & StubPlugin> {
	const plugin = new NotebookPlugin(new App() as never, MANIFEST as never) as NotebookPlugin & StubPlugin;
	prepare?.(plugin);
	await plugin.onload();
	return plugin;
}

export async function checkPlugin(api: PluginCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null;
	const sectionTitles = SECTIONS.map((s) => t(s.title));
	const rowNames = [...new Set(settingSpecs().map((s) => t(s.name)))];
	/** Sections and rows the tab drew (hidden rows included: they exist and can be revealed). */
	const drawn = (tab: PluginSettingTab) => {
		const headers = [...tab.containerEl.querySelectorAll(".notebook-settings-header-title")].map((el) => el.textContent ?? "");
		const names = new Set([...tab.containerEl.querySelectorAll(".setting-item-name")].map((el) => el.textContent ?? ""));
		return { headers, missing: rowNames.filter((n) => !names.has(n)), shown: headers.filter((_, i) => visible(tab.containerEl.querySelectorAll(".notebook-settings-header-title")[i]!)) };
	};

	// 1. A normal start: nothing fails, and the settings tab, the views, the commands and the ribbon icon are registered.
	const plugin = await startPlugin();
	const reg = plugin.registered;
	add("onload completes with no failed step", plugin.startupFailures.length === 0, plugin.startupFailures.join(", "));
	add("the settings tab is registered once", reg.settingTabs.length === 1 && reg.settingTabs[0] instanceof NotebookSettingTab, String(reg.settingTabs.length));
	add("the notebook, library and Home views are registered", [VIEW_TYPE, LIBRARY_VIEW_TYPE, HOME_VIEW_TYPE].every((v) => reg.views.includes(v)), reg.views.join(", "));
	add("the commands and the ribbon icon are registered", reg.commands >= 50 && reg.ribbonIcons >= 1, `${reg.commands} commands, ${reg.ribbonIcons} ribbon icons`);

	// 2. The registered tab through both of Obsidian's paths, on the page so visibility can be read.
	const tab = reg.settingTabs[0];
	if (tab) {
		tab.containerEl.addClass("harness-settings");
		document.body.appendChild(tab.containerEl);
		add("Obsidian 1.13+ reads the definitions when the tab is added", tab.settingItems.length === SECTIONS.length + 1, String(tab.settingItems.length));
		const path = tab.showDeclarative();
		const modern = drawn(tab);
		add("Obsidian 1.13+: the tab is drawn from its definitions", path === "declarative", path);
		add("Obsidian 1.13+: every section is drawn, in order", JSON.stringify(modern.headers) === JSON.stringify(sectionTitles), modern.headers.join(" · "));
		add("Obsidian 1.13+: every row is drawn", modern.missing.length === 0, modern.missing.slice(0, 5).join(", "));
		add("Obsidian 1.13+: sections without rows for this vault are hidden, the others shown", modern.shown.length >= 8 && modern.shown.length < sectionTitles.length, modern.shown.join(" · "));
		tab.containerEl.empty();
		tab.display();
		const legacy = drawn(tab);
		add("before 1.13 (display()): every section is drawn, in order", JSON.stringify(legacy.headers) === JSON.stringify(sectionTitles), legacy.headers.join(" · "));
		add("before 1.13 (display()): every row is drawn", legacy.missing.length === 0, legacy.missing.slice(0, 5).join(", "));
		add("both paths show the same sections", JSON.stringify(legacy.shown) === JSON.stringify(modern.shown), `${legacy.shown.length} / ${modern.shown.length}`);
		tab.hide();
		tab.containerEl.remove();
	}
	plugin.unload();

	// Faults below log on purpose: their console errors are checked here, then removed from the scenario's errors.
	const errorsBefore = api.errors.length;

	// 3. A start-up step that throws (the ribbon icon): the others still run, the settings tab among them.
	const broken = await startPlugin((p) => {
		p.addRibbonIcon = () => {
			throw new Error("harness: injected ribbon failure");
		};
	});
	// Two steps add a ribbon icon (Home, and the lecture shortcut): both fail, nothing else does.
	add("a failing step does not stop the start-up", JSON.stringify(broken.startupFailures) === JSON.stringify(["ribbon", "lecture ribbon"]), broken.startupFailures.join(", "));
	add("…the settings tab and the views are still registered", broken.registered.settingTabs.length === 1 && broken.registered.views.length >= 3, `${broken.registered.settingTabs.length} tab, ${broken.registered.views.length} views`);
	add("…and the failure is reported in a notice", api.notices.some((n) => n.includes("ribbon")), api.notices.slice(-1).join(""));
	broken.unload();

	// 4. Definitions that cannot be built: Obsidian 1.13+ gets an empty list and falls back to display(), not to no tab.
	const fragile = new NotebookSettingTab(plugin.app, plugin);
	(fragile as unknown as { definitions: () => never }).definitions = () => {
		throw new Error("harness: injected definitions failure");
	};
	document.body.appendChild(fragile.containerEl);
	const fragileTab = fragile as unknown as PluginSettingTab;
	const fallback = fragileTab.showDeclarative();
	add("definitions that throw fall back to the hand-drawn tab", fallback === "display" && drawn(fragileTab).missing.length === 0, fallback);
	fragile.containerEl.remove();

	// 5. An unreadable data.json: the plugin starts on the defaults, and a settings change never writes them over the file.
	let writes = 0;
	const unreadable = await startPlugin((p) => {
		p.loadData = () => Promise.reject(new SyntaxError("harness: unreadable data.json"));
		p.saveData = () => {
			writes++;
			return Promise.resolve();
		};
	});
	await unreadable.saveSettings();
	unreadable.remember("Notebooks/A.notebook", 2);
	add("an unreadable settings file does not stop the start-up", unreadable.startupFailures.join() === "settings file" && unreadable.registered.settingTabs.length === 1, unreadable.startupFailures.join(", "));
	add("…and is never written over", writes === 0, `${writes} writes`);
	unreadable.unload();

	const logged = api.errors.splice(errorsBefore);
	add("the injected failures were logged", ["ribbon", "definitions", "data.json"].every((k) => logged.some((e) => e.includes(k))), `${logged.length} errors`);

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: {} };
}
