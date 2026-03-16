/**
 * useActivityMonitor Hook
 *
 * Watches activity.jsonl for notifications from the MCP server and polls
 * SQLite for full activity details. This is the TUI side of the self-recording
 * activity monitor system.
 *
 * Design:
 *   - activity.jsonl is a "doorbell" — it signals that SQLite has a new row.
 *   - TUI truncates activity.jsonl on startup before watching it.
 *   - MCP server is append-only; TUI owns truncation.
 *   - 500ms polling fallback for fs.watch reliability on all platforms.
 *   - Startup replay deferred by one tick (setTimeout) so child view effects
 *     can register their handlers before replay fires.
 */

import { existsSync, statSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useCallback, useEffect, useRef } from "react";
import type { ActivityRow, FileTracker } from "../../core/tracker.js";

// ============================================================================
// Types
// ============================================================================

export interface ActivityRecord {
	id: number;
	type: string;
	metadata: Record<string, unknown>;
	timestamp: string;
}

// ============================================================================
// Hook
// ============================================================================

export function useActivityMonitor(
	projectPath: string,
	tracker: FileTracker | null,
	onActivity: (record: ActivityRecord) => void,
): void {
	const lastSeenIdRef = useRef(0);
	const byteOffsetRef = useRef(0);
	const onActivityRef = useRef(onActivity);
	onActivityRef.current = onActivity;

	// Read new activities from SQLite since lastSeenId
	const pollActivities = useCallback(() => {
		if (!tracker) return;
		try {
			const rows: ActivityRow[] = tracker.getActivity(lastSeenIdRef.current);
			for (const row of rows) {
				try {
					const record: ActivityRecord = {
						id: row.id,
						type: row.type,
						metadata: JSON.parse(row.metadata) as Record<string, unknown>,
						timestamp: row.timestamp,
					};
					onActivityRef.current(record);
				} catch {
					// Skip malformed row but don't lose other events
				}
				// Always advance cursor — even for malformed rows, to avoid
				// re-processing the same broken record on every poll cycle
				lastSeenIdRef.current = row.id;
			}
		} catch {
			// Silent — DB may be locked by MCP server momentarily
		}
	}, [tracker]);

	// Check activity.jsonl for new bytes — use file size as a signal
	const readNotifications = useCallback(() => {
		const jsonlPath = join(projectPath, ".mnemex", "activity.jsonl");
		try {
			const stat = statSync(jsonlPath);
			if (stat.size < byteOffsetRef.current) {
				// File was truncated (shouldn't happen since TUI owns truncation,
				// but handle it gracefully)
				byteOffsetRef.current = 0;
			}
			if (stat.size <= byteOffsetRef.current) {
				return; // No new data
			}
			// New bytes arrived — update offset and poll SQLite for new rows
			byteOffsetRef.current = stat.size;
			pollActivities();
		} catch {
			// File doesn't exist yet — that's fine, polling will catch up
		}
	}, [projectPath, pollActivities]);

	// Main effect: set up file watch + polling fallback + startup replay
	useEffect(() => {
		const jsonlPath = join(projectPath, ".mnemex", "activity.jsonl");

		// Truncate activity.jsonl on startup (TUI owns truncation, MCP is append-only)
		try {
			if (existsSync(jsonlPath)) {
				writeFileSync(jsonlPath, "");
			}
		} catch {
			// Silent — file may not be writable; not critical
		}
		byteOffsetRef.current = 0;

		// Deferred startup replay: load recent activity from SQLite.
		// Defer by one tick so child view effects have registered before replay.
		const replayTimer = setTimeout(() => pollActivities(), 0);

		// Watch the .mnemex directory for changes to activity.jsonl
		let watcher: ReturnType<typeof watch> | null = null;
		try {
			const dir = join(projectPath, ".mnemex");
			if (existsSync(dir)) {
				watcher = watch(dir, (_eventType, filename) => {
					if (filename === "activity.jsonl") {
						readNotifications();
					}
				});
			}
		} catch {
			// Silent — directory may not exist; polling fallback covers this
		}

		// 500ms polling fallback for fs.watch reliability
		const pollInterval = setInterval(readNotifications, 500);

		return () => {
			clearTimeout(replayTimer);
			watcher?.close();
			clearInterval(pollInterval);
		};
	}, [projectPath, pollActivities, readNotifications]);

	// Prune old activity rows every 5 minutes to prevent unbounded growth
	useEffect(() => {
		if (!tracker) return;
		const pruneInterval = setInterval(
			() => {
				try {
					tracker.pruneActivity(200);
				} catch {
					// Silent — pruning is a maintenance operation
				}
			},
			5 * 60 * 1000,
		);
		return () => clearInterval(pruneInterval);
	}, [tracker]);
}
