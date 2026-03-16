/**
 * Setup TUI Entry Point
 *
 * Shows btop-inspired deployment mode diagrams first,
 * then launches the OpenTUI wizard for remaining steps.
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { SetupApp } from "./SetupApp.js";
import { selectMode } from "./mode-diagrams.js";

// ============================================================================
// Entry
// ============================================================================

export async function startSetupWizard(): Promise<void> {
	if (!process.stdout.isTTY) {
		throw new Error("mnemex setup requires an interactive terminal (TTY)");
	}

	// Phase 1: Show mode diagrams and collect selection (plain terminal)
	const selectedMode = await selectMode();

	// Phase 2: Launch OpenTUI wizard starting after mode-select
	const renderer = await createCliRenderer({
		exitOnCtrlC: true,
		useAlternateScreen: true,
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
	root.render(<SetupApp quit={quit} initialMode={selectedMode} />);
}
