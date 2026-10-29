import { Setting, type SettingDefinitionItem } from "obsidian";
import { t } from "../i18n";
import { DEFAULT_TRASH_SETTINGS, TRASH_RETENTION_MAX_DAYS, type TrashSettings } from "../storage/trash-settings";

/** What the settings tab gives these settings: current values and a setter (validated by readSettings). */
export interface TrashSettingsHost {
	get(): TrashSettings;
	set(key: keyof TrashSettings, value: unknown): Promise<void>;
}

/** Declarative definitions (Obsidian 1.13+), appended to the plugin's list. */
export function trashSettingDefinitions(): SettingDefinitionItem<keyof TrashSettings>[] {
	return [
		{
			name: t("settings.trashRetention"),
			desc: t("settings.trashRetention.desc"),
			control: {
				type: "slider", key: "trashRetentionDays", defaultValue: DEFAULT_TRASH_SETTINGS.trashRetentionDays,
				min: 0, max: TRASH_RETENTION_MAX_DAYS, step: 1, displayFormat: (v) => (v === 0 ? "off" : `${v} d`),
			},
		},
		{
			name: t("settings.templatesFolder"),
			desc: t("settings.templatesFolder.desc"),
			control: { type: "folder", key: "templatesFolder", defaultValue: DEFAULT_TRASH_SETTINGS.templatesFolder, placeholder: "_templates" },
		},
	];
}

/** Fallback for Obsidian older than 1.13 (classic settings tab). */
export function displayTrashSettings(containerEl: HTMLElement, host: TrashSettingsHost): void {
	const s = host.get();
	new Setting(containerEl)
		.setName(t("settings.trashRetention"))
		.setDesc(t("settings.trashRetention.desc"))
		.addSlider((slider) => slider.setLimits(0, TRASH_RETENTION_MAX_DAYS, 1).setValue(s.trashRetentionDays).onChange((v) => host.set("trashRetentionDays", v)));
	new Setting(containerEl)
		.setName(t("settings.templatesFolder"))
		.setDesc(t("settings.templatesFolder.desc"))
		.addText((text) => text.setPlaceholder("_templates").setValue(s.templatesFolder).onChange((v) => host.set("templatesFolder", v)));
}
