/**
 * claudemem CLI
 *
 * Command-line interface for code indexing and search.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { confirm, input, select } from "@inquirer/prompts";
import inquirerSearch from "@inquirer/search";
import {
	type AgentRole,
	VALID_ROLES,
	getCompactInstructions,
	getInstructions,
	listRoles,
} from "./ai-instructions.js";
import {
	CLAUDEMEM_MCP_SKILL,
	CLAUDEMEM_QUICK_REF,
	CLAUDEMEM_SKILL,
	CLAUDEMEM_SKILL_COMPACT,
	getCompactSkillWithRole,
	getFullSkillWithRole,
} from "./ai-skill.js";
import {
	ENV,
	getAnthropicApiKey,
	getApiKey,
	getContext7ApiKey,
	getEmbeddingModel,
	getLLMSpec,
	getVoyageApiKey,
	hasApiKey,
	isLearningEnabled,
	isVectorEnabled,
	loadGlobalConfig,
	saveGlobalConfig,
} from "./config.js";
import { canChunkFile, chunkFileByPath } from "./core/chunker.js";
// Note: createIndexer imports store.js which loads LanceDB - made lazy to avoid startup errors
// Use: const { createIndexer } = await import("./core/indexer.js");
import {
	createEmbeddingsClient,
	getModelContextLength,
	truncateForModel,
} from "./core/embeddings.js";
import { createReferenceGraphManager } from "./core/reference-graph.js";
// Note: createVectorStore is imported lazily to avoid loading LanceDB on startup
// Use: const { createVectorStore } = await import("./core/store.js");
import { createRepoMapGenerator } from "./core/repo-map.js";
import { FileTracker } from "./core/tracker.js";
import {
	CURATED_PICKS,
	RECOMMENDED_MODELS,
	discoverEmbeddingModels,
	formatModelInfo,
} from "./models/model-discovery.js";
// Note: learning module is imported lazily to avoid startup errors
// Use: const { createLearningSystem } = await import("./learning/index.js");
import {
	type CellValue,
	type TableColumn,
	createBenchmarkProgress,
	formatContextLength,
	formatCost,
	formatDuration,
	formatElapsed,
	formatPercent,
	getHighlight,
	getLogo,
	printLogo as printLogoUI,
	renderError,
	renderHeader,
	renderInfo,
	renderSuccess,
	renderSummary,
	renderTable,
	truncate,
} from "./ui/index.js";

// ============================================================================
// Version & Branding
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
	readFileSync(join(__dirname, "../package.json"), "utf-8"),
);
const VERSION = packageJson.version;

/** Global flag for agent mode (--agent): no logo, plain output, compact format */
let agentMode = false;

/** Print logo for interactive commands */
function printLogo(): void {
	if (!agentMode) {
		printLogoUI();
	}
}

/** Check if running in agent/compact mode */
function isAgentMode(): boolean {
	return (
		agentMode ||
		// Claude Code
		process.env.CLAUDECODE === "1" ||
		process.env.CLAUDE_CODE_ENTRYPOINT !== undefined ||
		// OpenCode and other AI coding tools
		process.env.OPENCODE === "1" ||
		// Standard non-interactive indicators
		process.env.NO_COLOR !== undefined ||
		process.env.TERM === "dumb" ||
		process.env.CI === "true" ||
		// Not a TTY (piped, redirected, etc.)
		!process.stdout.isTTY
	);
}

/** Print compact help for AI agents (3 lines) */
function printCompactHelp(): void {
	console.log(`claudemem v${VERSION} - Semantic code search with AST analysis`);
	console.log(
		"Commands: index search map symbol callers callees context dead-code test-gaps impact hook update",
	);
	console.log(
		"Use: claudemem --agent <cmd> | Docs: https://github.com/MadAppGang/claudemem",
	);
}

// ============================================================================
// Compact Output for Claude Code (3 lines max, no animations)
// ============================================================================

/** Compact output: 3 lines for AI agents */
function compactOutput(line1: string, line2: string, line3: string): void {
	console.log(line1);
	console.log(line2);
	console.log(line3);
}

/** Format file path compactly */
function compactPath(path: string, maxLen = 40): string {
	if (path.length <= maxLen) return path;
	const parts = path.split("/");
	if (parts.length <= 2) return path.slice(-maxLen);
	return `...${path.slice(-(maxLen - 3))}`;
}

