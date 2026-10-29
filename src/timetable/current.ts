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
