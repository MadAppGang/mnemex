/**
 * TUI Entry Point
 *
 * Initializes the terminal renderer and mounts the React root.
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { resolve } from "node:path";
import { App } from "./App.js";
import { MonitorApp } from "./MonitorApp.js";

// ============================================================================
// Entry Function
// ============================================================================

/** Alias for startTUI – used by CLI handler */
export async function startTui(projectPath?: string): Promise<void> {
	return startTUI(projectPath);
}

export async function startTUI(projectPath?: string): Promise<void> {
	// Ensure we have a TTY
	if (!process.stdout.isTTY) {
		console.error("mnemex tui requires a TTY terminal");
		process.exit(1);
	}

	const resolvedPath = resolve(projectPath ?? process.cwd());

	// Create terminal renderer
	// OpenTUI handles exit signals (SIGINT, SIGTERM, etc.) internally via exitOnCtrlC
	// and its own signal handlers, which call renderer.destroy(). The Zig native
	// destroyRenderer runs performShutdownSequence to properly disable mouse tracking,
	// alternate screen, etc. The onDestroy callback fires after all native cleanup
	// is complete, so process.exit(0) here is safe.
	const renderer = await createCliRenderer({
		exitOnCtrlC: true,
		useAlternateScreen: true,
		onDestroy: () => {
			process.exit(0);
		},
	});

	// Quit callback for the app to trigger clean shutdown (e.g. pressing 'q').
	// Unmounts React tree then destroys the renderer, which triggers the full
	// Zig native cleanup (mouse tracking disable, alternate screen exit, etc.)
	// before onDestroy fires process.exit(0).
	const quit = () => {
		root.unmount();
		renderer.destroy();
	};

	// Create React root and render App
	const root = createRoot(renderer);
	root.render(<App projectPath={resolvedPath} quit={quit} />);
}

// ============================================================================
// Monitor Mode Entry
// ============================================================================

/** Start monitor mode — passive display of MCP activity */
export async function startMonitor(projectPath?: string): Promise<void> {
	if (!process.stdout.isTTY) {
		console.error("mnemex monitor requires a TTY terminal");
		process.exit(1);
	}

	const resolvedPath = resolve(projectPath ?? process.cwd());

	const renderer = await createCliRenderer({
		exitOnCtrlC: true,
		useAlternateScreen: true,
		onDestroy: () => {
			process.exit(0);
		},
	});

	const quit = () => {
		root.unmount();
		renderer.destroy();
	};

	const root = createRoot(renderer);
	root.render(<MonitorApp projectPath={resolvedPath} quit={quit} />);
}
