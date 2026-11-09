import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ getLanguage: () => "en" }));

const { setUiLanguage } = await import("../src/i18n");
const { macroNotice } = await import("../src/ui/macro-notice");

// The closing notice of a macro run (review fix R6): singular / plural, skipped steps, the other reasons.
const m = { id: "a", name: "Maths", icon: "zap", steps: [{ action: "page-paper", value: "grid" }, { action: "tool-pen" }] };
const name = (s: { action: string }) => s.action;

describe("the closing notice (R6)", () => {
	afterEach(() => setUiLanguage("en"));

	it("says '1 step' for one step and 'n steps' for more, in English and Italian", () => {
		setUiLanguage("en");
		expect(macroNotice(m, { ok: true, ran: 0, skipped: 0, noEffect: 1 }, name)).toBe("Maths: nothing changed (1 step had no effect).");
		expect(macroNotice(m, { ok: true, ran: 0, skipped: 0, noEffect: 3 }, name)).toBe("Maths: nothing changed (3 steps had no effect).");
		expect(macroNotice(m, { ok: true, ran: 2, skipped: 0, noEffect: 1 }, name)).toContain("1 step changed nothing.");
		expect(macroNotice(m, { ok: true, ran: 2, skipped: 0, noEffect: 2 }, name)).toContain("2 steps changed nothing.");
		setUiLanguage("it");
		expect(macroNotice(m, { ok: true, ran: 0, skipped: 0, noEffect: 1 }, name)).toBe("Maths: non è cambiato nulla (1 passaggio senza effetto).");
		expect(macroNotice(m, { ok: true, ran: 0, skipped: 0, noEffect: 2 }, name)).toBe("Maths: non è cambiato nulla (2 passaggi senza effetto).");
		expect(macroNotice(m, { ok: true, ran: 1, skipped: 0, noEffect: 1 }, name)).toContain("1 passaggio non ha cambiato nulla.");
	});

	it("still says how many steps were skipped when nothing changed", () => {
		setUiLanguage("en");
		expect(macroNotice(m, { ok: true, ran: 0, skipped: 2, noEffect: 1 }, name)).toBe("Maths: nothing changed (1 step had no effect). 2 skipped (not available).");
		setUiLanguage("it");
		expect(macroNotice(m, { ok: true, ran: 0, skipped: 2, noEffect: 2 }, name)).toBe("Maths: non è cambiato nulla (2 passaggi senza effetto). 2 saltati (non disponibili).");
	});

	it("names the step that stopped the run and the other reasons", () => {
		setUiLanguage("en");
		expect(macroNotice(m, { ok: false, reason: "refused", step: 0, action: "page-paper", done: 0, skipped: 0 }, name)).toContain("stopped at step 1 (page-paper)");
		expect(macroNotice(m, { ok: false, reason: "writing" }, name)).toContain("Lift the pen");
		expect(macroNotice(m, { ok: false, reason: "empty" }, name)).toContain("no step that can run");
	});
});
