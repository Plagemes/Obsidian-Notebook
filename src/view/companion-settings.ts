import { Setting, type Plugin, type SettingDefinitionItem } from "obsidian";
import { t } from "../i18n";
import { companionService } from "../integration/companion";
import { DEFAULT_COMPANION_SETTINGS, NAME_TOKEN, type CompanionSettings } from "../storage/companion-path";

/** What the settings tab gives the companion settings: current values and a setter (validated by readSettings). */
export interface CompanionSettingsHost {
	plugin: Plugin;
	get(): CompanionSettings;
	set(key: keyof CompanionSettings, value: unknown): Promise<void>;
}

const locationOptions = () => ({ beside: t("settings.companionLocation.beside"), folder: t("settings.companionLocation.folder") });

const updateAll = (host: CompanionSettingsHost) => void companionService(host.plugin)?.updateAll();

/** Declarative definitions (Obsidian 1.13+), appended to the plugin's list. */
export function companionSettingDefinitions(host: CompanionSettingsHost): SettingDefinitionItem<keyof CompanionSettings>[] {
	return [
		{
			name: t("settings.companion"),
			desc: t("settings.companion.desc"),
			control: { type: "toggle", key: "companionNotes", defaultValue: DEFAULT_COMPANION_SETTINGS.companionNotes },
		},
		{
			name: t("settings.companionLocation"),
			control: { type: "dropdown", key: "companionLocation", defaultValue: DEFAULT_COMPANION_SETTINGS.companionLocation, options: locationOptions() },
		},
		{
			name: t("settings.companionFolder"),
			desc: t("settings.companionFolder.desc"),
			control: { type: "folder", key: "companionFolder", defaultValue: DEFAULT_COMPANION_SETTINGS.companionFolder, placeholder: DEFAULT_COMPANION_SETTINGS.companionFolder },
		},
		{
			name: t("settings.companionName"),
			desc: t("settings.companionName.desc"),
			control: { type: "text", key: "companionName", defaultValue: DEFAULT_COMPANION_SETTINGS.companionName, placeholder: NAME_TOKEN },
		},
		{
			name: t("settings.companionUpdateAll"),
			desc: t("settings.companionUpdateAll.desc"),
			action: () => updateAll(host),
		},
	];
}

/** Fallback for Obsidian older than 1.13 (classic settings tab). */
export function displayCompanionSettings(containerEl: HTMLElement, host: CompanionSettingsHost): void {
	const s = host.get();
	new Setting(containerEl)
		.setName(t("settings.companion"))
		.setDesc(t("settings.companion.desc"))
		.addToggle((tg) => tg.setValue(s.companionNotes).onChange((v) => host.set("companionNotes", v)));
	new Setting(containerEl)
		.setName(t("settings.companionLocation"))
		.addDropdown((dd) => dd.addOptions(locationOptions()).setValue(s.companionLocation).onChange((v) => host.set("companionLocation", v)));
	new Setting(containerEl)
		.setName(t("settings.companionFolder"))
		.setDesc(t("settings.companionFolder.desc"))
		.addText((text) => text.setPlaceholder(DEFAULT_COMPANION_SETTINGS.companionFolder).setValue(s.companionFolder).onChange((v) => host.set("companionFolder", v)));
	new Setting(containerEl)
		.setName(t("settings.companionName"))
		.setDesc(t("settings.companionName.desc"))
		.addText((text) => text.setPlaceholder(NAME_TOKEN).setValue(s.companionName).onChange((v) => host.set("companionName", v)));
	new Setting(containerEl)
		.setName(t("settings.companionUpdateAll"))
		.setDesc(t("settings.companionUpdateAll.desc"))
		.addButton((b) => b.setButtonText(t("settings.companionUpdateAll.button")).onClick(() => updateAll(host)));
}
