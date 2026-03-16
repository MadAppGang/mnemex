/**
 * ThinCloudClient — real HTTP ICloudIndexClient
 *
 * Implements ICloudIndexClient by making real HTTP requests to the
 * mnemex cloud REST API. Uses native fetch() (no external dependencies).
 *
 * Authentication: Bearer token sent in Authorization header.
 * All requests include X-ClaudeMem-Version header for server-side negotiation.
 *
 * Error handling:
 *   401 → CloudApiError (auth failure)
 *   409 → CloudApiError (model mismatch or conflict)
 *   429 → CloudApiError with retryAfter populated
 *   5xx → CloudApiError (server-side error)
 */

import type {
	ICloudIndexClient,
	ChunkCheckResult,
	CloudCallerResult,
	CloudCalleeResult,
	CloudGraphResult,
	CloudSearchRequest,
	CloudSearchResult,
	CloudSymbol,
	CommitStatus,
	RegisterRepoRequest,
	RegisterRepoResponse,
	UploadIndexRequest,
	UploadIndexResponse,
} from "./types.js";
import { getMachineId } from "./machine-id.js";

// ============================================================================
// Error class
// ============================================================================

/**
 * Error thrown when the cloud API returns a non-2xx response.
 */
export class CloudApiError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
		public readonly errorCode?: string,
		/** Seconds to wait before retrying (from Retry-After header on 429) */
		public readonly retryAfter?: number,
	) {
		super(message);
		this.name = "CloudApiError";
	}
}

// ============================================================================
// ThinCloudClient
// ============================================================================

/** Options for constructing a ThinCloudClient */
export interface ThinCloudClientOptions {
	/** Cloud API base URL (e.g. "https://api.mnemex.dev") */
	endpoint: string;
	/** Bearer token for authentication */
	token: string;
	/** API protocol version sent in X-ClaudeMem-Version header (default: 1) */
	version?: number;
}

/** Default polling parameters for waitForCommit */
const WAIT_INITIAL_DELAY_MS = 1_000;
const WAIT_MAX_DELAY_MS = 30_000;
const WAIT_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Real HTTP client for the mnemex cloud API.
 * Use LocalCloudStub in unit tests instead of this class.
 */
export class ThinCloudClient implements ICloudIndexClient {
	private readonly endpoint: string;
	private readonly token: string;
	private readonly version: number;
	private readonly machineId: string;

	constructor(options: ThinCloudClientOptions) {
		// Strip trailing slash so URL joining is consistent
		this.endpoint = options.endpoint.replace(/\/$/, "");
		this.token = options.token;
		this.version = options.version ?? 1;
		this.machineId = getMachineId();
	}

	// --------------------------------------------------------------------------
	// ICloudIndexClient implementation
	// --------------------------------------------------------------------------

	async checkChunks(
		repoSlug: string,
		hashes: string[],
		commitSha?: string,
	): Promise<ChunkCheckResult> {
		const extraHeaders: Record<string, string> = {};
		if (commitSha) {
			extraHeaders["X-ClaudeMem-Commit-SHA"] = commitSha;
		}
		return this.postWithHeaders<ChunkCheckResult>(
			"/v1/chunks/check",
			{ repoSlug, hashes },
			extraHeaders,
		);
	}

	async uploadIndex(request: UploadIndexRequest): Promise<UploadIndexResponse> {
		return this.post<UploadIndexResponse>("/v1/index", request);
	}

	async getCommitStatus(
		repoSlug: string,
		commitSha: string,
	): Promise<CommitStatus> {
		const qs = new URLSearchParams({ repo: repoSlug });
		return this.get<CommitStatus>(`/v1/commits/${commitSha}/status?${qs}`);
	}

