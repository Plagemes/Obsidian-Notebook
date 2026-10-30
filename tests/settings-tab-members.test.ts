import { describe, expect, it } from "vitest";
import settingsTab from "../src/view/settings-tab.ts?raw";
import libraryView from "../src/library/library-view.ts?raw";

const SOURCES = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

// Obsidian assigns instance fields on a SettingTab (for example `name` and `icon` on 1.13+). A method of the
// same name on our subclass is shadowed by the field, so calling it throws "this.name is not a function"
// (0.12.0/0.12.1 on the tablet). Keep our members clear of the fields Obsidian may set.
const RESERVED = ["name", "icon", "id", "app", "plugin", "containerEl", "navEl", "tabEl", "settingEl"];
// The same for an ItemView: the public fields plus the view-header elements Obsidian keeps on the view (0.12.2), and the
// Component methods a subclass must not replace (0.12.3).
const RESERVED_VIEW = [
	"app", "icon", "navigation", "leaf", "containerEl", "contentEl", "headerEl", "titleEl", "titleContainerEl", "titleParentEl", "iconEl", "actionsEl",
	"backButtonEl", "forwardButtonEl", "leftActionsEl", "moreOptionsButtonEl", "closeable",
	"addAction", "load", "unload", "addChild", "removeChild", "register", "registerEvent", "registerDomEvent", "registerInterval",
];
// 0.12.3: a Modal's fields (documented, and the ones Obsidian keeps on every modal) and the methods a subclass must not replace.
const RESERVED_MODAL = [
	"app", "scope", "containerEl", "modalEl", "titleEl", "contentEl", "bgEl", "headerEl", "closeButtonEl", "shouldRestoreSelection", "shouldAnimate",
	"bgOpacity", "dimBackground", "selection", "win", "setTitle", "setContent", "setCloseCallback", "open",
];
// A SuggestModal / FuzzySuggestModal adds its input, its result list and their helpers.
const RESERVED_SUGGEST = [...RESERVED_MODAL, "inputEl", "resultContainerEl", "chooser", "instructionsEl", "setPlaceholder", "setInstructions", "selectSuggestion", "updateSuggestions"];

const BASES: Record<string, string[]> = {
	Modal: RESERVED_MODAL,
	SuggestModal: RESERVED_SUGGEST,
	FuzzySuggestModal: RESERVED_SUGGEST,
	ItemView: RESERVED_VIEW,
	FileView: RESERVED_VIEW,
	TextFileView: RESERVED_VIEW,
	PluginSettingTab: RESERVED,
	// Our own views built on ItemView.
	LibraryView: RESERVED_VIEW,
};

// Documented fields a subclass is meant to set with a value (`navigation = true`); declaring them as a method still clashes.
const SETTABLE = ["navigation", "allowNoFile", "icon"];
const MEMBER = /^\t(?:(?:private|protected|public|readonly|async|static|override)\s+)*([A-Za-z_$][\w$]*)\s*[(:<=?!]/gm;

/** The names of the members declared at the top level of the class body (one tab of indentation). */
function members(src: string, cls: string): string[] {
	const body = src.slice(src.indexOf(`export class ${cls}`));
	return [...body.matchAll(MEMBER)].map((m) => m[1]!);
}

/** Every class in src/ that extends one of BASES: its file, name, base and the members of its own body. */
function subclasses(): Array<{ file: string; cls: string; base: string; names: string[] }> {
	const out: Array<{ file: string; cls: string; base: string; names: string[] }> = [];
	for (const [file, raw] of Object.entries(SOURCES)) {
		const src = raw.replace(/\r\n/g, "\n");
		for (const m of src.matchAll(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:<[^>]*>)?\s+extends\s+(\w+)/gm)) {
			const base = m[2]!;
			if (!(base in BASES)) continue;
			const end = src.indexOf("\n}\n", m.index);
			const body = src.slice(m.index, end < 0 ? undefined : end);
			const names = [...body.matchAll(MEMBER)].filter((x) => !(SETTABLE.includes(x[1]!) && x[0].trimEnd().endsWith("="))).map((x) => x[1]!);
			out.push({ file, cls: m[1]!, base, names });
		}
	}
	return out;
}

describe("NotebookSettingTab members", () => {
	it("never shadows a field Obsidian sets on a SettingTab", () => {
		const names = members(settingsTab, "NotebookSettingTab");
		expect(names.length).toBeGreaterThan(5);
		expect(names.filter((m) => RESERVED.includes(m))).toEqual([]);
	});
});

describe("LibraryView members", () => {
	it("never shadows a field Obsidian sets on an ItemView", () => {
		const names = members(libraryView, "LibraryView");
		expect(names.length).toBeGreaterThan(20);
		expect(names.filter((m) => RESERVED_VIEW.includes(m))).toEqual([]);
	});
});

describe("Modal, ItemView and SettingTab subclasses (0.12.3)", () => {
	const all = subclasses();

	it("finds the creation dialog, Home and the other modals", () => {
		const names = all.map((c) => c.cls);
		for (const cls of ["CreateDialog", "IconSearchModal", "HomeView", "LibraryView", "NotebookSettingTab"]) expect(names).toContain(cls);
		expect(all.filter((c) => c.base === "Modal").length).toBeGreaterThan(10);
	});

	it("no subclass declares a member that shadows its Obsidian base", () => {
		const clashes = all.flatMap((c) => c.names.filter((n) => BASES[c.base]!.includes(n)).map((n) => `${c.file}: ${c.cls} extends ${c.base} declares "${n}"`));
		expect(clashes).toEqual([]);
	});
});
