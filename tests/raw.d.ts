// Vite's `?raw` imports (file contents as a string) in tests.
declare module "*?raw" {
	const text: string;
	export default text;
}
