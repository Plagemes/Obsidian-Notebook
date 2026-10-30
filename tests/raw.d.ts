// Vite's `?raw` imports (file contents as a string) in tests.
declare module "*?raw" {
	const text: string;
	export default text;
}

// Vite's `import.meta.glob` (eager, `?raw`): the text of many files at once, in tests.
interface ImportMeta {
	glob<T = unknown>(pattern: string | string[], options?: { query?: string; import?: string; eager?: boolean }): Record<string, T>;
}
