/**
 * renderBenchmarkResultsTui
 *
 * Launches a full-screen interactive TUI to display benchmark results.
 * Uses useAlternateScreen: true to take over the entire terminal.
 * The promise resolves when the user presses 'q' to quit or 'b' to go back.
 *
 * Extracted into a .tsx file so JSX can be used. Called from index.ts.
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { BenchmarkResultsApp } from "../tui/components/command/BenchmarkResults.js";
import type { BenchmarkResultsData } from "../tui/components/command/BenchmarkResults.js";

// Re-export the data type so callers don't need to import from the TUI module directly
export type { BenchmarkResultsData };

export type ResultsTuiAction = "quit" | "back";

/**
 * Renders benchmark results using an interactive full-screen OpenTUI.
 * Always supports 'b' to go back to the run list.
 * Returns "back" if the user pressed 'b', "quit" otherwise.
 */
export async function renderBenchmarkResultsTui(
	data: BenchmarkResultsData,
): Promise<ResultsTuiAction> {
	// Ensure we have a TTY - interactive TUI requires one
	if (!process.stdout.isTTY) {
		// Fallback: print a simple message and skip the TUI
		console.log(
			"[benchmark] Results ready. Run with a TTY to see interactive TUI.",
		);
		return "quit";
	}

	const renderer = await createCliRenderer({
		useAlternateScreen: true, // FULL SCREEN - takes over the terminal
		exitOnCtrlC: true,
		onDestroy: () => {
			// Renderer destroyed - don't call process.exit here so the
			// benchmark caller can continue (e.g. write output files).
		},
	});

	const root = createRoot(renderer);

	return new Promise<ResultsTuiAction>((resolve) => {
		const cleanup = (action: ResultsTuiAction) => {
			root.unmount();
			// Resolve BEFORE destroying the renderer. renderer.destroy() removes
			// all stdin listeners, signal handlers, and timers — leaving the
			// Node.js event loop with nothing to do. If we destroy first, the
			// process exits before the awaiting caller can create the next
			// renderer. By resolving first, the microtask queue delivers the
			// result to the caller (which can set up a keepalive) before we
			// tear down.
			resolve(action);
			renderer.destroy();
		};

		const quit = () => cleanup("quit");
		const onBack = () => cleanup("back");

		root.render(
			<BenchmarkResultsApp data={data} quit={quit} onBack={onBack} />,
		);
	});
}
