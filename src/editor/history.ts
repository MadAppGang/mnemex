import {
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";

export interface EditSession {
	sessionId: string; // UUID v4 (or passed in)
	createdAt: string; // ISO timestamp
	files: string[]; // absolute paths backed up
}

interface StoredSession extends EditSession {
	// same structure for now, but separating interface for potential future internal fields
}

export class EditHistory {
	private historyDir: string;
	private sessionsFile: string;

	/** Directory: {indexDir}/edit-history/ */
	constructor(indexDir: string) {
		this.historyDir = join(indexDir, "edit-history");
		this.sessionsFile = join(this.historyDir, "sessions.json");
		this.ensureDir();
	}

	private ensureDir() {
		if (!existsSync(this.historyDir)) {
			mkdirSync(this.historyDir, { recursive: true });
		}
	}

	/**
	 * Create a new session and back up a single file.
	 *
	 * Backup path: {indexDir}/edit-history/{sessionId}/{sanitized-filename}
	 */
	async backup(
		sessionId: string,
		filePath: string,
		content: string,
	): Promise<void> {
		const sessionDir = this.sessionDir(sessionId);
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		const backupPath = join(sessionDir, this.sanitizeFilename(filePath));
		writeFileSync(backupPath, content, "utf-8");

		this.updateSessionIndex(sessionId, [filePath]);
	}

	/**
	 * Back up multiple files atomically (all or nothing).
	 * Creates the session directory first, then writes all files.
	 * On any write failure, cleans up the session directory.
	 */
	async backupAll(
		sessionId: string,
		files: Array<{ filePath: string; content: string }>,
	): Promise<void> {
		const sessionDir = this.sessionDir(sessionId);

		// Start fresh for this session ID
		if (existsSync(sessionDir)) {
			rmSync(sessionDir, { recursive: true, force: true });
		}
		mkdirSync(sessionDir, { recursive: true });

		try {
			const backedUpFiles: string[] = [];
			for (const file of files) {
				const backupPath = join(
					sessionDir,
					this.sanitizeFilename(file.filePath),
				);
				writeFileSync(backupPath, file.content, "utf-8");
				backedUpFiles.push(file.filePath);
			}
			this.updateSessionIndex(sessionId, backedUpFiles);
		} catch (error) {
			// Cleanup on failure
			try {
				rmSync(sessionDir, { recursive: true, force: true });
			} catch (e) {
				// ignore cleanup error
			}
			throw error;
		}
	}

	/**
	 * Restore a single file from a session backup.
	 */
	async restore(sessionId: string, filePath: string): Promise<void> {
		const sessionDir = this.sessionDir(sessionId);
		const backupPath = join(sessionDir, this.sanitizeFilename(filePath));

		if (!existsSync(backupPath)) {
			throw new Error(
				`Backup for file ${filePath} not found in session ${sessionId}`,
			);
		}

		const content = readFileSync(backupPath, "utf-8");
		writeFileSync(filePath, content, "utf-8");
	}

	/**
	 * Restore all files backed up in a session.
	 * Used for rollback after WorkspaceEdit partial failure.
	 */
	async restoreAll(sessionId: string): Promise<string[]> {
		const session = this.getSession(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} not found`);
		}

		const restoredFiles: string[] = [];
		for (const filePath of session.files) {
			await this.restore(sessionId, filePath);
			restoredFiles.push(filePath);
		}
		return restoredFiles;
	}

	/**
	 * List all sessions, newest first.
	 */
	listSessions(): EditSession[] {
		if (!existsSync(this.sessionsFile)) {
			return [];
		}
		try {
			const data = readFileSync(this.sessionsFile, "utf-8");
			const sessions = JSON.parse(data) as EditSession[];
			// Sort by createdAt descending
			return sessions.sort(
				(a, b) =>
					new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
			);
		} catch (e) {
			return [];
		}
	}

	/**
	 * Get the most recent session.
	 */
	getLatestSession(): EditSession | null {
		const sessions = this.listSessions();
		return sessions.length > 0 ? sessions[0] : null;
	}

	private getSession(sessionId: string): EditSession | null {
		const sessions = this.listSessions();
		return sessions.find((s) => s.sessionId === sessionId) || null;
	}

	/**
	 * Prune sessions older than maxSessions (respects MNEMEX_EDIT_HISTORY_MAX).
	 */
	prune(maxSessions: number): void {
		const sessions = this.listSessions();
		if (sessions.length <= maxSessions) {
			return;
		}

		const sessionsToKeep = sessions.slice(0, maxSessions);
		const sessionsToRemove = sessions.slice(maxSessions);

		for (const session of sessionsToRemove) {
			const dir = this.sessionDir(session.sessionId);
			if (existsSync(dir)) {
				try {
					rmSync(dir, { recursive: true, force: true });
				} catch (e) {
					// ignore error removing dir
				}
			}
		}

		this.saveSessions(sessionsToKeep);
	}

	private sessionDir(sessionId: string): string {
		return join(this.historyDir, sessionId);
	}

	private sanitizeFilename(filePath: string): string {
		// Replace all non-alphanumeric chars with underscore, keep logic simple and safe
		return filePath.replace(/[^a-zA-Z0-9.-]/g, "_");
	}

	private updateSessionIndex(sessionId: string, newFiles: string[]) {
		const sessions = this.listSessions();
		const existingIndex = sessions.findIndex((s) => s.sessionId === sessionId);

		if (existingIndex >= 0) {
			// Update existing session
			const existingFiles = new Set(sessions[existingIndex].files);
			newFiles.forEach((f) => existingFiles.add(f));
			sessions[existingIndex].files = Array.from(existingFiles);
			sessions[existingIndex].createdAt = new Date().toISOString(); // Update timestamp
		} else {
			// Create new session entry
			sessions.unshift({
				sessionId,
				createdAt: new Date().toISOString(),
				files: newFiles,
			});
		}

		this.saveSessions(sessions);
	}

	private saveSessions(sessions: EditSession[]) {
		writeFileSync(
			this.sessionsFile,
			JSON.stringify(sessions, null, 2),
			"utf-8",
		);
	}
}
