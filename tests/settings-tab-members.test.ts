import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Obsidian assigns instance fields on a SettingTab (for example `name` and `icon` on 1.13+). A method of the
// same name on our subclass is shadowed by the field, so calling it throws "this.name is not a function"
// (0.12.0/0.12.1 on the tablet). Keep our members clear of the fields Obsidian may set.
const RESERVED = ["name", "icon", "id", "app", "plugin", "containerEl", "navEl", "tabEl", "settingEl"];

describe("NotebookSettingTab members", () => {
	it("never shadows a field Obsidian sets on a SettingTab", () => {
		const src = readFileSync("src/view/settings-tab.ts", "utf8");
		const body = src.slice(src.indexOf("export class NotebookSettingTab"));
		const members = [...body.matchAll(/^\t(?:(?:private|protected|public|readonly|async|static)\s+)*([A-Za-z_$][\w$]*)\s*[(:<=?!]/gm)].map((m) => m[1]);
		expect(members.length).toBeGreaterThan(5);
		expect(members.filter((m) => RESERVED.includes(m))).toEqual([]);
	});
});
