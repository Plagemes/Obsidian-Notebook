import { describe, expect, it } from "vitest";
import { PROFILE_SCORE, suggestPaper } from "../src/model/paper-suggest";
import type { PaperKind } from "../src/model/types";
import { applyPatch, BUILTIN_PROFILES, profilePaperCandidate, type WritingProfile } from "../src/view/writing-profiles";

/** 0.25: the active writing profile's paper is the strongest signal of the suggested paper (roadmap 409 + 219). */
const lecture = BUILTIN_PROFILES.find((p) => p.id === "lecture")!;
const settingsFor = (p: WritingProfile) => applyPatch(p);
const grid = ["grid", "grid", "grid", "grid", "grid"] as PaperKind[];

describe("the writing profile's paper in the paper suggestion", () => {
	it("offers the paper of the active profile with the top score and a profile reason", () => {
		expect(profilePaperCandidate([], settingsFor(lecture))).toEqual([{ paper: lecture.paper, score: PROFILE_SCORE, reason: { kind: "profile" } }]);
	});

	it("offers nothing without an active profile, for an unknown one, or when the settings drifted from it", () => {
		const s = settingsFor(lecture);
		expect(profilePaperCandidate([], { ...s, writingProfileActive: "" })).toEqual([]);
		expect(profilePaperCandidate([], { ...s, writingProfileActive: "profile-99" })).toEqual([]);
		expect(profilePaperCandidate([], { ...s, defaultPaper: lecture.paper === "grid" ? "dotted" : "grid" })).toEqual([]);
		expect(profilePaperCandidate([], { ...s, stabilization: s.stabilization + 1 })).toEqual([]);
	});

	it("outranks a run of another paper in the suggestion, and the history decides again without a profile", () => {
		const input = { pages: grid, index: 4 };
		const withProfile = suggestPaper({ ...input, extra: profilePaperCandidate([], settingsFor(lecture)) });
		expect(withProfile).toMatchObject({ paper: lecture.paper, reason: { kind: "profile" } });
		const without = suggestPaper({ ...input, extra: profilePaperCandidate([], { ...settingsFor(lecture), writingProfileActive: "" }) });
		expect(without).toMatchObject({ paper: "grid", reason: { kind: "recent" } });
	});
});
