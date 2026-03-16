/**
 * CreateKeyView — name input form + secret display after creation.
 *
 * Two sub-states:
 *   "input"  — text field for key name; Enter to create, Esc to cancel
 *   "secret" — shows the secret once; Enter or Escape to return to list
 */

import { useState, useEffect } from "react";
import { useKeyboard } from "@opentui/react";
import { execSync } from "node:child_process";
import { theme } from "../theme.js";

function copyToClipboard(text: string): boolean {
	try {
		execSync("pbcopy", { input: text });
		return true;
	} catch {
		return false;
	}
}

// ============================================================================
// Types
// ============================================================================

export interface CreateKeyViewProps {
	/** Secret shown after creation (null = still in input state) */
	newSecret: string | null;
	/** Name of the newly created key (for display) */
	newKeyName: string;
	loading: boolean;
	error: string | null;
	onCreate: (name: string) => void;
	onCancel: () => void;
	onDismissSecret: () => void;
}

// ============================================================================
// Component
// ============================================================================

export function CreateKeyView({
	newSecret,
	newKeyName,
	loading,
	error,
	onCreate,
	onCancel,
	onDismissSecret,
}: CreateKeyViewProps) {
	const [name, setName] = useState("");
	const [copied, setCopied] = useState(false);

	// Auto-copy secret to clipboard when it appears
	useEffect(() => {
		if (newSecret) {
			setCopied(copyToClipboard(newSecret));
		}
	}, [newSecret]);

	useKeyboard((key) => {
		// If showing secret, only Enter or Escape dismisses
		if (newSecret !== null) {
			if (
				key.name === "return" ||
				key.name === "enter" ||
				key.name === "escape"
			) {
				onDismissSecret();
			}
			return;
		}

		if (key.name === "escape") {
			onCancel();
			return;
		}

		if (key.name === "return" || key.name === "enter") {
			if (name.trim()) {
				onCreate(name.trim());
			}
			return;
		}

		if (key.name === "backspace" || key.name === "delete") {
			setName((prev) => prev.slice(0, -1));
			return;
		}

		// Printable characters
		if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
			setName((prev) => prev + key.sequence);
		}
	});

	// ── Secret display state ────────────────────────────────────────────────
	if (newSecret !== null) {
		return (
			<box flexDirection="column" width="100%" height="100%" padding={2}>
				{/* Section title */}
				<box flexDirection="row">
					<text fg={theme.borderDim}>{"┌─"}</text>
					<text fg={theme.primary}>{" Admin "}</text>
					<text fg={theme.borderDim}>{"─"}</text>
					<text fg={theme.muted}>{" Key Created "}</text>
					<text fg={theme.borderDim}>{"─┐"}</text>
				</box>

				{/* Key name confirmation */}
				<box flexDirection="row" marginTop={1} paddingLeft={2}>
					<text fg={theme.muted}>{"key  "}</text>
					<text fg={theme.valueBright}>{newKeyName}</text>
					<text fg={theme.accentGreen}>{"  created"}</text>
				</box>

				{/* Warning box for secret */}
				<box
					flexDirection="column"
					marginTop={2}
					borderStyle="double"
					borderColor={theme.warning}
					paddingLeft={2}
					paddingRight={2}
					paddingTop={1}
					paddingBottom={1}
				>
					<box flexDirection="row">
						<text fg={theme.warning}>{"! WARNING  "}</text>
						<text fg={theme.dangerText}>
							{"This secret will NOT be shown again"}
						</text>
					</box>

					<box marginTop={1} flexDirection="row">
						<text fg={theme.muted}>{"secret  "}</text>
						<text fg={theme.secretBright}>{newSecret}</text>
					</box>

					{copied && (
						<box marginTop={1} flexDirection="row">
							<text fg={theme.accentGreen}>{"  copied to clipboard"}</text>
						</box>
					)}
					{!copied && (
						<box marginTop={1} flexDirection="row">
							<text fg={theme.dimmed}>
								{"  clipboard unavailable — copy manually"}
							</text>
						</box>
					)}
				</box>

				{/* Dismiss hint — very dim */}
				<box marginTop={2} paddingLeft={1}>
					<text fg={theme.borderDim}>{"└─ "}</text>
					<text fg={theme.dimmed}>{"press "}</text>
					<text fg={theme.labelDim}>{"Enter"}</text>
					<text fg={theme.dimmed}>{" or "}</text>
					<text fg={theme.labelDim}>{"Esc"}</text>
					<text fg={theme.dimmed}>{" to return to list"}</text>
					<text fg={theme.borderDim}>{" ─┘"}</text>
				</box>
			</box>
		);
	}

	// ── Input state ─────────────────────────────────────────────────────────
	return (
		<box flexDirection="column" width="100%" height="100%" padding={2}>
			{/* Section title */}
			<box flexDirection="row">
				<text fg={theme.borderDim}>{"┌─"}</text>
				<text fg={theme.primary}>{" Admin "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.muted}>{" Create API Key "}</text>
				<text fg={theme.borderDim}>{"─┐"}</text>
			</box>

			{/* Input field */}
			<box
				flexDirection="column"
				marginTop={2}
				borderStyle="single"
				borderColor={name.length > 0 ? theme.primary : theme.border}
				paddingLeft={2}
				paddingRight={2}
				paddingTop={1}
				paddingBottom={1}
			>
				<box flexDirection="row">
					<text fg={theme.labelDim}>{"key name  "}</text>
					<text fg={theme.valueBright}>{name}</text>
					<text fg={theme.primary}>{"_"}</text>
				</box>
			</box>

			{/* Error */}
			{error && (
				<box flexDirection="row" marginTop={1} paddingLeft={1}>
					<text fg={theme.error}>{"! "}</text>
					<text fg={theme.dangerText}>{error}</text>
				</box>
			)}

			{/* Loading */}
			{loading && (
				<box marginTop={1} paddingLeft={1}>
					<text fg={theme.muted}>{"  creating..."}</text>
				</box>
			)}

			{/* Spacer */}
			<box flexGrow={1} />

			{/* Footer */}
			<box flexDirection="row" paddingLeft={1}>
				<text fg={theme.borderDim}>{"└─ "}</text>
				<text fg={theme.shortcutBracket}>{"["}</text>
				<text fg={theme.shortcutKey}>{"Enter"}</text>
				<text fg={theme.shortcutBracket}>{"]"}</text>
				<text fg={theme.muted}>{" create  "}</text>
				<text fg={theme.shortcutBracket}>{"["}</text>
				<text fg={theme.shortcutKey}>{"Esc"}</text>
				<text fg={theme.shortcutBracket}>{"]"}</text>
				<text fg={theme.muted}>{" cancel"}</text>
				<text fg={theme.borderDim}>{" ─┘"}</text>
			</box>
		</box>
	);
}
