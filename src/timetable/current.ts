import type { LectureClass } from "./lecture-mode";
/**
 * Link between the timetable and "New lecture" without making the lecture code depend on the timetable service:
 * the plugin registers a provider, `runNewLecture` asks it for a course to prefill.
 */
type CourseProvider = (notebookPath: string | null | undefined) => string | null;

let provider: CourseProvider | null = null;

export function setLectureCourseProvider(fn: CourseProvider | null): void {
	provider = fn;
}

/** Course of the class in progress for that notebook, or null (use the notebook name instead). */
export function suggestedCourse(notebookPath: string | null | undefined): string | null {
	try {
		return provider ? provider(notebookPath) : null;
	} catch (e) {
		console.error("[notebook] timetable course provider", e);
		return null;
	}
}

/**
 * 0.14 (#438): the same link for the whole class (time slot, room, lecturer), so a lecture page started by hand can be
 * filled in as well. Same rule as the course: the class in progress linked to the notebook, else an unlinked one.
 */
type ClassProvider = (notebookPath: string | null | undefined) => LectureClass | null;

let classProvider: ClassProvider | null = null;

export function setLectureClassProvider(fn: ClassProvider | null): void {
	classProvider = fn;
}

export function suggestedClass(notebookPath: string | null | undefined): LectureClass | null {
	try {
		return classProvider ? classProvider(notebookPath) : null;
	} catch (e) {
		console.error("[notebook] timetable class provider", e);
		return null;
	}
}