/** Format duration compactly */
function compactDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60000).toFixed(1)}m`;
}

// ============================================================================
// CLI Entry Point
// ============================================================================

export async function runCli(args: string[]): Promise<void> {
	// Parse --agent flag: enables compact output for AI agents/tools
	// This replaces --nologo, --raw, --plain with a single flag
	if (args.includes("--agent")) {
		agentMode = true;
		args = args.filter((a) => a !== "--agent");
	}

	// Auto-enable agent mode in AI/non-TTY environments
	if (isAgentMode()) {
		agentMode = true;
	}

	// Parse command
	const command = args[0];

	// Handle global flags
	// Note: -v is reserved for --verbose in subcommands, use --version only for version
	if (args.includes("--version")) {
		console.log(`claudemem v${VERSION}`);

		// Async check for updates (non-blocking with timeout)
		const { UpdateManager } = await import("./updater/index.js");
		const updater = new UpdateManager();

		try {
			// Try to check for update with 2s timeout
			const check = await Promise.race([
				updater.checkForUpdate(),
				new Promise<null>((_, reject) =>
					setTimeout(() => reject(new Error("timeout")), 2000),
				),
			]);

			if (check?.isUpdateAvailable) {
				console.log(`\nUpdate available: v${check.latestVersion}`);
				console.log("Run: \x1b[36mclaudemem update\x1b[0m");
			}
		} catch {
			// Silently ignore errors (offline, timeout, etc.)
		}

		return;
	}

	if (args.includes("--help") || args.includes("-h") || !command) {
		if (isAgentMode()) {
			printCompactHelp();
		} else {
			printHelp();
		}
		return;
	}

	// Handle --models as global flag
	if (args.includes("--models")) {
		const remainingArgs = args.filter((a) => a !== "--models");
		await handleModels(remainingArgs);
		return;
	}

	// Route to command handler
	switch (command) {
		case "index":
			await handleIndex(args.slice(1));
			break;
		case "search":
			await handleSearch(args.slice(1));
			break;
		case "status":
			await handleStatus(args.slice(1));
			break;
		case "clear":
			await handleClear(args.slice(1));
			break;
		case "init":
			await handleInit();
			break;
		case "models":
			await handleModels(args.slice(1));
			break;
		case "benchmark":
			await handleBenchmark(args.slice(1));
			break;
		case "benchmark-llm":
			await handleBenchmarkLLM(args.slice(1));
			break;
		case "benchmark-list":
			await handleBenchmarkList(args.slice(1));
			break;
		case "benchmark-show":
			await handleBenchmarkShow(args.slice(1));
			break;
		case "ai":
			handleAiInstructions(args.slice(1));
			break;
		// Symbol graph commands for AI agents
		case "map":
			await handleMap(args.slice(1));
			break;
		case "symbol":
			await handleSymbol(args.slice(1));
			break;
		case "callers":
			await handleCallers(args.slice(1));
			break;
		case "callees":
			await handleCallees(args.slice(1));
			break;
		case "context":
			await handleContext(args.slice(1));
			break;
		// Code analysis commands
		case "dead-code":
			await handleDeadCode(args.slice(1));
			break;
		case "test-gaps":
			await handleTestGaps(args.slice(1));
			break;
		case "impact":
			await handleImpact(args.slice(1));
			break;
		// Developer experience commands
		case "watch":
			await handleWatch(args.slice(1));
			break;
		case "hooks":
			await handleHooks(args.slice(1));
			break;
		case "hook":
			// Claude Code hook handler - reads JSON from stdin
			await handleHookCommand(args.slice(1));
			break;
		case "install":
			await handleInstall(args.slice(1));
			break;
		// Documentation commands
		case "docs":
			await handleDocs(args.slice(1));
			break;
		// Learning commands
		case "feedback":
			await handleFeedback(args.slice(1));
			break;
		case "learn":
			await handleLearn(args.slice(1));
			break;
		// Update command
		case "update":
			await handleUpdate(args.slice(1));
			break;
		default:
			// Check if it looks like a search query
			if (!command.startsWith("-")) {
				await handleSearch(args);
			} else {
				console.error(`Unknown command: ${command}`);
				console.error('Run "claudemem --help" for usage information.');
				process.exit(1);
			}
	}
}

// ============================================================================
// Command Handlers
// ============================================================================

// Note: formatElapsed and createBenchmarkProgress are imported from ./ui/index.js

/** Animation frames for indexing progress (local copy for createProgressRenderer) */
const INDEX_ANIM_FRAMES = ["▓", "▒", "░", "▒"];

/** Phase state for parallel phase tracking */
interface PhaseState {
	completed: number;
	total: number;
	inProgress: number;
	detail: string;
	startTime: number;
	isComplete: boolean;
	/** Frozen duration when phase completes (ms) */
	finalDuration?: number;
}

/** Create a progress renderer with support for parallel phases */
function createProgressRenderer() {
	const globalStartTime = Date.now();
	let animFrame = 0;
	let interval: ReturnType<typeof setInterval> | null = null;
	let maxLinesWritten = 0; // Track MAXIMUM lines ever written (for cursor movement)

	// Track multiple phases simultaneously (for parallel execution)
	const phases = new Map<string, PhaseState>();
	// Order phases appeared (for consistent rendering order)
	const phaseOrder: string[] = [];

	function renderLine(
		elapsed: string,
		bar: string,
		percent: number,
		phase: string,
		detail: string,
	) {
		return `⏱ ${elapsed} │ ${bar} ${percent.toString().padStart(3)}% │ ${phase.padEnd(16)} │ ${detail}`;
	}

	function buildBar(completed: number, total: number, inProgress: number) {
		const width = 20;
		const filledRatio = total > 0 ? completed / total : 0;
		const inProgressRatio = total > 0 ? inProgress / total : 0;

		const filledWidth = Math.round(filledRatio * width);
		const inProgressWidth = Math.min(
			Math.round(inProgressRatio * width),
			width - filledWidth,
		);
		const emptyWidth = width - filledWidth - inProgressWidth;

		const filled = "█".repeat(filledWidth);
		let animated = "";
		for (let i = 0; i < inProgressWidth; i++) {
			const charIndex = (animFrame + i) % INDEX_ANIM_FRAMES.length;
			animated += INDEX_ANIM_FRAMES[charIndex];
		}
		const empty = "░".repeat(emptyWidth);
		return filled + animated + empty;
	}

	function render() {
		animFrame = (animFrame + 1) % INDEX_ANIM_FRAMES.length;

		// Calculate how many lines we'll write THIS render (phases + total)
		const linesToWrite = phaseOrder.length + 1;

		// Move cursor up by the MAXIMUM lines ever written (not current count)
		// This ensures we always start from the same position
		if (maxLinesWritten > 0) {
			process.stdout.write(`\x1b[${maxLinesWritten}A`);
		}

		// Render each phase in order
		for (const phaseName of phaseOrder) {
			const phase = phases.get(phaseName)!;
			const percent =
				phase.total > 0 ? Math.round((phase.completed / phase.total) * 100) : 0;
			const bar = phase.isComplete
				? "█".repeat(20)
				: buildBar(phase.completed, phase.total, phase.inProgress);
			// Use frozen duration for completed phases, live duration for active
			const elapsed =
				phase.isComplete && phase.finalDuration !== undefined
					? formatElapsed(phase.finalDuration)
					: formatElapsed(Date.now() - phase.startTime);
			const detail = phase.isComplete ? "done" : phase.detail;

			process.stdout.write(
				`\r${renderLine(elapsed, bar, percent, phaseName, detail)}\x1b[K\n`,
			);
		}

		// Render total line
		const totalElapsed = formatElapsed(Date.now() - globalStartTime);
		process.stdout.write(`\r\x1b[2m⏱ ${totalElapsed} total\x1b[0m\x1b[K\n`);

		// Update max lines (phases can only increase, so this tracks growth)
		maxLinesWritten = Math.max(maxLinesWritten, linesToWrite);
	}

	return {
		start() {
			interval = setInterval(render, 100);
			if (interval.unref) interval.unref();
		},
		update(completed: number, total: number, detail: string, inProgress = 0) {
			// Match phase names including spaces, e.g. [file summaries]
			const phaseMatch = detail.match(/^\[([^\]]+)\]/);
			const phaseName = phaseMatch ? phaseMatch[1] : "processing";
			const cleanDetail = detail.replace(/^\[[^\]]+\]\s*/, "");

			// Create or update phase
			if (!phases.has(phaseName)) {
				phases.set(phaseName, {
					completed: 0,
					total: 0,
					inProgress: 0,
					detail: "",
					startTime: Date.now(),
					isComplete: false,
				});
				phaseOrder.push(phaseName);
			}

			const phase = phases.get(phaseName)!;

			// Only update if not already complete (don't regress)
			if (!phase.isComplete) {
				phase.completed = completed;
				phase.total = total;
				phase.inProgress = inProgress;
				phase.detail = cleanDetail;

				// Mark complete when 100% and no in-progress items
				if (completed >= total && total > 0 && inProgress === 0) {
					phase.isComplete = true;
					// Freeze the elapsed time
					phase.finalDuration = Date.now() - phase.startTime;
				}
			}
		},
		stop() {
			if (interval) {
				clearInterval(interval);
				interval = null;
			}
		},
		finish() {
			this.stop();

			// Mark all phases as complete with frozen durations
			for (const phase of phases.values()) {
				if (!phase.isComplete) {
					phase.finalDuration = Date.now() - phase.startTime;
				}
				phase.isComplete = true;
				phase.completed = phase.total;
				phase.inProgress = 0;
			}

			// Final render - use maxLinesWritten to properly overwrite all previous lines
			animFrame = 0;
			if (maxLinesWritten > 0) {
				process.stdout.write(`\x1b[${maxLinesWritten}A`);
			}

			for (const phaseName of phaseOrder) {
				const phase = phases.get(phaseName)!;
				const elapsed = formatElapsed(
					phase.finalDuration ?? Date.now() - phase.startTime,
				);
				const bar = "█".repeat(20);
				process.stdout.write(
					`\r${renderLine(elapsed, bar, 100, phaseName, "done")}\x1b[K\n`,
				);
			}

			const totalElapsed = formatElapsed(Date.now() - globalStartTime);
			process.stdout.write(`\r\x1b[2m⏱ ${totalElapsed} total\x1b[0m\x1b[K\n`);

			// Update maxLinesWritten for consistency
			maxLinesWritten = Math.max(maxLinesWritten, phaseOrder.length + 1);
		},
	};
}

async function handleIndex(args: string[]): Promise<void> {
	// Parse arguments
	const force = args.includes("--force") || args.includes("-f");
	const noLlm = args.includes("--no-llm") || args.includes("--no-enrichment");
	const forceUnlock = args.includes("--force-unlock");
	const wait = args.includes("--wait") || args.includes("-w");
	const pathArg = args.find((a) => !a.startsWith("-"));
	const projectPath = pathArg ? resolve(pathArg) : process.cwd();

	// Parse concurrency (default 10 for parallel LLM requests)
	const concurrencyArg = args.find((a) => a.startsWith("--concurrency="));
	const concurrency = concurrencyArg
		? Number.parseInt(concurrencyArg.split("=")[1], 10)
		: 10;

	// Parse wait timeout (default 5 minutes)
	const waitTimeoutArg = args.find((a) => a.startsWith("--wait-timeout="));
	const waitTimeout = waitTimeoutArg
		? Number.parseInt(waitTimeoutArg.split("=")[1], 10) * 1000
		: 5 * 60 * 1000;

	// Handle force unlock
	if (forceUnlock) {
		const { createIndexer } = await import("./core/indexer.js");
		const indexer = createIndexer({ projectPath });
		const released = indexer.forceUnlock();
		if (released) {
			console.log("✅ Lock released successfully.");
		} else {
			console.log("ℹ️  No lock file found.");
		}
		return;
	}

	// Check if vector mode is enabled
	const vectorEnabled = isVectorEnabled(projectPath);

	// Check for API key (not needed when vector mode is disabled)
	if (vectorEnabled && !hasApiKey()) {
		console.error("Error: OpenRouter API key not configured.");
		console.error("Run 'claudemem init' to set up, or set OPENROUTER_API_KEY.");
		process.exit(1);
	}

	// Get model info for display
	const embeddingModel = getEmbeddingModel(projectPath);
	const llmSpec = getLLMSpec(projectPath);
	const compactMode = agentMode;

	// Compact mode: single line start message
	if (compactMode) {
		console.log(`Indexing ${compactPath(projectPath, 50)}...`);
	} else {
		console.log(`\nIndexing ${projectPath}...`);
		if (vectorEnabled) {
			console.log(`  Embedding model: ${embeddingModel}`);
		} else {
			console.log("  Vector mode: disabled (BM25 keyword search only)");
		}
		if (!noLlm) {
			console.log(`  LLM for enrichment: ${llmSpec.displayName}`);
		}
		if (force) {
			console.log("(Force mode: re-indexing all files)");
		}
		if (noLlm) {
			console.log("(LLM enrichment disabled)");
		} else {
			console.log(`(Enrichment: ${concurrency} parallel requests)`);
		}
		console.log("");
	}

	// Create progress renderer (skip in compact mode)
	const progress = compactMode ? null : createProgressRenderer();
	let waitingMessageShown = false;

	const { createIndexer, IndexLockError } = await import("./core/indexer.js");
	const indexer = createIndexer({
		projectPath,
		enableEnrichment: !noLlm,
		enrichmentConcurrency: concurrency,
		lockOptions: wait ? { waitTimeout } : undefined,
		onWaitingForLock: (holderPid, waitedMs) => {
			if (!waitingMessageShown) {
				console.log(
					`⏳ Waiting for another indexing process (PID ${holderPid}) to finish...`,
				);
				waitingMessageShown = true;
			}
		},
		onProgress: (current, total, file, inProgress) => {
			if (!progress) return;
			progress.update(current, total, file, inProgress ?? 0);
		},
	});

	// Start progress only after we know we have the lock (skip in compact mode)
	if (progress) progress.start();

	try {
		const result = await indexer.index(force);

		// Show final state and stop progress renderer
		if (progress) progress.finish();

		// Compact mode: 3-line summary
		if (compactMode) {
			const costStr =
				result.cost !== undefined ? ` | Cost: $${result.cost.toFixed(4)}` : "";
			const errStr =
				result.errors.length > 0 ? ` | ${result.errors.length} errors` : "";
			compactOutput(
				`✓ Indexed ${result.filesIndexed} files → ${result.chunksCreated} chunks in ${compactDuration(result.durationMs)}${costStr}${errStr}`,
				`Model: ${embeddingModel}${result.enrichment ? ` | Enriched: ${result.enrichment.documentsCreated} docs` : ""}`,
				`Next: claudemem search "query" | claudemem map | claudemem symbol <name>`,
			);
			await indexer.close();
			return;
		}

		const totalElapsed = formatElapsed(result.durationMs);
		console.log(`✅ Indexing complete in ${totalElapsed}!\n`);
		console.log(`  Files indexed:  ${result.filesIndexed}`);
		console.log(`  Chunks created: ${result.chunksCreated}`);
		console.log(`  Duration:       ${(result.durationMs / 1000).toFixed(2)}s`);
		if (result.cost !== undefined) {
			console.log(`  Cost:           $${result.cost.toFixed(6)}`);
		}

		// Show enrichment results if available
		if (result.enrichment) {
			console.log("\n  Enrichment:");
			console.log(`    Documents:    ${result.enrichment.documentsCreated}`);

			// Show LLM calls and cost
			if (result.enrichment.llmCalls) {
				const { fileSummaries, symbolSummaries, total } =
					result.enrichment.llmCalls;
				const provider = result.enrichment.llmProvider;

				// For subscription/local providers, show "Subscription" or "Free" instead of cost
				if (provider === "claude-code") {
					console.log(`    LLM calls:    ${total} (Subscription)`);
					console.log(`      - file summaries:   ${fileSummaries} calls`);
					console.log(`      - symbol summaries: ${symbolSummaries} calls`);
				} else if (provider === "local") {
					console.log(`    LLM calls:    ${total} (Free - local)`);
					console.log(`      - file summaries:   ${fileSummaries} calls`);
					console.log(`      - symbol summaries: ${symbolSummaries} calls`);
				} else if (result.enrichment.cost !== undefined) {
					console.log(
						`    LLM cost:     $${result.enrichment.cost.toFixed(6)} (${total} calls)`,
					);
					if (result.enrichment.costBreakdown) {
						const breakdown = result.enrichment.costBreakdown;
						if (breakdown.fileSummaries !== undefined) {
							console.log(
								`      - file summaries:   $${breakdown.fileSummaries.toFixed(6)} (${fileSummaries} calls)`,
							);
						}
						if (breakdown.symbolSummaries !== undefined) {
							console.log(
								`      - symbol summaries: $${breakdown.symbolSummaries.toFixed(6)} (${symbolSummaries} calls)`,
							);
						}
					}
				} else {
					console.log(`    LLM calls:    ${total}`);
					console.log(`      - file summaries:   ${fileSummaries} calls`);
					console.log(`      - symbol summaries: ${symbolSummaries} calls`);
				}
			}

			if (result.enrichment.errors.length > 0) {
				console.log(`    Errors:       ${result.enrichment.errors.length}`);
				// Group errors by error message for cleaner output
				const errorGroups = new Map<
					string,
					{ count: number; files: string[] }
				>();
				for (const err of result.enrichment.errors) {
					const key = err.error;
					const existing = errorGroups.get(key);
					if (existing) {
						existing.count++;
						if (existing.files.length < 3) {
							existing.files.push(err.file);
						}
					} else {
						errorGroups.set(key, { count: 1, files: [err.file] });
					}
				}
				// Show unique errors with counts
				console.log("\n  Enrichment errors:");
				for (const [error, { count, files }] of errorGroups) {
					const truncatedError =
						error.length > 100 ? `${error.slice(0, 100)}...` : error;
					console.log(`    ✖ ${truncatedError}`);
					console.log(
						`      (${count}x) files: ${files.join(", ")}${count > files.length ? ` +${count - files.length} more` : ""}`,
					);
				}
			}
		}

		if (result.errors.length > 0) {
			console.log(`\n⚠️  Errors (${result.errors.length}):`);
			for (const err of result.errors.slice(0, 5)) {
				console.log(`  - ${err.file}: ${err.error}`);
			}
			if (result.errors.length > 5) {
				console.log(`  ... and ${result.errors.length - 5} more`);
			}
		}
	} catch (error) {
		if (progress) progress.stop();

		if (error instanceof IndexLockError) {
			console.error(`\n❌ ${error.message}`);
			process.exit(1);
		}

		throw error;
	} finally {
		if (progress) progress.stop();
		await indexer.close();
	}
}

async function handleSearch(args: string[]): Promise<void> {
	const compactMode = agentMode;

	// Parse arguments
	const limitIdx = args.findIndex((a) => a === "-n" || a === "--limit");
	const limit =
		limitIdx >= 0 && args[limitIdx + 1]
			? Number.parseInt(args[limitIdx + 1], 10)
			: 10;

	const langIdx = args.findIndex((a) => a === "-l" || a === "--language");
	const language = langIdx >= 0 ? args[langIdx + 1] : undefined;

	const pathIdx = args.findIndex((a) => a === "-p" || a === "--path");
	const projectPath = pathIdx >= 0 ? resolve(args[pathIdx + 1]) : process.cwd();

	// Embedding model override (will error if doesn't match stored model)
	const modelIdx = args.findIndex((a) => a === "-m" || a === "--model");
	const model = modelIdx >= 0 ? args[modelIdx + 1] : undefined;

	// Auto-index flags
	const noReindex = args.includes("--no-reindex");
	const autoYes = args.includes("-y") || args.includes("--yes");

	// Search use case (fim, search, navigation)
	const useCaseIdx = args.findIndex((a) => a === "--use-case");
	const useCase =
		useCaseIdx >= 0
			? (args[useCaseIdx + 1] as "fim" | "search" | "navigation")
			: "search";

	// Keyword-only search (skip embedding API call, use BM25 only)
	const keywordOnly = args.includes("-k") || args.includes("--keyword");

	// Get query (everything that's not a flag)
	// Only add indices to flagIndices if the flag was actually found (>= 0)
	const flagIndices = new Set<number>();
	if (limitIdx >= 0) {
		flagIndices.add(limitIdx);
		flagIndices.add(limitIdx + 1);
	}
	if (langIdx >= 0) {
		flagIndices.add(langIdx);
		flagIndices.add(langIdx + 1);
	}
	if (pathIdx >= 0) {
		flagIndices.add(pathIdx);
		flagIndices.add(pathIdx + 1);
	}
	if (modelIdx >= 0) {
		flagIndices.add(modelIdx);
		flagIndices.add(modelIdx + 1);
	}
	if (useCaseIdx >= 0) {
		flagIndices.add(useCaseIdx);
		flagIndices.add(useCaseIdx + 1);
	}
	const queryParts = args.filter(
		(_, i) => !flagIndices.has(i) && !args[i].startsWith("-"),
	);
	const query = queryParts.join(" ");

	if (!query) {
		console.error("Error: No search query provided.");
		console.error('Usage: claudemem search "your query"');
		process.exit(1);
	}

	// Check if vector mode is enabled in config
	const vectorEnabled = isVectorEnabled(projectPath);

	// Check for API key (not needed for keyword-only search or when vector mode disabled)
	if (!keywordOnly && vectorEnabled && !hasApiKey()) {
		console.error("Error: OpenRouter API key not configured.");
		console.error("Run 'claudemem init' to set up, or set OPENROUTER_API_KEY.");
		process.exit(1);
	}

	const { createIndexer, EmbeddingModelMismatchError } = await import(
		"./core/indexer.js"
	);
	const indexer = createIndexer({ projectPath, model });

	try {
		// Check if index exists
		const status = await indexer.getStatus();

		if (!status.exists) {
			// No index - prompt to create or auto-create with -y
			if (autoYes) {
				console.log("\nNo index found. Creating initial index...\n");
			} else {
				const shouldIndex = await confirm({
					message: "No index found. Create initial index now?",
					default: true,
				});

				if (!shouldIndex) {
					console.log(
						"Search cancelled. Run 'claudemem index' to create an index.",
					);
					return;
				}
				console.log("");
			}

			// Create initial index
			const result = await indexer.index(false);
			console.log(
				`✅ Indexed ${result.filesIndexed} files (${result.chunksCreated} chunks)\n`,
			);
		} else if (!noReindex) {
			// Index exists - auto-reindex changed files with progress display
			// In compact mode, do silent reindex
			if (compactMode) {
				const { createIndexer: createTempIndexer } = await import(
					"./core/indexer.js"
				);
				const tempIndexer = createTempIndexer({ projectPath });
				await tempIndexer.index(false);
			} else {
				// First, check if there are changes (quick check before showing progress)
				const progress = createProgressRenderer();
				let hasChanges = false;

				// Create a temporary indexer with progress callback
				const { createIndexer: createTempIndexer } = await import(
					"./core/indexer.js"
				);
				const tempIndexer = createTempIndexer({
					projectPath,
					onProgress: (current, total, detail, inProgress) => {
						if (!hasChanges && current > 0) {
							hasChanges = true;
							console.log("\n🔄 Auto-reindexing changed files...\n");
							progress.start();
						}
						if (hasChanges) {
							progress.update(current, total, detail, inProgress ?? 0);
						}
					},
				});

				const result = await tempIndexer.index(false); // incremental

				if (hasChanges) {
					progress.finish();
					console.log(
						`✅ Auto-indexed ${result.filesIndexed} changed file(s)\n`,
					);
				}
			}
		}

		if (!compactMode) {
			console.log(
				`Searching for: "${query}"${keywordOnly ? " (keyword-only)" : ""}`,
			);
		}

		const results = await indexer.search(query, {
			limit,
			language,
			useCase,
			keywordOnly,
		});

		if (results.length === 0) {
			if (compactMode) {
				console.log(`✗ No results for "${query}"`);
				console.log("Index may be stale: claudemem index");
				console.log("Try: claudemem map | claudemem symbol <name>");
			} else {
				console.log("\nNo results found.");
				console.log("Make sure the codebase is indexed: claudemem index");
			}
			return;
		}

		// Record query for implicit feedback (refinement detection)
		// This happens in background and doesn't block results
		// Only if learning is enabled in config
		if (isLearningEnabled(projectPath)) {
			const tracker = getFileTracker(projectPath);
			if (tracker) {
				try {
					const { createLearningSystem } = await import("./learning/index.js");
					const learning = createLearningSystem(tracker.getDatabase());
					// Generate a CLI session ID based on process start time
					const cliSessionId = `cli_${process.pid}`;
					learning.collector.recordSearch({
						query,
						sessionId: cliSessionId,
						resultCount: results.length,
						useCase,
					});
				} catch (learningError) {
					// Learning system errors shouldn't break search (silent in compact mode)
					if (!compactMode) {
						console.error("[claudemem] Learning system error:", learningError);
					}
				} finally {
					tracker.close();
				}
			}
		}

		// Compact mode: show results in condensed format
		if (compactMode) {
			// Plain mode: minimal output for tools/CI (no emojis, no hints)
			if (agentMode) {
				const topResults = results
					.slice(0, 5)
					.map((r) => `${r.chunk.filePath}:${r.chunk.startLine}`)
					.join("\n");
				console.log(topResults);
				return;
			}
			// Line 1: Summary
			console.log(`✓ Found ${results.length} results for "${query}"`);
			// Line 2: Top results (file:line score%)
			const topResults = results
				.slice(0, 5)
				.map(
					(r) =>
						`${compactPath(r.chunk.filePath, 25)}:${r.chunk.startLine} (${(r.score * 100).toFixed(0)}%)`,
				)
				.join(" | ");
			console.log(topResults);
			// Line 3: Use Read tool hint
			const firstFile = results[0]?.chunk.filePath;
			console.log(
				`Read: ${firstFile}:${results[0]?.chunk.startLine} | More: claudemem symbol <name>`,
			);
			return;
		}

		console.log(`Found ${results.length} result(s):\n`);

		// Collect result IDs for feedback hint
		const resultIds = results.map((r) => r.chunk.id);

		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			const chunk = r.chunk;

			console.log(
				`━━━ ${i + 1}. ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} ━━━`,
			);
			console.log(`ID: ${chunk.id}`);
			console.log(
				`Type: ${chunk.chunkType}${chunk.name ? ` | Name: ${chunk.name}` : ""}${chunk.parentName ? ` | Parent: ${chunk.parentName}` : ""}`,
			);
			console.log(
				`Score: ${(r.score * 100).toFixed(1)}% (vector: ${(r.vectorScore * 100).toFixed(0)}%, keyword: ${(r.keywordScore * 100).toFixed(0)}%)`,
			);
			console.log("");

			// Print code with truncation
			const lines = chunk.content.split("\n");
			const maxLines = 20;
			const displayLines = lines.slice(0, maxLines);

			for (const line of displayLines) {
				console.log(`  ${line}`);
			}

			if (lines.length > maxLines) {
				console.log(`  ... (${lines.length - maxLines} more lines)`);
			}

			console.log("");
		}

		// Show feedback hint for agents
		console.log(
			`💡 To provide feedback: claudemem feedback --query "${query}" --helpful <ids> --unhelpful <ids>`,
		);
		console.log(`   Result IDs: ${resultIds.join(",")}\n`);
	} catch (error) {
		if (error instanceof EmbeddingModelMismatchError) {
			console.error(`\n❌ ${error.message}\n`);
			process.exit(1);
		}
		throw error;
	} finally {
		await indexer.close();
	}
}

async function handleStatus(args: string[]): Promise<void> {
	const compactMode = agentMode;
	printLogo();

	const pathArg = args.find((a) => !a.startsWith("-"));
	const projectPath = pathArg ? resolve(pathArg) : process.cwd();

	const { createIndexer } = await import("./core/indexer.js");
	const indexer = createIndexer({ projectPath });

	try {
		const status = await indexer.getStatus();

		if (!status.exists) {
			if (compactMode) {
				console.log(`✗ No index at ${compactPath(projectPath, 40)}`);
				console.log("Create: claudemem index");
				console.log("Docs: https://github.com/MadAppGang/claudemem");
			} else {
				console.log("\nNo index found for this project.");
				console.log("Run 'claudemem index' to create one.");
			}
			return;
		}

		// Compact mode: 3-line status
		if (compactMode) {
			const age = status.lastUpdated
				? `${compactDuration(Date.now() - status.lastUpdated.getTime())} ago`
				: "unknown";
			console.log(
				`✓ Index: ${status.totalFiles} files, ${status.totalChunks} chunks (${age})`,
			);
			console.log(
				`Languages: ${status.languages.join(", ") || "none"} | Model: ${status.embeddingModel || "none"}`,
			);
			console.log(
				"Commands: search map symbol callers callees context dead-code test-gaps impact",
			);
			return;
		}

		console.log("\n📊 Index Status\n");
		console.log(`  Path: ${projectPath}`);
		console.log(`  Files: ${status.totalFiles}`);
		console.log(`  Chunks: ${status.totalChunks}`);
		console.log(`  Languages: ${status.languages.join(", ") || "none"}`);
		if (status.embeddingModel) {
			console.log(`  Embedding model: ${status.embeddingModel}`);
		}
		if (status.lastUpdated) {
			console.log(`  Last updated: ${status.lastUpdated.toISOString()}`);
		}
	} finally {
		await indexer.close();
	}
}

async function handleClear(args: string[]): Promise<void> {
	printLogo();

	const pathArg = args.find((a) => !a.startsWith("-"));
	const projectPath = pathArg ? resolve(pathArg) : process.cwd();

	const force = args.includes("--force") || args.includes("-f");

	if (!force) {
		const confirmed = await confirm({
			message: `Clear index for ${projectPath}?`,
			default: false,
		});

		if (!confirmed) {
			console.log("Cancelled.");
			return;
		}
	}

	const { createIndexer } = await import("./core/indexer.js");
	const indexer = createIndexer({ projectPath });

	try {
		await indexer.clear();
		console.log("\n✅ Index cleared.");
	} finally {
		await indexer.close();
	}
}

async function handleInit(): Promise<void> {
	printLogo();

	console.log("🔧 Setup\n");

	// ═══════════════════════════════════════════════════════════════════════════
	// STEP 1: Embedding Provider
	// ═══════════════════════════════════════════════════════════════════════════
	console.log("─── Embedding Configuration ───\n");

	const embeddingProvider = (await select({
		message: "Select embedding provider:",
		choices: [
			{
				name: "Voyage AI (recommended, best quality)",
				value: "voyage",
			},
			{
				name: "OpenRouter (cloud API, many models)",
				value: "openrouter",
			},
			{
				name: "Ollama (local, free)",
				value: "ollama",
			},
			{
				name: "LM Studio (local, OpenAI-compatible)",
				value: "lmstudio",
			},
			{
				name: "Custom endpoint (local HTTP server)",
				value: "local",
			},
		],
	})) as "voyage" | "openrouter" | "ollama" | "lmstudio" | "local";

	let embeddingModel: string;
	let embeddingEndpoint: string | undefined;
	let voyageApiKey: string | undefined;
	let openrouterApiKey: string | undefined;

	if (embeddingProvider === "voyage") {
		// Voyage AI setup
		const existingKey = getVoyageApiKey();
		if (existingKey) {
			const useExisting = await confirm({
				message: "Voyage API key already configured. Keep it?",
				default: true,
			});
			if (!useExisting) {
				voyageApiKey = await promptForVoyageApiKey();
			}
		} else {
			voyageApiKey = await promptForVoyageApiKey();
		}

		embeddingModel = await select({
			message: "Select Voyage embedding model:",
			choices: [
				{
					name: "voyage-3.5-lite (recommended, fast, cheap)",
					value: "voyage-3.5-lite",
				},
				{ name: "voyage-3 (highest quality)", value: "voyage-3" },
				{ name: "voyage-code-3 (optimized for code)", value: "voyage-code-3" },
			],
		});
	} else if (embeddingProvider === "openrouter") {
		// OpenRouter setup
		const existingKey = getApiKey();
		if (existingKey) {
			const useExisting = await confirm({
				message: "OpenRouter API key already configured. Keep it?",
				default: true,
			});
			if (!useExisting) {
				await promptForApiKey();
			}
		} else {
			await promptForApiKey();
		}

		// Select OpenRouter model
		console.log("\n📦 Fetching available models...\n");
		const models = await discoverEmbeddingModels();

		embeddingModel = await inquirerSearch({
			message: "Choose embedding model:",
			source: async (term: string | undefined) => {
				const filtered = term
					? models.filter(
							(m) =>
								m.id.toLowerCase().includes(term.toLowerCase()) ||
								m.name.toLowerCase().includes(term.toLowerCase()),
						)
					: models.slice(0, 10);

				return filtered.map((m) => ({
					name: formatModelInfo(m),
					value: m.id,
				}));
			},
		});
	} else if (embeddingProvider === "ollama") {
		// Ollama setup
		embeddingEndpoint = await input({
			message: "Ollama endpoint URL:",
			default: "http://localhost:11434",
		});

		// Test connection
		console.log("\n🔄 Testing Ollama connection...");
		try {
			const response = await fetch(`${embeddingEndpoint}/api/tags`);
			if (response.ok) {
				const data = (await response.json()) as {
					models?: Array<{ name: string }>;
				};
				const installedModels = data.models || [];
				const embModels = installedModels.filter(
					(m: { name: string }) =>
						m.name.includes("embed") ||
						m.name.includes("nomic") ||
						m.name.includes("minilm") ||
						m.name.includes("bge"),
				);

				if (embModels.length > 0) {
					console.log(`✅ Found ${embModels.length} embedding model(s)`);
					embeddingModel = await select({
						message: "Select embedding model:",
						choices: embModels.map((m: { name: string }) => ({
							name: m.name,
							value: m.name.replace(":latest", ""),
						})),
					});
				} else {
					console.log("⚠️  No embedding models found.");
					console.log("   Run: ollama pull nomic-embed-text");
					embeddingModel = "nomic-embed-text";
				}
			} else {
				throw new Error("Connection failed");
			}
		} catch {
			console.log("⚠️  Could not connect to Ollama. Make sure it's running.");
			embeddingModel = await input({
				message: "Enter embedding model name:",
				default: "nomic-embed-text",
			});
		}
	} else if (embeddingProvider === "lmstudio") {
		// LM Studio setup (OpenAI-compatible API)
		embeddingEndpoint = await input({
			message: "LM Studio endpoint URL:",
			default: "http://localhost:1234/v1",
		});

		// Test connection and list embedding models
		console.log("\n🔄 Fetching LM Studio embedding models...");
		const models = await fetchLMStudioModels(embeddingEndpoint, "embedding");

		if (models.length > 0) {
			console.log(`✅ Found ${models.length} embedding model(s)`);
			embeddingModel = await select({
				message: "Select embedding model:",
				choices: models.map((m) => ({
					name: `${m.id}${m.publisher ? ` (${m.publisher})` : ""}`,
					value: m.id,
				})),
			});
		} else {
			console.log("⚠️  No embedding models found in LM Studio.");
			console.log(
				"   Make sure LM Studio is running and has embedding models loaded.",
			);
			embeddingModel = await input({
				message: "Enter embedding model name:",
				default: "text-embedding-nomic-embed-text-v1.5",
			});
		}
	} else {
		// Custom endpoint setup
		embeddingEndpoint = await input({
			message: "Custom endpoint URL:",
			default: "http://localhost:8000",
		});
		embeddingModel = await input({
			message: "Model name:",
			default: "all-minilm-l6-v2",
		});
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// STEP 2: LLM Enrichment
	// ═══════════════════════════════════════════════════════════════════════════
	console.log("\n─── LLM Enrichment Configuration ───\n");
	console.log(
		"LLM enrichment generates semantic summaries for better search.\n",
	);

	const enableEnrichment = await confirm({
		message: "Enable LLM enrichment?",
		default: true,
	});

	let llmSpec: string | undefined;
	let anthropicApiKey: string | undefined;

	if (enableEnrichment) {
		const llmProvider = await select({
			message: "Select LLM provider for enrichment:",
			choices: [
				{
					name: "Claude Code CLI (uses your subscription)",
					value: "claude-code",
				},
				{
					name: "Anthropic API (direct, requires API key)",
					value: "anthropic",
				},
				{ name: "OpenRouter (many models)", value: "openrouter" },
				{ name: "LM Studio (local, OpenAI-compatible)", value: "lmstudio" },
				{ name: "Ollama (local)", value: "ollama" },
				{
					name: "OpenAI-compatible (MLX, vLLM, llamafile, etc.)",
					value: "openai-compat",
				},
			],
		});

		if (llmProvider === "claude-code") {
			const llmModel = await select({
				message: "Select Claude model:",
				choices: [
					{ name: "Claude Sonnet (recommended, balanced)", value: "sonnet" },
					{ name: "Claude Haiku (fastest, cheapest)", value: "haiku" },
					{ name: "Claude Opus (highest quality)", value: "opus" },
				],
			});
			llmSpec = `cc/${llmModel}`;
		} else if (llmProvider === "anthropic") {
			const existingAnthropicKey = getAnthropicApiKey();
			if (existingAnthropicKey) {
				const useExisting = await confirm({
					message: "Anthropic API key already configured. Keep it?",
					default: true,
				});
				if (!useExisting) {
					anthropicApiKey = await input({
						message: "Enter your Anthropic API key:",
						validate: (v) =>
							v.startsWith("sk-ant-") ||
							"Invalid format. Keys start with 'sk-ant-'",
					});
				}
			} else {
				anthropicApiKey = await input({
					message: "Enter your Anthropic API key:",
					validate: (v) =>
						v.startsWith("sk-ant-") ||
						"Invalid format. Keys start with 'sk-ant-'",
				});
			}

			const llmModel = await select({
				message: "Select Claude model:",
				choices: [
					{
						name: "Claude Sonnet 4 (recommended)",
						value: "claude-sonnet-4-20250514",
					},
					{
						name: "Claude Haiku 3.5 (fastest)",
						value: "claude-3-5-haiku-20241022",
					},
					{ name: "Claude Opus 4", value: "claude-opus-4-20250514" },
				],
			});
			llmSpec = `a/${llmModel}`;
		} else if (llmProvider === "openrouter") {
			// Reuse OpenRouter key if already set
			if (!getApiKey()) {
				console.log("\n⚠️  OpenRouter API key needed for LLM.");
				await promptForApiKey();
			}

			llmSpec = await input({
				message:
					"Enter OpenRouter model (e.g., openai/gpt-4o, anthropic/claude-3.5-sonnet):",
				default: "anthropic/claude-3.5-sonnet",
			});
			llmSpec = `or/${llmSpec}`;
		} else if (llmProvider === "lmstudio") {
			// LM Studio for LLM enrichment
			const lmstudioEndpoint = await input({
				message: "LM Studio endpoint URL:",
				default: "http://localhost:1234/v1",
			});

			// Fetch LLM models (llm and vlm types)
			console.log("\n🔄 Fetching LM Studio LLM models...");
			const models = await fetchLMStudioModels(lmstudioEndpoint, "llm");

			let localModel: string;
			if (models.length > 0) {
				console.log(`✅ Found ${models.length} LLM model(s)`);
				localModel = await select({
					message: "Select LLM model:",
					choices: models.map((m) => ({
						name: `${m.id}${m.publisher ? ` (${m.publisher})` : ""}`,
						value: m.id,
					})),
				});
			} else {
				console.log("⚠️  No LLM models found in LM Studio.");
				console.log(
					"   Make sure LM Studio is running and has LLM models loaded.",
				);
				localModel = await input({
					message: "Enter LLM model name:",
					default: "llama-3.2-3b-instruct",
				});
			}
			llmSpec = `lmstudio/${localModel}`;
		} else if (llmProvider === "ollama") {
			// Ollama for LLM enrichment
			const ollamaEndpoint = await input({
				message: "Ollama endpoint URL:",
				default: "http://localhost:11434",
			});

			// Test connection and list models
			console.log("\n🔄 Testing Ollama connection...");
			try {
				const response = await fetch(`${ollamaEndpoint}/api/tags`);
				if (response.ok) {
					const data = (await response.json()) as {
						models?: Array<{ name: string }>;
					};
					const installedModels = data.models || [];

					if (installedModels.length > 0) {
						console.log(`✅ Found ${installedModels.length} model(s)`);
						const localModel = await select({
							message: "Select LLM model:",
							choices: installedModels.map((m: { name: string }) => ({
								name: m.name,
								value: m.name.replace(":latest", ""),
							})),
						});
						llmSpec = `ollama/${localModel}`;
					} else {
						console.log("⚠️  No models found. Run: ollama pull llama3.2");
						const localModel = await input({
							message: "Enter model name:",
							default: "llama3.2",
						});
						llmSpec = `ollama/${localModel}`;
					}
				} else {
					throw new Error("Connection failed");
				}
			} catch {
				console.log("⚠️  Could not connect to Ollama. Make sure it's running.");
				const localModel = await input({
					message: "Enter model name:",
					default: "llama3.2",
				});
				llmSpec = `ollama/${localModel}`;
			}
		} else if (llmProvider === "openai-compat") {
			// Generic OpenAI-compatible server (MLX, vLLM, text-generation-inference, etc.)
			const customEndpoint = await input({
				message: "OpenAI-compatible server URL:",
				default: "http://localhost:8080",
			});

			// Normalize endpoint
			const normalizedEndpoint = customEndpoint
				.replace(/\/v1\/?$/, "")
				.replace(/\/$/, "");

			console.log("\n🔄 Fetching available models...");
			const models = await fetchOpenAICompatibleModels(
				normalizedEndpoint,
				"llm",
			);

			let localModel: string;
			if (models.length > 0) {
				console.log(`✅ Found ${models.length} model(s)`);
				localModel = await select({
					message: "Select LLM model:",
					choices: models.map((m) => ({
						name: `${m.id}${m.publisher ? ` (${m.publisher})` : ""}`,
						value: m.id,
					})),
				});
			} else {
				console.log(
					"⚠️  Could not fetch models. Server might be starting up or doesn't support /v1/models.",
				);
				localModel = await input({
					message: "Enter model name (check your server logs):",
					default: "default",
				});
			}

			// Save custom endpoint to config and use local provider
			llmSpec = `local/${localModel}`;
			// Store the endpoint separately - will be saved to config below
			saveGlobalConfig({ llmEndpoint: `${normalizedEndpoint}/v1` });
			console.log(`\n📝 Saved endpoint: ${normalizedEndpoint}/v1`);
		}
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// STEP 3: Documentation Sources
	// ═══════════════════════════════════════════════════════════════════════════
	console.log("\n─── Documentation Sources ───\n");
	console.log(
		"Automatically fetch framework docs for your project dependencies.",
	);
	console.log("Docs are searchable alongside your code.\n");

	const enableDocs = await confirm({
		message: "Enable automatic documentation fetching?",
		default: true,
	});

	let context7ApiKey: string | undefined;

	if (enableDocs) {
		console.log(`
Documentation providers (used in priority order):
  • Context7 - 6000+ libraries, versioned code examples (requires API key)
  • llms.txt - Official AI-friendly docs from framework sites (free)
  • DevDocs  - Consistent offline documentation (free)
`);

		const configureContext7 = await confirm({
			message:
				"Configure Context7 API for best coverage? (free tier available)",
			default: true,
		});

		if (configureContext7) {
			const existingKey = getContext7ApiKey();
			if (existingKey) {
				const useExisting = await confirm({
					message: "Context7 API key already configured. Keep it?",
					default: true,
				});
				if (!useExisting) {
					console.log(
						"Get your free API key at: https://context7.com/dashboard\n",
					);
					context7ApiKey = await input({
						message: "Enter Context7 API key:",
						validate: (v) => v.trim().length > 0 || "API key is required",
					});
				}
			} else {
				console.log(
					"Get your free API key at: https://context7.com/dashboard\n",
				);
				context7ApiKey = await input({
					message: "Enter Context7 API key (or press Enter to skip):",
				});
				// Clear empty input
				if (context7ApiKey && !context7ApiKey.trim()) {
					context7ApiKey = undefined;
				}
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// STEP 4: Self-Learning System
	// ═══════════════════════════════════════════════════════════════════════════
	console.log("\n─── Self-Learning System ───\n");
	console.log(
		"claudemem can learn from your interactions to improve search quality.",
	);
	console.log(
		"It tracks which results you find helpful and adapts over time.\n",
	);

	const enableLearning = await confirm({
		message: "Enable self-learning system?",
		default: true,
	});

	if (enableLearning) {
		console.log(`
Learning features:
  • Tracks search interactions and result feedback
  • Learns from user corrections to improve ranking
  • Adapts to your codebase patterns over time
  • All data stored locally in .claudemem/

View stats anytime with: claudemem learn
`);
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Save Configuration
	// ═══════════════════════════════════════════════════════════════════════════
	saveGlobalConfig({
		embeddingProvider:
			embeddingProvider === "lmstudio" ? "lmstudio" : embeddingProvider,
		defaultModel: embeddingModel,
		...(voyageApiKey ? { voyageApiKey } : {}),
		...(openrouterApiKey ? { openrouterApiKey } : {}),
		...(anthropicApiKey ? { anthropicApiKey } : {}),
		...(embeddingProvider === "ollama" && embeddingEndpoint
			? { ollamaEndpoint: embeddingEndpoint }
			: {}),
		...(embeddingProvider === "lmstudio" && embeddingEndpoint
			? { lmstudioEndpoint: embeddingEndpoint }
			: {}),
		...(embeddingProvider === "local" && embeddingEndpoint
			? { localEndpoint: embeddingEndpoint }
			: {}),
		enableEnrichment,
		...(llmSpec ? { llm: llmSpec } : {}),
		...(context7ApiKey ? { context7ApiKey } : {}),
		learning: enableLearning,
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// Summary
	// ═══════════════════════════════════════════════════════════════════════════
	console.log("\n✅ Setup complete!\n");
	console.log("─── Configuration Summary ───\n");
	console.log(`  Embedding provider: ${embeddingProvider}`);
	console.log(`  Embedding model:    ${embeddingModel}`);
	if (embeddingEndpoint)
		console.log(`  Endpoint:           ${embeddingEndpoint}`);
	console.log(
		`  LLM enrichment:     ${enableEnrichment ? "enabled" : "disabled"}`,
	);
	if (llmSpec) console.log(`  LLM model:          ${llmSpec}`);
	console.log(`  Auto-fetch docs:    ${enableDocs ? "enabled" : "disabled"}`);
	if (enableDocs) {
		const hasContext7 = context7ApiKey || getContext7ApiKey();
		console.log(
			`  Context7 API:       ${hasContext7 ? "configured" : "not configured (using llms.txt/DevDocs)"}`,
		);
	}
	console.log(
		`  Self-learning:      ${enableLearning ? "enabled" : "disabled"}`,
	);
	console.log("\nYou can now index your codebase:");
	console.log("  claudemem index\n");
}

interface LMStudioModel {
	id: string;
	type: string; // "llm" | "embeddings" | "vlm"
	publisher?: string;
	architecture?: string;
}

/**
 * Fetch available models from LM Studio
 * Uses the new API: http://localhost:1234/api/v0/models
 * Falls back to OpenAI-compatible /v1/models if that fails
 */
async function fetchLMStudioModels(
	endpoint: string,
	filter?: "embedding" | "llm",
): Promise<LMStudioModel[]> {
	const baseUrl = endpoint.replace(/\/v1\/?$/, ""); // Remove /v1 suffix if present

	// Try LM Studio's native API first
	try {
		const response = await fetch(`${baseUrl}/api/v0/models`);
		if (response.ok) {
			const data = (await response.json()) as { data?: LMStudioModel[] };
			let models = data.data || [];

			// Filter by type if specified
			if (filter === "embedding") {
				models = models.filter((m) => m.type === "embeddings");
			} else if (filter === "llm") {
				models = models.filter((m) => m.type === "llm" || m.type === "vlm");
			}

			if (models.length > 0) {
				return models;
			}
		}
	} catch {
		// Fall through to OpenAI-compatible API
	}

	// Fallback: Try OpenAI-compatible /v1/models endpoint
	return fetchOpenAICompatibleModels(endpoint, filter);
}

/**
 * Fetch models from an OpenAI-compatible API endpoint
 * Works with MLX-server, vLLM, text-generation-inference, llamafile, etc.
 */
async function fetchOpenAICompatibleModels(
	endpoint: string,
	filter?: "embedding" | "llm",
): Promise<LMStudioModel[]> {
	try {
		// Ensure endpoint has /v1 suffix
		const baseUrl = endpoint.replace(/\/v1\/?$/, "");
		const response = await fetch(`${baseUrl}/v1/models`, {
			signal: AbortSignal.timeout(5000), // 5 second timeout
		});

		if (!response.ok) {
			return [];
		}

		const data = (await response.json()) as {
			data?: Array<{ id: string; owned_by?: string }>;
		};
		const rawModels = data.data || [];

		// Convert to LMStudioModel format
		// OpenAI API doesn't expose model type, so we guess based on name
		const models: LMStudioModel[] = rawModels.map((m) => {
			const id = m.id;
			const isEmbedding =
				id.toLowerCase().includes("embed") ||
				id.toLowerCase().includes("e5") ||
				id.toLowerCase().includes("bge");
			return {
				id,
				type: isEmbedding ? "embeddings" : "llm",
				publisher: m.owned_by,
			};
		});

		// Filter by type if specified
		if (filter === "embedding") {
			return models.filter((m) => m.type === "embeddings");
		}
		if (filter === "llm") {
			return models.filter((m) => m.type === "llm");
		}

		return models;
	} catch {
		return [];
	}
}

async function promptForVoyageApiKey(): Promise<string> {
	console.log("Voyage API key required for embeddings.");
	console.log("Get yours at: https://dash.voyageai.com/api-keys\n");

	const apiKey = await input({
		message: "Enter your Voyage API key:",
		validate: (value) => {
			if (!value.trim()) {
				return "API key is required";
			}
			if (!value.startsWith("pa-")) {
				return "Invalid format. Voyage keys start with 'pa-'";
			}
			return true;
		},
	});

	return apiKey;
}

async function handleModels(args: string[]): Promise<void> {
	printLogo();

	const freeOnly = args.includes("--free");
	const forceRefresh = args.includes("--refresh");
	const showOllama = args.includes("--ollama");

	// Colors for output
	const c = {
		reset: "\x1b[0m",
		bold: "\x1b[1m",
		dim: "\x1b[2m",
		cyan: "\x1b[36m",
		green: "\x1b[38;5;78m",
		yellow: "\x1b[33m",
		magenta: "\x1b[35m",
		orange: "\x1b[38;5;209m",
	};

	// Check current provider
	const config = loadGlobalConfig();
	const currentProvider = config.embeddingProvider || "openrouter";

	// Show Ollama models if requested or if using Ollama provider
	if (showOllama || currentProvider === "ollama") {
		console.log("\n📦 Ollama Embedding Models\n");

		// Show recommended Ollama models
		console.log(`${c.orange}${c.bold}⭐ RECOMMENDED OLLAMA MODELS${c.reset}\n`);

		const ollamaModels = [
			{
				id: "nomic-embed-text",
				dim: 768,
				size: "274MB",
				desc: "Best quality, multilingual",
			},
			{
				id: "mxbai-embed-large",
				dim: 1024,
				size: "670MB",
				desc: "Large context, high quality",
			},
			{
				id: "all-minilm",
				dim: 384,
				size: "46MB",
				desc: "Fastest, lightweight",
			},
			{
				id: "snowflake-arctic-embed",
				dim: 1024,
				size: "670MB",
				desc: "Optimized for retrieval",
			},
		];

		for (const m of ollamaModels) {
			console.log(`  ${c.cyan}${m.id}${c.reset}`);
			console.log(`     ${m.desc} | ${m.dim}d | ${m.size}`);
		}

		console.log(`\n${c.bold}Install:${c.reset} ollama pull nomic-embed-text`);
		console.log(`${c.bold}Current provider:${c.reset} ${currentProvider}`);
		if (config.ollamaEndpoint) {
			console.log(`${c.bold}Endpoint:${c.reset} ${config.ollamaEndpoint}`);
		}
		console.log("");
		return;
	}

	// Show current provider info
	console.log(`\n${c.dim}Current provider: ${currentProvider}${c.reset}`);
	console.log("📦 Fetching embedding models from OpenRouter...\n");

	const allModels = await discoverEmbeddingModels(forceRefresh);

	// Categorize models
	const freeModels = allModels.filter((m) => m.isFree);
	const paidModels = allModels.filter((m) => !m.isFree);
	const recommendedIds = new Set(RECOMMENDED_MODELS.map((m) => m.id));

	// Helper to print a model row
	const printModel = (model: (typeof allModels)[0], prefix = "  ") => {
		const id = model.id.length > 35 ? `${model.id.slice(0, 32)}...` : model.id;
		const price = model.isFree
			? `${c.green}FREE${c.reset}`
			: `$${model.pricePerMillion.toFixed(3)}/1M`;
		const context = `${Math.round(model.contextLength / 1000)}K`;
		const dim = model.dimension ? `${model.dimension}d` : "N/A";
		console.log(
			`${prefix}${id.padEnd(36)} ${model.provider.padEnd(10)} ${price.padEnd(20)} ${context.padEnd(6)} ${dim}`,
		);
	};

	// Print header
	const printHeader = () => {
		console.log(
			`  ${"Model".padEnd(36)} ${"Provider".padEnd(10)} ${"Price".padEnd(12)} ${"Context".padEnd(6)} Dim`,
		);
		console.log(`  ${"─".repeat(78)}`);
	};

	if (freeOnly) {
		// Show only free models
		console.log(`${c.yellow}${c.bold}FREE EMBEDDING MODELS${c.reset}\n`);
		printHeader();

		if (freeModels.length === 0) {
			console.log(`  ${c.dim}No free models currently available${c.reset}`);
		} else {
			for (const model of freeModels) {
				printModel(model);
			}
		}
		console.log("");
		console.log(
			`${c.dim}Note: Free model availability changes frequently.${c.reset}`,
		);
		console.log(`${c.dim}Use --refresh to fetch the latest list.${c.reset}\n`);
		return;
	}

	// Show all categories

	// 1. Curated Picks (4 categories)
	console.log(`${c.orange}${c.bold}⭐ CURATED PICKS${c.reset}\n`);

	const picks = [
		{
			label: "Best Quality",
			emoji: "🏆",
			model: CURATED_PICKS.bestQuality,
			desc: "Top-tier code understanding",
		},
		{
			label: "Best Balanced",
			emoji: "⚖️",
			model: CURATED_PICKS.bestBalanced,
			desc: "Excellent quality/price ratio",
		},
		{
			label: "Best Value",
			emoji: "💰",
			model: CURATED_PICKS.bestValue,
			desc: "Great quality, lowest cost",
		},
		{
			label: "Fastest",
			emoji: "⚡",
			model: CURATED_PICKS.fastest,
			desc: "Optimized for speed",
		},
	];

	for (const pick of picks) {
		const price = pick.model.isFree
			? `${c.green}FREE${c.reset}`
			: `$${pick.model.pricePerMillion.toFixed(3)}/1M`;
		const context = `${Math.round(pick.model.contextLength / 1000)}K`;
		const dim = pick.model.dimension ? `${pick.model.dimension}d` : "";
		console.log(
			`  ${pick.emoji} ${c.bold}${pick.label}${c.reset}: ${c.cyan}${pick.model.id}${c.reset}`,
		);
		console.log(`     ${pick.desc} | ${price} | ${context} ctx | ${dim}`);
	}
	console.log("");

	// 3. Free Models (if any)
	if (freeModels.length > 0) {
		console.log(
			`${c.green}${c.bold}🆓 FREE MODELS${c.reset} ${c.dim}(Currently available)${c.reset}\n`,
		);
		printHeader();
		for (const model of freeModels.slice(0, 10)) {
			printModel(model);
		}
		if (freeModels.length > 10) {
			console.log(
				`  ${c.dim}... and ${freeModels.length - 10} more free models${c.reset}`,
			);
		}
		console.log("");
	}

	// 4. Other Paid Models
	const otherPaid = paidModels.filter((m) => !recommendedIds.has(m.id));
	if (otherPaid.length > 0) {
		console.log(`${c.cyan}${c.bold}💰 OTHER PAID MODELS${c.reset}\n`);
		printHeader();
		for (const model of otherPaid) {
			printModel(model);
		}
		console.log("");
	}

	// Summary
	console.log(
		`${c.bold}Summary:${c.reset} ${allModels.length} total models (${freeModels.length} free, ${paidModels.length} paid)`,
	);
	console.log(
		`\n${c.dim}Use --free to show only free models, --refresh to update from API${c.reset}\n`,
	);
}

// ============================================================================
// Helper Functions
// ============================================================================

async function promptForApiKey(): Promise<void> {
	console.log("OpenRouter API key required for embeddings.");
	console.log("Get yours at: https://openrouter.ai/keys\n");

	const apiKey = await input({
		message: "Enter your OpenRouter API key:",
		validate: (value) => {
			if (!value.trim()) {
				return "API key is required";
			}
			if (!value.startsWith("sk-or-")) {
				return "Invalid format. OpenRouter keys start with 'sk-or-'";
			}
			return true;
		},
	});

	saveGlobalConfig({ openrouterApiKey: apiKey });
	console.log("\n✅ API key saved.");
}

// ============================================================================
// Benchmark Command
// ============================================================================

/** Directories to always exclude when discovering files */
const EXCLUDE_DIRS = new Set([
	"node_modules",
	".git",
	".svn",
	".hg",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	".output",
	"coverage",
	".cache",
	".claudemem",
	"__pycache__",
	".pytest_cache",
	"venv",
	".venv",
	"target",
]);

// Note: createBenchmarkProgress is imported from ./ui/index.js

interface BenchmarkResult {
	model: string;
	speedMs: number;
	cost: number | undefined;
	dimension: number;
	contextLength: number;
	chunks: number;
	// Quality metrics
	ndcg: number;
	mrr: number;
	hitRate: { k1: number; k3: number; k5: number };
	error?: string;
}

/**
 * Discover source files and parse them into chunks for benchmarking
 */
async function discoverAndChunkFiles(
	projectPath: string,
	maxChunks: number,
): Promise<string[]> {
	const files: string[] = [];

	// Walk directory to find source files
	const walk = (dir: string) => {
		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = join(dir, entry.name);

				if (entry.isDirectory()) {
					// Skip excluded directories
					if (!EXCLUDE_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
						walk(fullPath);
					}
				} else if (entry.isFile()) {
					// Check if file can be chunked (supported language)
					if (canChunkFile(fullPath)) {
						files.push(fullPath);
					}
				}
			}
		} catch {
			// Ignore permission errors
		}
	};

	walk(projectPath);

	// Parse files into chunks
	const allChunks: string[] = [];
	for (const filePath of files) {
		if (allChunks.length >= maxChunks) break;

		try {
			const content = readFileSync(filePath, "utf-8");
			const fileHash = createHash("md5").update(content).digest("hex");
			const chunks = await chunkFileByPath(content, filePath, fileHash);

			for (const chunk of chunks) {
				if (allChunks.length >= maxChunks) break;
				allChunks.push(chunk.content);
			}
		} catch {
			// Skip files that can't be read/parsed
		}
	}

	return allChunks;
}

/**
 * Discover source files and parse them into chunks WITH file paths
 * (needed for auto test query generation)
 */
async function discoverAndChunkFilesWithPaths(
	projectPath: string,
	maxChunks: number,
): Promise<Array<{ content: string; fileName: string }>> {
	const files: string[] = [];

	// Walk directory to find source files
	const walk = (dir: string) => {
		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = join(dir, entry.name);

				if (entry.isDirectory()) {
					if (!EXCLUDE_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
						walk(fullPath);
					}
				} else if (entry.isFile()) {
					if (canChunkFile(fullPath)) {
						files.push(fullPath);
					}
				}
			}
		} catch {
			// Ignore permission errors
		}
	};

	walk(projectPath);

	// Sort files for reproducible chunk selection
	files.sort();

	// Parse files into chunks with file paths
	const allChunks: Array<{ content: string; fileName: string }> = [];
	for (const filePath of files) {
		if (allChunks.length >= maxChunks) break;

		try {
			const content = readFileSync(filePath, "utf-8");
			const fileHash = createHash("md5").update(content).digest("hex");
			const chunks = await chunkFileByPath(content, filePath, fileHash);
			const fileName = filePath.split("/").pop() || "";

			for (const chunk of chunks) {
				if (allChunks.length >= maxChunks) break;
				allChunks.push({ content: chunk.content, fileName });
			}
		} catch {
			// Skip files that can't be read/parsed
		}
	}

	return allChunks;
}

async function handleBenchmark(args: string[]): Promise<void> {
	printLogo();

	const c = {
		reset: "\x1b[0m",
		bold: "\x1b[1m",
		dim: "\x1b[2m",
		cyan: "\x1b[36m",
		green: "\x1b[38;5;78m",
		yellow: "\x1b[33m",
		red: "\x1b[31m",
		orange: "\x1b[38;5;209m",
	};

	// Check for API key
	if (!hasApiKey()) {
		console.error("Error: OpenRouter API key not configured.");
		console.error("Run 'claudemem init' to set up, or set OPENROUTER_API_KEY.");
		process.exit(1);
	}

	// Parse flags
	const useRealData = args.includes("--real");
	const verbose = args.includes("--verbose") || args.includes("-v");
	const autoMode = args.includes("--auto");

	// Parse --models flag (support multiple formats)
	let models: string[];
	const modelsArgEquals = args.find((a) => a.startsWith("--models="));
	const modelsArgNoEquals = args.find(
		(a) => a.startsWith("--models") && a.length > 8 && !a.includes("="),
	);
	const modelsArgIndex = args.findIndex((a) => a === "--models");

	if (modelsArgEquals) {
		// --models=model1,model2
		models = modelsArgEquals
			.replace("--models=", "")
			.split(",")
			.map((s) => s.trim());
	} else if (modelsArgNoEquals) {
		// --modelsmodel1,model2 (typo - missing =)
		models = modelsArgNoEquals
			.replace("--models", "")
			.split(",")
			.map((s) => s.trim());
		console.log(`${c.dim}(Note: use --models= for clarity)${c.reset}`);
	} else if (
		modelsArgIndex !== -1 &&
		args[modelsArgIndex + 1] &&
		!args[modelsArgIndex + 1].startsWith("-")
	) {
		// --models model1,model2 (space-separated)
		models = args[modelsArgIndex + 1].split(",").map((s) => s.trim());
	} else {
		// Default models
		models = [
			CURATED_PICKS.bestBalanced.id, // qwen/qwen3-embedding-8b
			"openai/text-embedding-3-small",
		];
	}

	const projectPath = process.cwd();

	console.log(`\n${c.orange}${c.bold}🏁 EMBEDDING MODEL BENCHMARK${c.reset}\n`);

	// Get chunks with file paths (always needed for quality testing)
	console.log(`${c.dim}Parsing source files...${c.reset}`);
	const chunksWithPaths = await discoverAndChunkFilesWithPaths(
		projectPath,
		useRealData ? 100 : 50,
	);
	if (chunksWithPaths.length === 0) {
		console.error("No source files found in the current directory.");
		process.exit(1);
	}

	// Get test queries - either auto-generated or predefined
	let testQueries: TestQuery[];
	if (autoMode) {
		testQueries = await extractAutoTestQueries(projectPath);
		if (testQueries.length === 0) {
			console.error(
				"No functions with docstrings found. Run without --auto to use predefined queries.",
			);
			process.exit(1);
		}
	} else {
		// Predefined queries for claudemem codebase
		testQueries = [
			{
				query: "convert text to vector representation",
				category: "semantic",
				expected: [
					{ file: "embeddings.ts", relevance: 3 },
					{ file: "store.ts", relevance: 2 },
				],
				description: "embedding",
			},
			{
				query: "split code into smaller pieces",
				category: "semantic",
				expected: [
					{ file: "chunker.ts", relevance: 3 },
					{ file: "parser-manager.ts", relevance: 2 },
				],
				description: "chunking",
			},
			{
				query: "find similar code based on meaning",
				category: "semantic",
				expected: [
					{ file: "store.ts", relevance: 3 },
					{ file: "indexer.ts", relevance: 2 },
				],
				description: "search",
			},
			{
				query: "LanceDB vector database",
				category: "keyword",
				expected: [{ file: "store.ts", relevance: 3 }],
				description: "LanceDB",
			},
			{
				query: "tree-sitter parser AST",
				category: "keyword",
				expected: [
					{ file: "parser-manager.ts", relevance: 3 },
					{ file: "chunker.ts", relevance: 2 },
				],
				description: "tree-sitter",
			},
			{
				query: "OpenRouter API embeddings",
				category: "keyword",
				expected: [
					{ file: "embeddings.ts", relevance: 3 },
					{ file: "config.ts", relevance: 2 },
				],
				description: "OpenRouter",
			},
			{
				query: "how do I search for code",
				category: "natural",
				expected: [
					{ file: "indexer.ts", relevance: 3 },
					{ file: "store.ts", relevance: 2 },
				],
				description: "search usage",
			},
			{
				query: "createEmbeddingsClient function",
				category: "api",
				expected: [{ file: "embeddings.ts", relevance: 3 }],
				description: "embeddings API",
			},
			{
				query: "VectorStore search method",
				category: "api",
				expected: [{ file: "store.ts", relevance: 3 }],
				description: "vector store",
			},
			{
				query: "handle API timeout retry",
				category: "error",
				expected: [{ file: "embeddings.ts", relevance: 3 }],
				description: "retry logic",
			},
		];
	}

	console.log(
		`${c.dim}Testing ${models.length} models with ${chunksWithPaths.length} chunks + ${testQueries.length} quality queries${c.reset}\n`,
	);

	// Create multi-line progress display
	const progress = createBenchmarkProgress(models);
	progress.start();

	// Benchmark directory for temp stores
	const benchDbBase = join(projectPath, ".claudemem", "benchmark");
	if (!existsSync(benchDbBase)) {
		mkdirSync(benchDbBase, { recursive: true });
	}

	// Separate local (Ollama) and cloud models
	const ollamaModels = models.filter((m) => m.startsWith("ollama/"));
	const cloudModels = models.filter((m) => !m.startsWith("ollama/"));

	// Helper to benchmark a single model
	const benchmarkModel = async (modelId: string): Promise<BenchmarkResult> => {
		const startTime = Date.now();
		const modelSlug = modelId.replace(/[^a-zA-Z0-9]/g, "-");
		const tempDbPath = join(benchDbBase, modelSlug);

		try {
			const client = createEmbeddingsClient({ model: modelId });

			// Truncate chunks to fit model's context window
			const chunkTexts = truncateForModel(
				chunksWithPaths.map((c) => c.content),
				modelId,
			);

			// Phase 1: Embed all chunks
			const embedResult = await client.embed(
				chunkTexts,
				(completed, total, inProgress) => {
					progress.update(modelId, completed, total, inProgress ?? 0, "embed");
				},
			);

			const embedTimeMs = Date.now() - startTime;

			// Phase 2: Build temp vector store and run quality queries
			progress.update(
				modelId,
				0,
				testQueries.length,
				testQueries.length,
				"quality",
			);

			// Clear existing temp db
			if (existsSync(tempDbPath)) {
				const { rmSync } = await import("node:fs");
				rmSync(tempDbPath, { recursive: true, force: true });
			}

			const { createVectorStore } = await import("./core/store.js");
			const store = createVectorStore(tempDbPath);
			await store.initialize();

			// Add chunks with embeddings (filter out failed ones with empty vectors)
			const chunksForStore = chunksWithPaths
				.map((chunk, i) => ({
					id: `chunk-${i}`,
					contentHash: "", // Not used in benchmarking
					content: chunk.content,
					filePath: chunk.fileName,
					startLine: 0,
					endLine: 0,
					language: "unknown",
					chunkType: "block" as const,
					fileHash: `hash-${i}`,
					vector: embedResult.embeddings[i],
				}))
				.filter((chunk) => chunk.vector && chunk.vector.length > 0);

			if (chunksForStore.length === 0) {
				throw new Error("All chunks failed to embed");
			}
			await store.addChunks(chunksForStore);

			// Run quality queries
			let mrrSum = 0;
			let ndcgSum = 0;
			const hitCounts = { k1: 0, k3: 0, k5: 0 };

			for (let qi = 0; qi < testQueries.length; qi++) {
				const tq = testQueries[qi];
				progress.update(modelId, qi, testQueries.length, 1, "quality");

				// Embed query and search
				const queryVector = await client.embedOne(tq.query);
				const searchResults = await store.search(tq.query, queryVector, {
					limit: 5,
				});

				// Build relevance map
				const relevanceMap = new Map<string, number>();
				for (const exp of tq.expected) {
					relevanceMap.set(exp.file, exp.relevance);
				}

				// Score results
				let firstRelevantRank: number | null = null;
				const actualRelevances: number[] = [];
				const idealRelevances = tq.expected.map((e) => e.relevance);

				for (let i = 0; i < Math.min(searchResults.length, 5); i++) {
					const fileName = searchResults[i].chunk.filePath;
					let relevance = 0;
					for (const [expFile, expRel] of relevanceMap) {
						if (fileName.includes(expFile)) {
							relevance = expRel;
							break;
						}
					}
					actualRelevances.push(relevance);
					if (relevance > 0 && firstRelevantRank === null) {
						firstRelevantRank = i + 1;
					}
				}

				// Pad to 5
				while (actualRelevances.length < 5) actualRelevances.push(0);

				// Calculate NDCG
				const dcg = calculateDCG(actualRelevances);
				const idcg = calculateDCG([...idealRelevances].sort((a, b) => b - a));
				const ndcg = idcg === 0 ? 0 : dcg / idcg;

				ndcgSum += ndcg;
				if (firstRelevantRank !== null) {
					mrrSum += 1 / firstRelevantRank;
					if (firstRelevantRank <= 1) hitCounts.k1++;
					if (firstRelevantRank <= 3) hitCounts.k3++;
					if (firstRelevantRank <= 5) hitCounts.k5++;
				}
			}

			// Cleanup
			await store.close();

			const n = testQueries.length;
			progress.finish(modelId);

			// Find first non-empty embedding for dimension
			const firstValidEmbedding = embedResult.embeddings.find(
				(e) => e && e.length > 0,
			);

			return {
				model: modelId,
				speedMs: embedTimeMs,
				cost: embedResult.cost,
				dimension: firstValidEmbedding?.length || 0,
				contextLength: getModelContextLength(modelId),
				chunks: chunksWithPaths.length,
				ndcg: (ndcgSum / n) * 100,
				mrr: (mrrSum / n) * 100,
				hitRate: {
					k1: (hitCounts.k1 / n) * 100,
					k3: (hitCounts.k3 / n) * 100,
					k5: (hitCounts.k5 / n) * 100,
				},
			};
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			progress.setError(modelId, errMsg);
			return {
				model: modelId,
				speedMs: Date.now() - startTime,
				cost: undefined,
				dimension: 0,
				contextLength: getModelContextLength(modelId),
				chunks: 0,
				ndcg: 0,
				mrr: 0,
				hitRate: { k1: 0, k3: 0, k5: 0 },
				error: errMsg,
			};
		}
	};

	// Run cloud models in PARALLEL (they use different APIs)
	const cloudPromises = cloudModels.map((modelId) => benchmarkModel(modelId));
	const cloudResults = await Promise.all(cloudPromises);

	// Run Ollama models SEQUENTIALLY (they share local GPU/CPU)
	const ollamaResults: BenchmarkResult[] = [];
	for (const modelId of ollamaModels) {
		const result = await benchmarkModel(modelId);
		ollamaResults.push(result);
	}

	const results = [...cloudResults, ...ollamaResults];
	progress.stop();

	// Sort by NDCG (quality first)
	results.sort(
		(a, b) => (a.error ? 1 : 0) - (b.error ? 1 : 0) || b.ndcg - a.ndcg,
	);

	// Display results table
	console.log(`\n${c.bold}Results (sorted by quality):${c.reset}\n`);
	console.log(
		`  ${"Model".padEnd(28)} ${"Speed".padEnd(7)} ${"Cost".padEnd(11)} ${"Ctx".padEnd(6)} ${"Dim".padEnd(6)} ${"NDCG".padEnd(6)} ${"MRR".padEnd(6)} ${"Hit@5"}`,
	);
	console.log(`  ${"─".repeat(82)}`);

	// Truncate long model names
	const truncate = (s: string, max = 26) =>
		s.length > max ? `${s.slice(0, max - 1)}…` : s;

	// Format context length (e.g., 32000 -> "32K")
	const fmtCtx = (ctx: number) =>
		ctx >= 1000 ? `${Math.round(ctx / 1000)}K` : String(ctx);

	// Calculate best/worst for highlighting
	const successResults = results.filter((r) => !r.error);
	const minSpeed = Math.min(...successResults.map((r) => r.speedMs));
	const maxSpeed = Math.max(...successResults.map((r) => r.speedMs));
	const costsWithValues = successResults.filter((r) => r.cost !== undefined);
	const minCost =
		costsWithValues.length > 0
			? Math.min(...costsWithValues.map((r) => r.cost!))
			: undefined;
	const maxCost =
		costsWithValues.length > 0
			? Math.max(...costsWithValues.map((r) => r.cost!))
			: undefined;
	const maxNdcg = Math.max(...successResults.map((r) => r.ndcg));
	const minNdcg = Math.min(...successResults.map((r) => r.ndcg));
	const shouldHighlight = successResults.length > 1;

	for (const r of results) {
		const displayName = truncate(r.model).padEnd(28);
		if (r.error) {
			console.log(`  ${c.red}${displayName} ERROR${c.reset}`);
			console.log(`    ${c.dim}${r.error}${c.reset}`);
			continue;
		}

		// Speed with highlighting
		const speedVal = `${(r.speedMs / 1000).toFixed(1)}s`;
		let speed = speedVal.padEnd(7);
		if (shouldHighlight && r.speedMs === minSpeed) {
			speed = `${c.green}${speedVal.padEnd(7)}${c.reset}`;
		} else if (
			shouldHighlight &&
			r.speedMs === maxSpeed &&
			minSpeed !== maxSpeed
		) {
			speed = `${c.red}${speedVal.padEnd(7)}${c.reset}`;
		}

		// Cost with highlighting (FREE for local/ollama models)
		const isLocal = r.model.startsWith("ollama/");
		const costVal = isLocal
			? "FREE"
			: r.cost !== undefined
				? `$${r.cost.toFixed(5)}`
				: "N/A";
		let cost = costVal.padEnd(11);
		if (isLocal) {
			cost = `${c.green}${costVal.padEnd(11)}${c.reset}`;
		} else if (
			shouldHighlight &&
			r.cost !== undefined &&
			minCost !== undefined &&
			r.cost === minCost
		) {
			cost = `${c.green}${costVal.padEnd(11)}${c.reset}`;
		} else if (
			shouldHighlight &&
			r.cost !== undefined &&
			maxCost !== undefined &&
			r.cost === maxCost &&
			minCost !== maxCost
		) {
			cost = `${c.red}${costVal.padEnd(11)}${c.reset}`;
		}

		// Context length
		const ctx = fmtCtx(r.contextLength).padEnd(6);

		// NDCG with highlighting
		const ndcgVal = `${r.ndcg.toFixed(0)}%`;
		let ndcg = ndcgVal.padEnd(6);
		if (shouldHighlight && r.ndcg === maxNdcg) {
			ndcg = `${c.green}${ndcgVal.padEnd(6)}${c.reset}`;
		} else if (shouldHighlight && r.ndcg === minNdcg && minNdcg !== maxNdcg) {
			ndcg = `${c.red}${ndcgVal.padEnd(6)}${c.reset}`;
		}

		const dim = `${r.dimension}d`.padEnd(6);
		const mrr = `${r.mrr.toFixed(0)}%`.padEnd(6);
		const hit5 = `${r.hitRate.k5.toFixed(0)}%`;

		console.log(
			`  ${displayName} ${speed} ${cost} ${ctx} ${dim} ${ndcg} ${mrr} ${hit5}`,
		);
	}

	// Summary
	if (successResults.length > 0) {
		const fastest = successResults.reduce((a, b) =>
			a.speedMs < b.speedMs ? a : b,
		);
		const cheapest =
			costsWithValues.length > 0
				? costsWithValues.reduce((a, b) =>
						(a.cost || Number.POSITIVE_INFINITY) <
						(b.cost || Number.POSITIVE_INFINITY)
							? a
							: b,
					)
				: null;
		const bestQuality = successResults.reduce((a, b) =>
			a.ndcg > b.ndcg ? a : b,
		);

		console.log(`\n${c.bold}Summary:${c.reset}`);
		console.log(
			`  ${c.green}🏆 Best Quality:${c.reset} ${bestQuality.model} (NDCG: ${bestQuality.ndcg.toFixed(0)}%)`,
		);
		console.log(
			`  ${c.green}⚡ Fastest:${c.reset} ${fastest.model} (${(fastest.speedMs / 1000).toFixed(2)}s)`,
		);
		if (cheapest) {
			console.log(
				`  ${c.green}💰 Cheapest:${c.reset} ${cheapest.model} ($${cheapest.cost?.toFixed(6)})`,
			);
		}
	}

	console.log(
		`\n${c.dim}Metrics: NDCG (quality), MRR (rank), Hit@5 (found in top 5)${c.reset}`,
	);
	console.log(
		`${c.dim}Use --auto to generate queries from docstrings (works on any codebase)${c.reset}`,
	);
	console.log(
		`${c.dim}Use --verbose for detailed per-query results${c.reset}\n`,
	);
}

// ============================================================================
// LLM Benchmark Handler (V2 - Comprehensive evaluation)
// ============================================================================

async function handleBenchmarkLLM(args: string[]): Promise<void> {
	const { runBenchmarkCLI } = await import("./benchmark-v2/index.js");
	await runBenchmarkCLI(args);
}

// ============================================================================
// Quality Test Types
// ============================================================================

/**
 * Query categories for comprehensive evaluation
 */
type QueryCategory = "semantic" | "keyword" | "natural" | "error" | "api";

/**
 * Test query with graded relevance (0-3 scale like CodeSearchNet)
 * 0 = irrelevant, 1 = marginally relevant, 2 = relevant, 3 = highly relevant
 */
interface TestQuery {
	query: string;
	/** Category of query for analysis */
	category: QueryCategory;
	/** Expected results with graded relevance scores */
	expected: Array<{
		file: string;
		relevance: 0 | 1 | 2 | 3;
	}>;
	/** Description of what we're testing */
	description: string;
}

interface QueryResult {
	query: string;
	category: QueryCategory;
	/** Rank at which first relevant result was found (null if not found) */
	firstRelevantRank: number | null;
	/** Top 5 results with their relevance scores */
	results: Array<{
		file: string;
		relevance: number;
		rank: number;
	}>;
	/** DCG (Discounted Cumulative Gain) at K=5 */
	dcg: number;
	/** IDCG (Ideal DCG) - best possible DCG */
	idcg: number;
	/** NDCG = DCG / IDCG */
	ndcg: number;
}

interface TestResult {
	model: string;
	indexTimeMs: number;
	indexCost?: number;
	queryResults: QueryResult[];
	/** Metrics computed at different K values */
	metrics: {
		/** Hit Rate: % of queries with at least one relevant result in top K */
		hitRate: { k1: number; k3: number; k5: number };
		/** MRR: Mean Reciprocal Rank */
		mrr: number;
		/** Mean NDCG across all queries */
		ndcg: number;
		/** Precision: avg % of top K results that are relevant */
		precision: { k1: number; k3: number; k5: number };
	};
	/** Metrics broken down by category */
	byCategory: Record<
		QueryCategory,
		{ count: number; mrr: number; ndcg: number }
	>;
	error?: string;
}

/**
 * Calculate DCG (Discounted Cumulative Gain)
 * DCG = Σ (relevance_i / log2(i + 1))
 */
function calculateDCG(relevances: number[]): number {
	return relevances.reduce((sum, rel, i) => {
		return sum + rel / Math.log2(i + 2); // i+2 because rank starts at 1
	}, 0);
}

/**
 * Calculate NDCG (Normalized DCG)
 */
function calculateNDCG(
	actualRelevances: number[],
	idealRelevances: number[],
): number {
	const dcg = calculateDCG(actualRelevances);
	const idcg = calculateDCG(idealRelevances.sort((a, b) => b - a));
	return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Extract test queries automatically from codebase docstrings
 * Uses docstrings as queries and their source file as expected result
 * This enables testing on ANY codebase, not just claudemem
 */
async function extractAutoTestQueries(
	projectPath: string,
): Promise<TestQuery[]> {
	const queries: TestQuery[] = [];
	const seenQueries = new Set<string>();

	// Discover and chunk files WITH file paths
	const chunksWithFiles = await discoverAndChunkFilesWithPaths(
		projectPath,
		500,
	);

	// Regex patterns for extracting docstrings from different languages
	const docstringPatterns = [
		// JSDoc: /** ... */
		/\/\*\*\s*\n?\s*\*?\s*([^@*][^\n*]+)/,
		// Python docstring: """...""" or '''...'''
		/^(?:def|class)\s+\w+[^:]*:\s*(?:"""([^"]+)"""|'''([^']+)''')/m,
		// Single line comment describing function: // description
		/^(?:export\s+)?(?:async\s+)?function\s+\w+[^{]*\{\s*\/\/\s*(.+)/m,
		// TypeScript/JS: function with preceding comment
		/\/\/\s*([A-Z][^.\n]{10,80}\.?)\s*\n(?:export\s+)?(?:async\s+)?function/,
	];

	// Regex to extract function/class name
	const namePatterns = [
		/(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
		/(?:export\s+)?class\s+(\w+)/,
		/(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/,
		/def\s+(\w+)\s*\(/,
		/class\s+(\w+)/,
	];

	for (const { content, fileName } of chunksWithFiles) {
		// Try to extract docstring
		let docstring: string | null = null;
		for (const pattern of docstringPatterns) {
			const match = content.match(pattern);
			if (match) {
				docstring = (match[1] || match[2] || "").trim();
				break;
			}
		}

		// Try to extract name
		let funcName: string | null = null;
		for (const pattern of namePatterns) {
			const match = content.match(pattern);
			if (match) {
				funcName = match[1];
				break;
			}
		}

		// Create queries from docstrings (semantic category)
		if (
			docstring &&
			docstring.length > 15 &&
			docstring.length < 200 &&
			fileName
		) {
			// Clean up docstring
			const cleanDoc = docstring
				.replace(/\s+/g, " ")
				.replace(/^[\s*-]+/, "")
				.trim();

			if (!seenQueries.has(cleanDoc.toLowerCase())) {
				seenQueries.add(cleanDoc.toLowerCase());
				queries.push({
					query: cleanDoc,
					category: "semantic",
					expected: [{ file: fileName, relevance: 3 }],
					description: `Docstring: ${funcName || "unknown"}`,
				});
			}
		}

		// Create queries from function names (keyword category)
		if (
			funcName &&
			funcName.length > 3 &&
			fileName &&
			!seenQueries.has(funcName.toLowerCase())
		) {
			seenQueries.add(funcName.toLowerCase());

			// Convert camelCase/snake_case to words for better semantic search
			const words = funcName
				.replace(/([a-z])([A-Z])/g, "$1 $2")
				.replace(/_/g, " ")
				.toLowerCase();

			queries.push({
				query: `${funcName} function`,
				category: "keyword",
				expected: [{ file: fileName, relevance: 3 }],
				description: `Function: ${funcName}`,
			});

			// Also add semantic version if it produces meaningful words
			if (words.split(" ").length >= 2) {
				queries.push({
					query: words,
					category: "semantic",
					expected: [{ file: fileName, relevance: 3 }],
					description: `Semantic: ${funcName}`,
				});
			}
		}
	}

	// Limit to reasonable number (too many makes test slow)
	const maxQueries = 30;
	if (queries.length > maxQueries) {
		// Shuffle and take first N, ensuring mix of categories
		const byCategory = new Map<QueryCategory, TestQuery[]>();
		for (const q of queries) {
			if (!byCategory.has(q.category)) {
				byCategory.set(q.category, []);
			}
			byCategory.get(q.category)?.push(q);
		}

		const selected: TestQuery[] = [];
		const perCategory = Math.ceil(maxQueries / byCategory.size);
		for (const [_, catQueries] of byCategory) {
			// Shuffle
			for (let i = catQueries.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[catQueries[i], catQueries[j]] = [catQueries[j], catQueries[i]];
			}
			selected.push(...catQueries.slice(0, perCategory));
		}
		return selected.slice(0, maxQueries);
	}

	return queries;
}

// ============================================================================
// Symbol Graph Commands (for AI Agents)
// ============================================================================

/**
 * Format a symbol for raw output
 */
function formatSymbolRaw(symbol: {
	id?: string;
	name: string;
	kind: string;
	filePath: string;
	startLine: number;
	endLine: number;
	signature?: string;
	docstring?: string;
	isExported?: boolean;
	pagerankScore?: number;
}): string {
	const lines = [
		`file: ${symbol.filePath}`,
		`line: ${symbol.startLine}-${symbol.endLine}`,
		`kind: ${symbol.kind}`,
		`name: ${symbol.name}`,
	];
	if (symbol.signature) lines.push(`signature: ${symbol.signature}`);
	if (symbol.pagerankScore !== undefined)
		lines.push(`pagerank: ${symbol.pagerankScore.toFixed(4)}`);
	if (symbol.isExported !== undefined)
		lines.push(`exported: ${symbol.isExported}`);
	if (symbol.docstring)
		lines.push(`docstring: ${symbol.docstring.split("\n")[0]}`);
	return lines.join("\n");
}

/**
 * Get file tracker for a project path
 */
function getFileTracker(projectPath: string): FileTracker | null {
	const claudememDir = join(projectPath, ".claudemem");
	const dbPath = join(claudememDir, "index.db");

	if (!existsSync(dbPath)) {
		return null;
	}

	return new FileTracker(dbPath, projectPath);
}

/**
 * Handle 'map' command - generate repo map
 */
async function handleMap(args: string[]): Promise<void> {
	const compactMode = agentMode;

	// Parse --tokens flag
	let maxTokens = 2000;
	const tokensIdx = args.findIndex((a) => a === "--tokens");
	if (tokensIdx !== -1 && args[tokensIdx + 1]) {
		maxTokens = Number.parseInt(args[tokensIdx + 1], 10) || 2000;
	}

	// Parse --path flag for project path
	let projectPath = ".";
	const pathIdx = args.findIndex((a) => a === "--path" || a === "-p");
	if (pathIdx !== -1 && args[pathIdx + 1]) {
		projectPath = args[pathIdx + 1];
	}
	projectPath = resolve(projectPath);

	// Get query (first non-flag argument)
	const nonFlagArgs = args.filter((a) => !a.startsWith("-"));
	// Skip args that are values for flags
	const flagValues = new Set<string>();
	if (tokensIdx !== -1 && args[tokensIdx + 1])
		flagValues.add(args[tokensIdx + 1]);
	if (pathIdx !== -1 && args[pathIdx + 1]) flagValues.add(args[pathIdx + 1]);
	const query = nonFlagArgs.find((a) => !flagValues.has(a));

	const tracker = getFileTracker(projectPath);
	if (!tracker) {
		if (compactMode) {
			console.log("✗ No index found");
			console.log("Create: claudemem index");
			console.log("Docs: https://github.com/MadAppGang/claudemem");
		} else {
			console.error("No index found. Run 'claudemem index' first.");
		}
		process.exit(1);
	}

	try {
		const repoMapGen = createRepoMapGenerator(tracker);

		if (compactMode) {
			// Agent mode: top symbols as file:line list
			const structured = repoMapGen.generateStructured({ maxTokens: 1000 });
			const allSymbols = structured.flatMap((e) =>
				e.symbols.map((s) => ({ ...s, file: e.filePath })),
			);
			allSymbols.sort((a, b) => b.pagerankScore - a.pagerankScore);
			const top10 = allSymbols.slice(0, 10);
			for (const s of top10) {
				console.log(`${s.file}:${s.line} ${s.name} (${s.kind})`);
			}
		} else {
			let output: string;
			if (query) {
				output = repoMapGen.generateForQuery(query, { maxTokens });
			} else {
				output = repoMapGen.generate({ maxTokens });
			}
			printLogo();
			console.log("\n📊 Repository Map\n");
			console.log(output);
		}
	} finally {
		tracker.close();
	}
}

/**
 * Handle 'symbol' command - find symbol by name
 */
async function handleSymbol(args: string[]): Promise<void> {
	const compactMode = agentMode;
	const projectPath = resolve(".");

	// Get symbol name
	const symbolName = args.find((a) => !a.startsWith("-"));
	if (!symbolName) {
		if (compactMode) {
			console.log("Missing symbol name");
			console.log("Usage: claudemem --agent symbol <name>");
		} else {
			console.error("Usage: claudemem symbol <name> [--file <hint>]");
		}
		process.exit(1);
	}

	// Get file hint
	let fileHint: string | undefined;
	const fileIdx = args.findIndex((a) => a === "--file");
	if (fileIdx !== -1 && args[fileIdx + 1]) {
		fileHint = args[fileIdx + 1];
	}

	const tracker = getFileTracker(projectPath);
	if (!tracker) {
		if (compactMode) {
			console.log("✗ No index found");
			console.log("Create: claudemem index");
			console.log("Docs: https://github.com/MadAppGang/claudemem");
		} else {
			console.error("No index found. Run 'claudemem index' first.");
		}
		process.exit(1);
	}

	try {
		const graphManager = createReferenceGraphManager(tracker);
		const symbol = graphManager.findSymbol(symbolName, {
			preferExported: true,
			fileHint,
		});

		if (!symbol) {
			if (compactMode) {
				console.log(`✗ Symbol '${symbolName}' not found`);
				console.log(
					`Try: claudemem map "${symbolName}" | claudemem search "${symbolName}"`,
				);
				console.log("Fuzzy: similar names may exist with different casing");
			} else {
				console.error(`Symbol '${symbolName}' not found.`);
			}
			process.exit(1);
		}

		if (compactMode) {
			// Agent mode: file:line format
			console.log(
				`${symbol.filePath}:${symbol.startLine} ${symbol.name} (${symbol.kind})`,
			);
		} else {
			printLogo();
			console.log("\n🔍 Symbol Found\n");
			console.log(`  Name:      ${symbol.name}`);
			console.log(`  Kind:      ${symbol.kind}`);
			console.log(
				`  File:      ${symbol.filePath}:${symbol.startLine}-${symbol.endLine}`,
			);
			if (symbol.signature) console.log(`  Signature: ${symbol.signature}`);
			console.log(`  PageRank:  ${symbol.pagerankScore.toFixed(4)}`);
			console.log(`  Exported:  ${symbol.isExported}`);
			if (symbol.docstring)
				console.log(`  Docstring: ${symbol.docstring.split("\n")[0]}`);
			console.log("");
		}
	} finally {
		tracker.close();
	}
}

/**
 * Handle 'callers' command - find what calls a symbol
 */
async function handleCallers(args: string[]): Promise<void> {
	const compactMode = agentMode;
	const projectPath = resolve(".");

	const symbolName = args.find((a) => !a.startsWith("-"));
	if (!symbolName) {
		if (compactMode) {
			console.log("✗ Missing symbol name");
			console.log("Usage: claudemem callers <name>");
			console.log("Example: claudemem callers handleSearch");
		} else {
			console.error("Usage: claudemem callers <name>");
		}
		process.exit(1);
	}

	const tracker = getFileTracker(projectPath);
	if (!tracker) {
		if (compactMode) {
			console.log("✗ No index found");
			console.log("Create: claudemem index");
			console.log("Docs: https://github.com/MadAppGang/claudemem");
		} else {
			console.error("No index found. Run 'claudemem index' first.");
		}
		process.exit(1);
	}

	try {
		const graphManager = createReferenceGraphManager(tracker);
		const symbol = graphManager.findSymbol(symbolName, {
			preferExported: true,
		});

		if (!symbol) {
			if (compactMode) {
				console.log(`✗ Symbol '${symbolName}' not found`);
				console.log(
					`Try: claudemem symbol ${symbolName} | claudemem map "${symbolName}"`,
				);
				console.log("Check spelling and casing");
			} else {
				console.error(`Symbol '${symbolName}' not found.`);
			}
			process.exit(1);
		}

		const callers = graphManager.getCallers(symbol.id);

		if (compactMode) {
			// Agent mode: file:line list
			if (callers.length === 0) {
				console.log("No callers found");
			} else {
				for (const caller of callers.slice(0, 10)) {
					console.log(
						`${caller.filePath}:${caller.startLine} ${caller.name} (${caller.kind})`,
					);
				}
			}
		} else {
			printLogo();
			console.log(`\n📞 Callers of '${symbolName}'\n`);
			if (callers.length === 0) {
				console.log("  No callers found.");
			} else {
				for (const caller of callers) {
					console.log(`  ${caller.name}`);
					console.log(
						`     ${caller.filePath}:${caller.startLine} (${caller.kind})`,
					);
				}
			}
			console.log("");
		}
	} finally {
		tracker.close();
	}
}

/**
 * Handle 'callees' command - find what a symbol calls
 */
async function handleCallees(args: string[]): Promise<void> {
	const compactMode = agentMode;
	const projectPath = resolve(".");

	const symbolName = args.find((a) => !a.startsWith("-"));
	if (!symbolName) {
		if (compactMode) {
			console.log("✗ Missing symbol name");
			console.log("Usage: claudemem callees <name>");
			console.log("Example: claudemem callees handleSearch");
		} else {
			console.error("Usage: claudemem callees <name>");
		}
		process.exit(1);
	}

	const tracker = getFileTracker(projectPath);
	if (!tracker) {
		if (compactMode) {
			console.log("✗ No index found");
			console.log("Create: claudemem index");
			console.log("Docs: https://github.com/MadAppGang/claudemem");
		} else {
			console.error("No index found. Run 'claudemem index' first.");
		}
		process.exit(1);
	}

	try {
		const graphManager = createReferenceGraphManager(tracker);
		const symbol = graphManager.findSymbol(symbolName, {
			preferExported: true,
		});

		if (!symbol) {
			if (compactMode) {
				console.log(`✗ Symbol '${symbolName}' not found`);
				console.log(
					`Try: claudemem symbol ${symbolName} | claudemem map "${symbolName}"`,
				);
				console.log("Check spelling and casing");
			} else {
				console.error(`Symbol '${symbolName}' not found.`);
			}
			process.exit(1);
		}

		const callees = graphManager.getCallees(symbol.id);

		if (compactMode) {
			// Agent mode: file:line list
			if (callees.length === 0) {
				console.log("No callees found");
			} else {
				for (const callee of callees.slice(0, 10)) {
					console.log(
						`${callee.filePath}:${callee.startLine} ${callee.name} (${callee.kind})`,
					);
				}
			}
		} else {
			printLogo();
			console.log(`\n📤 Callees of '${symbolName}'\n`);
			if (callees.length === 0) {
				console.log("  No callees found.");
			} else {
				for (const callee of callees) {
					console.log(`  ${callee.name}`);
					console.log(
						`     ${callee.filePath}:${callee.startLine} (${callee.kind})`,
					);
				}
			}
			console.log("");
		}
	} finally {
		tracker.close();
	}
}

/**
 * Handle 'context' command - get full symbol context
 */
async function handleContext(args: string[]): Promise<void> {
	const compactMode = agentMode;
	const projectPath = resolve(".");

	const symbolName = args.find((a) => !a.startsWith("-"));
	if (!symbolName) {
		if (compactMode) {
			console.log("✗ Missing symbol name");
			console.log("Usage: claudemem context <name>");
			console.log("Example: claudemem context handleSearch");
		} else {
			console.error(
				"Usage: claudemem context <name> [--callers N] [--callees N]",
			);
		}
		process.exit(1);
	}

	// Parse limits
	let maxCallers = 10;
	let maxCallees = 15;
	const callersIdx = args.findIndex((a) => a === "--callers");
	if (callersIdx !== -1 && args[callersIdx + 1]) {
		maxCallers = Number.parseInt(args[callersIdx + 1], 10) || 10;
	}
	const calleesIdx = args.findIndex((a) => a === "--callees");
	if (calleesIdx !== -1 && args[calleesIdx + 1]) {
		maxCallees = Number.parseInt(args[calleesIdx + 1], 10) || 15;
	}

	const tracker = getFileTracker(projectPath);
	if (!tracker) {
		if (compactMode) {
			console.log("✗ No index found");
			console.log("Create: claudemem index");
			console.log("Docs: https://github.com/MadAppGang/claudemem");
		} else {
			console.error("No index found. Run 'claudemem index' first.");
		}
		process.exit(1);
	}

	try {
		const graphManager = createReferenceGraphManager(tracker);
		const symbol = graphManager.findSymbol(symbolName, {
			preferExported: true,
		});

		if (!symbol) {
			if (compactMode) {
				console.log(`✗ Symbol '${symbolName}' not found`);
				console.log(
					`Try: claudemem symbol ${symbolName} | claudemem map "${symbolName}"`,
				);
				console.log("Check spelling and casing");
			} else {
				console.error(`Symbol '${symbolName}' not found.`);
			}
			process.exit(1);
		}

		const context = graphManager.getSymbolContext(symbol.id, {
			includeCallers: true,
			includeCallees: true,
			maxCallers,
			maxCallees,
		});

		if (compactMode) {
			// Agent mode: file:line list for symbol, callers, callees
			console.log(
				`${symbol.filePath}:${symbol.startLine} ${symbol.name} (${symbol.kind})`,
			);
			if (context.callers.length > 0) {
				console.log("# callers:");
				for (const caller of context.callers.slice(0, 5)) {
					console.log(`${caller.filePath}:${caller.startLine} ${caller.name}`);
				}
			}
			if (context.callees.length > 0) {
				console.log("# callees:");
				for (const callee of context.callees.slice(0, 5)) {
					console.log(`${callee.filePath}:${callee.startLine} ${callee.name}`);
				}
			}
		} else {
			printLogo();
			console.log(`\n🔮 Context for '${symbolName}'\n`);

			// Symbol
			console.log("  Symbol:");
			console.log(`    ${symbol.name} (${symbol.kind})`);
			console.log(
				`    ${symbol.filePath}:${symbol.startLine}-${symbol.endLine}`,
			);
			if (symbol.signature) console.log(`    ${symbol.signature}`);

			// Callers
			console.log(`\n  Callers (${context.callers.length}):`);
			if (context.callers.length === 0) {
				console.log("    None");
			} else {
				for (const caller of context.callers) {
					console.log(
						`    ${caller.name} (${caller.filePath}:${caller.startLine})`,
					);
				}
			}

			// Callees
			console.log(`\n  Callees (${context.callees.length}):`);
			if (context.callees.length === 0) {
				console.log("    None");
			} else {
				for (const callee of context.callees) {
					console.log(
						`    ${callee.name} (${callee.filePath}:${callee.startLine})`,
					);
				}
			}
			console.log("");
		}
	} finally {
		tracker.close();
	}
}

// ============================================================================
// Code Analysis Commands
// ============================================================================

/**
 * Handle 'dead-code' command - find potentially dead code
 */
async function handleDeadCode(args: string[]): Promise<void> {
	const compactMode = agentMode;
	const projectPath = resolve(".");

	// Parse --max-pagerank flag
	let maxPageRank = 0.001;
	const prIdx = args.findIndex((a) => a === "--max-pagerank");
	if (prIdx !== -1 && args[prIdx + 1]) {
		maxPageRank = Number.parseFloat(args[prIdx + 1]) || 0.001;
	}

	// Parse --limit flag
	let limit = 50;
	const limitIdx = args.findIndex((a) => a === "--limit" || a === "-n");
	if (limitIdx !== -1 && args[limitIdx + 1]) {
		limit = Number.parseInt(args[limitIdx + 1], 10) || 50;
	}

	// Parse --include-exported flag
	const includeExported = args.includes("--include-exported");

	const tracker = getFileTracker(projectPath);
	if (!tracker) {
		if (compactMode) {
			console.log("✗ No index found");
			console.log("Create: claudemem index");
			console.log("Docs: https://github.com/MadAppGang/claudemem");
		} else {
			console.error("No index found. Run 'claudemem index' first.");
		}
		process.exit(1);
	}

	try {
		const { createCodeAnalyzer } = await import("./core/analysis/index.js");
		const analyzer = createCodeAnalyzer(tracker);

		const results = analyzer.findDeadCode({
			maxPageRank,
			unexportedOnly: !includeExported,
			excludeTestFiles: true,
			limit,
		});

		if (compactMode) {
			// Agent mode: file:line list
			if (results.length === 0) {
				console.log("No dead code found");
			} else {
				for (const r of results.slice(0, 10)) {
					console.log(
						`${r.symbol.filePath}:${r.symbol.startLine} ${r.symbol.name} (${r.symbol.kind})`,
					);
				}
			}
		} else {
			printLogo();
			console.log("\n💀 Dead Code Analysis\n");

			if (results.length === 0) {
				console.log("  No dead code found! Your codebase is clean.");
			} else {
				console.log(`  Found ${results.length} potentially dead symbol(s):\n`);
				for (const r of results) {
					console.log(`  ${r.symbol.name}`);
					console.log(
						`     ${r.symbol.filePath}:${r.symbol.startLine} (${r.symbol.kind})`,
					);
					console.log(`     PageRank: ${r.symbol.pagerankScore.toFixed(6)}`);
				}
			}
			console.log("");
		}
	} finally {
		tracker.close();
	}
}

/**
 * Handle 'test-gaps' command - find untested high-importance code
 */
async function handleTestGaps(args: string[]): Promise<void> {
	const compactMode = agentMode;
	const projectPath = resolve(".");

	// Parse --min-pagerank flag
	let minPageRank = 0.01;
	const prIdx = args.findIndex((a) => a === "--min-pagerank");
	if (prIdx !== -1 && args[prIdx + 1]) {
		minPageRank = Number.parseFloat(args[prIdx + 1]) || 0.01;
	}

	// Parse --limit flag
	let limit = 30;
	const limitIdx = args.findIndex((a) => a === "--limit" || a === "-n");
	if (limitIdx !== -1 && args[limitIdx + 1]) {
		limit = Number.parseInt(args[limitIdx + 1], 10) || 30;
	}

	const tracker = getFileTracker(projectPath);
	if (!tracker) {
		if (compactMode) {
			console.log("✗ No index found");
			console.log("Create: claudemem index");
			console.log("Docs: https://github.com/MadAppGang/claudemem");
		} else {
			console.error("No index found. Run 'claudemem index' first.");
		}
		process.exit(1);
	}

	try {
		const { createCodeAnalyzer } = await import("./core/analysis/index.js");
		const analyzer = createCodeAnalyzer(tracker);

		const results = analyzer.findTestGaps({
			minPageRank,
			limit,
		});

		if (compactMode) {
			// Agent mode: file:line list
			if (results.length === 0) {
				console.log("No test gaps found");
			} else {
				for (const r of results.slice(0, 10)) {
					console.log(
						`${r.symbol.filePath}:${r.symbol.startLine} ${r.symbol.name} (${r.symbol.kind})`,
					);
				}
			}
		} else {
			printLogo();
			console.log("\n🧪 Test Coverage Gaps\n");

			if (results.length === 0) {
				console.log(
					"  No test gaps found! All important code has test coverage.",
				);
			} else {
				console.log(
					`  Found ${results.length} important symbol(s) without test coverage:\n`,
				);
				for (const r of results) {
					console.log(`  ${r.symbol.name}`);
					console.log(
						`     ${r.symbol.filePath}:${r.symbol.startLine} (${r.symbol.kind})`,
					);
					console.log(
						`     PageRank: ${r.symbol.pagerankScore.toFixed(4)} | Callers: ${r.callerCount}`,
					);
				}
			}
			console.log("");
		}
	} finally {
		tracker.close();
	}
}

/**
 * Handle 'impact' command - analyze change impact
 */
async function handleImpact(args: string[]): Promise<void> {
	const compactMode = agentMode;
	const projectPath = resolve(".");

	// Get symbol name
	const symbolName = args.find((a) => !a.startsWith("-"));
	if (!symbolName) {
		if (compactMode) {
			console.log("✗ Missing symbol name");
			console.log("Usage: claudemem impact <name>");
			console.log("Example: claudemem impact handleSearch");
		} else {
			console.error("Usage: claudemem impact <symbol> [--max-depth N]");
		}
		process.exit(1);
	}

	// Parse --max-depth flag
	let maxDepth = 10;
	const depthIdx = args.findIndex((a) => a === "--max-depth");
	if (depthIdx !== -1 && args[depthIdx + 1]) {
		maxDepth = Number.parseInt(args[depthIdx + 1], 10) || 10;
	}

	// Parse --file flag for disambiguation
	let fileHint: string | undefined;
	const fileIdx = args.findIndex((a) => a === "--file");
	if (fileIdx !== -1 && args[fileIdx + 1]) {
		fileHint = args[fileIdx + 1];
	}

	const tracker = getFileTracker(projectPath);
	if (!tracker) {
		if (compactMode) {
			console.log("✗ No index found");
			console.log("Create: claudemem index");
			console.log("Docs: https://github.com/MadAppGang/claudemem");
		} else {
			console.error("No index found. Run 'claudemem index' first.");
		}
		process.exit(1);
	}

	try {
		const { createCodeAnalyzer } = await import("./core/analysis/index.js");
		const analyzer = createCodeAnalyzer(tracker);

		// Find the target symbol
		const target = analyzer.findSymbolForImpact(symbolName, fileHint);
		if (!target) {
			if (compactMode) {
				console.log(`✗ Symbol '${symbolName}' not found`);
				console.log(
					`Try: claudemem symbol ${symbolName} | claudemem map "${symbolName}"`,
				);
				console.log("Check spelling and casing");
			} else {
				console.error(`Symbol '${symbolName}' not found.`);
			}
			process.exit(1);
		}

		const impact = analyzer.findImpact(target.id, {
			maxDepth,
			includeTestFiles: true,
			groupByFile: true,
		});

		if (!impact) {
			if (compactMode) {
				console.log("✗ Failed to analyze impact");
				console.log(
					`Symbol: ${symbolName} at ${target.filePath}:${target.startLine}`,
				);
				console.log(`Try: claudemem callers ${symbolName}`);
			} else {
				console.error("Failed to analyze impact.");
			}
			process.exit(1);
		}

		if (compactMode) {
			// Agent mode: affected files list
			console.log(
				`${impact.target.filePath}:${impact.target.startLine} ${impact.target.name} (target)`,
			);
			console.log(
				`# ${impact.totalAffected} affected symbols in ${impact.byFile.size} files`,
			);
			for (const [filePath, results] of Array.from(
				impact.byFile.entries(),
			).slice(0, 5)) {
				for (const r of results.slice(0, 2)) {
					console.log(`${filePath}:${r.symbol.startLine} ${r.symbol.name}`);
				}
			}
		} else {
			printLogo();
			console.log(`\n🎯 Impact Analysis for '${symbolName}'\n`);

			// Target info
			console.log("  Target:");
			console.log(`    ${impact.target.name} (${impact.target.kind})`);
			console.log(`    ${impact.target.filePath}:${impact.target.startLine}`);

			// Summary
			console.log("\n  Summary:");
			console.log(`    Direct callers: ${impact.directCallers.length}`);
			console.log(`    Total affected: ${impact.totalAffected} symbols`);
			console.log(`    Files affected: ${impact.byFile.size}`);

			// By file
			if (impact.byFile.size > 0) {
				console.log("\n  Affected Files:");
				for (const [filePath, results] of impact.byFile) {
					console.log(`\n    📄 ${filePath} (${results.length} symbols)`);
					for (const r of results.slice(0, 5)) {
						const depthIcon =
							r.depth === 1 ? "→" : "→".repeat(Math.min(r.depth, 3));
						console.log(
							`       ${depthIcon} ${r.symbol.name}:${r.symbol.startLine} (depth ${r.depth})`,
						);
					}
					if (results.length > 5) {
						console.log(`       ... and ${results.length - 5} more`);
					}
				}
			}
			console.log("");
		}
	} finally {
		tracker.close();
	}
}

/**
 * Handle 'watch' command - file watcher daemon
 */
async function handleWatch(args: string[]): Promise<void> {
	const projectPath = resolve(".");

	// Parse --debounce flag
	let debounceMs = 1000;
	const debounceIdx = args.findIndex((a) => a === "--debounce");
	if (debounceIdx !== -1 && args[debounceIdx + 1]) {
		debounceMs = Number.parseInt(args[debounceIdx + 1], 10) || 1000;
	}

	const tracker = getFileTracker(projectPath);
	if (!tracker) {
		console.error("No index found. Run 'claudemem index' first.");
		process.exit(1);
	}

	try {
		const { createFileWatcher } = await import(
			"./core/watcher/file-watcher.js"
		);
		const watcher = createFileWatcher(projectPath, debounceMs);

		printLogo();
		console.log("\n👁️  Watch Mode\n");
		console.log(`  Watching for changes in: ${projectPath}`);
		console.log(`  Debounce: ${debounceMs}ms`);
		console.log("  Press Ctrl+C to stop\n");

		await watcher.start();

		// Handle shutdown
		const shutdown = () => {
			console.log("\n\n  Stopping watcher...");
			watcher.stop();
			tracker.close();
			process.exit(0);
		};

		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);

		// Keep process alive
		await new Promise(() => {}); // Never resolves
	} catch (error) {
		tracker.close();
		throw error;
	}
}

/**
 * Handle 'hooks' command - git hooks management
 */
async function handleHooks(args: string[]): Promise<void> {
	const projectPath = resolve(".");
	const subcommand = args[0];

	if (!subcommand || subcommand === "help") {
		console.log(`
Usage: claudemem hooks <subcommand>

Subcommands:
  install     Install post-commit hook for auto-indexing
  uninstall   Remove the post-commit hook
  status      Check if hook is installed
`);
		return;
	}

	const { createGitHookManager } = await import("./git/hook-manager.js");
	const hookManager = createGitHookManager(projectPath);

	switch (subcommand) {
		case "install":
			try {
				await hookManager.install();
				printLogo();
				console.log("\n✅ Git hook installed successfully!\n");
				console.log(
					"  The post-commit hook will now auto-index changes after each commit.",
				);
				console.log("  Location: .git/hooks/post-commit\n");
			} catch (error) {
				console.error(
					`Error: ${error instanceof Error ? error.message : String(error)}`,
				);
				process.exit(1);
			}
			break;

		case "uninstall":
			try {
				await hookManager.uninstall();
				printLogo();
				console.log("\n✅ Git hook uninstalled successfully!\n");
			} catch (error) {
				console.error(
					`Error: ${error instanceof Error ? error.message : String(error)}`,
				);
				process.exit(1);
			}
			break;

		case "status": {
			const status = await hookManager.status();
			printLogo();
			console.log("\n🔗 Git Hook Status\n");
			console.log(`  Installed: ${status.installed ? "Yes" : "No"}`);
			if (status.installed) {
				console.log(`  Hook type: ${status.hookType}`);
			}
			console.log("");
			break;
		}

		default:
			console.error(`Unknown subcommand: ${subcommand}`);
			console.error('Run "claudemem hooks help" for usage.');
			process.exit(1);
	}
}

/**
 * Handle 'hook' command - Claude Code hook event handler
 * Reads JSON from stdin and dispatches to appropriate handler
 */
async function handleHookCommand(args: string[]): Promise<void> {
	const debug = args.includes("--debug");

	try {
		const { handleHook } = await import("./hooks/index.js");
		await handleHook({ debug });
		process.exit(0);
	} catch (error) {
		if (debug) {
			console.error("Hook error:", error);
		}
		process.exit(2); // Blocking error
	}
}

// ============================================================================
// Integration Commands
// ============================================================================

/**
 * Handle 'install' command - install integrations for AI coding tools
 */
async function handleInstall(args: string[]): Promise<void> {
	const projectPath = resolve(".");
	const tool = args[0];
	const subcommand = args[1] || "install";

	if (!tool || tool === "help") {
		console.log(`
Usage: claudemem install <tool> [subcommand]

Tools:
  opencode     Install plugin for OpenCode (opencode.ai)
  claude-code  Show Claude Code integration instructions

Subcommands:
  install      Install integration (default)
  uninstall    Remove integration
  status       Check installation status

Options:
  --type <type>  Plugin type for OpenCode: both (default) | tools | suggestion

Examples:
  claudemem install opencode              Install OpenCode plugins
  claudemem install opencode --type tools Install tools plugin only
  claudemem install opencode status       Check if installed
  claudemem install opencode uninstall    Remove plugins
  claudemem install claude-code           Show Claude Code instructions
`);
		return;
	}

	switch (tool) {
		case "opencode":
			await handleOpenCodeIntegration(projectPath, subcommand, args.slice(2));
			break;

		case "claude-code":
		case "claudecode":
			handleClaudeCodeIntegration();
			break;

		default:
			console.error(`Unknown tool: ${tool}`);
			console.error("Available: opencode, claude-code");
			console.error('Run "claudemem install help" for usage.');
			process.exit(1);
	}
}

/**
 * Handle OpenCode integration
 */
async function handleOpenCodeIntegration(
	projectPath: string,
	subcommand: string,
	args: string[],
): Promise<void> {
	const { createOpenCodeIntegration } = await import(
		"./integrations/opencode.js"
	);
	const manager = createOpenCodeIntegration(projectPath);

	// Parse --type option (default: both)
	let pluginType: "suggestion" | "tools" | "both" = "both";
	const typeIndex = args.indexOf("--type");
	if (typeIndex !== -1 && args[typeIndex + 1]) {
		const type = args[typeIndex + 1];
		if (type === "suggestion" || type === "tools" || type === "both") {
			pluginType = type;
		}
	}

	switch (subcommand) {
		case "install":
			try {
				// Warn if not an OpenCode project
				if (!manager.isOpenCodeProject()) {
					console.log(
						"\n⚠️  No opencode.json or .opencode/ found in this directory.",
					);
					console.log("   This will create a new OpenCode configuration.\n");
				}

				await manager.install(pluginType);
				printLogo();
				console.log("\n✅ OpenCode integration installed!\n");
				console.log(`  Plugin type: ${pluginType}`);
				console.log("  Location: .opencode/plugin/");
				console.log("  Config: opencode.json (updated)\n");

				if (pluginType === "tools" || pluginType === "both") {
					console.log("  Available tools:");
					console.log("    • claudemem_search  - Semantic code search");
					console.log("    • claudemem_map     - Structural overview");
					console.log("    • claudemem_symbol  - Find symbol location");
					console.log("    • claudemem_callers - Impact analysis");
					console.log("    • claudemem_callees - Dependency tracing");
					console.log("    • claudemem_context - Full context\n");
				}

				// Check if indexed
				const { createVectorStore } = await import("./core/store.js");
				const { getVectorStorePath } = await import("./config.js");
				const store = await createVectorStore(getVectorStorePath(projectPath));
				const stats = await store.getStats();
				if (stats.totalChunks === 0) {
					console.log("  ⚠️  Project not indexed. Run: claudemem index\n");
				}
			} catch (error) {
				console.error(
					`Error: ${error instanceof Error ? error.message : String(error)}`,
				);
				process.exit(1);
			}
			break;

		case "uninstall":
			try {
				await manager.uninstall();
				printLogo();
				console.log("\n✅ OpenCode integration uninstalled!\n");
			} catch (error) {
				console.error(
					`Error: ${error instanceof Error ? error.message : String(error)}`,
				);
				process.exit(1);
			}
			break;

		case "status": {
			const status = await manager.status();
			printLogo();
			console.log("\n🔌 OpenCode Integration Status\n");
			console.log(
				`  OpenCode project: ${status.isOpenCodeProject ? "Yes" : "No"}`,
			);
			console.log(`  Installed: ${status.installed ? "Yes" : "No"}`);
			if (status.installed) {
				console.log(`  Plugin type: ${status.pluginType}`);
				console.log(`  Location: ${status.pluginDir}`);
				console.log(`  Config updated: ${status.configUpdated ? "Yes" : "No"}`);
				if (status.version) {
					console.log(`  Installed version: ${status.version}`);
				}
			}
			console.log("");
			break;
		}

		default:
			// Treat unknown subcommand as install with --type
			if (subcommand.startsWith("--")) {
				// Parse as option
				await handleOpenCodeIntegration(projectPath, "install", [
					subcommand,
					...args,
				]);
			} else {
				console.error(`Unknown subcommand: ${subcommand}`);
				console.error('Run "claudemem install opencode help" for usage.');
				process.exit(1);
			}
	}
}

/**
 * Handle Claude Code integration (just shows instructions)
 */
function handleClaudeCodeIntegration(): void {
	console.log(`
Claude Code Integration
=======================

Claude Code uses plugin marketplaces. To integrate claudemem:

1. Add the MAG plugins marketplace (one-time):

   /plugin marketplace add MadAppGang/claude-code

2. Enable the code-analysis plugin in .claude/settings.json:

   {
     "enabledPlugins": {
       "code-analysis@mag-claude-plugins": true
     }
   }

3. Commit settings.json so your team gets the same setup.

The code-analysis plugin includes detective skills that use claudemem:
  • developer-detective  - Implementation investigation
  • architect-detective  - Architecture analysis
  • tester-detective     - Test coverage gaps
  • debugger-detective   - Bug investigation
  • ultrathink-detective - Comprehensive analysis

For full documentation:
  https://github.com/MadAppGang/claudemem/blob/main/docs/CLAUDE_CODE_INTEGRATION.md
`);
}

// ============================================================================
// Documentation Commands
// ============================================================================

/**
 * Handle 'docs' command - external documentation management
 */
async function handleDocs(args: string[]): Promise<void> {
	const projectPath = resolve(".");
	const subcommand = args[0];

	if (!subcommand || subcommand === "help") {
		console.log(`
Usage: claudemem docs <subcommand> [options]

Subcommands:
  status              Show indexed libraries and cache state
  fetch [library]     Fetch docs for all dependencies or specific library
  refresh             Force refresh all cached documentation
  providers           List available documentation providers
  clear [library]     Clear cached documentation
`);
		return;
	}

	// Import required modules
	const { createFileTracker } = await import("./core/tracker.js");
	const { getIndexDbPath, isDocsEnabled, getDocsConfig, hasContext7ApiKey } =
		await import("./config.js");
	const { createDocsFetcher, createProviders } = await import(
		"./docs/index.js"
	);

	switch (subcommand) {
		case "status":
			await handleDocsStatus(projectPath);
			break;

		case "fetch":
			await handleDocsFetch(projectPath, args.slice(1));
			break;

		case "refresh":
			await handleDocsRefresh(projectPath);
			break;

		case "providers":
			await handleDocsProviders(projectPath);
			break;

		case "clear":
			await handleDocsClear(projectPath, args.slice(1));
			break;

		default:
			console.error(`Unknown subcommand: ${subcommand}`);
			console.error('Run "claudemem docs help" for usage.');
			process.exit(1);
	}
}

/**
 * Show documentation status
 */
async function handleDocsStatus(projectPath: string): Promise<void> {
	const { createFileTracker } = await import("./core/tracker.js");
	const { getIndexDbPath, isDocsEnabled } = await import("./config.js");
	const { existsSync } = await import("node:fs");

	const indexDbPath = getIndexDbPath(projectPath);
	if (!existsSync(indexDbPath)) {
		console.log("\n📚 Documentation Status\n");
		console.log("  No index found. Run 'claudemem index' first.\n");
		return;
	}

	const tracker = createFileTracker(indexDbPath, projectPath);

	try {
		const stats = tracker.getIndexedDocsStats();
		const docs = tracker.getAllIndexedDocs();

		printLogo();
		console.log("\n📚 Documentation Status\n");
		console.log(`  Enabled:     ${isDocsEnabled(projectPath) ? "Yes" : "No"}`);
		console.log(`  Libraries:   ${stats.totalLibraries}`);
		console.log(`  Chunks:      ${stats.totalChunks}`);

		if (stats.oldestFetch) {
			const age = Date.now() - new Date(stats.oldestFetch).getTime();
			const hours = Math.round(age / (1000 * 60 * 60));
			console.log(`  Cache age:   ${hours}h`);
		}

		if (docs.length > 0) {
			console.log("\n  Indexed Libraries:");
			for (const doc of docs.slice(0, 20)) {
				const version = doc.version ? `@${doc.version}` : "";
				const provider = doc.provider.replace("_", ".");
				console.log(
					`    • ${doc.library}${version} (${provider}, ${doc.chunkIds.length} chunks)`,
				);
			}
			if (docs.length > 20) {
				console.log(`    ... and ${docs.length - 20} more`);
			}
		}

		console.log("");
	} finally {
		tracker.close();
	}
}

/**
 * Fetch documentation for dependencies
 */
async function handleDocsFetch(
	projectPath: string,
	args: string[],
): Promise<void> {
	const { createDocsFetcher } = await import("./docs/index.js");
	const { createFileTracker } = await import("./core/tracker.js");
	const { createEmbeddingsClient } = await import("./core/embeddings.js");
	const { createVectorStore } = await import("./core/store.js");
	const { getIndexDbPath, getVectorStorePath, getEmbeddingModel } =
		await import("./config.js");
	const { computeHash } = await import("./core/tracker.js");

	const specificLibrary = args[0];

	printLogo();
	console.log("\n📚 Fetching Documentation\n");

	const fetcher = createDocsFetcher(projectPath);
	if (!fetcher.isEnabled()) {
		console.log("  No documentation providers available.");
		console.log(
			"  Configure Context7 API key or use llms.txt/DevDocs providers.\n",
		);
		return;
	}

	// Initialize components
	const indexDbPath = getIndexDbPath(projectPath);
	const tracker = createFileTracker(indexDbPath, projectPath);
	const embeddingsClient = createEmbeddingsClient({
		model: getEmbeddingModel(projectPath),
	});
	const vectorStore = createVectorStore(getVectorStorePath(projectPath));
	await vectorStore.initialize();

	try {
		let libraries: Array<{ name: string; majorVersion?: string }>;

		if (specificLibrary) {
			libraries = [{ name: specificLibrary }];
		} else {
			const deps = await fetcher.detectDependencies(projectPath);
			libraries = deps.map((d) => ({
				name: d.name,
				majorVersion: d.majorVersion,
			}));
		}

		if (libraries.length === 0) {
			console.log("  No dependencies detected.\n");
			return;
		}

		console.log(
			`  Found ${libraries.length} ${specificLibrary ? "library" : "dependencies"}\n`,
		);

		let successCount = 0;
		for (const lib of libraries) {
			process.stdout.write(`  Fetching ${lib.name}...`);

			try {
				const chunks = await fetcher.fetchAndChunk(lib.name, {
					version: lib.majorVersion,
				});

				if (chunks.length === 0) {
					console.log(" no docs found");
					continue;
				}

				// Delete old docs
				const docsPath = `docs:${lib.name}`;
				await vectorStore.deleteByFile(docsPath);

				// Embed and store
				const texts = chunks.map((c) => c.content);
				const embedResult = await embeddingsClient.embed(texts);

				const fileHash = computeHash(chunks.map((c) => c.content).join(""));
				const chunksWithEmbeddings = chunks.map((chunk, idx) => ({
					id: chunk.id,
					content: chunk.content,
					filePath: docsPath,
					startLine: 0,
					endLine: 0,
					language: "markdown",
					chunkType: "module" as const,
					contentHash: computeHash(chunk.content),
					fileHash,
					vector: embedResult.embeddings[idx],
					name: chunk.title,
					signature: chunk.sourceUrl,
				}));

				await vectorStore.addChunks(chunksWithEmbeddings);

				tracker.markDocsIndexed(
					lib.name,
					lib.majorVersion || null,
					chunks[0].provider,
					fileHash,
					chunks.map((c) => c.id),
				);

				console.log(` ✓ ${chunks.length} chunks`);
				successCount++;
			} catch (error) {
				console.log(` ✗ ${error instanceof Error ? error.message : "failed"}`);
			}
		}

		console.log(`\n  Fetched ${successCount}/${libraries.length} libraries\n`);
	} finally {
		tracker.close();
		await vectorStore.close();
	}
}

/**
 * Force refresh all documentation
 */
async function handleDocsRefresh(projectPath: string): Promise<void> {
	const { createFileTracker } = await import("./core/tracker.js");
	const { getIndexDbPath } = await import("./config.js");
	const { existsSync } = await import("node:fs");

	const indexDbPath = getIndexDbPath(projectPath);
	if (!existsSync(indexDbPath)) {
		console.log("\n  No index found. Run 'claudemem index' first.\n");
		return;
	}

	const tracker = createFileTracker(indexDbPath, projectPath);

	try {
		// Clear all indexed docs to force refresh on next index
		tracker.clearAllIndexedDocs();

		printLogo();
		console.log(
			"\n📚 Documentation cache cleared. Run 'claudemem index' to refresh.\n",
		);
	} finally {
		tracker.close();
	}
}

/**
 * List available documentation providers
 */
async function handleDocsProviders(projectPath: string): Promise<void> {
	const { createProviders } = await import("./docs/index.js");
	const { getDocsConfig, hasContext7ApiKey } = await import("./config.js");

	const config = getDocsConfig(projectPath);
	const providers = createProviders(config);

	printLogo();
	console.log("\n📚 Documentation Providers\n");

	const context7Configured = hasContext7ApiKey();

	console.log(
		`  Context7:  ${context7Configured ? "✓ Configured" : "✗ No API key"}`,
	);
	console.log("  llms.txt:  ✓ Available (free)");
	console.log("  DevDocs:   ✓ Available (free)");

	if (!context7Configured) {
		console.log("\n  To enable Context7:");
		console.log("    1. Get API key from https://context7.com/dashboard");
		console.log("    2. Run: export CONTEXT7_API_KEY=your_key");
	}

	console.log("\n  Provider priority: Context7 > llms.txt > DevDocs");
	console.log(`  Active providers:  ${providers.length}\n`);
}

/**
 * Clear cached documentation
 */
async function handleDocsClear(
	projectPath: string,
	args: string[],
): Promise<void> {
	const { createFileTracker } = await import("./core/tracker.js");
	const { createVectorStore } = await import("./core/store.js");
	const { getIndexDbPath, getVectorStorePath } = await import("./config.js");
	const { existsSync } = await import("node:fs");

	const specificLibrary = args[0];

	const indexDbPath = getIndexDbPath(projectPath);
	if (!existsSync(indexDbPath)) {
		console.log("\n  No index found.\n");
		return;
	}

	const tracker = createFileTracker(indexDbPath, projectPath);
	const vectorStore = createVectorStore(getVectorStorePath(projectPath));
	await vectorStore.initialize();

	try {
		if (specificLibrary) {
			// Clear specific library
			const state = tracker.getDocsState(specificLibrary);
			if (!state) {
				console.log(`\n  No documentation found for '${specificLibrary}'.\n`);
				return;
			}

			await vectorStore.deleteByFile(`docs:${specificLibrary}`);
			tracker.deleteIndexedDocs(specificLibrary);

			printLogo();
			console.log(`\n✓ Cleared documentation for '${specificLibrary}'\n`);
		} else {
			// Clear all documentation
			const docs = tracker.getAllIndexedDocs();

			for (const doc of docs) {
				await vectorStore.deleteByFile(`docs:${doc.library}`);
			}
			tracker.clearAllIndexedDocs();

			printLogo();
			console.log(`\n✓ Cleared all documentation (${docs.length} libraries)\n`);
		}
	} finally {
		tracker.close();
		await vectorStore.close();
	}
}

// ============================================================================
// Learning / Feedback Commands
// ============================================================================

/**
 * Handle 'feedback' command - report search feedback for adaptive ranking
 *
 * Usage:
 *   claudemem feedback --query "auth flow" --helpful id1,id2 --unhelpful id3
 *   claudemem feedback --query "auth flow" --helpful id1 --unhelpful id2,id3
 */
async function handleFeedback(args: string[]): Promise<void> {
	const compactMode = agentMode;
	const pathIdx = args.findIndex((a) => a === "-p" || a === "--path");
	const projectPath = pathIdx >= 0 ? resolve(args[pathIdx + 1]) : process.cwd();

	// Parse --query flag
	const queryIdx = args.findIndex((a) => a === "-q" || a === "--query");
	const query = queryIdx >= 0 ? args[queryIdx + 1] : undefined;

	// Parse --helpful flag (comma-separated chunk IDs)
	const helpfulIdx = args.findIndex((a) => a === "--helpful");
	const helpfulIds =
		helpfulIdx >= 0 && args[helpfulIdx + 1]
			? args[helpfulIdx + 1]
					.split(",")
					.map((id) => id.trim())
					.filter(Boolean)
			: [];

	// Parse --unhelpful flag (comma-separated chunk IDs)
	const unhelpfulIdx = args.findIndex((a) => a === "--unhelpful");
	const unhelpfulIds =
		unhelpfulIdx >= 0 && args[unhelpfulIdx + 1]
			? args[unhelpfulIdx + 1]
					.split(",")
					.map((id) => id.trim())
					.filter(Boolean)
			: [];

	// Parse --results flag (all result IDs from the search)
	const resultsIdx = args.findIndex((a) => a === "--results");
	const resultIds =
		resultsIdx >= 0 && args[resultsIdx + 1]
			? args[resultsIdx + 1]
					.split(",")
					.map((id) => id.trim())
					.filter(Boolean)
			: [...helpfulIds, ...unhelpfulIds]; // Default to combined if not specified

	if (!query) {
		if (compactMode) {
			console.log("error: --query is required");
		} else {
			console.error("Error: --query is required.");
			console.error(
				'Usage: claudemem feedback --query "your query" --helpful id1,id2 --unhelpful id3',
			);
		}
		process.exit(1);
	}

	if (helpfulIds.length === 0 && unhelpfulIds.length === 0) {
		if (compactMode) {
			console.log(
				"error: at least one of --helpful or --unhelpful is required",
			);
		} else {
			console.error(
				"Error: At least one of --helpful or --unhelpful is required.",
			);
			console.error(
				'Usage: claudemem feedback --query "your query" --helpful id1,id2 --unhelpful id3',
			);
		}
		process.exit(1);
	}

	// Check if learning is enabled
	if (!isLearningEnabled(projectPath)) {
		if (compactMode) {
			console.log("error: learning disabled in config");
		} else {
			console.error("Self-learning is disabled in configuration.");
			console.error(
				"Enable it with: claudemem init (or set learning: true in config)",
			);
		}
		process.exit(1);
	}

	const tracker = getFileTracker(projectPath);
	if (!tracker) {
		if (compactMode) {
			console.log("error: no index found");
		} else {
			console.error("No index found. Run 'claudemem index' first.");
		}
		process.exit(1);
	}

	try {
		const { createLearningSystem } = await import("./learning/index.js");
		const learning = createLearningSystem(tracker.getDatabase());

		// Record the feedback
		learning.collector.captureExplicitFeedback({
			query,
			resultIds,
			helpfulIds,
			unhelpfulIds,
		});

		// Train on the feedback
		const weights = await learning.engine.train();

		if (compactMode) {
			console.log("ok");
		} else {
			printLogo();
			console.log("\n✅ Feedback recorded\n");
			console.log(`  Query: "${query}"`);
			console.log(`  Helpful: ${helpfulIds.length} result(s)`);
			console.log(`  Unhelpful: ${unhelpfulIds.length} result(s)`);
			console.log("\n📊 Updated weights:");
			console.log(`  Vector: ${(weights.vectorWeight * 100).toFixed(1)}%`);
			console.log(`  BM25: ${(weights.bm25Weight * 100).toFixed(1)}%`);
			console.log(`  Confidence: ${(weights.confidence * 100).toFixed(0)}%`);
			console.log(`  Total feedback events: ${weights.feedbackCount}`);
			console.log("");
		}
	} finally {
		tracker.close();
	}
}

/**
 * Handle 'learn' command - show learning stats or reset
 *
 * Usage:
 *   claudemem learn                 Show learning statistics
 *   claudemem learn stats           Show detailed learning statistics
 *   claudemem learn sessions        Show session interaction statistics
 *   claudemem learn corrections     Show correction gap statistics
 *   claudemem learn patterns        Show detected patterns
 *   claudemem learn reset           Reset all learned weights
 */
async function handleLearn(args: string[]): Promise<void> {
	const compactMode = agentMode;
	const pathIdx = args.findIndex((a) => a === "-p" || a === "--path");
	const projectPath = pathIdx >= 0 ? resolve(args[pathIdx + 1]) : process.cwd();

	const subcommand = args.find((a) => !a.startsWith("-"));
	const learningEnabled = isLearningEnabled(projectPath);

	// Show warning if learning is disabled (but still allow viewing stats)
	if (!learningEnabled && !compactMode) {
		console.warn("⚠️  Self-learning is disabled in configuration.");
		console.warn(
			"   Enable with: claudemem init (or set learning: true in config)\n",
		);
	}

	const tracker = getFileTracker(projectPath);
	if (!tracker) {
		if (compactMode) {
			console.log("error: no index found");
		} else {
			console.error("No index found. Run 'claudemem index' first.");
		}
		process.exit(1);
	}

	try {
		const { createLearningSystem } = await import("./learning/index.js");
		const learning = createLearningSystem(tracker.getDatabase());

		// ================================================================
		// Interaction Monitoring Subcommands
		// ================================================================

		if (subcommand === "sessions") {
			// Show session interaction statistics
			const { getSessionStatistics, formatSessionStats } = await import(
				"./learning/interaction/index.js"
			);
			const stats = getSessionStatistics(projectPath);

			if (!stats) {
				if (compactMode) {
					console.log("error: interaction monitoring not enabled");
				} else {
					console.error("Interaction monitoring not enabled or no data yet.");
					console.error(
						"Session data is captured automatically during Claude Code sessions.",
					);
				}
				return;
			}

			if (compactMode) {
				console.log(
					`sessions:${stats.totalSessions} tools:${stats.totalToolEvents} corrections:${stats.totalCorrections} intervention:${(stats.avgInterventionRate * 100).toFixed(1)}%`,
				);
			} else {
				printLogo();
				console.log(`\n${formatSessionStats(stats)}`);
				console.log("");
			}
			return;
		}

		if (subcommand === "corrections") {
			// Show correction gap statistics
			const { getCorrectionGapStats, getRecentCorrections } = await import(
				"./learning/interaction/index.js"
			);

			const gapStats = getCorrectionGapStats(projectPath);
			const recentCorrections = getRecentCorrections(projectPath, 0.5);

			if (gapStats.length === 0 && recentCorrections.length === 0) {
				if (compactMode) {
					console.log("corrections:0");
				} else {
					printLogo();
					console.log("\n📊 No corrections detected yet.\n");
					console.log(
						"Corrections are detected when users modify agent-generated code.",
					);
					console.log("");
				}
				return;
			}

			if (compactMode) {
				console.log(`corrections:${recentCorrections.length}`);
			} else {
				printLogo();
				console.log("\n📊 Correction Gap Analysis\n");

				if (gapStats.length > 0) {
					console.log("Files with most corrections:");
					for (const stat of gapStats.slice(0, 10)) {
						console.log(`  ${stat.corrections}x  ${stat.filePath}`);
					}
				}

				if (recentCorrections.length > 0) {
					console.log("\nRecent high-confidence corrections:");
					for (const corr of recentCorrections.slice(0, 5)) {
						const score = (corr.correctionScore * 100).toFixed(0);
						const date = new Date(corr.timestamp).toLocaleDateString();
						console.log(
							`  [${score}%] ${date} - ${corr.triggerEvent?.substring(0, 50) || "N/A"}...`,
						);
					}
				}
				console.log("");
			}
			return;
		}

		if (subcommand === "patterns") {
			// Show detected patterns
			const { getPatternStatistics, formatPatternStats } = await import(
				"./learning/interaction/index.js"
			);
			const stats = getPatternStatistics(projectPath);

			if (!stats || stats.totalPatterns === 0) {
				if (compactMode) {
					console.log("patterns:0");
				} else {
					printLogo();
					console.log("\n📊 No patterns detected yet.\n");
					console.log(
						"Patterns are mined from tool sequences and error clusters.",
					);
					console.log("More interaction data is needed for pattern detection.");
					console.log("");
				}
				return;
			}

			if (compactMode) {
				console.log(`patterns:${stats.totalPatterns}`);
			} else {
				printLogo();
				console.log(`\n${formatPatternStats(stats)}`);
				console.log("");
			}
			return;
		}

		// ================================================================
		// Legacy Learning Subcommands
		// ================================================================

		if (subcommand === "reset") {
			// Block reset if learning is disabled
			if (!learningEnabled) {
				if (compactMode) {
					console.log("error: learning disabled in config");
				} else {
					console.error(
						"Cannot reset: Self-learning is disabled in configuration.",
					);
					console.error("Enable it first with: claudemem init");
				}
				return;
			}

			// Reset learning
			const force = args.includes("--force") || args.includes("-f");

			if (!force && !compactMode) {
				const confirmed = await confirm({
					message: "Reset all learned weights? This cannot be undone.",
					default: false,
				});

				if (!confirmed) {
					console.log("Cancelled.");
					return;
				}
			}

			learning.engine.reset();

			if (compactMode) {
				console.log("ok");
			} else {
				printLogo();
				console.log("\n✅ Learning data reset to defaults.\n");
			}
			return;
		}

		// Show stats (default or "stats" subcommand)
		const stats = learning.store.getStatistics();
		const weights = learning.engine.getWeights();

		// Extract counts from eventsByType
		const explicitCount = stats.eventsByType?.explicit ?? 0;
		const refinementCount = stats.eventsByType?.refinement ?? 0;
		const implicitCount = stats.eventsByType?.implicit ?? 0;
		const trackedFilesCount = stats.topBoostedFiles?.length ?? 0;

		if (compactMode) {
			console.log(
				`feedback:${stats.totalFeedbackEvents} queries:${stats.uniqueQueries}`,
			);
		} else {
			printLogo();
			console.log("\n📊 Learning Statistics\n");
			console.log(`  Total feedback events: ${stats.totalFeedbackEvents}`);
			console.log(`    Explicit: ${explicitCount}`);
			console.log(`    Refinement: ${refinementCount}`);
			console.log(`    Implicit: ${implicitCount}`);
			console.log(`  Unique queries: ${stats.uniqueQueries}`);
			console.log(`  Tracked files: ${trackedFilesCount}`);
			if (stats.lastTrainingAt) {
				console.log(`  Last trained: ${stats.lastTrainingAt.toISOString()}`);
			}
			console.log("\n📈 Current Weights\n");
			console.log(`  Vector: ${(weights.vectorWeight * 100).toFixed(1)}%`);
			console.log(`  BM25: ${(weights.bm25Weight * 100).toFixed(1)}%`);
			console.log(`  Confidence: ${(weights.confidence * 100).toFixed(0)}%`);

			// Show top file boosts if any
			const fileBoosts = weights.fileBoosts;
			if (fileBoosts.size > 0) {
				console.log("\n📁 File Boosts (top 10)\n");
				const sorted = [...fileBoosts.entries()]
					.sort((a, b) => b[1] - a[1])
					.slice(0, 10);
				for (const [file, boost] of sorted) {
					const boostPct = ((boost - 1) * 100).toFixed(0);
					const sign = boost >= 1 ? "+" : "";
					console.log(`  ${sign}${boostPct}%  ${file}`);
				}
			}

			// Show document type weights
			const docWeights = weights.documentTypeWeights;
			if (Object.keys(docWeights).length > 0) {
				console.log("\n📄 Document Type Weights\n");
				const sorted = Object.entries(docWeights).sort(
					(a, b) => (b[1] ?? 0) - (a[1] ?? 0),
				);
				for (const [type, weight] of sorted) {
					console.log(`  ${((weight ?? 0) * 100).toFixed(0)}%  ${type}`);
				}
			}

			console.log("");
		}
	} finally {
		tracker.close();
	}
}

// ============================================================================
// AI Instructions Command
// ============================================================================

function handleAiInstructions(args: string[]): void {
	const c = {
		reset: "\x1b[0m",
		bold: "\x1b[1m",
		dim: "\x1b[2m",
		cyan: "\x1b[36m",
		green: "\x1b[38;5;78m",
		yellow: "\x1b[33m",
		orange: "\x1b[38;5;209m",
	};

	const compact = args.includes("--compact") || args.includes("-c");
	const mcp = args.includes("--mcp-format") || args.includes("-m");
	const quick = args.includes("--quick") || args.includes("-q");
	const targetArg = args.find((a) => !a.startsWith("-"));

	// No target specified - show help
	if (!targetArg) {
		printLogo();
		console.log(`\n${c.orange}${c.bold}AI AGENT INSTRUCTIONS${c.reset}\n`);
		console.log("Print instructions for AI agents using claudemem.\n");
		console.log(`${c.yellow}${c.bold}USAGE${c.reset}`);
		console.log(`  ${c.cyan}claudemem ai <target>${c.reset} [options]\n`);
		console.log(`${c.yellow}${c.bold}TARGETS${c.reset}`);
		console.log(
			`  ${c.green}skill${c.reset}       Full claudemem skill (all capabilities)`,
		);
		console.log(
			`  ${c.green}architect${c.reset}   System design, codebase structure`,
		);
		console.log(
			`  ${c.green}developer${c.reset}   Implementation, code navigation`,
		);
		console.log(
			`  ${c.green}tester${c.reset}      Test coverage, quality assurance`,
		);
		console.log(
			`  ${c.green}debugger${c.reset}    Error tracing, diagnostics\n`,
		);
		console.log(`${c.yellow}${c.bold}OPTIONS${c.reset}`);
		console.log(
			`  ${c.cyan}-c, --compact${c.reset}       Minimal version (~50 tokens)`,
		);
		console.log(
			`  ${c.cyan}-q, --quick${c.reset}         Quick reference (~30 tokens)`,
		);
		console.log(`  ${c.cyan}-m, --mcp-format${c.reset}    MCP tools format\n`);
		console.log(`${c.yellow}${c.bold}EXAMPLES${c.reset}`);
		console.log(`  ${c.dim}# Full skill document for CLAUDE.md${c.reset}`);
		console.log(
			`  ${c.cyan}claudemem --agent ai skill >> CLAUDE.md${c.reset}\n`,
		);
		console.log(`  ${c.dim}# Compact skill + role for system prompt${c.reset}`);
		console.log(
			`  ${c.cyan}claudemem --agent ai developer --compact${c.reset}\n`,
		);
		console.log(`  ${c.dim}# MCP tools reference${c.reset}`);
		console.log(`  ${c.cyan}claudemem ai skill -m${c.reset}\n`);
		console.log(`  ${c.dim}# Quick reference (minimal tokens)${c.reset}`);
		console.log(`  ${c.cyan}claudemem ai skill --quick${c.reset}\n`);
		return;
	}

	const target = targetArg.toLowerCase();
	let output: string;
	let title: string;

	// Handle "skill" target
	if (target === "skill") {
		if (quick) {
			output = CLAUDEMEM_QUICK_REF;
			title = "QUICK REFERENCE";
		} else if (mcp) {
			output = CLAUDEMEM_MCP_SKILL;
			title = "MCP SKILL";
		} else if (compact) {
			output = CLAUDEMEM_SKILL_COMPACT;
			title = "SKILL (COMPACT)";
		} else {
			output = CLAUDEMEM_SKILL;
			title = "SKILL";
		}
	}
	// Handle role targets
	else if (VALID_ROLES.includes(target as AgentRole)) {
		const role = target as AgentRole;
		if (compact) {
			output = getCompactSkillWithRole(role);
			title = `${role.toUpperCase()} SKILL (COMPACT)`;
		} else {
			output = getFullSkillWithRole(role);
			title = `${role.toUpperCase()} SKILL`;
		}
	}
	// Unknown target
	else {
		console.error(`Error: Unknown target "${targetArg}"`);
		console.error(`Valid targets: skill, ${VALID_ROLES.join(", ")}`);
		process.exit(1);
	}

	// Output
	if (agentMode) {
		console.log(output);
	} else {
		printLogo();
		console.log(`\n${c.orange}${c.bold}${title}${c.reset}`);
		console.log(`${c.dim}${"─".repeat(60)}${c.reset}\n`);
		console.log(output);
		console.log(`\n${c.dim}${"─".repeat(60)}${c.reset}`);
		console.log(
			`${c.dim}For piping: claudemem --agent ai ${target} | pbcopy${c.reset}\n`,
		);
	}
}

// ============================================================================
// Update Command
// ============================================================================

/**
 * Handle update command - update to latest version from npm
 */
async function handleUpdate(args: string[]): Promise<void> {
	const autoApprove = args.includes("--yes") || args.includes("-y");

	if (!agentMode) {
		printLogo();
	}

	const { UpdateManager } = await import("./updater/index.js");
	const updater = new UpdateManager();

	if (agentMode) {
		// Compact output for AI agents
		const check = await updater.checkForUpdate();

		if (!check.isUpdateAvailable) {
			console.log(`claudemem v${check.currentVersion} - already latest`);
			return;
		}

		console.log(
			`claudemem v${check.currentVersion} - Update available: v${check.latestVersion}`,
		);

		if (!autoApprove) {
			console.log("Use --yes flag to auto-approve");
			return;
		}

		console.log("Updating...");
		const result = await updater.performUpdate({ verbose: false });

		if (result.success) {
			console.log(`Updated to v${result.newVersion}`);
		} else {
			console.log(`Update failed: ${result.error}`);
			process.exit(1);
		}
	} else {
		// Interactive output
		console.log("Checking for updates...\n");
		const check = await updater.checkForUpdate();

		if (!check.isUpdateAvailable) {
			console.log(`✓ Already on latest version: v${check.currentVersion}`);
			return;
		}

		console.log(
			`Update available: v${check.currentVersion} → v${check.latestVersion}`,
		);
		if (check.publishedAt) {
			const date = new Date(check.publishedAt).toLocaleDateString();
			console.log(`Published: ${date}`);
		}
		console.log();

		const shouldUpdate =
			autoApprove || (await confirm({ message: "Update now?", default: true }));

		if (!shouldUpdate) {
			console.log("Update cancelled.");
			return;
		}

		console.log("\nUpdating claudemem...");
		const result = await updater.performUpdate({ verbose: true });

		if (result.success) {
			console.log(`\n✓ Successfully updated to v${result.newVersion}`);
			console.log("Run 'claudemem --version' to verify.");
		} else {
			console.error(`\n✗ Update failed: ${result.error}`);

			// Provide helpful error messages
			if (
				result.error?.includes("EACCES") ||
				result.error?.includes("permission")
			) {
				console.error(
					"\nPermission denied. Try running with elevated privileges:",
				);
				console.error("  sudo npm install -g claude-codemem@latest");
			} else if (
				result.error?.includes("spawn") ||
				result.error?.includes("not found")
			) {
				console.error(
					"\nPackage manager not found. Please install npm or bun.",
				);
			} else {
				console.error("\nPlease try updating manually:");
				console.error("  npm install -g claude-codemem@latest");
			}

			process.exit(1);
		}
	}
}

function printHelp(): void {
	// Colors (matching claudish style)
	const c = {
		reset: "\x1b[0m",
		bold: "\x1b[1m",
		dim: "\x1b[2m",
		cyan: "\x1b[36m",
		green: "\x1b[38;5;78m", // Softer green (not acid)
		yellow: "\x1b[33m",
		blue: "\x1b[34m",
		magenta: "\x1b[35m",
		orange: "\x1b[38;5;209m", // Salmon/orange like claudish
		gray: "\x1b[90m",
	};

	// ASCII art logo (claudish style)
	console.log(`
${c.orange}   ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗${c.reset}${c.green}███╗   ███╗███████╗███╗   ███╗${c.reset}
${c.orange}  ██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝${c.reset}${c.green}████╗ ████║██╔════╝████╗ ████║${c.reset}
${c.orange}  ██║     ██║     ███████║██║   ██║██║  ██║█████╗  ${c.reset}${c.green}██╔████╔██║█████╗  ██╔████╔██║${c.reset}
${c.orange}  ██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝  ${c.reset}${c.green}██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║${c.reset}
${c.orange}  ╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗${c.reset}${c.green}██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║${c.reset}
${c.orange}   ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝${c.reset}${c.green}╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝${c.reset}

${c.bold}  Local Code Indexing.${c.reset} ${c.green}For Claude Code.${c.reset}
${c.dim}  Semantic search powered by embeddings via OpenRouter${c.reset}

${c.yellow}${c.bold}USAGE${c.reset}
  ${c.cyan}claudemem${c.reset} <command> [options]

${c.yellow}${c.bold}SERVER MODES${c.reset}
  ${c.cyan}claudemem --mcp${c.reset}                         Run MCP server for Claude Code
  ${c.cyan}claudemem --autocomplete-server${c.reset}         Run JSONL autocomplete server (editors)
  ${c.cyan}  --project${c.reset} <path>                      Project path (default: cwd)

${c.yellow}${c.bold}COMMANDS${c.reset}
  ${c.green}index${c.reset} [path]           Index a codebase (default: current directory)
  ${c.green}search${c.reset} <query>         Search indexed code ${c.dim}(auto-indexes changes)${c.reset}
  ${c.green}status${c.reset} [path]          Show index status
  ${c.green}clear${c.reset} [path]           Clear the index
  ${c.green}init${c.reset}                   Interactive setup wizard
  ${c.green}models${c.reset}                 List available embedding models
  ${c.green}benchmark${c.reset}              Compare embedding models (index, search quality, cost)
  ${c.green}benchmark-llm${c.reset}          Comprehensive LLM evaluation (4 methods, resumable)
  ${c.green}benchmark-list${c.reset}         List all benchmark runs
  ${c.green}benchmark-show${c.reset}         Show results for a specific run
  ${c.green}ai${c.reset} <role>             Print AI agent instructions (architect|developer|tester|debugger)
  ${c.green}update${c.reset}                 Update to latest version from npm

${c.yellow}${c.bold}SYMBOL GRAPH COMMANDS${c.reset} ${c.dim}(use --agent for compact output)${c.reset}
  ${c.green}map${c.reset} [query]            Get repo structure ${c.dim}(optionally filtered by query)${c.reset}
  ${c.green}symbol${c.reset} <name>          Find symbol definition
  ${c.green}callers${c.reset} <name>         Find what calls a symbol
  ${c.green}callees${c.reset} <name>         Find what a symbol calls
  ${c.green}context${c.reset} <name>         Get symbol with its callers and callees

${c.yellow}${c.bold}CODE ANALYSIS COMMANDS${c.reset}
  ${c.green}dead-code${c.reset}              Find potentially dead code ${c.dim}(zero callers + low PageRank)${c.reset}
  ${c.green}test-gaps${c.reset}              Find important code without test coverage
  ${c.green}impact${c.reset} <symbol>        Analyze change impact ${c.dim}(transitive callers)${c.reset}

${c.yellow}${c.bold}DEVELOPER EXPERIENCE${c.reset}
  ${c.green}watch${c.reset}                  Watch for changes and auto-reindex ${c.dim}(daemon mode)${c.reset}
  ${c.green}hooks${c.reset} <subcommand>     Manage git hooks ${c.dim}(install|uninstall|status)${c.reset}
  ${c.green}hook${c.reset}                   Claude Code hook handler ${c.dim}(reads JSON from stdin)${c.reset}
  ${c.green}install${c.reset} <tool>         Install integration ${c.dim}(opencode|claude-code)${c.reset}

${c.yellow}${c.bold}SELF-LEARNING SYSTEM${c.reset} ${c.dim}(enabled by default, learns from interactions)${c.reset}
  ${c.green}feedback${c.reset}               Report search feedback ${c.dim}(--query, --helpful, --unhelpful)${c.reset}
  ${c.green}learn${c.reset}                  Show learning statistics
  ${c.green}learn sessions${c.reset}         Show session interaction statistics
  ${c.green}learn corrections${c.reset}      Show correction gap analysis
  ${c.green}learn patterns${c.reset}         Show detected patterns
  ${c.green}learn reset${c.reset}            Reset learned weights to defaults
  ${c.dim}Configure: claudemem init or set "learning: false" in ~/.claudemem/config.json${c.reset}

${c.yellow}${c.bold}INDEX OPTIONS${c.reset}
  ${c.cyan}-f, --force${c.reset}            Force re-index all files
  ${c.cyan}--no-llm${c.reset}               Disable LLM enrichment (summaries, idioms, etc.)

${c.yellow}${c.bold}SEARCH OPTIONS${c.reset}
  ${c.cyan}-n, --limit${c.reset} <n>        Maximum results (default: 10)
  ${c.cyan}-l, --language${c.reset} <lang>  Filter by programming language
  ${c.cyan}-p, --path${c.reset} <path>      Project path (default: current directory)
  ${c.cyan}-y, --yes${c.reset}              Auto-create index if missing (no prompt)
  ${c.cyan}--no-reindex${c.reset}           Skip auto-reindexing changed files
  ${c.cyan}--use-case${c.reset} <case>      Search preset: fim | search | navigation (default: search)
  ${c.cyan}-k, --keyword${c.reset}          Keyword-only search (skip embedding, use BM25 only)

${c.yellow}${c.bold}MODELS OPTIONS${c.reset}
  ${c.cyan}--free${c.reset}                 Show only free models
  ${c.cyan}--refresh${c.reset}              Force refresh from API
  ${c.cyan}--ollama${c.reset}               Show Ollama local models

${c.yellow}${c.bold}BENCHMARK OPTIONS${c.reset} ${c.dim}(embedding benchmark)${c.reset}
  ${c.cyan}--models=${c.reset}<list>        Comma-separated model IDs to test
  ${c.cyan}--real${c.reset}                 Use 100 chunks (default: 50)
  ${c.cyan}--auto${c.reset}                 Auto-generate queries from docstrings (any codebase)
  ${c.cyan}--verbose${c.reset}              Show detailed per-query results

${c.yellow}${c.bold}BENCHMARK-LLM OPTIONS${c.reset} ${c.dim}(comprehensive LLM evaluation)${c.reset}
  ${c.cyan}--generators=${c.reset}<list>    LLM providers/models to test (comma-separated)
                          ${c.dim}Examples: openrouter/openai/gpt-4o, anthropic/claude-3-5-sonnet${c.reset}
  ${c.cyan}--judges=${c.reset}<list>        LLM models for LLM-as-Judge evaluation
  ${c.cyan}--cases=${c.reset}<n>            Target code units (default: 20)
  ${c.cyan}--resume=${c.reset}<run-id>      Resume from previous run
  ${c.cyan}--local-parallelism=${c.reset}<n> Local models parallelism (1=seq, 2-4, all) ${c.dim}(default: 1)${c.reset}
  ${c.cyan}--no-upload${c.reset}            Skip Firebase upload (local only)
  ${c.cyan}--list${c.reset}, ${c.cyan}-l${c.reset}              List all benchmark runs
  ${c.cyan}--verbose${c.reset}, ${c.cyan}-v${c.reset}           Show detailed progress

${c.yellow}${c.bold}BENCHMARK-LLM SUBCOMMANDS${c.reset}
  ${c.green}benchmark-llm upload${c.reset} <run-id>  Upload a specific run to Firebase
  ${c.dim}Evaluation methods: LLM-as-Judge, Contrastive, Retrieval (P@K/MRR), Downstream${c.reset}
  ${c.dim}Outputs: JSON, Markdown, HTML reports${c.reset}

${c.yellow}${c.bold}SYMBOL GRAPH OPTIONS${c.reset}
  ${c.cyan}--tokens${c.reset} <n>           Max tokens for map output (default: 2000)
  ${c.cyan}--file${c.reset} <hint>          Disambiguate symbol by file path
  ${c.cyan}--callers${c.reset} <n>          Max callers to show (default: 10)
  ${c.cyan}--callees${c.reset} <n>          Max callees to show (default: 15)

${c.yellow}${c.bold}CODE ANALYSIS OPTIONS${c.reset}
  ${c.cyan}--max-pagerank${c.reset} <n>     Dead-code threshold (default: 0.001)
  ${c.cyan}--min-pagerank${c.reset} <n>     Test-gaps threshold (default: 0.01)
  ${c.cyan}--max-depth${c.reset} <n>        Impact analysis depth (default: 10)
  ${c.cyan}--include-exported${c.reset}     Include exported symbols in dead-code scan
  ${c.cyan}-n, --limit${c.reset} <n>        Max results (default: 50 for dead-code, 30 for test-gaps)

${c.yellow}${c.bold}WATCH/HOOKS OPTIONS${c.reset}
  ${c.cyan}--debounce${c.reset} <ms>        Watch debounce time (default: 1000ms)

${c.yellow}${c.bold}FEEDBACK OPTIONS${c.reset}
  ${c.cyan}-q, --query${c.reset} <query>    The search query that was used
  ${c.cyan}--helpful${c.reset} <ids>        Comma-separated IDs of helpful results
  ${c.cyan}--unhelpful${c.reset} <ids>      Comma-separated IDs of unhelpful results
  ${c.cyan}--results${c.reset} <ids>        All result IDs from the search (optional)

${c.yellow}${c.bold}LEARN OPTIONS${c.reset}
  ${c.cyan}-f, --force${c.reset}            Skip confirmation for reset

${c.yellow}${c.bold}AI OPTIONS${c.reset}
  ${c.cyan}-c, --compact${c.reset}          Minimal version (~50 tokens)
  ${c.cyan}-q, --quick${c.reset}            Quick reference (~30 tokens)
  ${c.cyan}-m, --mcp-format${c.reset}       MCP tools format

${c.yellow}${c.bold}GLOBAL OPTIONS${c.reset}
  ${c.cyan}-v, --version${c.reset}          Show version
  ${c.cyan}-h, --help${c.reset}             Show this help
  ${c.cyan}--agent${c.reset}                Agent mode: no logo, compact output (for tools/scripts)
  ${c.cyan}--models${c.reset}               List available embedding models (with --free, --refresh)

${c.yellow}${c.bold}MCP SERVER${c.reset}
  ${c.cyan}claudemem --mcp${c.reset}        Start as MCP server (for Claude Code)

${c.yellow}${c.bold}ENVIRONMENT${c.reset}
  ${c.magenta}OPENROUTER_API_KEY${c.reset}     API key for embeddings
  ${c.magenta}ANTHROPIC_API_KEY${c.reset}      API key for LLM enrichment (Anthropic provider)
  ${c.magenta}CLAUDEMEM_MODEL${c.reset}        Override default embedding model
  ${c.magenta}CLAUDEMEM_LLM${c.reset}          LLM spec (e.g., "a/sonnet", "or/openai/gpt-4o", "cc/haiku")

${c.yellow}${c.bold}EXAMPLES${c.reset}
  ${c.dim}# First time setup${c.reset}
  ${c.cyan}claudemem init${c.reset}

  ${c.dim}# Index current project${c.reset}
  ${c.cyan}claudemem index${c.reset}

  ${c.dim}# Index without LLM enrichment (faster, code-only)${c.reset}
  ${c.cyan}claudemem index --no-llm${c.reset}

  ${c.dim}# Search (auto-indexes changes)${c.reset}
  ${c.cyan}claudemem search "authentication flow"${c.reset}
  ${c.cyan}claudemem search "error handling" -n 5${c.reset}

  ${c.dim}# Search without auto-reindex${c.reset}
  ${c.cyan}claudemem search "query" --no-reindex${c.reset}

  ${c.dim}# Auto-create index on first search${c.reset}
  ${c.cyan}claudemem search "something" -y${c.reset}

  ${c.dim}# Show available embedding models${c.reset}
  ${c.cyan}claudemem --models${c.reset}
  ${c.cyan}claudemem --models --free${c.reset}

  ${c.dim}# Benchmark embedding models (index speed, search quality, cost)${c.reset}
  ${c.cyan}claudemem benchmark${c.reset}
  ${c.cyan}claudemem benchmark --auto${c.reset}  ${c.dim}# works on any codebase${c.reset}
  ${c.cyan}claudemem benchmark --models=qwen/qwen3-embedding-8b,openai/text-embedding-3-small${c.reset}

  ${c.dim}# Get AI agent instructions${c.reset}
  ${c.cyan}claudemem ai${c.reset}                              ${c.dim}# show help${c.reset}
  ${c.cyan}claudemem ai skill${c.reset}                        ${c.dim}# full skill document${c.reset}
  ${c.cyan}claudemem --agent ai skill >> CLAUDE.md${c.reset}   ${c.dim}# append to CLAUDE.md${c.reset}
  ${c.cyan}claudemem ai developer --compact${c.reset}          ${c.dim}# role + skill (minimal)${c.reset}

  ${c.dim}# Symbol graph commands (for AI agents)${c.reset}
  ${c.cyan}claudemem --agent map${c.reset}                     ${c.dim}# repo structure${c.reset}
  ${c.cyan}claudemem --agent map "auth"${c.reset}              ${c.dim}# focused on query${c.reset}
  ${c.cyan}claudemem --agent symbol Indexer${c.reset}          ${c.dim}# find symbol${c.reset}
  ${c.cyan}claudemem --agent callers VectorStore${c.reset}     ${c.dim}# what uses it?${c.reset}
  ${c.cyan}claudemem --agent callees VectorStore${c.reset}     ${c.dim}# what it uses?${c.reset}
  ${c.cyan}claudemem --agent context VectorStore${c.reset}     ${c.dim}# full context${c.reset}

  ${c.dim}# Code analysis commands${c.reset}
  ${c.cyan}claudemem dead-code${c.reset}                       ${c.dim}# find dead code${c.reset}
  ${c.cyan}claudemem test-gaps${c.reset}                       ${c.dim}# find untested code${c.reset}
  ${c.cyan}claudemem impact createIndexer${c.reset}            ${c.dim}# change impact analysis${c.reset}

  ${c.dim}# Developer experience${c.reset}
  ${c.cyan}claudemem watch${c.reset}                           ${c.dim}# auto-reindex on changes${c.reset}

  ${c.dim}# Adaptive learning${c.reset}
  ${c.cyan}claudemem feedback --query "auth" --helpful id1,id2 --unhelpful id3${c.reset}
  ${c.cyan}claudemem learn${c.reset}                           ${c.dim}# show learning stats${c.reset}
  ${c.cyan}claudemem learn sessions${c.reset}                  ${c.dim}# session interactions${c.reset}
  ${c.cyan}claudemem learn corrections${c.reset}               ${c.dim}# correction gap analysis${c.reset}
  ${c.cyan}claudemem learn reset -f${c.reset}                  ${c.dim}# reset without prompt${c.reset}
  ${c.cyan}claudemem hooks install${c.reset}                   ${c.dim}# install git hook${c.reset}

${c.yellow}${c.bold}MORE INFO${c.reset}
  ${c.blue}https://github.com/MadAppGang/claudemem${c.reset}
`);
}

// ============================================================================
// Benchmark List/Show Handlers
// ============================================================================

async function handleBenchmarkList(args: string[]): Promise<void> {
	const { BenchmarkDatabase } = await import(
		"./benchmark-v2/storage/benchmark-db.js"
	);

	// Colors for output
	const c = {
		reset: "\x1b[0m",
		bold: "\x1b[1m",
		dim: "\x1b[2m",
		cyan: "\x1b[36m",
		green: "\x1b[38;5;78m",
		yellow: "\x1b[33m",
		red: "\x1b[31m",
	};

	// Parse arguments
	const limitArg = Number.parseInt(
		args.find((a) => a.startsWith("--limit="))?.split("=")[1] || "20",
		10,
	);
	const statusFilter = args
		.find((a) => a.startsWith("--status="))
		?.split("=")[1] as "completed" | "failed" | "running" | undefined;
	const projectPath =
		args.find((a) => a.startsWith("--project="))?.split("=")[1] ||
		process.cwd();

	const dbPath = join(projectPath, ".claudemem", "benchmark.db");
	if (!existsSync(dbPath)) {
		console.log(
			`${c.yellow}No benchmark database found at ${dbPath}${c.reset}`,
		);
		console.log(
			`${c.dim}Run benchmarks first with: claudemem benchmark ...${c.reset}`,
		);
		return;
	}

	const db = new BenchmarkDatabase(dbPath);
	const runs = db.listRuns(statusFilter).slice(0, limitArg);

	if (runs.length === 0) {
		console.log(`${c.yellow}No benchmark runs found${c.reset}`);
		return;
	}

	console.log(
		`\n${c.cyan}📊 Benchmark Runs${c.reset} (${runs.length} shown)\n`,
	);
	console.log(
		`${"ID".padEnd(38)} ${"Status".padEnd(10)} ${"Date".padEnd(20)} ${"Models".padEnd(8)} ${"Cases".padEnd(6)} Project`,
	);
	console.log(
		`${"─".repeat(38)} ${"─".repeat(10)} ${"─".repeat(20)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(30)}`,
	);

	for (const run of runs) {
		const date = new Date(run.startedAt).toLocaleString();
		const statusColor =
			run.status === "completed"
				? c.green
				: run.status === "failed"
					? c.red
					: c.yellow;
		const modelCount = run.config.generators.length;
		const caseCount = run.config.sampleSize;
		const project =
			run.config.projectPath.split("/").pop() || run.config.projectPath;

		console.log(
			`${c.dim}${run.id.slice(0, 36)}${c.reset} ` +
				`${statusColor}${run.status.padEnd(10)}${c.reset} ` +
				`${date.padEnd(20)} ` +
				`${String(modelCount).padEnd(8)} ` +
				`${String(caseCount).padEnd(6)} ` +
				`${project}`,
		);
	}

	console.log(
		`\n${c.dim}Use: claudemem benchmark-show <run-id> to view results${c.reset}\n`,
	);
}

async function handleBenchmarkShow(args: string[]): Promise<void> {
	const { BenchmarkDatabase } = await import(
		"./benchmark-v2/storage/benchmark-db.js"
	);
	const { displayBenchmarkResults } = await import("./benchmark-v2/display.js");

	// Colors for output
	const c = {
		reset: "\x1b[0m",
		bold: "\x1b[1m",
		dim: "\x1b[2m",
		cyan: "\x1b[36m",
		green: "\x1b[38;5;78m",
		yellow: "\x1b[33m",
		red: "\x1b[31m",
	};

	const runId = args.find((a) => !a.startsWith("--"));
	if (!runId) {
		console.log(`${c.red}Error: Please provide a run ID${c.reset}`);
		console.log("Usage: claudemem benchmark-show <run-id>");
		console.log("       claudemem benchmark-show <run-id> --json");
		console.log(
			"       claudemem benchmark-show <run-id> --project=/path/to/project",
		);
		return;
	}

	const projectPath =
		args.find((a) => a.startsWith("--project="))?.split("=")[1] ||
		process.cwd();
	const dbPath = join(projectPath, ".claudemem", "benchmark.db");
	if (!existsSync(dbPath)) {
		console.log(
			`${c.yellow}No benchmark database found at ${dbPath}${c.reset}`,
		);
		return;
	}

	const db = new BenchmarkDatabase(dbPath);
	const run = db.getRun(runId);

	if (!run) {
		console.log(`${c.red}Error: Run not found: ${runId}${c.reset}`);
		return;
	}

	const jsonOutput = args.includes("--json");

	if (jsonOutput) {
		const scores = db.getAggregatedScores(runId);
		console.log(
			JSON.stringify(
				{
					run: {
						id: run.id,
						status: run.status,
						startedAt: run.startedAt,
						config: run.config,
					},
					scores: Object.fromEntries(scores),
				},
				null,
				2,
			),
		);
		return;
	}

	// Display run info header
	console.log(`\n${c.cyan}📊 Benchmark Run: ${run.id}${c.reset}\n`);
	console.log(
		`Status:     ${run.status === "completed" ? c.green : c.red}${run.status}${c.reset}`,
	);
	console.log(`Started:    ${new Date(run.startedAt).toLocaleString()}`);
	console.log(`Project:    ${run.config.projectPath}`);
	console.log(`Cases:      ${run.config.sampleSize}`);
	console.log();

	// Use the full display function (same as after benchmark run)
	const generatorSpecs = run.config.generators.map((g) => g.id);
	const judgeModels = run.config.judges;

	await displayBenchmarkResults(db, runId, generatorSpecs, judgeModels);
}
