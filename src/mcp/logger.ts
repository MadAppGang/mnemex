/**
 * MCP Server Logger
 *
 * All output goes to stderr (stdout is reserved for MCP protocol).
 * Supports configurable log levels: debug < info < warn < error.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

/**
 * Stderr logger with configurable minimum log level.
 * Format: [mnemex] [LEVEL] message
 */
export class Logger {
	private minLevel: number;

	constructor(private level: LogLevel) {
		this.minLevel = LOG_LEVEL_ORDER[level];
	}

	debug(msg: string, ...args: unknown[]): void {
		if (LOG_LEVEL_ORDER.debug >= this.minLevel) {
			this.write("DEBUG", msg, args);
		}
	}

	info(msg: string, ...args: unknown[]): void {
		if (LOG_LEVEL_ORDER.info >= this.minLevel) {
			this.write("INFO", msg, args);
		}
	}

	warn(msg: string, ...args: unknown[]): void {
		if (LOG_LEVEL_ORDER.warn >= this.minLevel) {
			this.write("WARN", msg, args);
		}
	}

	error(msg: string, ...args: unknown[]): void {
		// error always writes
		this.write("ERROR", msg, args);
	}

	private write(label: string, msg: string, args: unknown[]): void {
		const extra = args.length > 0 ? " " + args.map(formatArg).join(" ") : "";
		process.stderr.write(`[mnemex] [${label}] ${msg}${extra}\n`);
	}
}

function formatArg(arg: unknown): string {
	if (typeof arg === "string") return arg;
	if (arg instanceof Error) return arg.message;
	try {
		return JSON.stringify(arg);
	} catch {
		return String(arg);
	}
}

/**
 * Create a Logger from a log level string.
 */
export function createLogger(level: LogLevel): Logger {
	return new Logger(level);
}
