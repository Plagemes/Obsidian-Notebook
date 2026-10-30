import { describe, expect, it } from "vitest";
import roadmapMd from "../docs/roadmap.md?raw";
import changelogMd from "../CHANGELOG.md?raw";
import { buildRoadmap, changelogReleases, EARLY, parseIdList, parseRoadmap } from "../scripts/roadmap-data.mjs";

const ROADMAP = `# Roadmap

## M7 — Additional features (backlog)

### Writing and tools
1. **P1** 🧪 Favourite pens: 4–6 saved presets.
2. **P2** 🚧 Side button: hold for eraser.
3. **P3** Plain idea (e.g. a thing). More text.
4. ~~**P2** Dropped idea.~~ — dropped (user decision)
5. ~~**P1** Flashcards from the lasso.~~ — moved to the "Study and exam update"
9999. **P1** 🧪 Old but unlisted.

## M10 — Native Obsidian integration (backlog)

- **O1 P1** 🧪 Companion note: a \`.md\` per notebook.
- ~~**O2 P1** Theme integration.~~ — dropped

## M5 — AI and academic features — ⏳ (only after M1–M3 are stable)

7. **P2** OCR of handwriting.
`;

const CHANGELOG = `# Changelog

## Unreleased

- Not a release (roadmap 3).

## 0.12.0 — 2026-10-30

- A thing (roadmap 2, 3).

## 0.11.0 — 2026-10-29

- Another (roadmap 3 and 3, M7 1; roadmap O1).
`;

const AT = "2026-10-30T12:00:00.000Z";

describe("roadmap data", () => {
	it("parses numbered and lettered ids with priority, milestone, area and status", () => {
		const rows = parseRoadmap(ROADMAP);
		expect(rows.map((r) => r.id)).toEqual(["1", "2", "3", "4", "5", "9999", "O1", "O2", "7"]);
		const by = Object.fromEntries(rows.map((r) => [r.id, r]));
		expect(by["1"]).toMatchObject({ title: "Favourite pens", priority: "P1", milestone: "M7", milestoneTitle: "Additional features", area: "Writing and tools", status: "done" });
		expect(by["2"]?.status).toBe("progress");
		expect(by["3"]).toMatchObject({ status: "todo", title: "Plain idea (e.g. a thing)" });
		expect(by["4"]?.status).toBe("dropped");
		expect(by["5"]?.status).toBe("deferred");
		expect(by["O1"]).toMatchObject({ milestone: "M10", area: "Native Obsidian integration", status: "done" });
		expect(by["O2"]?.status).toBe("dropped");
		expect(by["7"]).toMatchObject({ milestone: "M5", status: "deferred" });
	});

	it("takes the release from the oldest CHANGELOG mention, then the release sets, then the early bucket", () => {
		const released = changelogReleases(CHANGELOG);
		expect(released.get("3")).toBe("0.11.0");
		expect(released.get("2")).toBe("0.12.0");
		expect(released.get("1")).toBe("0.11.0");
		expect(released.get("O1")).toBe("0.11.0");
		const by = Object.fromEntries(parseRoadmap(ROADMAP, { released }).map((r) => [r.id, r]));
		expect(by["1"]?.release).toBe("0.11.0");
		expect(by["O1"]?.release).toBe("0.11.0");
		expect(by["9999"]?.release).toBe(EARLY);
		// Release sets: item 22 is in the 0.4.0 set, 105 in the 0.11.0 set.
		const sets = parseRoadmap("## M7 — X\n22. **P1** 🧪 A\n105. **P1** 🧪 B\n").map((r) => r.release);
		expect(sets).toEqual(["0.4.0", "0.11.0"]);
	});

	it("marks ids from an in-progress list and carries the wave label", () => {
		const rows = parseRoadmap(ROADMAP, { inProgress: parseIdList("# wave\n3, O1\n"), wave: "0.13.0" });
		const by = Object.fromEntries(rows.map((r) => [r.id, r]));
		expect(by["3"]).toMatchObject({ status: "progress", release: "0.13.0" });
		expect(by["O1"]?.status).toBe("progress");
	});

	it("is deterministic and its counts add up", () => {
		const input = { roadmap: ROADMAP, changelog: CHANGELOG, generatedAt: AT };
		const a = JSON.stringify(buildRoadmap(input));
		expect(JSON.stringify(buildRoadmap(input))).toBe(a);
		const data = buildRoadmap(input);
		expect(data.generatedAt).toBe(AT);
		expect(data.latestRelease).toBe("0.12.0");
		expect(data.counts).toEqual({ total: 9, done: 3, progress: 1, todo: 1, deferred: 2, dropped: 2 });
		expect(data.milestones.map((m) => m.id)).toEqual(["M7", "M10", "M5"]);
	});

	it("rejects a duplicate id", () => {
		expect(() => buildRoadmap({ roadmap: "## M7 — X\n1. **P1** A\n1. **P2** B\n", changelog: "", generatedAt: AT })).toThrow(/duplicate id 1/);
	});

	it("parses the real roadmap: unique ids, every status accounted for, 🧪 items all have a release", () => {
		const data = buildRoadmap({
			roadmap: roadmapMd,
			changelog: changelogMd,
			generatedAt: AT,
		});
		const c = data.counts;
		expect(c.total).toBeGreaterThan(400);
		expect(c.done + c.progress + c.todo + c.deferred + c.dropped).toBe(c.total);
		expect(new Set(data.features.map((f) => f.id)).size).toBe(c.total);
		expect(data.features.some((f) => /^[OZ]\d+$/.test(f.id))).toBe(true);
		for (const f of data.features) {
			expect(["P1", "P2", "P3"]).toContain(f.priority);
			expect(f.title.length).toBeGreaterThan(0);
			if (f.status === "done") expect(f.release).not.toBe("");
		}
	});
});
