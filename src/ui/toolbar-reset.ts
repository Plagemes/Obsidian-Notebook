// 0.14 generative UI (393): "Reset the adaptive toolbar" (settings). Forgets the learned use counts of this device and
// unpins every quick action; the three adaptive switches stay as the person set them.
import { t } from "../i18n";
import { showNotice } from "../view/notice";
import type { NotebookSettings } from "../settings";
import { clearStoredUsage, type LocalStore } from "./usage-store";

export function resetToolbarAdaptation(app: LocalStore, host: { settings: NotebookSettings; saveSettings(): Promise<void> }): void {
	clearStoredUsage(app);
	host.settings.pinnedQuick = [];
	void host.saveSettings().catch((e) => console.error("[notebook] saving settings failed", e));
	showNotice(t("settings.toolbarReset.done"));
}
