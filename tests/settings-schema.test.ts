import { describe, expect, it } from "vitest";
import { en, type MessageKey } from "../src/i18n/en";
import { LANGUAGES, LANGUAGE_CODES } from "../src/i18n/languages";
import { DEFAULT_SETTINGS, type NotebookSettings } from "../src/settings";
import {
	ADVANCED, editedKeys, GESTURE_KEY_PREFIX, GROUPS, groupKey, INTERNAL_SETTING_KEYS, matchesQuery, PEN_BUTTON_EXTENSIONS, SECTION_IDS, SECTIONS,
	settingSpecs, settingsView, type SettingsContext, type SettingSpec, type SettingsViewState,
} from "../src/view/settings-schema";

const CONTEXT: SettingsContext = { sync: true, timetable: true, timetableInUse: false, timetablePath: "Notebooks/_timetable.json" };

function state(over: Partial<NotebookSettings> = {}, extra: Partial<SettingsViewState> = {}): SettingsViewState {
	return { settings: { ...DEFAULT_SETTINGS, ...over }, context: CONTEXT, query: "", groupOverrides: new Map(), ...extra };
}

const shown = (s: SettingsViewState) => {
	const v = settingsView(settingSpecs(), s);
	return new Set([...v.rows].filter(([, on]) => on).map(([id]) => id));
};

describe("settings tab structure", () => {
	const specs = settingSpecs();

	it("has the sections of DESIGN.md §6, in order", () => {
		expect(SECTIONS.map((s) => s.id)).toEqual(["writing", "input", "pages", "reading", "library", "sync", "export", "integration", "study", "appearance", "diagnostics"]);
		expect(SECTION_IDS).toEqual(SECTIONS.map((s) => s.id));
	});

	it("puts every key of DEFAULT_SETTINGS in exactly one section, except the listed internal ones", () => {
		const sections = new Map<string, Set<string>>();
		for (const spec of specs) for (const key of editedKeys(spec)) sections.set(key, (sections.get(key) ?? new Set()).add(spec.section));
		const internal = Object.keys(INTERNAL_SETTING_KEYS);
		const missing = Object.keys(DEFAULT_SETTINGS).filter((k) => !internal.includes(k) && (sections.get(k)?.size ?? 0) !== 1);
		expect(missing).toEqual([]);
		expect(internal.filter((k) => sections.has(k))).toEqual([]);
		expect(internal.filter((k) => !(k in DEFAULT_SETTINGS))).toEqual([]);
		expect([...sections.keys()].filter((k) => !(k in DEFAULT_SETTINGS))).toEqual([]);
	});

	it("gives every row a unique id, a known group and parent, and a control of the setting's type", () => {
		const ids = specs.map((s) => s.id);
		expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
		const byId = new Map(specs.map((s) => [s.id, s]));
		for (const spec of specs) {
			if (spec.group && spec.group !== ADVANCED) expect(GROUPS.some((g) => g.id === spec.group && g.section === spec.section), spec.id).toBe(true);
			if (spec.parent) expect(byId.get(spec.parent)?.section, spec.id).toBe(spec.section);
			const c = spec.control;
			if (c.type === "action" || c.type === "custom") continue;
			const value: unknown = spec.id.startsWith(GESTURE_KEY_PREFIX) || spec.id === "penHoldStill" ? true : DEFAULT_SETTINGS[spec.id as keyof NotebookSettings];
			if (c.type === "toggle") expect(typeof value, spec.id).toBe("boolean");
			if (c.type === "slider") {
				expect(typeof value, spec.id).toBe("number");
				expect(value as number, spec.id).toBeGreaterThanOrEqual(c.min);
				expect(value as number, spec.id).toBeLessThanOrEqual(c.max);
			}
			if (c.type === "dropdown") expect(Object.keys(c.options((k) => k)), spec.id).toContain(value);
			if (c.type === "text" || c.type === "folder") expect(typeof value, spec.id).toBe("string");
		}
	});

	it("has short names and one-line descriptions in every language", () => {
		const keys = new Set<MessageKey>([...SECTIONS.map((s) => s.title), ...GROUPS.map((g) => g.title)]);
		for (const spec of specs) {
			keys.add(spec.name);
			if (spec.desc) keys.add(spec.desc);
		}
		const tooLong: string[] = [];
		for (const code of LANGUAGE_CODES) {
			const table: Record<string, string | undefined> = LANGUAGES[code].messages;
			for (const spec of specs) {
				const name = table[spec.name] ?? "";
				const desc = spec.desc ? table[spec.desc] ?? "" : "";
				if (name.length > 48) tooLong.push(`${code} ${spec.name}: ${name}`);
				if (desc.length > 90) tooLong.push(`${code} ${spec.desc}: ${desc}`);
				expect(name.charAt(0), `${code} ${spec.name}`).toBe(name.charAt(0).toUpperCase());
			}
		}
		expect([...keys].filter((k) => !(k in en))).toEqual([]);
		expect(tooLong).toEqual([]);
	});
});

