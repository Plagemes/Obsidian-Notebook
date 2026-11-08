/**
 * Retries with backoff for the cloud connector (#126): 429 and 5xx answers (and Drive's 403 rate-limit answers) and
 * requests that got no response at all are tried again a few times, waiting what `Retry-After` asks for when the server
 * says so, otherwise an exponential backoff with jitter. After the last try the caller gets a `TransientRemoteError`, which
 * the sync engine retries on a later run. Pure: time comes from an injectable `Clock`, so tests run instantly.
 */
import { TransientRemoteError } from "../provider-types";
import { errorCode, header, type Http, type HttpRequest, type HttpResponse } from "./http";

/** Time for the connector: `now` and an abortable wait. */
export interface Clock {
	now(): number;
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** An `Error` named "AbortError", thrown when the caller's signal aborts a request or a wait. */
export function abortError(): Error {
	const e = new Error("Aborted");
	e.name = "AbortError";
	return e;
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

/** The real clock (browser timers). */
export const realClock: Clock = {
	now: () => Date.now(),
	sleep: (ms, signal) =>
		new Promise<void>((resolve, reject) => {
			if (signal?.aborted) return reject(abortError());
			const done = (): void => {
				signal?.removeEventListener("abort", stop);
				resolve();
			};
			const handle = window.setTimeout(done, Math.max(0, ms));
			const stop = (): void => {
				window.clearTimeout(handle);
				reject(abortError());
			};
			signal?.addEventListener("abort", stop, { once: true });
		}),
};

export interface RetryOptions {
	clock: Clock;
	/** Attempts in all (default 4). */
	tries?: number;
	/** First backoff in ms (default 1000; doubles each time). */
	baseMs?: number;
	/** Longest single wait in ms (default 60 s). */
	maxWaitMs?: number;
	signal?: AbortSignal;
	/** 0..1 jitter source (default Math.random). */
	random?: () => number;
}

/** Drive answers rate limits with 403 and one of these reasons. */
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

/** True for an answer worth trying again: 429, 5xx (but not 501), or Drive's 403 rate limit. */
export function isTransientStatus(res: HttpResponse): boolean {
	if (res.status === 429 || (res.status >= 500 && res.status !== 501)) return true;
	if (res.status === 403) {
		const code = errorCode(res);
		return !!code && RATE_LIMIT_REASONS.has(code);
	}
	return false;
}

/** `Retry-After` in ms (seconds or an HTTP date), undefined when absent or unreadable. */
export function retryAfterMs(res: HttpResponse, now: number): number | undefined {
	const v = header(res, "retry-after")?.trim();
	if (!v) return undefined;
	if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
	const at = Date.parse(v);
	return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * Sends `req` (built fresh for each attempt, so a refreshed token can go in) and retries transient failures.
 * Resolves with the first non-transient response; throws `TransientRemoteError` after the last attempt.
 */
export async function sendWithRetry(http: Http, build: () => HttpRequest | Promise<HttpRequest>, o: RetryOptions): Promise<HttpResponse> {
	const tries = Math.max(1, o.tries ?? 4);
	const base = o.baseMs ?? 1000;
	const maxWait = o.maxWaitMs ?? 60_000;
	const random = o.random ?? Math.random;
	let lastMessage = "";
	let lastAfter: number | undefined;
	for (let attempt = 0; attempt < tries; attempt++) {
		throwIfAborted(o.signal);
		// Built outside the try: a failure to build (a refused token refresh) is not a network failure.
		const req = await build();
		let res: HttpResponse | undefined;
		try {
			res = await http.request(req);
		} catch (e) {
			if (e instanceof Error && e.name === "AbortError") throw e;
			lastMessage = `network: ${e instanceof Error ? e.message : String(e)}`;
			lastAfter = undefined;
		}
		throwIfAborted(o.signal);
		if (res && !isTransientStatus(res)) return res;
		if (res) {
			lastMessage = `HTTP ${res.status}${errorCode(res) ? ` ${errorCode(res)}` : ""}`;
			lastAfter = retryAfterMs(res, o.clock.now());
		}
		if (attempt === tries - 1) break;
		const backoff = base * 2 ** attempt * (0.75 + random() * 0.5);
		const wait = Math.min(maxWait, lastAfter ?? backoff);
		await o.clock.sleep(wait, o.signal);
	}
	throw new TransientRemoteError(`Cloud request failed after ${tries} tries (${lastMessage})`, lastAfter);
}
