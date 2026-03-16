/**
 * HTTP client for the /v1/keys API endpoints.
 * All requests use the master key via Authorization: Bearer header.
 */

// ============================================================================
// Types
// ============================================================================

export interface ApiKey {
	id: number;
	name: string;
	prefix: string;
	createdAt: string;
	lastUsedAt: string | null;
	isActive: boolean;
	usage: {
		total: number;
		byEndpoint: Record<string, number>;
	};
}

// ============================================================================
// Client
// ============================================================================

export class AdminApiClient {
	constructor(
		private readonly endpoint: string,
		private readonly masterKey: string,
	) {}

	private headers(): HeadersInit {
		return {
			Authorization: `Bearer ${this.masterKey}`,
			"Content-Type": "application/json",
			"X-ClaudeMem-Version": "1",
		};
	}

	async listKeys(): Promise<ApiKey[]> {
		const res = await fetch(`${this.endpoint}/v1/keys`, {
			method: "GET",
			headers: this.headers(),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as {
				error?: string;
			};
			throw new Error(body.error ?? `HTTP ${res.status}`);
		}
		const body = (await res.json()) as { keys: ApiKey[] };
		return body.keys;
	}

	async createKey(name: string): Promise<{ key: ApiKey; secret: string }> {
		const res = await fetch(`${this.endpoint}/v1/keys`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({ name }),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as {
				error?: string;
				field?: string;
			};
			const msg = body.field
				? `${body.error}: ${body.field}`
				: (body.error ?? `HTTP ${res.status}`);
			throw new Error(msg);
		}
		const body = (await res.json()) as {
			ok: boolean;
			key: ApiKey;
			secret: string;
		};
		return { key: body.key, secret: body.secret };
	}

	async deleteKey(id: number): Promise<void> {
		const res = await fetch(`${this.endpoint}/v1/keys/${id}`, {
			method: "DELETE",
			headers: this.headers(),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as {
				error?: string;
			};
			throw new Error(body.error ?? `HTTP ${res.status}`);
		}
	}
}
