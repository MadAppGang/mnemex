/**
 * Command Output Components
 *
 * Barrel export for all components under src/tui/components/command/.
 * These components are used by TuiOutput (src/output/tui-output.ts) to
 * render non-interactive command output via OpenTUI React with a temporary
 * renderer (useAlternateScreen: false).
 *
 * Component map:
 *   CommandOutputApp  — root wrapper, hosts child component + onDone lifecycle
 *   IndexProgress     — animated multi-phase progress for `mnemex index`
 *   StatusMessage     — success / error / info / warning footer lines
 */

export { CommandOutputApp } from "./CommandOutputApp.js";
export type { CommandOutputAppProps } from "./CommandOutputApp.js";

export { IndexProgress } from "./IndexProgress.js";
export type { IndexProgressProps } from "./IndexProgress.js";

export { StatusMessage } from "./StatusMessage.js";
export type { StatusMessageProps, StatusType } from "./StatusMessage.js";

export { BenchmarkResults, BenchmarkResultsApp } from "./BenchmarkResults.js";
export type {
	BenchmarkResultsProps,
	BenchmarkResultsData,
	BenchmarkResultsAppProps,
} from "./BenchmarkResults.js";

export { BenchmarkListApp } from "./BenchmarkList.js";
export type {
	RunError,
	BenchmarkRunSummary,
	BenchmarkListAppProps,
} from "./BenchmarkList.js";

export { MetricsTable } from "./MetricsTable.js";
export type { MetricsTableProps, MetricsColumn } from "./MetricsTable.js";

export { MetricHints } from "./MetricHints.js";
export type { MetricHintsProps, MetricHint } from "./MetricHints.js";