describe("what the tab shows", () => {
	it("shows dependent options only when their parent is on", () => {
		const off = shown(state());
		expect(off.has("companionNotes")).toBe(true);
		expect(off.has("companionLocation")).toBe(false);
		expect(off.has("companionFolder")).toBe(false);
		const on = shown(state({ companionNotes: true }));
		expect(on.has("companionLocation")).toBe(true);
		expect(on.has("companionFolder")).toBe(false);
		expect(shown(state({ companionNotes: true, companionLocation: "folder" })).has("companionFolder")).toBe(true);
		// A dependent of a dependent follows the root: the folder stays hidden while companion notes are off.
		expect(shown(state({ companionNotes: false, companionLocation: "folder" })).has("companionFolder")).toBe(false);
		expect(shown(state({ fingerDrawing: true })).has("fingerLongPress")).toBe(false);
		expect(shown(state({ scrollMode: "pages" })).has("fastScrollbar")).toBe(false);
		expect(shown(state({ snapshotIntervalHours: 0 })).has("snapshotsToKeep")).toBe(false);
	});

	it("keeps Advanced closed until it is opened, and shows its disclosure row", () => {
		const s = state({ edgeRejection: true });
		const view = settingsView(settingSpecs(), s);
		expect(view.rows.get("palmContactPx")).toBe(false);
		expect(view.groups.get(groupKey("input", ADVANCED))).toMatchObject({ visible: true, open: false });
		const opened = state({ edgeRejection: true }, { groupOverrides: new Map([[groupKey("input", ADVANCED), true]]) });
		const rows = shown(opened);
		expect(rows.has("palmContactPx")).toBe(true);
		expect(rows.has("edgeRejectionPx")).toBe(true);
		expect(rows.has("eraseAreaElements")).toBe(false);
	});

	it("collapses the options of features not in use and opens them when they are", () => {
		const idle = settingsView(settingSpecs(), state());
		expect(idle.groups.get(groupKey("input", "penGestures"))?.open).toBe(false);
		expect(idle.rows.get("penGestureLongPress")).toBe(false);
		expect(idle.groups.get(groupKey("study", "zettel"))?.open).toBe(false);
		const used = settingsView(settingSpecs(), state({ penSideButton: "radial-gesture" }));
		expect(used.groups.get(groupKey("input", "penGestures"))?.open).toBe(true);
		expect(used.rows.get(`${GESTURE_KEY_PREFIX}select`)).toBe(true);
		const timetable = settingsView(settingSpecs(), { ...state(), context: { ...CONTEXT, timetableInUse: true } });
		expect(timetable.rows.get("timetableOffer")).toBe(true);
	});

	it("hides the rows of a service that is not running, and a section with nothing to show", () => {
		const view = settingsView(settingSpecs(), { ...state(), context: { sync: false, timetable: false, timetableInUse: false } });
		expect(view.rows.get("deviceName")).toBe(false);
		expect(view.sections.get("sync")).toBe(false);
		expect(view.sections.get("export")).toBe(false);
		expect(view.sections.get("writing")).toBe(true);
	});

	it("searches names, descriptions and sections in English and Italian, ignoring accents", () => {
		const palm = settingsView(settingSpecs(), state({}, { query: "palm" }));
		expect(palm.rows.get("palmRejectionMs")).toBe(true);
		// In a closed Advanced group: the search opens it.
		expect(palm.rows.get("palmContactPx")).toBe(true);
		expect(palm.rows.get("fingerDrawing")).toBe(false);
		expect([...palm.sections].filter(([, on]) => on).map(([id]) => id)).toEqual(["input"]);
		expect([...palm.groups.values()].some((g) => g.visible)).toBe(false);
		expect(shown(state({}, { query: "attenua sfondi" })).has("dimBackground")).toBe(true);
		expect(shown(state({}, { query: "modalita notte" })).has("nightMode")).toBe(true);
		const diagnostics = shown(state({}, { query: "diagnostica" }));
		expect(diagnostics.has("penTest") && diagnostics.has("benchmark") && diagnostics.has("perfOverlay")).toBe(true);
		expect(settingsView(settingSpecs(), state({}, { query: "zzzz qqqq" })).matches).toBe(0);
	});

	it("shows the parent of a match that is not relevant yet", () => {
		const rows = shown(state({ edgeRejection: false }, { query: "edge width" }));
		expect(rows.has("edgeRejectionPx")).toBe(false);
		expect(rows.has("edgeRejection")).toBe(true);
		expect(shown(state({ edgeRejection: true }, { query: "edge width" })).has("edgeRejectionPx")).toBe(true);
	});

	it("matches every word of the query", () => {
		const spec = settingSpecs().find((s) => s.id === "dimBackground") as SettingSpec;
		expect(matchesQuery(spec, "dim")).toBe(true);
		expect(matchesQuery(spec, "dim pdf")).toBe(true);
		expect(matchesQuery(spec, "dim zettel")).toBe(false);
	});
});

