import { PluginSettingTab, Setting, type App, type Plugin, type SettingDefinitionItem } from "obsidian";
import { t } from "../i18n";
import { DEFAULT_SETTINGS, readSettings, type NotebookSettings } from "../settings";
import { PAGE_SIZES, PAPER_KINDS } from "../model/types";
import { defaultLooseSheetPath } from "../library/loose-sheet-logic";
import { EDGE_WIDTH_MAX, EDGE_WIDTH_MIN } from "../ink/edge-zones";
import { displayTimetableSettings } from "../timetable/settings-ui";
import type { TimetableService } from "../timetable/service";
import { companionSettingDefinitions, displayCompanionSettings, type CompanionSettingsHost } from "./companion-settings";

const paperOptions = () => Object.fromEntries(PAPER_KINDS.map((k) => [k, t(`paper.${k}`)]));
const sizeOptions = () => Object.fromEntries((Object.keys(PAGE_SIZES) as Array<keyof typeof PAGE_SIZES>).map((k) => [k, t(`size.${k}`)]));

export interface SettingsHost extends Plugin {
	settings: NotebookSettings;
	saveSettings(): Promise<void>;
	timetable?: TimetableService;
}

type Key = keyof NotebookSettings;

const penButtonOptions = () => ({
	radial: t("settings.penButton.radial"),
	eraser: t("settings.penButton.eraser"),
	off: t("settings.penButton.off"),
});

const EDGE_KEYS = [
	["edgeLeft", "settings.edgeLeft"],
	["edgeRight", "settings.edgeRight"],
	["edgeTop", "settings.edgeTop"],
	["edgeBottom", "settings.edgeBottom"],
] as const;

