/**
 * CloudWarning — warning screen for Full Cloud mode.
 *
 * Explains that source code will be transmitted to the cloud.
 * Requires explicit y confirmation to proceed.
 * n or Esc goes back to mode select.
 */

import { useKeyboard } from "@opentui/react";
import { theme } from "../../theme.js";
import type { ScreenProps } from "../types.js";

// ============================================================================
// Component
// ============================================================================

export function CloudWarningScreen({ onNext, onBack, onQuit }: ScreenProps) {
	useKeyboard((key) => {
		if (key.name === "y") {
			onNext();
			return;
		}
		if (key.name === "n" || key.name === "escape") {
			onBack();
			return;
		}
		if (key.name === "q") {
			onQuit();
			return;
		}
	});

	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Header */}
			<box flexDirection="row" paddingLeft={1} paddingTop={1}>
				<text fg={theme.dangerBorder}>{"┌─"}</text>
				<text fg={theme.error}>{" ! "}</text>
				<text fg={theme.dangerText}>{" Full Cloud Mode Warning "}</text>
				<text fg={theme.dangerBorder}>{"─┐"}</text>
			</box>

			{/* Warning box */}
			<box
				flexDirection="column"
				marginTop={2}
				marginLeft={2}
				marginRight={2}
				borderStyle="double"
				borderColor={theme.dangerBorder}
				paddingLeft={3}
				paddingRight={3}
				paddingTop={1}
				paddingBottom={1}
			>
				<box flexDirection="row">
					<text fg={theme.warning}>{"! CODE TRANSMISSION WARNING"}</text>
				</box>

				<box marginTop={2}>
					<text fg={theme.text}>
						{"In Full Cloud mode, your source code is transmitted to and"}
					</text>
				</box>
				<box>
					<text fg={theme.text}>
						{"processed by the cloud server for indexing."}
					</text>
				</box>

				<box marginTop={2}>
					<text fg={theme.labelDim}>{"What is transmitted:"}</text>
				</box>
				<box flexDirection="row" paddingLeft={2}>
					<text fg={theme.error}>{"• "}</text>
					<text fg={theme.text}>
						{"Full source code content of indexed files"}
					</text>
				</box>
				<box flexDirection="row" paddingLeft={2}>
					<text fg={theme.error}>{"• "}</text>
					<text fg={theme.text}>{"File paths and directory structure"}</text>
				</box>
				<box flexDirection="row" paddingLeft={2}>
					<text fg={theme.error}>{"• "}</text>
					<text fg={theme.text}>{"Symbol names, function signatures"}</text>
				</box>

				<box marginTop={2}>
					<text fg={theme.labelDim}>
						{"Alternatives that keep code local:"}
					</text>
				</box>
				<box flexDirection="row" paddingLeft={2}>
					<text fg={theme.accentGreen}>{"• "}</text>
					<text fg={theme.text}>{"Local mode — 100% on-device"}</text>
				</box>
				<box flexDirection="row" paddingLeft={2}>
					<text fg={theme.accentGreen}>{"• "}</text>
					<text fg={theme.text}>
						{"Shared mode — only vectors transmitted"}
					</text>
				</box>

				<box marginTop={2} flexDirection="row">
					<text fg={theme.dimmed}>
						{"By continuing, you confirm that you are"}
					</text>
				</box>
				<box>
					<text fg={theme.dimmed}>
						{
							"authorized to transmit this code to the configured cloud endpoint."
						}
					</text>
				</box>
			</box>

			{/* Spacer */}
			<box flexGrow={1} />

			{/* Footer */}
			<box flexDirection="row" paddingLeft={1} paddingBottom={1}>
				<text fg={theme.dangerBorder}>{"└─ "}</text>
				<text fg={theme.shortcutBracket}>{"["}</text>
				<text fg={theme.error}>{"y"}</text>
				<text fg={theme.shortcutBracket}>{"]"}</text>
				<text fg={theme.dangerText}>{" I understand, continue  "}</text>
				<text fg={theme.shortcutBracket}>{"["}</text>
				<text fg={theme.shortcutKey}>{"n"}</text>
				<text fg={theme.shortcutBracket}>{"]"}</text>
				<text fg={theme.muted}>{" go back  "}</text>
				<text fg={theme.shortcutBracket}>{"["}</text>
				<text fg={theme.shortcutKey}>{"q"}</text>
				<text fg={theme.shortcutBracket}>{"]"}</text>
				<text fg={theme.muted}>{" quit"}</text>
				<text fg={theme.dangerBorder}>{" ─┘"}</text>
			</box>
		</box>
	);
}
