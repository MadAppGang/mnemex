/**
 * SearchView
 *
 * Main search interface with live query input, filter options,
 * and expandable result cards.
 *
 * Focus model:
 *   - Input starts focused (ready to type)
 *   - Escape unfocuses input (enables j/k/o/l shortcuts)
 *   - / or Enter refocuses input
 *
 * Layout:
 *   Row 1: search input
 *   Row 2: options bar (language, sort)
 *   Main:  ResultList (scrollable)
 */

import { useState, useEffect } from "react";
import { useKeyboard } from "@opentui/react";
import { useAppContext } from "../context.js";
import { useSearch } from "../hooks/useSearch.js";

import { ResultList } from "../components/ResultList.js";
import { ResultDetailView } from "../components/ResultDetailView.js";
import { theme } from "../theme.js";

// ============================================================================
// Component
// ============================================================================

export function SearchView() {
	const {
		projectPath,
		setActiveTab,
		pushNav,
		inputFocused,
		setInputFocused,
		activeTab,
	} = useAppContext();
	const {
		query,
		setQuery,
		results,
		loading,
		error,
		selectedIndex,
		setSelectedIndex,
		expandedIndex,
		toggleExpanded,
		sortOrder,
		setSortOrder,
		language,
		setLanguage,
	} = useSearch(projectPath);

	const [detailIndex, setDetailIndex] = useState<number | null>(null);

	// Auto-focus input when entering search tab
	useEffect(() => {
		if (activeTab === "search") {
			setInputFocused(true);
		}
		return () => {
			// Unfocus when leaving this tab
			setInputFocused(false);
		};
	}, [activeTab, setInputFocused]);

	// Keyboard navigation
	useKeyboard((key) => {
		// Escape: unfocus input to enable shortcuts
		if (key.name === "escape") {
			if (inputFocused) {
				setInputFocused(false);
			}
			return;
		}

		// / or i: focus input for typing
		if (!inputFocused && (key.name === "/" || key.name === "i")) {
			setInputFocused(true);
			return;
		}

		// Arrow keys: auto-unfocus input and navigate results
		if (
			inputFocused &&
			results.length > 0 &&
			(key.name === "down" || key.name === "up")
		) {
			setInputFocused(false);
			if (key.name === "down") {
				setSelectedIndex(Math.min(selectedIndex + 1, results.length - 1));
			} else {
				setSelectedIndex(Math.max(selectedIndex - 1, 0));
			}
			return;
		}

		// When input is focused, let the <input> handle everything else
		if (inputFocused) {
			return;
		}

		// --- Shortcuts only work when input is NOT focused ---

		if (key.name === "j" || key.name === "down") {
			setSelectedIndex(Math.min(selectedIndex + 1, results.length - 1));
			return;
		}
		if (key.name === "k" || key.name === "up") {
			setSelectedIndex(Math.max(selectedIndex - 1, 0));
			return;
		}
		if (key.name === "return" || key.name === "space") {
			if (results.length > 0) {
				setDetailIndex(selectedIndex);
			}
			return;
		}
		// s: navigate to Graph view for selected symbol
		if (key.name === "s") {
			const result = results[selectedIndex];
			if (result?.chunk.name) {
				pushNav(result.chunk.name);
				setActiveTab("graph");
			}
			return;
		}
		// cycle sort orders with o
		if (key.name === "o") {
			const orders = ["score", "file", "name"] as const;
			const idx = orders.indexOf(sortOrder);
			setSortOrder(orders[(idx + 1) % orders.length]);
			return;
		}
		// clear language filter with l
		if (key.name === "l") {
			setLanguage(language ? null : "typescript");
			return;
		}
	});

	// When a result is selected for detail view, render the detail component
	if (detailIndex !== null && results[detailIndex]) {
		return (
			<ResultDetailView
				result={results[detailIndex]}
				allResults={results}
				onClose={() => setDetailIndex(null)}
				onNavigate={(newIndex) => setDetailIndex(newIndex)}
			/>
		);
	}

	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Search input row */}
			<box flexDirection="row" height={1} paddingLeft={1} paddingRight={1}>
				<text fg={inputFocused ? theme.primary : theme.muted}>
					{inputFocused ? "/ " : "> "}
				</text>
				<input
					value={query}
					placeholder="search query..."
					onChange={setQuery}
					focused={inputFocused}
					width="100%"
					textColor={theme.text}
				/>
				{!inputFocused && <text fg={theme.dimmed}>{"  (/ to type)"}</text>}
			</box>

			{/* Options row */}
			<box flexDirection="row" height={1} paddingLeft={1} paddingRight={1}>
				<text fg={theme.muted}>{"Sort: "}</text>
				<text fg={theme.info}>{sortOrder}</text>
				{!inputFocused && <text fg={theme.dimmed}>{"  (o)  "}</text>}
				{inputFocused && <text fg={theme.dimmed}>{"       "}</text>}
				<text fg={theme.muted}>{"  Lang: "}</text>
				<text fg={language ? theme.warning : theme.dimmed}>
					{language ?? "any"}
				</text>
				{!inputFocused && <text fg={theme.dimmed}>{"  (l)  "}</text>}
				{loading && <text fg={theme.info}>{"  Searching..."}</text>}
				{!loading && results.length > 0 && (
					<text fg={theme.muted}>{`  Results: ${results.length}`}</text>
				)}
			</box>

			{/* Mode indicator */}
			{inputFocused && (
				<box paddingLeft={1} height={1}>
					<text fg={theme.dimmed}>
						{"Type to search • Esc to navigate results • Tab to switch view"}
					</text>
				</box>
			)}

			{/* Error display */}
			{error && (
				<box paddingLeft={1} height={1}>
					<text fg={theme.error}>{`Error: ${error}`}</text>
				</box>
			)}

			{/* Results */}
			{!loading && !error && query.trim() === "" && (
				<box padding={2}>
					<text fg={theme.muted}>
						{inputFocused
							? "Start typing to search indexed code..."
							: "Press / to start searching..."}
					</text>
				</box>
			)}

			{!loading && !error && query.trim() !== "" && results.length === 0 && (
				<box padding={2}>
					<text fg={theme.muted}>{"No results found."}</text>
				</box>
			)}

			{results.length > 0 && (
				<box flexDirection="column" flexGrow={1} overflow="hidden">
					<ResultList
						results={results}
						query={query}
						selectedIndex={selectedIndex}
						expandedIndex={expandedIndex}
						onSelect={setSelectedIndex}
						onToggleExpand={toggleExpanded}
					/>
				</box>
			)}
		</box>
	);
}
