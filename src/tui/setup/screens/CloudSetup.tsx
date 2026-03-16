/**
 * CloudSetup — cloud endpoint and credentials configuration screen.
 *
 * Multi-field form: cloudEndpoint, cloudApiKey (masked), orgSlug, repoSlug.
 * Tab/arrow navigation between fields. Auto-detects repoSlug from git remote.
 */

import { useState, useEffect } from "react";
import { useKeyboard } from "@opentui/react";
import { spawnSync } from "node:child_process";
import { theme } from "../../theme.js";
import type { ScreenProps } from "../types.js";

// ============================================================================
// Sub-components
// ============================================================================

function ShortcutItem({ letter, label }: { letter: string; label: string }) {
	return (
		<box flexDirection="row">
			<text fg={theme.shortcutBracket}>{"["}</text>
			<text fg={theme.shortcutKey}>{letter}</text>
			<text fg={theme.shortcutBracket}>{"]"}</text>
			<text fg={theme.muted}>{` ${label}  `}</text>
		</box>
	);
}

// ============================================================================
// Helpers
// ============================================================================

function detectRepoSlug(): string {
	try {
		const result = spawnSync("git", ["remote", "get-url", "origin"], {
			encoding: "utf8",
			timeout: 3000,
		});

		if (result.status !== 0 || !result.stdout.trim()) {
			return "";
		}

		const url = result.stdout.trim();
		// Parse GitHub/GitLab URLs
		// https://github.com/owner/repo.git -> owner/repo
		// git@github.com:owner/repo.git -> owner/repo
		const httpsMatch = url.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
		const sshMatch = url.match(/github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
		return httpsMatch?.[1] ?? sshMatch?.[1] ?? "";
	} catch {
		return "";
	}
}

// ============================================================================
// Field types
// ============================================================================

type FieldName = "cloudEndpoint" | "cloudApiKey" | "orgSlug" | "repoSlug";

const FIELDS: Array<{ name: FieldName; label: string; masked?: boolean }> = [
	{ name: "cloudEndpoint", label: "Cloud endpoint" },
	{ name: "cloudApiKey", label: "API key", masked: true },
	{ name: "orgSlug", label: "Org slug" },
	{ name: "repoSlug", label: "Repo slug" },
];

// ============================================================================
// Component
// ============================================================================

export function CloudSetupScreen({
	wizardState,
	onUpdate,
	onNext,
	onBack,
	onQuit,
}: ScreenProps) {
	const [focusedField, setFocusedField] = useState<FieldName>("cloudEndpoint");
	const [values, setValues] = useState<Record<FieldName, string>>({
		cloudEndpoint: wizardState.cloudEndpoint,
		cloudApiKey: wizardState.cloudApiKey,
		orgSlug: wizardState.orgSlug,
		repoSlug: wizardState.repoSlug,
	});
	const [editMode, setEditMode] = useState(false);

	// Auto-detect repo slug on mount
	useEffect(() => {
		if (!values.repoSlug) {
			const detected = detectRepoSlug();
			if (detected) {
				setValues((prev) => ({ ...prev, repoSlug: detected }));
			}
		}
	}, []);

	const focusedIndex = FIELDS.findIndex((f) => f.name === focusedField);

	useKeyboard((key) => {
		// Edit mode for current field
		if (editMode) {
			if (key.name === "escape") {
				setEditMode(false);
				return;
			}
			if (key.name === "return" || key.name === "enter") {
				setEditMode(false);
				// Move to next field
				const next = FIELDS[focusedIndex + 1];
				if (next) {
					setFocusedField(next.name);
					setEditMode(true);
				}
				return;
			}
			if (key.name === "backspace" || key.name === "delete") {
				setValues((prev) => ({
					...prev,
					[focusedField]: prev[focusedField].slice(0, -1),
				}));
				return;
			}
			if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
				setValues((prev) => ({
					...prev,
					[focusedField]: prev[focusedField] + key.sequence,
				}));
			}
			return;
		}

		// Navigation mode
		if (key.name === "j" || key.name === "down" || key.name === "tab") {
			const next = FIELDS[focusedIndex + 1];
			if (next) setFocusedField(next.name);
			return;
		}
		if (key.name === "k" || key.name === "up") {
			const prev = FIELDS[focusedIndex - 1];
			if (prev) setFocusedField(prev.name);
			return;
		}
		if (key.name === "e" || key.name === "return" || key.name === "enter") {
			if (key.name === "return" || key.name === "enter") {
				// If all required fields filled, proceed
				if (values.cloudEndpoint && values.orgSlug) {
					onUpdate({
						cloudEndpoint: values.cloudEndpoint,
						cloudApiKey: values.cloudApiKey,
						orgSlug: values.orgSlug,
						repoSlug: values.repoSlug,
					});
					onNext();
				} else {
					// Start editing first empty field
					const firstEmpty = FIELDS.find(
						(f) => f.name === "cloudEndpoint" || f.name === "orgSlug",
					);
					if (firstEmpty && !values[firstEmpty.name]) {
						setFocusedField(firstEmpty.name);
					}
					setEditMode(true);
				}
			} else {
				setEditMode(true);
			}
			return;
		}
		if (key.name === "escape") {
			onBack();
			return;
		}
		if (key.name === "q") {
			onQuit();
			return;
		}
	});

	const renderFieldValue = (field: (typeof FIELDS)[0]) => {
		const val = values[field.name];
		const isFocused = focusedField === field.name;
		const isEditing = isFocused && editMode;

		let display = val;
		if (field.masked && val.length > 0) {
			display =
				val.length > 10
					? `${val.slice(0, 4)}${"*".repeat(Math.min(val.length - 4, 16))}`
					: "*".repeat(val.length);
		}

		return (
			<box
				key={field.name}
				flexDirection="column"
				marginBottom={1}
				marginLeft={2}
				borderStyle="single"
				borderColor={isFocused ? theme.primary : theme.border}
				paddingLeft={2}
				paddingRight={2}
				paddingTop={1}
				paddingBottom={1}
			>
				<box flexDirection="row">
					<text fg={theme.labelDim}>{`${field.label.padEnd(18)}`}</text>
					<text fg={field.masked ? theme.secretBright : theme.valueBright}>
						{display}
					</text>
					{isEditing && <text fg={theme.primary}>{"_"}</text>}
					{!val && !isEditing && <text fg={theme.dimmed}>{"(empty)"}</text>}
					{val &&
						!isEditing &&
						field.name === "cloudApiKey" &&
						val.length > 10 && <text fg={theme.accentGreen}>{" [ok]"}</text>}
				</box>
				{isFocused && !editMode && (
					<box marginTop={1}>
						<text fg={theme.dimmed}>{"Press [e] or [Enter] to edit"}</text>
					</box>
				)}
			</box>
		);
	};

	const canProceed =
		values.cloudEndpoint.length > 0 && values.orgSlug.length > 0;

	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Header */}
			<box flexDirection="row" paddingLeft={1} paddingTop={1}>
				<text fg={theme.borderDim}>{"┌─"}</text>
				<text fg={theme.primary}>{" mnemex "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.muted}>{" Setup "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.dimmed}>{" Cloud Configuration "}</text>
				<text fg={theme.borderDim}>{"─┐"}</text>
			</box>

			<box paddingLeft={3} paddingTop={1}>
				<text fg={theme.dimmed}>
					{"Configure cloud endpoint and credentials:"}
				</text>
			</box>

			{/* Fields */}
			<box flexDirection="column" paddingLeft={1} paddingTop={2}>
				{FIELDS.map(renderFieldValue)}
			</box>

			{/* Help hint */}
			{!canProceed && (
				<box paddingLeft={3} paddingTop={1}>
					<text fg={theme.warning}>{"! "}</text>
					<text fg={theme.dimmed}>
						{"cloudEndpoint and orgSlug are required"}
					</text>
				</box>
			)}

			{/* Spacer */}
			<box flexGrow={1} />

			{/* Footer */}
			<box flexDirection="row" paddingLeft={1} paddingBottom={1}>
				<text fg={theme.borderDim}>{"└─ "}</text>
				<ShortcutItem letter="j/k" label="navigate" />
				<ShortcutItem letter="e" label="edit" />
				<ShortcutItem letter="Enter" label="confirm" />
				<ShortcutItem letter="Esc" label="back" />
				<ShortcutItem letter="q" label="quit" />
				<text fg={theme.borderDim}>{" ─┘"}</text>
			</box>
		</box>
	);
}
