/**
 * 0.12.3: Settings → Diagnostics → Device info. The lines a bug report needs: the WebView's Chrome version (from the user
 * agent), Obsidian's API version, the platform flags, the screen and whether the art engine had to switch itself off.
 * Read-only; "Copy" puts them on the clipboard. Nothing is sent anywhere (CLAUDE.md rule 5).
 */
import { apiVersion, Platform, type Setting } from "obsidian";
import { t } from "../i18n";
import { artFailures } from "../ui/art/generative-art";
import { showNotice } from "./notice";

export interface DeviceFacts {
	userAgent: string;
	apiVersion: string;
	flags: Record<string, boolean>;
	screen: { width: number; height: number; dpr: number };
	art: { count: number; last: string; off: boolean };
}

/** The Chrome (or Android System WebView) version in a user agent, or null. */
export function chromeVersion(userAgent: string): string | null {
	return /\b(?:Chrome|Chromium|CriOS)\/(\d+(?:\.\d+)*)/.exec(userAgent)?.[1] ?? null;
}

/** The report lines, in English (they go into bug reports as they are). */
export function deviceInfoLines(f: DeviceFacts): string[] {
	const on = Object.entries(f.flags).filter(([, v]) => v).map(([k]) => k);
	const art = f.art.count === 0 ? "ok" : `${f.art.off ? "off" : "on"} after ${f.art.count} failure(s): ${f.art.last}`;
	return [
		`WebView: Chrome ${chromeVersion(f.userAgent) ?? "unknown"}`,
		`Obsidian API: ${f.apiVersion || "unknown"}`,
		`Platform: ${on.join(", ") || "none"}`,
		`Screen: ${f.screen.width}×${f.screen.height} @${f.screen.dpr}x`,
		`Art engine: ${art}`,
		`User agent: ${f.userAgent}`,
	];
}

function facts(): DeviceFacts {
	const w = activeWindow;
	return {
		userAgent: w.navigator.userAgent,
		apiVersion: typeof apiVersion === "string" ? apiVersion : "",
		flags: {
			isMobile: Platform.isMobile, isMobileApp: Platform.isMobileApp, isAndroidApp: Platform.isAndroidApp, isIosApp: Platform.isIosApp,
			isTablet: Platform.isTablet, isPhone: Platform.isPhone, isDesktop: Platform.isDesktop, isDesktopApp: Platform.isDesktopApp,
		},
		screen: { width: w.innerWidth, height: w.innerHeight, dpr: Math.round((w.devicePixelRatio || 1) * 100) / 100 },
		art: artFailures(),
	};
}

/** Draws the row: the lines under its name, and a Copy button. */
export function renderDeviceInfo(setting: Setting): void {
	const text = deviceInfoLines(facts()).join("\n");
	setting.descEl.createDiv({ cls: "notebook-settings-device-info", text });
	setting.addButton((b) => {
		b.setButtonText(t("settings.deviceInfo.copy"));
		b.onClick(() => {
			void activeWindow.navigator.clipboard.writeText(text).then(() => showNotice(t("settings.deviceInfo.copied")), (e: unknown) => console.error("[notebook] device info could not be copied", e));
		});
	});
}
