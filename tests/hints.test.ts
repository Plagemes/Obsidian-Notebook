import { describe, expect, it } from "vitest";
import { en } from "../src/i18n/en";
import { it as itMessages } from "../src/i18n/it";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { HINT_GAP_MS, HINT_IDS, HINTS, HintEngine, isHintId, normaliseSeen } from "../src/ui/hint-logic";

function engine(over: { enabled?: boolean; writing?: boolean } = {}, seen: Parameters<typeof normaliseSeen>[0] = []) {
	const clock = { t: 1_000_000 };
	const flags = { enabled: over.enabled ?? true, writing: over.writing ?? false };
	const e = new HintEngine({ now: () => clock.t, enabled: () => flags.enabled, isWriting: () => flags.writing }, normaliseSeen(seen));
	return { e, clock, flags };
}

describe("hint registry", () => {
	it("defines each id once with existing English and Italian texts", () => {
		expect(HINTS.map((h) => h.id)).toEqual([...HINT_IDS]);
		for (const h of HINTS) {
			expect(h.title in en && h.body in en, h.id).toBe(true);
			expect(h.title in itMessages && h.body in itMessages, h.id).toBe(true);
		}
		expect(HINT_IDS.length).toBeGreaterThanOrEqual(5);
	});
});

describe("hint engine", () => {
	it("shows a hint once, then never again", () => {
		const { e, clock } = engine();
		expect(e.decide("lasso-selected")).toBe("show");
		e.shown("lasso-selected");
		clock.t += HINT_GAP_MS * 10;
		expect(e.decide("lasso-selected")).toBe("seen");
	});

	it("allows at most one hint per gap", () => {
		const { e, clock } = engine();
		e.shown("pen-detected");
		expect(e.decide("lasso-selected")).toBe("rate-limited");
		clock.t += HINT_GAP_MS - 1;
		expect(e.decide("lasso-selected")).toBe("rate-limited");
		clock.t += 1;
		expect(e.decide("lasso-selected")).toBe("show");
	});

	it("does not mark a rate-limited hint as seen", () => {
		const { e, clock } = engine();
		e.shown("pen-detected");
		expect(e.decide("palm-blocked")).toBe("rate-limited");
		clock.t += HINT_GAP_MS;
		expect(e.decide("palm-blocked")).toBe("show");
	});

	it("waits while writing and when tips are off", () => {
		const { e, flags } = engine({ writing: true });
		expect(e.decide("inbox-item")).toBe("writing");
		flags.writing = false;
		expect(e.decide("inbox-item")).toBe("show");
		flags.enabled = false;
		expect(e.decide("inbox-item")).toBe("disabled");
	});

	it("ignores unknown ids", () => {
		expect(engine().e.decide("nope")).toBe("unknown");
	});

	it("starts from stored seen ids and reset brings every hint back", () => {
		const { e } = engine({}, ["pdf-imported", "bogus", "pdf-imported"]);
		expect(e.seen).toEqual(["pdf-imported"]);
		expect(e.decide("pdf-imported")).toBe("seen");
		e.shown("lasso-selected");
		e.reset();
		expect(e.seen).toEqual([]);
		expect(e.decide("pdf-imported")).toBe("show");
	});
});

describe("hint settings", () => {
	it("defaults to tips on and nothing seen", () => {
		expect(DEFAULT_SETTINGS.hintsEnabled).toBe(true);
		expect(DEFAULT_SETTINGS.hintsSeen).toEqual([]);
	});

	it("reads stored values and drops bad ones", () => {
		const s = readSettings({ hintsEnabled: false, hintsSeen: ["pen-detected", 3, "gone"] });
		expect(s.hintsEnabled).toBe(false);
		expect(s.hintsSeen).toEqual(["pen-detected"]);
		expect(readSettings({ hintsEnabled: "yes", hintsSeen: "x" }).hintsEnabled).toBe(true);
		expect(readSettings({ hintsSeen: "x" }).hintsSeen).toEqual([]);
		expect(isHintId("lasso-selected")).toBe(true);
	});
});
