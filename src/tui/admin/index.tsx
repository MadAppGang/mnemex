/**
 * Admin TUI Entry Point
 *
 * Starts the claudemem admin panel for API key management.
 * Mirrors the pattern of src/tui/index.tsx.
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { AdminApp } from "./AdminApp.js";

// ============================================================================
// Types
// ============================================================================

export interface AdminOptions {
	/** Cloud server URL, e.g. "https://cloud.claudemem.dev" */
	endpoint: string;
	/** Master API key value */
	masterKey: string;
}

// ============================================================================
// Entry
// ============================================================================

export async function startAdminTUI(options: AdminOptions): Promise<void> {
	if (!process.stdout.isTTY) {
		console.error("claudemem admin requires a TTY terminal");
		process.exit(1);
	}

	const renderer = await createCliRenderer({
		exitOnCtrlC: true,
		useAlternateScreen: false,
		useMouse: false,
		onDestroy: () => {
			process.exit(0);
		},
	});

	const quit = () => {
		root.unmount();
		renderer.destroy();
	};

	const root = createRoot(renderer);
	root.render(
		<AdminApp
			endpoint={options.endpoint}
			masterKey={options.masterKey}
			quit={quit}
		/>,
	);
}
