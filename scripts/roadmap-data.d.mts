export type RoadmapStatus = "done" | "progress" | "todo" | "deferred" | "dropped";

export interface RoadmapFeature {
	id: string;
	title: string;
	priority: "P1" | "P2" | "P3";
	milestone: string;
	milestoneTitle: string;
	area: string;
	status: RoadmapStatus;
	release: string;
}

export interface RoadmapCounts {
	total: number;
	done: number;
	progress: number;
	todo: number;
	deferred: number;
	dropped: number;
}

export interface RoadmapData {
	generatedAt: string;
	source: string;
	latestRelease: string;
	latestReleaseDate: string;
	counts: RoadmapCounts;
	badge: string;
	milestones: { id: string; title: string; features: number }[];
	releases: string[];
	features: RoadmapFeature[];
}

export const RELEASE_SETS: [string, Set<string>][];
export const EARLY: string;
export function changelogReleases(text: string): Map<string, string>;
export function parseIdList(text: string): Set<string>;
export function parseRoadmap(
	text: string,
	options?: { released?: Map<string, string>; inProgress?: Set<string>; wave?: string },
): RoadmapFeature[];
export function buildRoadmap(input: {
	roadmap: string;
	changelog: string;
	inProgress?: Set<string>;
	wave?: string;
	generatedAt: string;
}): RoadmapData;
