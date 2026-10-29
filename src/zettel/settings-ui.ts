import { Setting, type Plugin, type SettingDefinitionItem } from "obsidian";
import { t } from "../i18n";
import { zettelService } from "./index";
import { DEFAULT_ZETTEL_SETTINGS, type ZettelSettings } from "./settings";

/** What the settings tab gives the Zettelkasten settings: current values and a setter (validated by readSettings). */
export interface ZettelSettingsHost {
	plugin: Plugin;
	get(): ZettelSettings;
	set(key: keyof ZettelSettings, value: unknown): Promise<void>;
}

const schemeOptions = () => ({ timestamp: t("settings.zettelIdScheme.timestamp"), luhmann: t("settings.zettelIdScheme.luhmann") });

/** Saves a value and redraws the card regions (the overlay reads the settings when it draws). */
async function setAndRefresh(host: ZettelSettingsHost, key: keyof ZettelSettings, value: unknown): Promise<void> {
	await host.set(key, value);
	zettelService(host.plugin)?.refreshOverlays();
}

/** Declarative definitions (Obsidian 1.13+), appended to the plugin's list. */
export function zettelSettingDefinitions(host: ZettelSettingsHost): SettingDefinitionItem<keyof ZettelSettings>[] {
	return [
		{
			name: t("settings.zettelFolder"),
			desc: t("settings.zettelFolder.desc"),
			control: { type: "folder", key: "zettelFolder", defaultValue: DEFAULT_ZETTEL_SETTINGS.zettelFolder, placeholder: DEFAULT_ZETTEL_SETTINGS.zettelFolder },
		},
		{
			name: t("settings.zettelIdScheme"),
			desc: t("settings.zettelIdScheme.desc"),
			control: { type: "dropdown", key: "zettelIdScheme", defaultValue: DEFAULT_ZETTEL_SETTINGS.zettelIdScheme, options: schemeOptions() },
		},
		{
			name: t("settings.zettelShowRegions"),
			desc: t("settings.zettelShowRegions.desc"),
			control: { type: "toggle", key: "zettelShowRegions", defaultValue: DEFAULT_ZETTEL_SETTINGS.zettelShowRegions },
		},
	];
}

/** Fallback for Obsidian older than 1.13 (classic settings tab). */
export function displayZettelSettings(containerEl: HTMLElement, host: ZettelSettingsHost): void {
	const s = host.get();
	new Setting(containerEl).setName(t("settings.zettel")).setHeading();
	new Setting(containerEl)
		.setName(t("settings.zettelFolder"))
		.setDesc(t("settings.zettelFolder.desc"))
		.addText((text) => text.setPlaceholder(DEFAULT_ZETTEL_SETTINGS.zettelFolder).setValue(s.zettelFolder).onChange((v) => host.set("zettelFolder", v)));
	new Setting(containerEl)
		.setName(t("settings.zettelIdScheme"))
		.setDesc(t("settings.zettelIdScheme.desc"))
		.addDropdown((dd) => dd.addOptions(schemeOptions()).setValue(s.zettelIdScheme).onChange((v) => host.set("zettelIdScheme", v)));
	new Setting(containerEl)
		.setName(t("settings.zettelShowRegions"))
		.setDesc(t("settings.zettelShowRegions.desc"))
		.addToggle((tg) => tg.setValue(s.zettelShowRegions).onChange((v) => setAndRefresh(host, "zettelShowRegions", v)));
}
