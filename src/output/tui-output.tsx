/**
 * TuiOutput: OutputRouter implementation for interactive TTY mode.
 *
 * Uses OpenTUI React (createCliRenderer + createRoot) to render an animated
 * IndexProgress component. The ProgressStore bridges the imperative indexer
 * callbacks to React state polled at 100ms intervals.
 *
 * Lifecycle:
 *   1. start()           → await createCliRenderer(...), store renderer
 *   2. renderProgress()  → create ProgressStore, mount IndexProgress via React root
 *                          return ProgressHandle delegating to store
 *   3. stop()            → unmount root, renderer.destroy(), remove signal handlers
 *
 * text() and error() delegate to console.log/console.error for non-progress
 * output like headers that appear before the progress bar.
 */

import React from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
// CliRenderer type inferred from createCliRenderer return
import { ProgressStore } from "./progress-store.js";
import { IndexProgress } from "../tui/components/command/IndexProgress.js";
import type { OutputRouter, ProgressHandle } from "./index.js";

// ============================================================================
// TuiOutput
// ============================================================================

/**
 * OutputRouter for interactive TTY mode.
 *
 * Renders IndexProgress via OpenTUI React. The renderer is created in start()
 * with useAlternateScreen: false so progress output stays visible after stop().
 */
export class TuiOutput implements OutputRouter {
	private renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null;
	private root: ReturnType<typeof createRoot> | null = null;
	private sigintHandler: (() => void) | null = null;

	async start(): Promise<void> {
		this.renderer = await createCliRenderer({
			useAlternateScreen: false,
			exitOnCtrlC: false,
			useMouse: false,
		});

		// Register SIGINT handler so Ctrl+C cleans up the renderer properly.
		this.sigintHandler = () => {
			void this.stop().then(() => {
				process.exit(0);
			});
		};
		process.on("SIGINT", this.sigintHandler);
	}

	async stop(): Promise<void> {
		// Remove SIGINT handler
		if (this.sigintHandler) {
			process.removeListener("SIGINT", this.sigintHandler);
			this.sigintHandler = null;
		}

		// Unmount React root
		if (this.root) {
			this.root.unmount();
			this.root = null;
		}

		// Destroy the terminal renderer
		if (this.renderer) {
			this.renderer.destroy();
			this.renderer = null;
		}
	}

	renderProgress(): ProgressHandle {
		if (!this.renderer) {
			throw new Error(
				"TuiOutput.start() must be called before renderProgress()",
			);
		}

		const renderer = this.renderer;
		const store = new ProgressStore();

		// Capture stop reference for the finish callback
		const self = this;

		// Mount IndexProgress component
		const root = createRoot(renderer);
		this.root = root;

		root.render(
			<IndexProgress
				store={store}
				globalStartTime={store.getGlobalStartTime()}
			/>,
		);

		return {
			update(
				completed: number,
				total: number,
				detail: string,
				inProgress?: number,
			): void {
				store.update(completed, total, detail, inProgress);
			},

			finish(): void {
				store.finish();
				// Wait 200ms for the final render to flush, then stop the renderer
				setTimeout(() => {
					void self.stop();
				}, 200);
			},

			stop(): void {
				void self.stop();
			},
		};
	}

	text(line: string): void {
		// Non-progress output (headers, summaries) goes directly to stdout.
		// console.log writes before the TUI renderer takes over the screen.
		console.log(line);
	}

	error(line: string): void {
		console.error(line);
	}
}
