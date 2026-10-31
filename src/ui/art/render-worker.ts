// Rendering the art off the main thread: an inline Blob worker that replays a recording on an OffscreenCanvas and encodes
// the PNG. No extra file at runtime. Where Worker, Blob, URL.createObjectURL or OffscreenCanvas are missing (or the worker
// fails) the caller falls back to drawing on the main thread. Does not import obsidian.
import { workerSource, type Recording } from "./record";
import { clearTimer, setTimer } from "./timers";

/** What the manager needs from a worker (a fake in tests). */
export interface WorkerLike {
	onmessage: ((e: { data: unknown }) => void) | null;
	onerror: ((e: unknown) => void) | null;
	postMessage(message: unknown): void;
	terminate(): void;
}

export interface WorkerJob extends Recording {
	/** Size in device pixels and the scale to draw at. */
	pw: number;
	ph: number;
	dpr: number;
}

const JOB_TIMEOUT_MS = 6000;
const IDLE_MS = 20_000;
/** After this many consecutive failures the worker is not tried again in this session. */
const MAX_WORKER_FAILURES = 2;

let factory: (() => WorkerLike) | null = null;
let worker: WorkerLike | null = null;
let blobUrl = "";
let nextId = 1;
let failures = 0;
let idleTimer: number | null = null;
const pending = new Map<number, { resolve: (url: string) => void; reject: (e: Error) => void; timer: number }>();

/** Replaces the worker factory (tests). `null` restores the real one. Resets the failure count. */
export function setArtWorkerFactory(f: (() => WorkerLike) | null): void {
	disposeArtWorker();
	factory = f;
	failures = 0;
}

/** Whether a worker can be tried here. */
export function workerAvailable(): boolean {
	if (failures >= MAX_WORKER_FAILURES) return false;
	if (factory) return true;
	return typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
		&& typeof OffscreenCanvas !== "undefined" && typeof OffscreenCanvas.prototype?.convertToBlob === "function";
}

function create(): WorkerLike {
	if (factory) return factory();
	blobUrl = URL.createObjectURL(new Blob([workerSource()], { type: "text/javascript" }));
	return new Worker(blobUrl) as unknown as WorkerLike;
}

function failAll(message: string): void {
	for (const [id, job] of pending) {
		clearTimer(job.timer);
		job.reject(new Error(message));
		pending.delete(id);
	}
}

/** Stops the worker and frees its script URL (it is created again on the next job). */
export function disposeArtWorker(): void {
	if (idleTimer) clearTimer(idleTimer);
	idleTimer = null;
	failAll("worker disposed");
	try {
		worker?.terminate();
	} catch {
		// Already gone.
	}
	worker = null;
	if (blobUrl) {
		try {
			URL.revokeObjectURL(blobUrl);
		} catch {
			// Nothing to free.
		}
		blobUrl = "";
	}
}

function armIdle(): void {
	if (idleTimer) clearTimer(idleTimer);
	idleTimer = setTimer(() => {
		if (pending.size === 0) disposeArtWorker();
		else armIdle();
	}, IDLE_MS);
}

function onMessage(e: { data: unknown }): void {
	const d = e.data as { id?: number; url?: string; error?: string } | null;
	if (!d || typeof d.id !== "number") return;
	const job = pending.get(d.id);
	if (!job) return;
	pending.delete(d.id);
	clearTimer(job.timer);
	if (typeof d.url === "string" && d.url.startsWith("data:image/png")) {
		failures = 0;
		job.resolve(d.url);
	} else {
		failures++;
		job.reject(new Error(d.error ?? "worker returned no image"));
	}
}

/** Renders a recording in the worker; resolves to a PNG data URL, rejects on any failure (the caller falls back). */
export function renderInWorker(job: WorkerJob): Promise<string> {
	if (!workerAvailable()) return Promise.reject(new Error("no worker"));
	return new Promise<string>((resolve, reject) => {
		try {
			if (!worker) {
				worker = create();
				worker.onmessage = onMessage;
				worker.onerror = () => {
					failures++;
					failAll("worker error");
					disposeArtWorker();
				};
			}
			const id = nextId++;
			const timer = setTimer(() => {
				pending.delete(id);
				failures++;
				reject(new Error("worker timed out"));
				disposeArtWorker();
			}, JOB_TIMEOUT_MS);
			pending.set(id, { resolve, reject, timer });
			worker.postMessage({ id, pw: job.pw, ph: job.ph, dpr: job.dpr, ops: job.ops, strings: job.strings });
			armIdle();
		} catch (e) {
			failures++;
			disposeArtWorker();
			reject(e instanceof Error ? e : new Error(String(e)));
		}
	});
}