describe("Pen & input extension point", () => {
	it("places the S Pen rows after the side button and before the hold-still option, the timing in Advanced", () => {
		const ids = settingSpecs().filter((s) => s.section === "input" && !s.group).map((s) => s.id);
		const at = ids.indexOf("penSideButton");
		expect(ids.slice(at, at + 5)).toEqual(["penSideButton", "penButtonEraserNext", "penButtonKey", "penButtonKeyAction", "penHoldStill"]);
		const advanced = settingSpecs().filter((s) => s.section === "input" && s.group === ADVANCED).map((s) => s.id);
		expect(advanced).toEqual(expect.arrayContaining(["penButtonContactBeforeMs", "penButtonContactAfterMs"]));
		expect(PEN_BUTTON_EXTENSIONS.every((s) => s.section === "input")).toBe(true);
	});

	it("shows the key action only once a key is set, and the button rows only while the button does something", () => {
		const open = new Map([[groupKey("input", ADVANCED), true]]);
		const on = shown(state({ penSideButton: "radial-eraser", penButtonKey: "" }, { groupOverrides: open }));
		expect(on.has("penButtonEraserNext")).toBe(true);
		expect(on.has("penButtonKey")).toBe(true);
		expect(on.has("penButtonKeyAction")).toBe(false);
		expect(on.has("penButtonContactBeforeMs") && on.has("penButtonContactAfterMs")).toBe(true);
		expect(shown(state({ penButtonKey: "F9" })).has("penButtonKeyAction")).toBe(true);
		const off = shown(state({ penSideButton: "off", penButtonKey: "F9" }, { groupOverrides: open }));
		expect(off.has("penButtonEraserNext")).toBe(false);
		expect(off.has("penButtonContactBeforeMs")).toBe(false);
		// The pen key works whatever the side button does.
		expect(off.has("penButtonKey") && off.has("penButtonKeyAction")).toBe(true);
	});
});
