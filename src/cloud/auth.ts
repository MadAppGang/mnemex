/**
 * CloudAuthManager — file-based credential storage
 *
 * Stores OAuth/API tokens at ~/.mnemex/credentials.json with
 * mode 0600 (owner read/write only). Tokens are keyed by orgSlug
 * and checked for expiry before being returned.
 *
 * Future work (Phase 5): swap storage backend for OS keychain via keytar.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

interface StoredCredential {
	/** Bearer token */
	token: string;
	/** ISO 8601 expiry timestamp (optional — if absent, token never expires) */
	expiresAt?: string;
	/** When the credential was stored */
	storedAt: string;
}

type CredentialStore = Record<string, StoredCredential>;

// ============================================================================
// CloudAuthManager
// ============================================================================

/** Path to the credentials file */
const CREDENTIALS_PATH = join(homedir(), ".mnemex", "credentials.json");
const CREDENTIALS_DIR = join(homedir(), ".mnemex");

/**
 * File-based credential manager for the mnemex cloud API.
 *
 * Tokens are stored per-org and checked for expiry before use.
 * The credentials file is created with 0600 permissions to prevent
 * other users from reading API tokens.
 */
export class CloudAuthManager {
	private readonly credentialsPath: string;

	constructor(credentialsPath: string = CREDENTIALS_PATH) {
		this.credentialsPath = credentialsPath;
	}

	// --------------------------------------------------------------------------
	// Public API
	// --------------------------------------------------------------------------

	/**
	 * Get the stored token for an org, or undefined if not stored / expired.
	 */
	getToken(orgSlug: string): string | undefined {
		const store = this.readStore();
		const cred = store[orgSlug];
		if (!cred) return undefined;
		if (this.isExpired(cred)) {
			// Clean up silently
			this.removeToken(orgSlug);
			return undefined;
		}
		return cred.token;
	}

	/**
	 * Store a token for an org.
	 *
	 * @param orgSlug   — Organization identifier
	 * @param token     — Bearer token to store
	 * @param expiresAt — Optional ISO 8601 expiry timestamp
	 */
	setToken(orgSlug: string, token: string, expiresAt?: string): void {
		const store = this.readStore();
		store[orgSlug] = {
			token,
			storedAt: new Date().toISOString(),
			...(expiresAt ? { expiresAt } : {}),
		};
		this.writeStore(store);
	}

	/**
	 * Remove the stored token for an org.
	 * No-op if no token is stored for that org.
	 */
	removeToken(orgSlug: string): void {
		const store = this.readStore();
		if (!(orgSlug in store)) return;
		delete store[orgSlug];
		this.writeStore(store);
	}

	/**
	 * Check whether a valid (non-expired) token is stored for an org.
	 */
	isAuthenticated(orgSlug: string): boolean {
		return this.getToken(orgSlug) !== undefined;
	}

	// --------------------------------------------------------------------------
	// Private helpers
	// --------------------------------------------------------------------------

	private readStore(): CredentialStore {
		if (!existsSync(this.credentialsPath)) {
			return {};
		}
		try {
			const raw = readFileSync(this.credentialsPath, "utf8");
			return JSON.parse(raw) as CredentialStore;
		} catch {
			// Corrupted file — start fresh
			return {};
		}
	}

	private writeStore(store: CredentialStore): void {
		// Ensure directory exists
		const dir = join(this.credentialsPath, "..");
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const content = JSON.stringify(store, null, 2);
		writeFileSync(this.credentialsPath, content, {
			encoding: "utf8",
			mode: 0o600,
		});

		// Ensure permissions are 0600 even if the file already existed with
		// broader permissions (writeFileSync mode only sets on creation)
		try {
			chmodSync(this.credentialsPath, 0o600);
		} catch {
			// Non-fatal: best-effort permission setting
		}
	}

	private isExpired(cred: StoredCredential): boolean {
		if (!cred.expiresAt) return false;
		return new Date(cred.expiresAt) <= new Date();
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a CloudAuthManager using the default credentials path
 * (~/.mnemex/credentials.json).
 */
export function createCloudAuthManager(
	credentialsPath?: string,
): CloudAuthManager {
	return new CloudAuthManager(credentialsPath);
}

// ============================================================================
// Singleton helper
// ============================================================================

let _defaultManager: CloudAuthManager | undefined;

/**
 * Get the default CloudAuthManager singleton.
 * Lazily created on first access.
 */
export function getDefaultAuthManager(): CloudAuthManager {
	_defaultManager ??= new CloudAuthManager();
	return _defaultManager;
}

// Ensure the .mnemex directory exists with correct permissions on first use
if (!existsSync(CREDENTIALS_DIR)) {
	try {
		mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
	} catch {
		// Best-effort directory creation
	}
}
