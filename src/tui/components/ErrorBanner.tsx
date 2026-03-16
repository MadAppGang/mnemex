/**
 * ErrorBanner Component
 *
 * Dismissible error message with auto-dismiss after 5 seconds.
 * Shows with red border and error styling.
 */

import { useEffect } from "react";
import { theme } from "../theme.js";

// ============================================================================
// Props
// ============================================================================

export interface ErrorBannerProps {
	message: string;
	onDismiss: () => void;
}

// ============================================================================
// Component
// ============================================================================

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
	// Auto-dismiss after 5 seconds
	useEffect(() => {
		const timer = setTimeout(() => {
			onDismiss();
		}, 5000);

		return () => clearTimeout(timer);
	}, [message, onDismiss]);

	return (
		<box
			position="absolute"
			bottom={1}
			left={2}
			right={2}
			flexDirection="row"
			borderStyle="single"
			borderColor={theme.error}
			padding={0}
			paddingLeft={1}
			paddingRight={1}
		>
			<text fg={theme.error}>{"Error: "}</text>
			<text fg={theme.text}>{message}</text>
			<text fg={theme.dimmed}>{" (press any key to dismiss)"}</text>
		</box>
	);
}
