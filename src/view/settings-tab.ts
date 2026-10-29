import { PluginSettingTab, Setting, type App, type Plugin, type SettingDefinitionItem } from "obsidian";
import { t } from "../i18n";
import { DEFAULT_SETTINGS, readSettings, type NotebookSettings } from "../settings";

export interface SettingsHost extends Plugin {
	settings: NotebookSettings;
	saveSettings(): Promise<void>;
}

type Key = keyof NotebookSettings;

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
				name: t("settings.prediction"),
				desc: t("settings.prediction.desc"),
				control: { type: "toggle", key: "prediction", defaultValue: DEFAULT_SETTINGS.prediction },
			},
		];
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
			.setName(t("settings.prediction"))
			.setDesc(t("settings.prediction.desc"))
			.addToggle((toggle) => toggle.setValue(s.prediction).onChange((v) => this.setControlValue("prediction", v)));
	}
}
