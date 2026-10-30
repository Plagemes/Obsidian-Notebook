import { describe, expect, it } from "vitest";
import settingsTab from "../src/view/settings-tab.ts?raw";
import libraryView from "../src/library/library-view.ts?raw";

// Obsidian assigns instance fields on a SettingTab (for example `name` and `icon` on 1.13+). A method of the
// same name on our subclass is shadowed by the field, so calling it throws "this.name is not a function"
// (0.12.0/0.12.1 on the tablet). Keep our members clear of the fields Obsidian may set.
const RESERVED = ["name", "icon", "id", "app", "plugin", "containerEl", "navEl", "tabEl", "settingEl"];
// The same for an ItemView: the public fields plus the view-header elements Obsidian keeps on the view (0.12.2).
const RESERVED_VIEW = ["app", "icon", "navigation", "leaf", "containerEl", "contentEl", "headerEl", "titleEl", "titleContainerEl", "titleParentEl", "iconEl", "actionsEl", "backButtonEl", "forwardButtonEl"];

/** The names of the members declared at the top level of the class body (one tab of indentation). */
function members(src: string, cls: string): string[] {
	const body = src.slice(src.indexOf(`export class ${cls}`));
	return [...body.matchAll(/^\t(?:(?:private|protected|public|readonly|async|static)\s+)*([A-Za-z_$][\w$]*)\s*[(:<=?!]/gm)].map((m) => m[1]!);
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
