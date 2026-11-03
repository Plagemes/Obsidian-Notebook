import { describe, expect, it } from "vitest";
import { classifyViewport, sameViewport, viewportClasses, viewportKey, ViewportTracker } from "../src/ui/viewport-class";
import { splitOrientation } from "../src/pdf/sync-layout";

const key = (w: number, h: number, coarse = true) => viewportKey(classifyViewport(w, h, null, { coarse }));

describe("classifyViewport", () => {
	it("recognises the reference devices", () => {
		expect(key(412, 915)).toBe("phone-portrait");
		expect(key(360, 740)).toBe("phone-portrait");
		expect(key(740, 360)).toBe("phone-landscape-short");
		expect(key(800, 1280)).toBe("tablet-portrait");
		expect(key(1280, 800)).toBe("tablet-landscape");
		expect(key(1280, 800, false)).toBe("desktop-landscape");
		expect(key(1448, 1086, false)).toBe("desktop-landscape");
		expect(key(1448, 1086)).toBe("tablet-landscape");
	});

	it("marks a tablet with little height as short landscape", () => {
		expect(key(1280, 400)).toBe("tablet-landscape-short");
		expect(key(400, 1280)).toBe("phone-portrait");
	});

	it("a narrow Obsidian pane on a desktop is a phone-sized view", () => {
		expect(key(420, 900, false)).toBe("phone-portrait");
	});

	it("keeps the previous class inside the hysteresis band", () => {
		const phone = classifyViewport(500, 900, null, { coarse: true });
		expect(phone.size).toBe("phone");
		expect(classifyViewport(530, 900, phone, { coarse: true }).size).toBe("phone");
		expect(classifyViewport(560, 900, phone, { coarse: true }).size).toBe("tablet");
		const tablet = classifyViewport(560, 900, null, { coarse: true });
		expect(classifyViewport(510, 900, tablet, { coarse: true }).size).toBe("phone");
		expect(classifyViewport(530, 900, tablet, { coarse: true }).size).toBe("tablet");
	});

	it("does not flip orientation on a nearly square view", () => {
		const land = classifyViewport(1000, 800, null);
		expect(land.orientation).toBe("landscape");
		expect(classifyViewport(900, 920, land).orientation).toBe("landscape");
		expect(classifyViewport(800, 1000, land).orientation).toBe("portrait");
		const port = classifyViewport(800, 1000, null);
		expect(classifyViewport(930, 900, port).orientation).toBe("portrait");
		expect(classifyViewport(1000, 800, port).orientation).toBe("landscape");
	});

	it("short height is sticky", () => {
		const short = classifyViewport(900, 470, null, { coarse: true });
		expect(short.shortHeight).toBe(true);
		expect(classifyViewport(900, 500, short, { coarse: true }).shortHeight).toBe(true);
		expect(classifyViewport(900, 530, short, { coarse: true }).shortHeight).toBe(false);
		expect(classifyViewport(900, 500, null, { coarse: true }).shortHeight).toBe(false);
	});

	it("a portrait view is never short", () => {
		expect(classifyViewport(300, 400, null).shortHeight).toBe(false);
	});

	it("ignores a view without size", () => {
		const prev = classifyViewport(800, 1280, null, { coarse: true });
		expect(classifyViewport(0, 0, prev)).toBe(prev);
	});

	it("names the classes", () => {
		expect(viewportClasses({ size: "phone", orientation: "landscape", shortHeight: true })).toEqual(["nb-vp-phone", "nb-vp-landscape", "nb-vp-short"]);
		expect(viewportClasses({ size: "tablet", orientation: "portrait", shortHeight: false })).toEqual(["nb-vp-tablet", "nb-vp-portrait"]);
	});
});

describe("ViewportTracker", () => {
	it("reports only changes", () => {
		const t = new ViewportTracker(() => ({ coarse: true }));
		const first = t.update(800, 1280);
		expect(first && viewportKey(first)).toBe("tablet-portrait");
		expect(t.update(801, 1280)).toBeNull();
		expect(t.update(0, 0)).toBeNull();
		const rotated = t.update(1280, 800);
		expect(rotated && viewportKey(rotated)).toBe("tablet-landscape");
		expect(sameViewport(t.current, rotated)).toBe(true);
	});

	it("does not flicker while a split is dragged across the phone threshold", () => {
		const t = new ViewportTracker(() => ({ coarse: true }));
		t.update(520, 900);
		let changes = 0;
		for (const w of [530, 545, 535, 548, 540, 525, 545]) if (t.update(w, 900)) changes++;
		expect(changes).toBe(0);
	});
});

describe("splitOrientation hysteresis", () => {
	it("keeps the side-by-side split a little below the entry width", () => {
		expect(splitOrientation(690, 600)).toBe("column");
		expect(splitOrientation(690, 600, "row")).toBe("row");
		expect(splitOrientation(600, 500, "row")).toBe("column");
		expect(splitOrientation(740, 360)).toBe("row");
	});
});
