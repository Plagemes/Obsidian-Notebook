import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { actionById } from "../src/ui/actions";
import { en } from "../src/i18n/en";
import { it as itMessages } from "../src/i18n/it";

describe("hook clean-up wiring (#314)", () => {
	it("the setting is off by default and read leniently", () => {
		expect(DEFAULT_SETTINGS.trimHooks).toBe(false);
		expect(readSettings({ trimHooks: true }).trimHooks).toBe(true);
		expect(readSettings({ trimHooks: "yes" }).trimHooks).toBe(false);
		expect(readSettings({}).trimHooks).toBe(false);
	});

	it("the action is in the selection bar for ink only, and has its command and texts in both languages", () => {
		const a = actionById("selection-cleanup")!;
		expect(a).toBeDefined();
		expect(a.surfaces).toContain("context");
		expect(a.contexts).toContain("selection");
		expect(a.command).toBe("command.cleanUp");
		for (const key of ["cleanup.action", "command.cleanUp", "cleanup.done", "cleanup.nothing", "settings.trimHooks", "settings.trimHooks.desc"] as const) {
			expect(en[key], key).toBeTruthy();
			expect(itMessages[key], key).toBeTruthy();
		}
		expect(en["cleanup.done"]).toContain("{hooks}");
		expect(en["cleanup.done"]).toContain("{dots}");
		expect(itMessages["cleanup.done"]).toContain("{hooks}");
		expect(itMessages["cleanup.done"]).toContain("{dots}");
	});
});
