/**
 * Generate and persist a stable anonymous machine ID.
 * Stored at ~/.mnemex/machine-id — created on first call, reused thereafter.
 * Used as X-ClaudeMem-Machine-ID header for server-side device tracking.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MACHINE_ID_DIR = join(homedir(), ".mnemex");
const MACHINE_ID_FILE = join(MACHINE_ID_DIR, "machine-id");

/** Get the machine ID, creating it if it doesn't exist. Synchronous for simplicity. */
export function getMachineId(): string {
	try {
		if (existsSync(MACHINE_ID_FILE)) {
			const id = readFileSync(MACHINE_ID_FILE, "utf-8").trim();
			if (id.length > 0) return id;
		}

		// Create directory if needed
		mkdirSync(MACHINE_ID_DIR, { recursive: true });

		const id = randomUUID();
		writeFileSync(MACHINE_ID_FILE, id, { encoding: "utf-8", mode: 0o600 });
		return id;
	} catch {
		// If anything fails (permissions, etc.), return a session-scoped ID.
		// This is better than crashing or sending no ID at all.
		return randomUUID();
	}
}
