/**
 * MapView
 *
 * Repository map with collapsible file/symbol tree.
 * Shows PageRank scores for each symbol.
 *
 * Layout:
 *   Row 1: filter input
 *   Main:  SymbolTree (scrollable)
 */

import { useState, useEffect } from "react";
import { useKeyboard } from "@opentui/react";
import { useAppContext } from "../context.js";
import { useRepoMap } from "../hooks/useRepoMap.js";
import { SymbolTree } from "../components/SymbolTree.js";
import { theme } from "../theme.js";

// ============================================================================
// Component
// ============================================================================

export function MapView() {
	const {
		tracker,
		setActiveTab,
		pushNav,
		inputFocused,
		setInputFocused,
		activeTab,
	} = useAppContext();
	const {
		entries,
		filter,
		setFilter,
		expandedPaths,
		togglePath,
		loading,
		error,
		refresh,
	} = useRepoMap(tracker);

	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [filterFocused, setFilterFocused] = useState(false);

	// Sync inputFocused state
	useEffect(() => {
		if (activeTab === "map") {
			setInputFocused(filterFocused);
		}
		return () => {
			if (activeTab === "map") setInputFocused(false);
		};
	}, [filterFocused, activeTab, setInputFocused]);

	// Build flat list of navigable items for keyboard nav
	const navItems: Array<{ path: string; isFile: boolean }> = [];
	for (const entry of entries) {
		navItems.push({ path: entry.filePath, isFile: true });
		if (expandedPaths.has(entry.filePath)) {
			for (const sym of entry.symbols) {
				navItems.push({
					path: `${entry.filePath}:${sym.name}`,
					isFile: false,
				});
			}
		}
	}

	const currentNavIdx = navItems.findIndex(
		(item) => item.path === selectedPath,
	);

	useKeyboard((key) => {
		if (key.name === "escape") {
			if (filterFocused) {
				setFilterFocused(false);
			}
			return;
		}
		if (!filterFocused && key.name === "/") {
			setFilterFocused(true);
			return;
		}
		// When filter input is focused, let it handle keys
		if (filterFocused) return;

		if (key.name === "j" || key.name === "down") {
			const nextIdx = Math.min(currentNavIdx + 1, navItems.length - 1);
			setSelectedPath(navItems[nextIdx]?.path ?? null);
			return;
		}
		if (key.name === "k" || key.name === "up") {
			const prevIdx = Math.max(currentNavIdx - 1, 0);
			setSelectedPath(navItems[prevIdx]?.path ?? null);
			return;
		}
		// g: go to top
		if (key.name === "g") {
			setSelectedPath(navItems[0]?.path ?? null);
			return;
		}
		// G: go to bottom
		if (key.name === "G" || (key.shift && key.name === "g")) {
			setSelectedPath(navItems[navItems.length - 1]?.path ?? null);
			return;
		}
		// Enter or Right: expand file
		if (key.name === "return" || key.name === "right") {
			if (selectedPath) {
				// Only expand file-level paths
				const item = navItems[currentNavIdx];
				if (item?.isFile) {
					togglePath(selectedPath);
				} else if (selectedPath.includes(":")) {
					// It's a symbol, navigate to graph
					const symName = selectedPath.split(":").pop();
					if (symName) {
						pushNav(symName);
						setActiveTab("graph");
					}
				}
			}
			return;
		}
		// Left: collapse
		if (key.name === "left") {
			if (selectedPath && expandedPaths.has(selectedPath)) {
				togglePath(selectedPath);
			}
			return;
		}
		// s: navigate to graph for symbol
		if (key.name === "s") {
			const item = navItems[currentNavIdx];
			if (item && !item.isFile) {
				const symName = item.path.split(":").pop();
				if (symName) {
					pushNav(symName);
					setActiveTab("graph");
				}
			}
			return;
		}
		// r: refresh
		if (key.name === "r") {
			refresh();
			return;
		}
	});

	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Filter row */}
			<box flexDirection="row" height={1} paddingLeft={1} paddingRight={1}>
				<text fg={filterFocused ? theme.primary : theme.muted}>
					{"Filter: "}
				</text>
				<input
					value={filter}
					placeholder="path pattern..."
					onChange={setFilter}
					focused={filterFocused}
					width={30}
					textColor={theme.text}
				/>
				{!filterFocused && (
					<text fg={theme.dimmed}>{"  / filter  r refresh"}</text>
				)}
				{filterFocused && <text fg={theme.dimmed}>{"  Esc to navigate"}</text>}
				{loading && <text fg={theme.info}>{"  Loading..."}</text>}
			</box>

			{/* Error */}
			{error && (
				<box paddingLeft={1} height={1}>
					<text fg={theme.error}>{`Error: ${error}`}</text>
				</box>
			)}

			{/* Tree */}
			<box flexDirection="column" flexGrow={1} overflow="hidden">
				<SymbolTree
					entries={entries}
					expandedPaths={expandedPaths}
					onToggle={togglePath}
					selectedPath={selectedPath}
					onSelect={setSelectedPath}
				/>
			</box>
		</box>
	);
}
