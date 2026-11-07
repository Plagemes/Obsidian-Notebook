import type { ButtonComponent, Setting } from "obsidian";
import { t } from "../i18n";
import type { BackupService } from "../storage/backup-service";

/**
 * 0.21 (#127): the "Back up now" row of the settings tab. The description is the status line (last backup time and result, next
 * due time); it follows the service while a run is in progress. Returns the way to stop following it (the tab calls it when it
 * is closed or redrawn).
 */
export function renderBackupRow(setting: Setting, service: BackupService): () => void {
	let button: ButtonComponent | null = null;
	const update = (): void => {
		setting.setDesc(service.statusText());
		button?.setDisabled(service.running());
		button?.setButtonText(service.running() ? t("backup.status.running") : t("settings.backupNow.button"));
	};
	setting.addButton((b) => {
		button = b;
		b.setCta().onClick(() => void service.backUpNow());
	});
	update();
	return service.onChange(update);
}
