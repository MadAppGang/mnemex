/**
 * AdminApp — root component for the mnemex admin TUI.
 *
 * State machine:
 *   "list"           — shows KeyListView
 *   "create"         — shows CreateKeyView (input form)
 *   "delete-confirm" — shows delete confirmation overlay over KeyListView
 */

import { useState, useEffect, useCallback } from "react";
import { useKeyboard } from "@opentui/react";
import { AdminApiClient, type ApiKey } from "./AdminApiClient.js";
import { KeyListView } from "./KeyListView.js";
import { CreateKeyView } from "./CreateKeyView.js";
import { theme } from "../theme.js";

// ============================================================================
// Types
// ============================================================================

type AdminView = "list" | "create" | "delete-confirm";

export interface AdminAppProps {
	endpoint: string;
	masterKey: string;
	quit: () => void;
}

// ============================================================================
// Component
// ============================================================================

export function AdminApp({ endpoint, masterKey, quit }: AdminAppProps) {
	const [client] = useState(() => new AdminApiClient(endpoint, masterKey));

	const [view, setView] = useState<AdminView>("list");
	const [keys, setKeys] = useState<ApiKey[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [newSecret, setNewSecret] = useState<string | null>(null);
	const [newKeyName, setNewKeyName] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [createLoading, setCreateLoading] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);

	const loadKeys = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const list = await client.listKeys();
			setKeys(list);
			setSelectedIndex((prev) => Math.min(prev, Math.max(list.length - 1, 0)));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [endpoint, masterKey]);

	// Load keys on mount
	useEffect(() => {
		loadKeys();
	}, [loadKeys]);

	// Delete confirmation keyboard
	useKeyboard((key) => {
		if (view !== "delete-confirm") return;

		if (key.name === "y") {
			const selectedKey = keys[selectedIndex];
			if (!selectedKey) return;
			setView("list");
			client
				.deleteKey(selectedKey.id)
				.then(() => loadKeys())
				.catch((err: unknown) => {
					setError(err instanceof Error ? err.message : String(err));
				});
			return;
		}

		if (key.name === "n" || key.name === "escape") {
			setView("list");
			return;
		}
	});

	const handleCreate = async (name: string) => {
		setCreateLoading(true);
		setCreateError(null);
		try {
			const result = await client.createKey(name);
			setNewSecret(result.secret);
			setNewKeyName(result.key.name);
			await loadKeys();
		} catch (err) {
			setCreateError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreateLoading(false);
		}
	};

	const handleDismissSecret = () => {
		setNewSecret(null);
		setNewKeyName("");
		setView("list");
	};

	const selectedKey = keys[selectedIndex];

	// Delete confirmation — standalone screen
	if (view === "delete-confirm" && selectedKey) {
		return (
			<box flexDirection="column" width="100%" height="100%" padding={2}>
				{/* Title bar */}
				<box flexDirection="row">
					<text fg={theme.dangerBorder}>{"┌─"}</text>
					<text fg={theme.error}>{" ! "}</text>
					<text fg={theme.dangerText}>{" Delete API Key "}</text>
					<text fg={theme.dangerBorder}>{"─┐"}</text>
				</box>

				{/* Dialog body */}
				<box
					flexDirection="column"
					marginTop={1}
					borderStyle="double"
					borderColor={theme.dangerBorder}
					paddingLeft={3}
					paddingRight={3}
					paddingTop={1}
					paddingBottom={1}
				>
					<box>
						<text fg={theme.text}>
							{"Are you sure you want to delete this key?"}
						</text>
					</box>

					<box marginTop={1} flexDirection="row">
						<text fg={theme.labelDim}>{"  name    "}</text>
						<text fg={theme.valueBright}>{selectedKey.name}</text>
					</box>
					<box flexDirection="row">
						<text fg={theme.labelDim}>{"  prefix  "}</text>
						<text fg={theme.muted}>{selectedKey.prefix}</text>
					</box>

					<box marginTop={1} flexDirection="row">
						<text fg={theme.error}>{"  ! "}</text>
						<text fg={theme.dimmed}>
							{"This action cannot be undone. All usage data will be lost."}
						</text>
					</box>
				</box>

				{/* Choices */}
				<box flexDirection="row" marginTop={2} paddingLeft={1}>
					<text fg={theme.dangerBorder}>{"└─ "}</text>
					<text fg={theme.shortcutBracket}>{"["}</text>
					<text fg={theme.error}>{"y"}</text>
					<text fg={theme.shortcutBracket}>{"]"}</text>
					<text fg={theme.dangerText}>{" yes, delete  "}</text>
					<text fg={theme.shortcutBracket}>{"["}</text>
					<text fg={theme.shortcutKey}>{"n"}</text>
					<text fg={theme.shortcutBracket}>{"]"}</text>
					<text fg={theme.muted}>{" cancel  "}</text>
					<text fg={theme.shortcutBracket}>{"["}</text>
					<text fg={theme.shortcutKey}>{"Esc"}</text>
					<text fg={theme.shortcutBracket}>{"]"}</text>
					<text fg={theme.muted}>{" cancel"}</text>
					<text fg={theme.dangerBorder}>{" ─┘"}</text>
				</box>
			</box>
		);
	}

	if (view === "create") {
		return (
			<CreateKeyView
				newSecret={newSecret}
				newKeyName={newKeyName}
				loading={createLoading}
				error={createError}
				onCreate={handleCreate}
				onCancel={() => {
					setCreateError(null);
					setView("list");
				}}
				onDismissSecret={handleDismissSecret}
			/>
		);
	}

	return (
		<KeyListView
			endpoint={endpoint}
			keys={keys}
			selectedIndex={selectedIndex}
			loading={loading}
			error={error}
			onSelect={setSelectedIndex}
			onNew={() => {
				setCreateError(null);
				setNewSecret(null);
				setView("create");
			}}
			onDelete={() => {
				if (keys.length > 0) setView("delete-confirm");
			}}
			onRefresh={loadKeys}
			onQuit={quit}
		/>
	);
}
