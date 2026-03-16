/**
 * IndexProgress
 *
 * Multi-phase animated progress display for `mnemex index`.
 * Replaces the manual ANSI-based createProgressRenderer() in cli.ts.
 *
 * Renders each indexing phase as a row in the exact same format as the
 * current text-mode renderer:
 *
 *   ⏱ 00:02 │ ████████████████████ 100% │ parsing          │ done
 *   ⏱ 00:01 │ ████████░░░░░░░░░░░░  40% │ embedding        │ 4/10
 *   ⏱ 00:03 total
 *
 * Animation is driven by a 100ms setInterval (matching existing behavior).
 * State is read from a ProgressStore polled on each tick — the store is
 * updated imperatively by the indexer's onProgress callbacks outside React.
 */

import { useState, useEffect } from "react";
import type {
	ProgressStore,
	PhaseState,
} from "../../../output/progress-store.js";
import { theme } from "../../theme.js";
import { formatElapsed } from "../../../ui/progress.js";

// ============================================================================
// Constants
// ============================================================================

/** Width of the progress bar in characters (matches current renderer) */
const BAR_WIDTH = 20;

/** Animation frames cycled for in-progress cells */
const ANIM_FRAMES = ["▓", "▒", "░", "▒"] as const;

// ============================================================================
// Props
// ============================================================================

export interface IndexProgressProps {
	/** Mutable state bridge populated by the indexer onProgress callbacks */
	store: ProgressStore;
	/** Wall-clock ms when indexing began (for total elapsed display) */
	globalStartTime: number;
	/** Called once when the store reports finished = true */
	onDone?: () => void;
}

// ============================================================================
// Pure Helpers
// ============================================================================

/**
 * Build a 20-character progress bar string for a single phase.
 *
 * Segments:
 *   filled    ████  completed items
 *   animated  ▓▒░▒  items currently in-progress (animated per frame)
 *   empty     ░░░░  remaining
 */
function buildBar(phase: PhaseState, animFrame: number): string {
	const { completed, total, inProgress, isComplete } = phase;

	if (isComplete) {
		return "█".repeat(BAR_WIDTH);
	}

	if (total === 0) {
		// No total known yet — show empty bar
		return "░".repeat(BAR_WIDTH);
	}

	const filledRatio = completed / total;
	const inProgressRatio = inProgress / total;

	const filledWidth = Math.round(filledRatio * BAR_WIDTH);
	const inProgressWidth = Math.min(
		Math.round(inProgressRatio * BAR_WIDTH),
		BAR_WIDTH - filledWidth,
	);
	const emptyWidth = BAR_WIDTH - filledWidth - inProgressWidth;

	const filled = "█".repeat(filledWidth);
	let animated = "";
	for (let i = 0; i < inProgressWidth; i++) {
		const charIndex = (animFrame + i) % ANIM_FRAMES.length;
		animated += ANIM_FRAMES[charIndex];
	}
	const empty = "░".repeat(emptyWidth);

	return filled + animated + empty;
}

/**
 * Compute elapsed milliseconds for a phase.
 * Uses finalDuration when available (frozen at completion).
 */
function phaseElapsedMs(phase: PhaseState): number {
	if (phase.finalDuration !== undefined) {
		return phase.finalDuration;
	}
	return Date.now() - phase.startTime;
}

/**
 * Build the status string shown after the phase name column.
 *
 * Examples:
 *   done
 *   4/10
 *   src/foo.ts
 */
function buildStatus(phase: PhaseState): string {
	if (phase.isComplete) {
		return "done";
	}
	if (phase.total > 0) {
		return `${phase.completed}/${phase.total}`;
	}
	if (phase.detail) {
		// Truncate long file paths
		return phase.detail.length > 20
			? phase.detail.slice(phase.detail.length - 20)
			: phase.detail;
	}
	return "...";
}

/** Compute the percent integer (0-100) for display */
function buildPercent(phase: PhaseState): number {
	if (phase.isComplete) return 100;
	if (phase.total === 0) return 0;
	return Math.round((phase.completed / phase.total) * 100);
}

// ============================================================================
// PhaseRow Component
// ============================================================================

interface PhaseRowProps {
	phase: PhaseState;
	animFrame: number;
}

/**
 * Renders a single phase progress row:
 *   ⏱ 00:02 │ ████████████████████ 100% │ parsing          │ done
 */
function PhaseRow({ phase, animFrame }: PhaseRowProps) {
	const elapsed = formatElapsed(phaseElapsedMs(phase));
	const bar = buildBar(phase, animFrame);
	const percent = buildPercent(phase);
	const status = buildStatus(phase);
	const phaseName = phase.name.padEnd(16).slice(0, 16);

	// Bar color: green when done, primary (orange) while in progress
	const barColor = phase.isComplete ? theme.success : theme.primary;
	// Empty-bar portion is always dimmed
	const emptyStart = phase.isComplete
		? BAR_WIDTH
		: Math.round((phase.completed / Math.max(phase.total, 1)) * BAR_WIDTH);
	const filledPart = bar.slice(0, emptyStart);
	const emptyPart = bar.slice(emptyStart);

	const statusColor = phase.isComplete ? theme.success : theme.text;

	return (
		<box flexDirection="row" height={1}>
			<text fg={theme.muted}>{"⏱ "}</text>
			<text fg={theme.muted}>{elapsed}</text>
			<text fg={theme.dimmed}>{" │ "}</text>
			<text fg={barColor}>{filledPart}</text>
			<text fg={theme.dimmed}>{emptyPart}</text>
			<text fg={theme.muted}>{` ${percent.toString().padStart(3)}%`}</text>
			<text fg={theme.dimmed}>{" │ "}</text>
			<text fg={theme.text}>{phaseName}</text>
			<text fg={theme.dimmed}>{" │ "}</text>
			<text fg={statusColor}>{status}</text>
		</box>
	);
}

// ============================================================================
// IndexProgress Component
// ============================================================================

/**
 * Multi-phase animated progress display.
 *
 * Polls the ProgressStore every 100ms via setInterval. When the store
 * reports finished=true, calls onDone() and stops the interval.
 */
export function IndexProgress({
	store,
	globalStartTime,
	onDone,
}: IndexProgressProps) {
	const [snapshot, setSnapshot] = useState(() => store.getSnapshot());
	const [animFrame, setAnimFrame] = useState(0);

	useEffect(() => {
		const interval = setInterval(() => {
			const snap = store.getSnapshot();
			setSnapshot(snap);
			setAnimFrame((f) => (f + 1) % ANIM_FRAMES.length);

			if (snap.finished) {
				clearInterval(interval);
				// Slight delay so the final "done" state renders before we exit
				setTimeout(() => {
					onDone?.();
				}, 50);
			}
		}, 100);

		return () => clearInterval(interval);
	}, [store, onDone]);

	const { phases, finished } = snapshot;
	const totalElapsed = formatElapsed(Date.now() - globalStartTime);

	return (
		<box flexDirection="column">
			{phases.map((phase) => (
				<PhaseRow key={phase.name} phase={phase} animFrame={animFrame} />
			))}
			{/* Total elapsed line (shown when there are multiple phases or done) */}
			{(phases.length > 1 || finished) && (
				<box flexDirection="row" height={1}>
					<text fg={theme.muted}>{"⏱ "}</text>
					<text fg={finished ? theme.success : theme.muted}>
						{totalElapsed}
					</text>
					<text fg={theme.dimmed}>{" total"}</text>
				</box>
			)}
		</box>
	);
}
