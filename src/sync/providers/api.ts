/**
 * Authorised requests shared by both providers (#126): the bearer token goes in each attempt, transient answers are
 * retried (retry.ts), a 401 refreshes the token once and tries again, a second 401 means the user must sign in again.
 * Every other answer goes back to the provider, which maps the statuses its API documents.
 */
import { AuthRequiredError, type ProviderId } from "../provider-types";
import { errorCode, type Http, type HttpRequest, type HttpResponse } from "../auth/http";
import { sendWithRetry, type Clock } from "../auth/retry";
import type { TokenManager } from "../auth/tokens";

/** An answer the provider did not expect (a bug, or a remote set-up the connector does not handle). Carries no token. */
export class RemoteHttpError extends Error {
	constructor(readonly status: number, readonly code: string | undefined, what: string) {
		super(`${what}: HTTP ${status}${code ? ` ${code}` : ""}`);
		this.name = "RemoteHttpError";
	}
}

export interface ApiTuning {
	/** Attempts per request (default 4). */
	tries?: number;
	/** First backoff in ms (default 1000). */
	baseMs?: number;
	random?: () => number;
}

export class ApiClient {
	constructor(
		private readonly http: Http,
		readonly tokens: TokenManager,
		readonly clock: Clock,
		private readonly provider: ProviderId,
		private readonly tuning: ApiTuning = {},
	) {}

	/** Sends `req` with the bearer token (or without it when `auth` is false, e.g. to a pre-authorised upload URL). */
	async send(req: HttpRequest, signal?: AbortSignal, auth = true): Promise<HttpResponse> {
		for (let round = 0; ; round++) {
			let used = "";
			const res = await sendWithRetry(this.http, async () => {
				if (!auth) return req;
				used = await this.tokens.token(signal);
				return { ...req, headers: { ...req.headers, Authorization: `Bearer ${used}` } };
			}, { clock: this.clock, signal, tries: this.tuning.tries, baseMs: this.tuning.baseMs, random: this.tuning.random });
			if (res.status !== 401 || !auth) return res;
			if (round > 0) throw new AuthRequiredError(this.provider);
			this.tokens.invalidate(used);
		}
	}

	/** Throws `RemoteHttpError` for an answer the caller does not handle. */
	fail(res: HttpResponse, what: string): never {
		throw new RemoteHttpError(res.status, errorCode(res), what);
	}
}
