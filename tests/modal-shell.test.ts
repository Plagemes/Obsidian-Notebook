import { describe, expect, it } from "vitest";
import css from "../styles.css?raw";
import shellSrc from "../src/ui/components/modal-shell.ts?raw";
import { shellButtonClasses, shellClasses, shellColour } from "../src/ui/components/modal-shell-model";
import { SUBJECT_COLORS } from "../src/ui/palette";
import { en } from "../src/i18n/en";
import { it as italian } from "../src/i18n/it";

const SOURCES = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });
const src = (path: string): string => (SOURCES[`../src/${path}`] ?? "").replace(/\r\n/g, "\n");

/** Every dialog, prompt and card of wave 0.13: the file, and what it must call to be on the shell. */
const SURFACES: Array<[string, RegExp]> = [
	["view/modals.ts", /modalShell\(this[\s\S]*promptShell\(this/],
	["view/arrange-modals.ts", /modalShell\(this[\s\S]*modalShell\(this/],
	["view/export-dialog.ts", /modalShell\(this[\s\S]*modalShell\(this/],
	["view/goto-page.ts", /promptShell\(this/],
	["view/paste-modal.ts", /modalShell\(this/],
	["view/pdf-range-modal.ts", /modalShell\(modal/],
	["view/practice-modal.ts", /modalShell\(modal[\s\S]*modalShell\(modal/],
	["view/pen-test-modal.ts", /modalShell\(this/],
	["view/lecture-pack-modal.ts", /modalShell\(modal[\s\S]*modalShell\(modal[\s\S]*modalShell\(modal/],
	["view/shared-clip-modal.ts", /modalShell\(this/],
	["view/colour-picker.ts", /shellCard\(this\.el/],
	["view/equation-editor.ts", /shellCard\(this\.el/],
	["view/find-replace.ts", /modalShell\(this/],
	["view/quick-switcher.ts", /promptShell\(this/],
	["view/stamp-palette.ts", /shellCard\(this\.el/],
	["ui/destructive.ts", /modalShell\(this/],
];

describe("the modal shell (0.13)", () => {
	it("scopes a dialog under .nb-ui with its width class and any extra class", () => {
		expect(shellClasses()).toEqual(["nb-ui", "nb-modal", "is-medium"]);
		expect(shellClasses("narrow", "notebook-style-panel")).toEqual(["nb-ui", "nb-modal", "is-narrow", "notebook-style-panel"]);
		expect(shellClasses("wide", "nb-prompt  notebook-goto-modal")).toEqual(["nb-ui", "nb-modal", "is-wide", "nb-prompt", "notebook-goto-modal"]);
	});

	it("gives each button kind its look, and keeps Obsidian's mod-cta / mod-warning hooks", () => {
		expect(shellButtonClasses("primary")).toEqual(["nb-modal-btn", "is-primary", "mod-cta"]);
		expect(shellButtonClasses("secondary")).toEqual(["nb-modal-btn", "is-secondary"]);
		expect(shellButtonClasses("danger")).toEqual(["nb-modal-btn", "is-danger", "mod-warning"]);
	});

	it("takes the colour asked for, else a subject colour that is stable for the seed or the title", () => {
		expect(shellColour({ title: "Export", color: "#123456" })).toBe("#123456");
		const palette = SUBJECT_COLORS.map((c) => c.base);
		expect(palette).toContain(shellColour({ title: "Export" }));
		expect(shellColour({ title: "Export" })).toBe(shellColour({ title: "Export" }));
		expect(shellColour({ title: "A", seed: "same" })).toBe(shellColour({ title: "B", seed: "same" }));
	});

	it("puts every dialog, prompt and card of the wave on the shell", () => {
		for (const [file, needle] of SURFACES) expect(src(file), file).toMatch(needle);
	});

	it("keeps the footers on the shell: no dialog draws its own Cancel / primary row with Setting buttons", () => {
		for (const [file] of SURFACES) {
			if (file === "ui/destructive.ts") continue;
			expect(src(file), file).not.toMatch(/\.addButton\(\(b\) => b\.setButtonText[\s\S]{0,120}setCta\(\)/);
		}
	});

	it("never builds the header's art on a Document, and hides the art when it cannot be drawn", () => {
		expect(shellSrc).not.toMatch(/activeDocument\.createEl|document\.createEl|activeDocument\.createDiv/);
		expect(shellSrc).toMatch(/decorate\(/);
	});

	it("styles every class the shell builds, under .nb-ui", () => {
		const built = new Set([...shellSrc.matchAll(/"(nb-(?:modal|card)[\w-]*)"/g)].map((m) => m[1]!));
		built.add("nb-prompt");
		for (const cls of built) {
			if (cls === "nb-card" || cls === "nb-modal-btn-label") continue; // the card has its own compound rules; the label is a plain inline span
			expect(css, cls).toMatch(new RegExp(String.raw`\.${cls}[\s,{:.]`));
		}
		expect(css).toMatch(/\.nb-ui\.nb-card \{/);
		for (const size of ["narrow", "medium", "wide"]) expect(css, size).toContain(`.modal.nb-modal.nb-ui.is-${size} {`);
	});

	it("keeps the 40 px target and the phone footer", () => {
		expect(css).toMatch(/\.nb-ui \.nb-modal-btn \{[^}]*min-height: var\(--nb-target\)/);
		expect(css).toMatch(/\.nb-ui \.nb-modal-close,\n\.nb-ui \.nb-card-btn \{[^}]*width: var\(--nb-target\)/);
		expect(css).toMatch(/@media \(max-width: 600px\) \{\n\t\.modal\.nb-modal\.nb-ui \{/);
	});

	it("has the new strings in English and Italian", () => {
		for (const key of ["ui.modal.cancel", "goto.title", "quicknav.title", "modal.open.title"] as const) {
			expect(en[key], key).toBeTruthy();
			expect(italian[key], key).toBeTruthy();
		}
	});
});
