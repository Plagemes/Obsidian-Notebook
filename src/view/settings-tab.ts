import { PluginSettingTab, setIcon, Setting, type App, type Plugin, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import { setUiLanguage, t } from "../i18n";
import { DEFAULT_SETTINGS, readSettings, type NotebookSettings } from "../settings";
import type { TimetableService } from "../timetable/service";
import { effectivePenHold } from "../ink/pen-button";
import { PenTestModal, penSignalInfo } from "./pen-test-modal";
import { companionService } from "../integration/companion";
import { zettelService } from "../zettel";
import { gestureKeyId } from "./pen-gesture-settings";
import { CustomGesturesModal, GestureCheatSheet, setGestureEnabled, type PenGestureUiHost } from "./pen-gesture-ui";
import { deviceNameRow, type SyncSafetyService } from "./sync-safety";
import {
	ADVANCED, groupKey, groupSpec, SECTIONS, sectionGroups, settingSpecs, settingsView, translations,
	type SectionSpec, type SettingActionId, type SettingCustomId, type SettingsContext, type SettingSpec, type SettingsView,
} from "./settings-schema";

export interface SettingsHost extends Plugin {
	settings: NotebookSettings;
	saveSettings(): Promise<void>;
	timetable?: TimetableService;
	syncSafety?: SyncSafetyService;
	/** Runs a plugin-level action of the registry (the benchmark of the Diagnostics section). */
	runGlobal(id: string): void;
}

/** A row drawn on the tab and whether it is shown now (the hand-drawn tab of Obsidian older than 1.13). */
interface LegacyRow {
	el: HTMLElement;
	shown: () => boolean;
}

const bool = (v: unknown): boolean => v === true;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/**
 * The plugin's settings tab (DESIGN.md §6, docs/design-ui.md *Settings*). Both ways Obsidian draws a tab come from the
 * one list in `settings-schema.ts`: `getSettingDefinitions()` on Obsidian 1.13+, `display()` on older versions. What is
 * shown (dependent options, collapsed groups, the search) is decided by `settingsView` for both.
 */
export class NotebookSettingTab extends PluginSettingTab {
	private specs: SettingSpec[] = settingSpecs();
	private query = "";
	private readonly groupOverrides = new Map<string, boolean>();
	private cached: SettingsView | null = null;
	/** Set while the hand-drawn tab is on screen. */
	private legacyRows: LegacyRow[] | null = null;
	/** Rows that redraw a part of themselves when the state changes (disclosure rows, the "no match" line), by id. */
	private readonly updaters = new Map<string, () => void>();

	constructor(app: App, private readonly host: SettingsHost) {
		super(app, host);
		this.containerEl.addClass("notebook-settings");
	}

	// ------------------------------------------------------------------------------------------------- state

	private context(): SettingsContext {
		const timetable = this.host.timetable;
		return {
			sync: !!this.host.syncSafety,
			timetable: !!timetable,
			timetableInUse: timetable?.hasClasses() ?? false,
			timetablePath: timetable?.path(),
		};
	}

	private view(): SettingsView {
		this.cached ??= settingsView(this.specs, {
			settings: this.host.settings,
			context: this.context(),
			query: this.query,
			groupOverrides: this.groupOverrides,
		});
		return this.cached;
	}

	/** A setting, the search or an open group changed: recompute what is shown and apply it in place. */
	private changed(): void {
		this.cached = null;
		this.applyStyle();
		for (const update of this.updaters.values()) update();
		if (this.legacyRows) {
			for (const row of this.legacyRows) row.el.toggleClass("notebook-hidden", !row.shown());
			return;
		}
		// Obsidian 1.13+: re-evaluates every `visible` predicate without redrawing (the search field keeps its focus).
		const refresh = (this as { refreshDomState?: () => void }).refreshDomState;
		if (typeof refresh === "function") refresh.call(this);
	}

	private applyStyle(): void {
		this.containerEl.toggleClass("nb-style-obsidian", this.host.settings.appearanceStyle === "obsidian");
	}

	private rowShown(spec: SettingSpec): boolean {
		return this.view().rows.get(spec.id) ?? false;
	}

	private sectionShown(section: SectionSpec): boolean {
		return this.view().sections.get(section.id) ?? false;
	}

	private groupShown(section: SectionSpec, group: string): boolean {
		return this.view().groups.get(groupKey(section.id, group))?.visible ?? false;
	}

	private emptyShown(): boolean {
		return this.query.trim() !== "" && this.view().matches === 0;
	}

	// ------------------------------------------------------------------------------------- values and actions

	getControlValue(key: string): unknown {
		// The hold-still toggle shows what is in effect: without a choice of the user that depends on the device.
		if (key === "penHoldStill") return effectivePenHold(this.host.settings.penHoldStill, this.host.settings.penButtonSeen);
		const gesture = gestureKeyId(key);
		if (gesture) return !this.host.settings.penGesturesOff.includes(gesture);
		return this.host.settings[key as keyof NotebookSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const gesture = gestureKeyId(key);
		if (gesture) {
			await setGestureEnabled(this.penGestureHost(), gesture, value === true);
		} else {
			// readSettings drops values of the wrong type and keeps the defaults.
			this.host.settings = readSettings({ ...this.host.settings, [key]: value });
			await this.host.saveSettings();
		}
		if (key === "uiLanguage") {
			this.languageChanged();
			return;
		}
		// The card regions are drawn from the settings: redraw them.
		if (key === "zettelShowRegions") zettelService(this.host)?.refreshOverlays();
		this.changed();
	}

	private penGestureHost(): PenGestureUiHost {
		return { app: this.app, get: () => this.host.settings, set: (key, value) => this.setControlValue(key, value) };
	}

	private run(id: SettingActionId): void {
		switch (id) {
			case "pen-test": new PenTestModal(this.app, penSignalInfo(this.host)).open(); break;
			case "benchmark": this.host.runGlobal("benchmark"); break;
			case "companion-update-all": void companionService(this.host)?.updateAll(); break;
			case "sync-check": void this.host.syncSafety?.openCheck(); break;
			case "timetable-edit": void this.host.timetable?.edit(); break;
			case "gesture-sheet": new GestureCheatSheet(this.penGestureHost()).open(); break;
			case "gesture-custom": new CustomGesturesModal(this.penGestureHost()).open(); break;
		}
	}

	private renderCustom(id: SettingCustomId, setting: Setting): void {
		if (id === "device-name" && this.host.syncSafety) deviceNameRow(setting, this.host.syncSafety);
	}

	/** Applies the new language and redraws this tab; open notebooks pick it up when reopened (see `onLanguageChanged`). */
	private languageChanged(): void {
		setUiLanguage(this.host.settings.uiLanguage);
		// Obsidian 1.13+ re-reads getSettingDefinitions() in update(); older versions only have display().
		const update = (this as { update?: () => void }).update;
		if (typeof update === "function" && !this.legacyRows) update.call(this);
		else this.renderLegacy();
	}

	// ------------------------------------------------------------------------------- rows shared by both paths

	private name(spec: SettingSpec): string {
		return t(spec.name);
	}

	private desc(spec: SettingSpec): string {
		return spec.desc ? t(spec.desc, spec.descVars?.(this.context())) : "";
	}

	/** The search pill at the top: filters every row by name, description and section, in every language. */
	private renderSearch(setting: Setting): () => void {
		setting.settingEl.addClass("notebook-settings-search");
		setting.infoEl.addClass("notebook-hidden");
		const pill = setting.controlEl.createDiv({ cls: "notebook-settings-search-pill" });
		setIcon(pill.createSpan({ cls: "notebook-settings-search-icon" }), "search");
		const input = pill.createEl("input", {
			type: "search",
			placeholder: t("settings.search.placeholder"),
			attr: { "aria-label": t("settings.search.placeholder"), enterkeyhint: "search" },
		});
		input.value = this.query;
		const onInput = () => {
			this.query = input.value;
			this.changed();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || !input.value) return;
			e.preventDefault();
			e.stopPropagation();
			input.value = "";
			onInput();
		};
		input.addEventListener("input", onInput);
		input.addEventListener("keydown", onKey);
		return () => {
			input.removeEventListener("input", onInput);
			input.removeEventListener("keydown", onKey);
		};
	}

	/** "No setting matches …", shown while a search finds nothing. */
	private renderEmpty(setting: Setting): void {
		setting.settingEl.addClass("notebook-settings-empty");
		const update = () => {
			setting.setName(t("settings.search.empty", { query: this.query.trim() }));
		};
		update();
		this.updaters.set("empty", update);
	}

	/** Section header: icon and title (DESIGN.md §6). */
	private renderHeader(setting: Setting, section: SectionSpec): void {
		setting.setHeading();
		setting.settingEl.addClass("notebook-settings-header");
		setting.nameEl.empty();
		setIcon(setting.nameEl.createSpan({ cls: "notebook-settings-header-icon" }), section.icon);
		setting.nameEl.createSpan({ cls: "notebook-settings-header-title", text: t(section.title) });
	}

	/** The row that opens and closes a group (*Advanced*, or a feature not in use). The whole row is the target. */
	private renderDisclosure(setting: Setting, section: SectionSpec, group: string): () => void {
		const key = groupKey(section.id, group);
		const title = group === ADVANCED ? t("settings.group.advanced") : t(groupSpec(section.id, group)?.title ?? "settings.group.advanced");
		const el = setting.settingEl;
		el.addClass("notebook-settings-disclosure");
		el.setAttr("role", "button");
		el.setAttr("tabindex", 0);
		setting.setName(title);
		setIcon(setting.controlEl.createSpan({ cls: "notebook-settings-chevron" }), "chevron-right");
		const update = () => {
			const view = this.view().groups.get(key);
			const open = view?.open ?? false;
			el.toggleClass("is-open", open);
			el.setAttr("aria-expanded", open);
			setting.setDesc(t("settings.group.count", { count: String(view?.count ?? 0) }));
		};
		update();
		this.updaters.set(key, update);
		const toggle = () => {
			this.groupOverrides.set(key, !(this.view().groups.get(key)?.open ?? false));
			this.changed();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Enter" && e.key !== " ") return;
			e.preventDefault();
			toggle();
		};
		el.addEventListener("click", toggle);
		el.addEventListener("keydown", onKey);
		return () => {
			el.removeEventListener("click", toggle);
			el.removeEventListener("keydown", onKey);
			if (this.updaters.get(key) === update) this.updaters.delete(key);
		};
	}

	// ------------------------------------------------------------------------- Obsidian 1.13+: definitions

	/** Obsidian 1.13+: the declarative tab, also indexed by Obsidian's own settings search. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		this.legacyRows = null;
		this.specs = settingSpecs();
		this.cached = null;
		this.updaters.clear();
		this.applyStyle();
		return [
			{
				type: "group",
				cls: "notebook-settings-top",
				items: [
					{ name: t("settings.search.placeholder"), searchable: false, render: (setting) => this.renderSearch(setting) },
					{ name: t("settings.search.placeholder"), searchable: false, visible: () => this.emptyShown(), render: (setting) => this.renderEmpty(setting) },
				],
			},
			...SECTIONS.map((section): SettingDefinitionItem => ({
				type: "group",
				cls: "notebook-settings-section",
				visible: () => this.sectionShown(section),
				items: [
					{ name: t(section.title), searchable: false, render: (setting) => this.renderHeader(setting, section) },
					...sectionGroups(section.id).flatMap((group) => this.groupDefinitions(section, group)),
				],
			})),
		];
	}

	private groupDefinitions(section: SectionSpec, group: string | undefined): SettingDefinition[] {
		const specs = this.specs.filter((s) => s.section === section.id && s.group === group);
		if (specs.length === 0) return [];
		const rows = specs.map((spec) => this.definition(spec));
		if (group === undefined) return rows;
		const title = group === ADVANCED ? "settings.group.advanced" : groupSpec(section.id, group)?.title ?? "settings.group.advanced";
		return [
			{ name: t(title), searchable: false, visible: () => this.groupShown(section, group), render: (setting) => this.renderDisclosure(setting, section, group) },
			...rows,
		];
	}

	private definition(spec: SettingSpec): SettingDefinition {
		const base = {
			name: this.name(spec),
			desc: this.desc(spec),
			aliases: [...translations(spec.name), ...(spec.keywords ? [spec.keywords] : [])],
			visible: () => this.rowShown(spec),
		};
		const c = spec.control;
		const key = spec.id;
		const value = this.defaultValue(spec);
		switch (c.type) {
			case "toggle": return { ...base, control: { type: "toggle", key, defaultValue: bool(value) } };
			case "dropdown": return { ...base, control: { type: "dropdown", key, defaultValue: str(value), options: c.options(t) } };
			case "slider": return { ...base, control: { type: "slider", key, defaultValue: num(value), min: c.min, max: c.max, step: c.step, displayFormat: c.format ? (v) => c.format?.(v, t) ?? String(v) : undefined } };
			case "text": return { ...base, control: { type: "text", key, defaultValue: str(value), placeholder: c.placeholder } };
			case "folder": return { ...base, control: { type: "folder", key, defaultValue: str(value), placeholder: c.placeholder } };
			case "action": return { ...base, action: () => this.run(c.run) };
			case "custom": return { ...base, render: (setting) => this.renderCustom(c.render, setting) };
		}
	}

	/** The default shown by a control: the stored default, or what is in effect for the derived toggles. */
	private defaultValue(spec: SettingSpec): unknown {
		if (spec.id === "penHoldStill" || gestureKeyId(spec.id)) return true;
		return DEFAULT_SETTINGS[spec.id as keyof NotebookSettings];
	}

	// -------------------------------------------------------------------- Obsidian older than 1.13: by hand

	/** Fallback for Obsidian older than 1.13, which does not read getSettingDefinitions() and calls display() instead. */
	display(): void {
		this.renderLegacy();
	}

	/** The same tab drawn by hand from the same list, for Obsidian older than 1.13 (see `display`). */
	private renderLegacy(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.specs = settingSpecs();
		this.cached = null;
		this.updaters.clear();
		const rows: LegacyRow[] = [];
		this.legacyRows = rows;
		this.applyStyle();

		const top = containerEl.createDiv({ cls: "notebook-settings-top" });
		this.renderSearch(new Setting(top));
		const empty = new Setting(top);
		this.renderEmpty(empty);
		rows.push({ el: empty.settingEl, shown: () => this.emptyShown() });

		for (const section of SECTIONS) {
			const sectionEl = containerEl.createDiv({ cls: "notebook-settings-section" });
			rows.push({ el: sectionEl, shown: () => this.sectionShown(section) });
			this.renderHeader(new Setting(sectionEl), section);
			for (const group of sectionGroups(section.id)) {
				const specs = this.specs.filter((s) => s.section === section.id && s.group === group);
				if (specs.length === 0) continue;
				if (group !== undefined) {
					const disclosure = new Setting(sectionEl);
					this.renderDisclosure(disclosure, section, group);
					rows.push({ el: disclosure.settingEl, shown: () => this.groupShown(section, group) });
				}
				for (const spec of specs) {
					const setting = new Setting(sectionEl).setName(this.name(spec));
					const desc = this.desc(spec);
					if (desc) setting.setDesc(desc);
					this.legacyControl(setting, spec);
					rows.push({ el: setting.settingEl, shown: () => this.rowShown(spec) });
				}
			}
		}
		for (const row of rows) row.el.toggleClass("notebook-hidden", !row.shown());
	}

	private legacyControl(setting: Setting, spec: SettingSpec): void {
		const c = spec.control;
		const key = spec.id;
		const value = this.getControlValue(key);
		const save = (v: unknown) => void this.setControlValue(key, v);
		switch (c.type) {
			case "toggle":
				setting.addToggle((tg) => tg.setValue(bool(value)).onChange(save));
				break;
			case "dropdown":
				setting.addDropdown((dd) => dd.addOptions(c.options(t)).setValue(str(value)).onChange(save));
				break;
			case "slider":
				setting.addSlider((sl) => sl.setLimits(c.min, c.max, c.step).setValue(num(value)).onChange(save));
				break;
			case "text":
			case "folder":
				setting.addText((text) => text.setPlaceholder(c.placeholder ?? "").setValue(str(value)).onChange(save));
				break;
			case "action":
				setting.addButton((b) => b.setButtonText(t(c.button ?? spec.name)).onClick(() => this.run(c.run)));
				break;
			case "custom":
				this.renderCustom(c.render, setting);
				break;
		}
	}
}