	async waitForCommit(
		repoSlug: string,
		commitSha: string,
		timeoutMs: number = WAIT_DEFAULT_TIMEOUT_MS,
	): Promise<CommitStatus> {
		const deadline = Date.now() + timeoutMs;
		let delay = WAIT_INITIAL_DELAY_MS;

		while (true) {
			const status = await this.getCommitStatus(repoSlug, commitSha);

			if (status.status === "ready" || status.status === "error") {
				return status;
			}

			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				// Return whatever status we have on timeout
				return status;
			}

			// Sleep for the current delay (capped to remaining time)
			const sleepMs = Math.min(delay, remaining);
			await sleep(sleepMs);

			// Exponential backoff: 1s → 2s → 4s → 8s → 30s (capped)
			delay = Math.min(delay * 2, WAIT_MAX_DELAY_MS);
		}
	}

	async search(request: CloudSearchRequest): Promise<CloudSearchResult[]> {
		return this.post<CloudSearchResult[]>("/v1/search", request);
	}

	async registerRepo(
		request: RegisterRepoRequest,
	): Promise<RegisterRepoResponse> {
		const { orgSlug, repoSlug } = request;
		return this.post<RegisterRepoResponse>(
			`/v1/repos/${encodeURIComponent(orgSlug)}/${encodeURIComponent(repoSlug)}/register`,
			request,
		);
	}

	async getSymbol(
		repoSlug: string,
		commitSha: string,
		name: string,
	): Promise<CloudSymbol[]> {
		const qs = new URLSearchParams({ repo: repoSlug, commit: commitSha });
		return this.get<CloudSymbol[]>(
			`/v1/symbol/${encodeURIComponent(name)}?${qs}`,
		);
	}

	async getCallers(
		repoSlug: string,
		commitSha: string,
		name: string,
	): Promise<CloudCallerResult> {
		const qs = new URLSearchParams({ repo: repoSlug, commit: commitSha });
		return this.get<CloudCallerResult>(
			`/v1/callers/${encodeURIComponent(name)}?${qs}`,
		);
	}

	async getCallees(
		repoSlug: string,
		commitSha: string,
		name: string,
	): Promise<CloudCalleeResult> {
		const qs = new URLSearchParams({ repo: repoSlug, commit: commitSha });
		return this.get<CloudCalleeResult>(
			`/v1/callees/${encodeURIComponent(name)}?${qs}`,
		);
	}

	async getMap(
		repoSlug: string,
		commitSha: string,
		query?: string,
		maxTokens?: number,
	): Promise<string> {
		const qs = new URLSearchParams({ repo: repoSlug, commit: commitSha });
		if (query) qs.set("query", query);
		if (maxTokens != null) qs.set("maxTokens", String(maxTokens));
		return this.getText(`/v1/map?${qs}`);
	}

	async getGraph(
		repoSlug: string,
		commitSha: string,
	): Promise<CloudGraphResult> {
		const qs = new URLSearchParams({ repo: repoSlug, commit: commitSha });
		return this.get<CloudGraphResult>(`/v1/graph?${qs}`);
	}

	// --------------------------------------------------------------------------
	// Private HTTP helpers
	// --------------------------------------------------------------------------

	/** Common request headers */
	private headers(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.token}`,
			"X-ClaudeMem-Version": String(this.version),
			"X-ClaudeMem-Machine-ID": this.machineId,
			"Content-Type": "application/json",
		};
	}

	/** GET and parse JSON response */
	private async get<T>(path: string): Promise<T> {
		const url = `${this.endpoint}${path}`;
		const response = await fetch(url, {
			method: "GET",
			headers: this.headers(),
		});
		return this.handleResponse<T>(response);
	}

	/** GET and return raw text response */
	private async getText(path: string): Promise<string> {
		const url = `${this.endpoint}${path}`;
		const response = await fetch(url, {
			method: "GET",
			headers: this.headers(),
		});
		await this.assertSuccess(response);
		return response.text();
	}

	/** POST with JSON body and parse JSON response */
	protected async post<T>(path: string, body: unknown): Promise<T> {
		const url = `${this.endpoint}${path}`;
		const response = await fetch(url, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});
		return this.handleResponse<T>(response);
	}

	/** POST with JSON body, extra headers merged in, and parse JSON response */
	protected async postWithHeaders<T>(
		path: string,
		body: unknown,
		extraHeaders: Record<string, string> = {},
	): Promise<T> {
		const url = `${this.endpoint}${path}`;
		const response = await fetch(url, {
			method: "POST",
			headers: { ...this.headers(), ...extraHeaders },
			body: JSON.stringify(body),
		});
		return this.handleResponse<T>(response);
	}

	/** Parse a JSON response, throwing CloudApiError on non-2xx status */
	private async handleResponse<T>(response: Response): Promise<T> {
		await this.assertSuccess(response);
		return response.json() as Promise<T>;
	}

	/** Throw a typed CloudApiError for non-2xx responses */
	private async assertSuccess(response: Response): Promise<void> {
		if (response.ok) return;

		const { status } = response;

		// Try to extract error details from response body
		let errorCode: string | undefined;
		let message: string;
		try {
			const body = (await response.json()) as Record<string, unknown>;
			message =
				typeof body["message"] === "string"
					? body["message"]
					: `HTTP ${status}`;
			errorCode =
				typeof body["errorCode"] === "string" ? body["errorCode"] : undefined;
		} catch {
			message = `HTTP ${status}: ${response.statusText}`;
		}

		if (status === 401) {
			throw new CloudApiError(
				`Authentication failed: ${message}`,
				status,
				errorCode ?? "AUTH_FAILED",
			);
		}

		if (status === 409) {
			throw new CloudApiError(
				`Conflict: ${message}`,
				status,
				errorCode ?? "CONFLICT",
			);
		}

		if (status === 429) {
			const retryAfterHeader = response.headers.get("Retry-After");
			const retryAfter = retryAfterHeader
				? parseInt(retryAfterHeader, 10)
				: undefined;
			throw new CloudApiError(
				`Rate limited: ${message}`,
				status,
				errorCode ?? "RATE_LIMITED",
				Number.isFinite(retryAfter) ? retryAfter : undefined,
			);
		}

		if (status >= 500) {
			throw new CloudApiError(
				`Server error: ${message}`,
				status,
				errorCode ?? "SERVER_ERROR",
			);
		}

		throw new CloudApiError(message, status, errorCode);
	}
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a new ThinCloudClient.
 */
export function createThinCloudClient(
	options: ThinCloudClientOptions,
): ICloudIndexClient {
	return new ThinCloudClient(options);
}
