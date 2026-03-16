/**
 * Progress Bar Utilities
 *
 * Animated progress bars for CLI benchmark tools.
 * Supports multiple concurrent progress items with individual timing.
 */

import { colors as c } from "./colors.js";

/** Animation frames for "in progress" portion */
const ANIM_FRAMES = ["▓", "▒", "░", "▒"];

/** Format elapsed time as mm:ss */
export function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

/** State for a single progress item */
interface ProgressItemState {
	completed: number;
	total: number;
	inProgress: number;
	failures: number;
	phase: string;
	done: boolean;
	started: boolean;
	error?: string;
	startTime: number;
	endTime?: number;
}

/**
 * Multi-item progress renderer for benchmarks
 *
 * Displays multiple concurrent progress bars with:
 * - Individual elapsed time tracking
 * - Animated in-progress indicators
 * - Status labels (waiting, in-progress, done, error)
 *
 * Example output:
 * ```
 * ⏱ 00:02 │ ████████████████████ 100% │ model-name              │ ✓ done
 * ⏱ 00:01 │ ████████░░░░░░░░░░░░  40% │ another-model           │ embed: 4/10
 * ```
 */
export function createBenchmarkProgress(itemIds: string[]) {
	const globalStartTime = Date.now();
	let animFrame = 0;
	let interval: ReturnType<typeof setInterval> | null = null;
	let stopped = false; // Guard against rendering after stop

	// State for each item (with individual timing)
	const itemState = new Map<string, ProgressItemState>();
	for (const id of itemIds) {
		itemState.set(id, {
			completed: 0,
			total: 0,
			inProgress: 0,
			failures: 0,
			phase: "processing",
			done: false,
			started: false,
			startTime: globalStartTime,
		});
	}

	function doRender() {
		animFrame = (animFrame + 1) % ANIM_FRAMES.length;

		// Calculate max status width to prevent line wrapping
		// Line format: "⏱ 00:03 │ <20-char bar> 100% │ <25-char name> │ <status>"
		// Fixed prefix = 2 + 5 + 3 + 20 + 1 + 4 + 3 + 25 + 3 = 66 chars
		const PREFIX_WIDTH = 66;
		const termCols = process.stdout.columns || 80;
		const maxStatusWidth = Math.max(10, termCols - PREFIX_WIDTH - 1);

		// Move cursor up to overwrite previous lines
		if (itemIds.length > 0) {
			process.stdout.write(`\x1b[${itemIds.length}A`);
		}

		for (const itemId of itemIds) {
			const state = itemState.get(itemId)!;
			const {
				completed,
				total,
				inProgress,
				failures,
				phase,
				done,
				started,
				error,
				startTime,
				endTime,
			} = state;

			// Calculate elapsed time (frozen when done/error, or show 00:00 if not started)
			const elapsedMs = started ? (endTime || Date.now()) - startTime : 0;
			const elapsed = formatElapsed(elapsedMs);

			// Short display name (last part after /)
			const shortName = itemId.split("/").pop() || itemId;
			const displayName =
				shortName.length > 25 ? shortName.slice(0, 22) + "..." : shortName;

			// Build progress bar and status
			const width = 20;
			let bar: string;
			let percent: number;
			let status: string;

			if (error) {
				bar = `${c.red}${"✗".repeat(width)}${c.reset}`;
				percent = 0;
				// Truncate error to fit terminal width (full error shown in results table)
				const maxErrLen = maxStatusWidth - 2; // "✗ " prefix
				const truncatedError =
					error.length > maxErrLen
						? error.slice(0, maxErrLen - 1) + "…"
						: error;
				status = `${c.red}✗ ${truncatedError}${c.reset}`;
			} else if (done) {
				bar = `${c.green}${"█".repeat(width)}${c.reset}`;
				percent = 100;
				status = `${c.green}${("✓ " + phase).padEnd(20)}${c.reset}`;
			} else if (!started) {
				// Item is waiting to start (sequential queue)
				bar = `${c.gray}${"░".repeat(width)}${c.reset}`;
				percent = 0;
				status = `${c.gray}${"⏳ waiting...".padEnd(20)}${c.reset}`;
			} else {
				percent = total > 0 ? Math.round((completed / total) * 100) : 0;
				const filledRatio = total > 0 ? completed / total : 0;
				const inProgressRatio = total > 0 ? inProgress / total : 0;

				const filledWidth = Math.round(filledRatio * width);
				const inProgressWidth = Math.min(
					Math.round(inProgressRatio * width),
					width - filledWidth,
				);
				const emptyWidth = width - filledWidth - inProgressWidth;

				const filled = "█".repeat(filledWidth);
				let animated = "";
				for (let i = 0; i < inProgressWidth; i++) {
					const charIndex = (animFrame + i) % ANIM_FRAMES.length;
					animated += ANIM_FRAMES[charIndex];
				}
				const empty = "░".repeat(emptyWidth);
				bar = filled + animated + empty;
				// Show failures count in yellow if any
				if (failures > 0) {
					status = `${c.yellow}${phase}: ${completed}/${total} (${failures} failed)${c.reset}`;
				} else {
					status = `${phase}: ${completed}/${total}`.padEnd(20);
				}
			}

			process.stdout.write(
				`\x1b[2K\r⏱ ${elapsed} │ ${bar} ${percent.toString().padStart(3)}% │ ${displayName.padEnd(25)} │ ${status}\n`,
			);
		}
	}

	// Wrapper for interval callbacks - guards against stale callbacks
	function render() {
		if (stopped || !interval) return;
		doRender();
	}

	return {
		/** Start the progress display and animation */
		start() {
			// Reserve lines for each item
			for (let i = 0; i < itemIds.length; i++) {
				console.log("");
			}
			interval = setInterval(render, 100);
			if (interval.unref) interval.unref();
			doRender(); // Initial render (interval is set, so doRender is safe)
		},

		/** Update progress for an item */
		update(
			itemId: string,
			completed: number,
			total: number,
			inProgress = 0,
			phase = "processing",
			failures = 0,
		) {
			const state = itemState.get(itemId);
			if (state) {
				// Start the timer on first update (when item actually begins)
				if (!state.started) {
					state.started = true;
					state.startTime = Date.now();
				}
				state.completed = completed;
				state.total = total;
				state.inProgress = inProgress;
				state.failures = failures;
				state.phase = phase;
			}
		},

		/** Mark an item as finished */
		finish(itemId: string) {
			const state = itemState.get(itemId);
			if (state) {
				state.done = true;
				state.inProgress = 0;
				state.completed = state.total;
				state.endTime = Date.now();
			}
		},

		/** Mark an item as errored */
		setError(itemId: string, error: string) {
			const state = itemState.get(itemId);
			if (state) {
				state.error = error;
				state.done = true;
				state.endTime = Date.now();
			}
		},

		/** Mark all items as finished (used when phase transitions) */
		finishAll() {
			for (const [, state] of itemState) {
				if (!state.done && state.started) {
					state.done = true;
					state.inProgress = 0;
					// Keep completed at current value if total is 0 or unknown
					if (state.total > 0) {
						state.completed = state.total;
					}
					state.endTime = Date.now();
				}
			}
		},

		/** Stop the animation and optionally render final state */
		stop(skipFinalRender = false) {
			if (stopped) return; // Already stopped
			stopped = true; // Mark as stopped FIRST to prevent interval race
			if (interval) {
				clearInterval(interval);
				interval = null;
			}
			if (skipFinalRender) {
				// Clear the progress bar lines (move up and clear each line)
				if (itemIds.length > 0) {
					process.stdout.write(`\x1b[${itemIds.length}A`); // Move up
					for (let i = 0; i < itemIds.length; i++) {
						process.stdout.write(`\x1b[2K\n`); // Clear line and move down
					}
					process.stdout.write(`\x1b[${itemIds.length}A`); // Move back up
				}
			} else {
				// Final render - use doRender directly (bypasses stopped check)
				doRender();
			}
		},

		/** Get elapsed time for an item in milliseconds */
		getElapsedMs(itemId: string): number {
			const state = itemState.get(itemId);
			if (!state || !state.started) return 0;
			return (state.endTime || Date.now()) - state.startTime;
		},
	};
}

/** Type for the benchmark progress instance */
export type BenchmarkProgress = ReturnType<typeof createBenchmarkProgress>;

/**
 * Simple single-line progress bar (for non-parallel tasks)
 */
export function createSimpleProgress(label: string, total: number) {
	const startTime = Date.now();
	let current = 0;

	function render() {
		const elapsed = formatElapsed(Date.now() - startTime);
		const percent = total > 0 ? Math.round((current / total) * 100) : 0;
		const width = 20; // Match multi-item progress bar width
		const filled = Math.round((current / total) * width);
		const empty = width - filled;
		const bar = `${c.green}${"█".repeat(filled)}${c.reset}${"░".repeat(empty)}`;
		const status =
			current >= total
				? `${c.green}✓ ${label}${c.reset}`
				: `${label}: ${current}/${total}`;
		process.stdout.write(
			`\r\x1b[2K⏱ ${elapsed} │ ${bar} ${percent.toString().padStart(3)}% │ ${label.padEnd(25)} │ ${status}`,
		);
	}

	return {
		update(value: number) {
			current = value;
			render();
		},
		increment() {
			current++;
			render();
		},
		finish() {
			current = total;
			render();
			console.log();
		},
	};
}
