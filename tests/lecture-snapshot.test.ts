import { describe, expect, it } from "vitest";
import { parseSnapshotName, snapshotsToPrune } from "../src/storage/history";
import {
	cleanCourse, contentFingerprint, courseOf, decideLectureSnapshot, isLectureSnapshotName, lectureLabelParts, lectureSnapshotFileName,
	lectureSnapshotsToPrune, ordinarySnapshotNames, readLectureLabels, withLectureLabel, type LectureSnapshotInput,
} from "../src/storage/lecture-snapshot";

const base: LectureSnapshotInput = { enabled: true, wrote: true, saved: true, fingerprint: "a", latestFingerprint: "b", nameTaken: false };

describe("lecture snapshot names", () => {
	it("round-trips through the snapshot name parser", () => {
		const d = new Date(2026, 10, 4, 9, 30);
		const name = lectureSnapshotFileName(d);
		expect(name).toBe("20261104-0930-lecture.snapshot");
		expect(parseSnapshotName(name)?.getTime()).toBe(d.getTime());
		expect(isLectureSnapshotName(name)).toBe(true);
		expect(isLectureSnapshotName("20261104-0930.snapshot")).toBe(false);
		expect(isLectureSnapshotName("lectures.json")).toBe(false);
		expect(parseSnapshotName("20261104-0930-other.snapshot")).toBeNull();
	});
});

describe("retention", () => {
	const lectures = [1, 2, 3, 4, 5].map((d) => `2026110${d}-0900-lecture.snapshot`);
	const manual = ["20261101-0800.snapshot", "20261102-0800.snapshot"];
	it("prunes only the oldest lecture snapshots beyond the count", () => {
		expect(lectureSnapshotsToPrune([...manual, ...lectures], 3).sort()).toEqual(["20261101-0900-lecture.snapshot", "20261102-0900-lecture.snapshot"]);
	});
	it("never lists an ordinary snapshot, and keeps at least one", () => {
		expect(lectureSnapshotsToPrune(manual, 1)).toEqual([]);
		expect(lectureSnapshotsToPrune(lectures, 0)).toHaveLength(4);
	});
	it("the interval retention ignores lecture snapshots", () => {
		const names = ordinarySnapshotNames([...manual, ...lectures]);
		expect(names).toEqual(manual);
		expect(snapshotsToPrune(names, 1)).toEqual(["20261101-0800.snapshot"]);
	});
});

describe("decision", () => {
	it("takes a snapshot when enabled, written, saved and changed", () => {
		expect(decideLectureSnapshot(base)).toEqual({ take: true });
		expect(decideLectureSnapshot({ ...base, latestFingerprint: null })).toEqual({ take: true });
	});
	it("skips with the reason", () => {
		expect(decideLectureSnapshot({ ...base, enabled: false })).toEqual({ take: false, why: "off" });
		expect(decideLectureSnapshot({ ...base, wrote: false })).toEqual({ take: false, why: "nothing-written" });
		expect(decideLectureSnapshot({ ...base, saved: false })).toEqual({ take: false, why: "not-saved" });
		expect(decideLectureSnapshot({ ...base, latestFingerprint: "a" })).toEqual({ take: false, why: "unchanged" });
		expect(decideLectureSnapshot({ ...base, nameTaken: true })).toEqual({ take: false, why: "exists" });
	});
});

describe("fingerprint", () => {
	it("ignores modifiedAt but sees any other change", () => {
		const a = '{"id":"x","modifiedAt":"2026-11-04T09:00:00.000Z","pages":[1]}';
		const b = '{"id":"x","modifiedAt":"2026-11-04T10:00:00.000Z","pages":[1]}';
		const c = '{"id":"x","modifiedAt":"2026-11-04T09:00:00.000Z","pages":[1,2]}';
		expect(contentFingerprint(a)).toBe(contentFingerprint(b));
		expect(contentFingerprint(a)).not.toBe(contentFingerprint(c));
	});
});

describe("label sidecar", () => {
	it("reads leniently and refuses to treat garbage as empty", () => {
		expect(readLectureLabels(null)).toEqual({});
		expect(readLectureLabels("")).toEqual({});
		expect(readLectureLabels("{not json")).toBeNull();
		expect(readLectureLabels("[1]")).toBeNull();
	});
	it("adds a label, drops entries of removed snapshots and keeps unknown ones", () => {
		const old = { "20261101-0900-lecture.snapshot": { course: "Old" }, "20261102-0900-lecture.snapshot": { course: "Two", extra: 1 }, other: { course: "x" } };
		const out = withLectureLabel(old, "20261103-0900-lecture.snapshot", "  Algebra\n I ", ["20261102-0900-lecture.snapshot"]);
		expect(Object.keys(out).sort()).toEqual(["20261102-0900-lecture.snapshot", "20261103-0900-lecture.snapshot", "other"]);
		expect(out["20261102-0900-lecture.snapshot"]).toEqual({ course: "Two", extra: 1 });
		expect(courseOf(out, "20261103-0900-lecture.snapshot")).toBe("Algebra I");
		expect(courseOf(null, "x")).toBeNull();
	});
	it("formats the label parts", () => {
		expect(lectureLabelParts(new Date(2026, 10, 4, 9, 5))).toEqual({ date: "2026-11-04", time: "09:05" });
		expect(cleanCourse("a".repeat(200))).toHaveLength(80);
	});
});
