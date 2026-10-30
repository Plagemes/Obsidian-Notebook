import { Setting } from "obsidian";
import { t } from "../i18n";
import type { NotebookSettings } from "../settings";
import type { TimetableService } from "./service";

export interface TimetableSettingsHost {
	settings: NotebookSettings;
	saveSettings(): Promise<void>;
	timetable?: TimetableService;
}

/** "Class timetable" part of the settings tab: the editor button and the three behaviour settings. */
export function displayTimetableSettings(containerEl: HTMLElement, host: TimetableSettingsHost): void {
	const s = host.settings;
	const service = host.timetable;
	new Setting(containerEl).setName(t("settings.timetable")).setHeading();
	new Setting(containerEl)
		.setName(t("settings.timetable.edit"))
		.setDesc(t("settings.timetable.desc", { path: service?.path() ?? "_timetable.json" }))
		.addButton((b) => b.setButtonText(t("settings.timetable.edit")).setCta().onClick(() => void service?.edit()));
	new Setting(containerEl)
		.setName(t("settings.timetable.offer"))
		.setDesc(t("settings.timetable.offer.desc"))
		.addToggle((toggle) => toggle.setValue(s.timetableOffer).onChange((v) => {
			s.timetableOffer = v;
			void host.saveSettings();
		}));
	new Setting(containerEl)
		.setName(t("settings.timetable.auto"))
		.setDesc(t("settings.timetable.auto.desc"))
		.addToggle((toggle) => toggle.setValue(s.timetableAutoOpen).onChange((v) => {
			s.timetableAutoOpen = v;
			void host.saveSettings();
		}));
	new Setting(containerEl)
		.setName(t("settings.timetable.lead"))
		.addSlider((slider) => slider.setLimits(0, 30, 1).setValue(s.timetableLeadMinutes).onChange((v) => {
			s.timetableLeadMinutes = v;
			void host.saveSettings();
		}));
}