export class NotebookSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly host: SettingsHost) {
		super(app, host);
	}

	/** Obsidian 1.13+: declarative settings, also indexed by the settings search. */
	getSettingDefinitions(): SettingDefinitionItem<Key>[] {
		return [
			{
				name: t("settings.folder"),
				desc: t("settings.folder.desc"),
				control: {
					type: "folder",
					key: "folder",
					defaultValue: DEFAULT_SETTINGS.folder,
					placeholder: DEFAULT_SETTINGS.folder,
				},
			},
			{
				name: t("settings.looseSheet"),
				desc: t("settings.looseSheet.desc"),
				control: { type: "text", key: "looseSheetPath", defaultValue: DEFAULT_SETTINGS.looseSheetPath, placeholder: defaultLooseSheetPath(DEFAULT_SETTINGS.folder) },
			},
			{
				name: t("settings.defaultPaper"),
				desc: t("settings.defaultPaper.desc"),
				control: { type: "dropdown", key: "defaultPaper", defaultValue: DEFAULT_SETTINGS.defaultPaper, options: paperOptions() },
			},
			{
				name: t("settings.defaultSize"),
				control: { type: "dropdown", key: "defaultPageSize", defaultValue: DEFAULT_SETTINGS.defaultPageSize, options: sizeOptions() },
			},
			{
				name: t("settings.defaultLandscape"),
				control: { type: "toggle", key: "defaultLandscape", defaultValue: DEFAULT_SETTINGS.defaultLandscape },
			},
			{
				name: t("settings.finger"),
				desc: t("settings.finger.desc"),
				control: { type: "toggle", key: "fingerDrawing", defaultValue: DEFAULT_SETTINGS.fingerDrawing },
			},
			{
				name: t("settings.palm"),
				desc: t("settings.palm.desc"),
				control: {
					type: "slider", key: "palmRejectionMs", defaultValue: DEFAULT_SETTINGS.palmRejectionMs,
					min: 0, max: 2000, step: 50, displayFormat: (v) => `${v} ms`,
				},
			},
			{
				name: t("settings.pressure"),
				desc: t("settings.pressure.desc"),
				control: {
					type: "dropdown", key: "pressureMode", defaultValue: DEFAULT_SETTINGS.pressureMode,
					options: { auto: t("settings.pressure.auto"), simulated: t("settings.pressure.simulated") },
				},
			},
			{
				name: t("settings.inkPrediction"),
				desc: t("settings.inkPrediction.desc"),
				control: { type: "toggle", key: "inkPrediction", defaultValue: DEFAULT_SETTINGS.inkPrediction },
			},
			{
				name: t("settings.lowLatencyInk"),
				desc: t("settings.lowLatencyInk.desc"),
				control: { type: "toggle", key: "lowLatencyInk", defaultValue: DEFAULT_SETTINGS.lowLatencyInk },
			},
			{
				name: t("settings.stabilization"),
				desc: t("settings.stabilization.filter.desc"),
				control: { type: "slider", key: "stabilization", defaultValue: DEFAULT_SETTINGS.stabilization, min: 0, max: 10, step: 1 },
			},
			{
				name: t("settings.palmSize"),
				desc: t("settings.palmSize.desc"),
				control: {
					type: "slider", key: "palmContactPx", defaultValue: DEFAULT_SETTINGS.palmContactPx,
					min: 0, max: 120, step: 5, displayFormat: (v) => (v === 0 ? "off" : `${v} px`),
				},
			},
			{
				name: t("settings.perfOverlay"),
				desc: t("settings.perfOverlay.desc"),
				control: { type: "toggle", key: "perfOverlay", defaultValue: DEFAULT_SETTINGS.perfOverlay },
			},
			{
				name: t("settings.snapshotInterval"),
				desc: t("settings.snapshotInterval.desc"),
				control: {
					type: "slider", key: "snapshotIntervalHours", defaultValue: DEFAULT_SETTINGS.snapshotIntervalHours,
					min: 0, max: 168, step: 1, displayFormat: (v) => (v === 0 ? "off" : `${v} h`),
				},
			},
			{
				name: t("settings.snapshotKeep"),
				desc: t("settings.snapshotKeep.desc"),
				control: { type: "slider", key: "snapshotsToKeep", defaultValue: DEFAULT_SETTINGS.snapshotsToKeep, min: 1, max: 50, step: 1 },
			},
			{
				name: t("settings.autoNextPage"),
				desc: t("settings.autoNextPage.desc"),
				control: { type: "toggle", key: "autoNextPage", defaultValue: DEFAULT_SETTINGS.autoNextPage },
			},
			{
				name: t("settings.eraseAreaElements"),
				desc: t("settings.eraseAreaElements.desc"),
				control: { type: "toggle", key: "eraseAreaElements", defaultValue: DEFAULT_SETTINGS.eraseAreaElements },
			},
			// wave p1a: input
			{
				name: t("settings.edge"),
				desc: t("settings.edge.desc"),
				control: { type: "toggle", key: "edgeRejection", defaultValue: DEFAULT_SETTINGS.edgeRejection },
			},
			{
				name: t("settings.edgePx"),
				desc: t("settings.edgePx.desc"),
				control: {
					type: "slider", key: "edgeRejectionPx", defaultValue: DEFAULT_SETTINGS.edgeRejectionPx,
					min: EDGE_WIDTH_MIN, max: EDGE_WIDTH_MAX, step: 2, displayFormat: (v) => `${v} px`,
				},
			},
			...EDGE_KEYS.map(([key, label]): SettingDefinitionItem<Key> => ({
				name: t(label),
				control: { type: "toggle", key, defaultValue: DEFAULT_SETTINGS[key] },
			})),
			{
				name: t("settings.penButton"),
				desc: t("settings.penButton.desc"),
				control: { type: "dropdown", key: "penButtonAction", defaultValue: DEFAULT_SETTINGS.penButtonAction, options: penButtonOptions() },
			},
			// Companion notes (O1)
			...companionSettingDefinitions(this.companionHost()),
		];
	}

	private companionHost(): CompanionSettingsHost {
		return { plugin: this.host, get: () => this.host.settings, set: (key, value) => this.setControlValue(key, value) };
	}

	getControlValue(key: string): unknown {
		return this.host.settings[key as Key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		// readSettings drops values of the wrong type and keeps the defaults.
		this.host.settings = readSettings({ ...this.host.settings, [key]: value });
		await this.host.saveSettings();
	}

	/** Fallback for Obsidian older than 1.13, which does not read getSettingDefinitions(). */
	display(): void {
		const { containerEl } = this;
		const s = this.host.settings;
		containerEl.empty();

		new Setting(containerEl)
			.setName(t("settings.folder"))
			.setDesc(t("settings.folder.desc"))
			.addText((text) => text
				.setPlaceholder(DEFAULT_SETTINGS.folder)
				.setValue(s.folder)
				.onChange((v) => this.setControlValue("folder", v)));

		new Setting(containerEl)
			.setName(t("settings.looseSheet"))
			.setDesc(t("settings.looseSheet.desc"))
			.addText((text) => text
				.setPlaceholder(defaultLooseSheetPath(DEFAULT_SETTINGS.folder))
				.setValue(s.looseSheetPath)
				.onChange((v) => this.setControlValue("looseSheetPath", v)));

		new Setting(containerEl)
			.setName(t("settings.defaultPaper"))
			.setDesc(t("settings.defaultPaper.desc"))
			.addDropdown((dd) => dd.addOptions(paperOptions()).setValue(s.defaultPaper).onChange((v) => this.setControlValue("defaultPaper", v)));

		new Setting(containerEl)
			.setName(t("settings.defaultSize"))
			.addDropdown((dd) => dd.addOptions(sizeOptions()).setValue(s.defaultPageSize).onChange((v) => this.setControlValue("defaultPageSize", v)));

		new Setting(containerEl)
			.setName(t("settings.defaultLandscape"))
			.addToggle((tg) => tg.setValue(s.defaultLandscape).onChange((v) => this.setControlValue("defaultLandscape", v)));

		new Setting(containerEl)
			.setName(t("settings.finger"))
			.setDesc(t("settings.finger.desc"))
			.addToggle((toggle) => toggle.setValue(s.fingerDrawing).onChange((v) => this.setControlValue("fingerDrawing", v)));

		new Setting(containerEl)
			.setName(t("settings.palm"))
			.setDesc(t("settings.palm.desc"))
			.addSlider((slider) => slider
				.setLimits(0, 2000, 50)
				.setValue(s.palmRejectionMs)
				.onChange((v) => this.setControlValue("palmRejectionMs", v)));

		new Setting(containerEl)
			.setName(t("settings.pressure"))
			.setDesc(t("settings.pressure.desc"))
			.addDropdown((dd) => dd
				.addOption("auto", t("settings.pressure.auto"))
				.addOption("simulated", t("settings.pressure.simulated"))
				.setValue(s.pressureMode)
				.onChange((v) => this.setControlValue("pressureMode", v)));

		new Setting(containerEl)
			.setName(t("settings.inkPrediction"))
			.setDesc(t("settings.inkPrediction.desc"))
			.addToggle((toggle) => toggle.setValue(s.inkPrediction).onChange((v) => this.setControlValue("inkPrediction", v)));

		new Setting(containerEl)
			.setName(t("settings.lowLatencyInk"))
			.setDesc(t("settings.lowLatencyInk.desc"))
			.addToggle((toggle) => toggle.setValue(s.lowLatencyInk).onChange((v) => this.setControlValue("lowLatencyInk", v)));

		new Setting(containerEl)
			.setName(t("settings.stabilization"))
			.setDesc(t("settings.stabilization.filter.desc"))
			.addSlider((slider) => slider.setLimits(0, 10, 1).setValue(s.stabilization).onChange((v) => this.setControlValue("stabilization", v)));

		new Setting(containerEl)
			.setName(t("settings.palmSize"))
			.setDesc(t("settings.palmSize.desc"))
			.addSlider((slider) => slider.setLimits(0, 120, 5).setValue(s.palmContactPx).onChange((v) => this.setControlValue("palmContactPx", v)));

		new Setting(containerEl)
			.setName(t("settings.perfOverlay"))
			.setDesc(t("settings.perfOverlay.desc"))
			.addToggle((toggle) => toggle.setValue(s.perfOverlay).onChange((v) => this.setControlValue("perfOverlay", v)));

		new Setting(containerEl)
			.setName(t("settings.snapshotInterval"))
			.setDesc(t("settings.snapshotInterval.desc"))
			.addSlider((slider) => slider.setLimits(0, 168, 1).setValue(s.snapshotIntervalHours).onChange((v) => this.setControlValue("snapshotIntervalHours", v)));

		new Setting(containerEl)
			.setName(t("settings.snapshotKeep"))
			.setDesc(t("settings.snapshotKeep.desc"))
			.addSlider((slider) => slider.setLimits(1, 50, 1).setValue(s.snapshotsToKeep).onChange((v) => this.setControlValue("snapshotsToKeep", v)));

		new Setting(containerEl)
			.setName(t("settings.autoNextPage"))
			.setDesc(t("settings.autoNextPage.desc"))
			.addToggle((toggle) => toggle.setValue(s.autoNextPage).onChange((v) => this.setControlValue("autoNextPage", v)));

		new Setting(containerEl)
			.setName(t("settings.eraseAreaElements"))
			.setDesc(t("settings.eraseAreaElements.desc"))
			.addToggle((toggle) => toggle.setValue(s.eraseAreaElements).onChange((v) => this.setControlValue("eraseAreaElements", v)));
		// wave p1a: input
		new Setting(containerEl)
			.setName(t("settings.edge"))
			.setDesc(t("settings.edge.desc"))
			.addToggle((toggle) => toggle.setValue(s.edgeRejection).onChange((v) => this.setControlValue("edgeRejection", v)));

		new Setting(containerEl)
			.setName(t("settings.edgePx"))
			.setDesc(t("settings.edgePx.desc"))
			.addSlider((slider) => slider.setLimits(EDGE_WIDTH_MIN, EDGE_WIDTH_MAX, 2).setValue(s.edgeRejectionPx).onChange((v) => this.setControlValue("edgeRejectionPx", v)));

		for (const [key, label] of EDGE_KEYS) {
			new Setting(containerEl)
				.setName(t(label))
				.addToggle((toggle) => toggle.setValue(s[key]).onChange((v) => this.setControlValue(key, v)));
		}

		new Setting(containerEl)
			.setName(t("settings.penButton"))
			.setDesc(t("settings.penButton.desc"))
			.addDropdown((dd) => dd.addOptions(penButtonOptions()).setValue(s.penButtonAction).onChange((v) => this.setControlValue("penButtonAction", v)));
		displayCompanionSettings(containerEl, this.companionHost());
		displayTimetableSettings(containerEl, this.host);
	}
}
