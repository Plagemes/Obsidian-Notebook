import { PluginSettingTab, Setting, type App, type Plugin } from "obsidian";
import { t } from "../i18n";
import { DEFAULT_SETTINGS, type NotebookSettings } from "../settings";

export interface SettingsHost extends Plugin {
	settings: NotebookSettings;
	saveSettings(): Promise<void>;
}

export class NotebookSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly host: SettingsHost) {
		super(app, host);
	}

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
				.onChange(async (v) => {
					s.folder = v.trim() || DEFAULT_SETTINGS.folder;
					await this.host.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t("settings.finger"))
			.setDesc(t("settings.finger.desc"))
			.addToggle((toggle) => toggle.setValue(s.fingerDrawing).onChange(async (v) => {
				s.fingerDrawing = v;
				await this.host.saveSettings();
			}));

		new Setting(containerEl)
			.setName(t("settings.palm"))
			.setDesc(t("settings.palm.desc"))
			.addSlider((slider) => slider
				.setLimits(0, 2000, 50)
				.setValue(s.palmRejectionMs)
				.setDynamicTooltip()
				.onChange(async (v) => {
					s.palmRejectionMs = v;
					await this.host.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t("settings.pressure"))
			.setDesc(t("settings.pressure.desc"))
			.addDropdown((dd) => dd
				.addOption("auto", t("settings.pressure.auto"))
				.addOption("simulated", t("settings.pressure.simulated"))
				.setValue(s.pressureMode)
				.onChange(async (v) => {
					s.pressureMode = v === "simulated" ? "simulated" : "auto";
					await this.host.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t("settings.prediction"))
			.setDesc(t("settings.prediction.desc"))
			.addToggle((toggle) => toggle.setValue(s.prediction).onChange(async (v) => {
				s.prediction = v;
				await this.host.saveSettings();
			}));
	}
}
