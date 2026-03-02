/**
 * Unit tests for Logger
 *
 * Verifies that:
 * - A logger configured with level "error" only produces output for error()
 * - A logger configured with level "debug" produces output for all levels
 * - All output is written to stderr (not stdout)
 * - The format includes the level label and the message
 *
 * Black-box: tests exercise the public Logger API only.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Logger } from "../../../src/mcp/logger.js";

// ---------------------------------------------------------------------------
// Stderr capture helper
// ---------------------------------------------------------------------------

/**
 * Intercept process.stderr.write for the duration of a callback.
 * Returns all strings written during that call.
 */
function captureStderr(fn: () => void): string[] {
	const captured: string[] = [];
	const original = process.stderr.write.bind(process.stderr);

	// Override with a spy that captures and suppresses output
	(process.stderr as { write: typeof process.stderr.write }).write = (
		chunk: string | Uint8Array,
		...args: unknown[]
	): boolean => {
		captured.push(typeof chunk === "string" ? chunk : chunk.toString());
		return true;
	};

	try {
		fn();
	} finally {
		process.stderr.write = original;
	}

	return captured;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Logger", () => {
	// -------------------------------------------------------------------------
	// Level "error" - only error() should produce output
	// -------------------------------------------------------------------------

	describe('Logger with level "error"', () => {
		let logger: Logger;

		beforeEach(() => {
			logger = new Logger("error");
		});

		test("does NOT output for debug()", () => {
			const output = captureStderr(() => logger.debug("debug message"));
			expect(output).toHaveLength(0);
		});

		test("does NOT output for info()", () => {
			const output = captureStderr(() => logger.info("info message"));
			expect(output).toHaveLength(0);
		});

		test("does NOT output for warn()", () => {
			const output = captureStderr(() => logger.warn("warn message"));
			expect(output).toHaveLength(0);
		});

		test("outputs for error()", () => {
			const output = captureStderr(() => logger.error("error message"));
			expect(output.length).toBeGreaterThan(0);
		});

		test("error() output contains the message", () => {
			const output = captureStderr(() => logger.error("something went wrong"));
			const combined = output.join("");
			expect(combined).toContain("something went wrong");
		});

		test("error() output contains 'ERROR' label", () => {
			const output = captureStderr(() => logger.error("oops"));
			const combined = output.join("");
			expect(combined).toContain("ERROR");
		});
	});

	// -------------------------------------------------------------------------
	// Level "debug" - all levels should produce output
	// -------------------------------------------------------------------------

	describe('Logger with level "debug"', () => {
		let logger: Logger;

		beforeEach(() => {
			logger = new Logger("debug");
		});

		test("outputs for debug()", () => {
			const output = captureStderr(() => logger.debug("debug message"));
			expect(output.length).toBeGreaterThan(0);
		});

		test("outputs for info()", () => {
			const output = captureStderr(() => logger.info("info message"));
			expect(output.length).toBeGreaterThan(0);
		});

		test("outputs for warn()", () => {
			const output = captureStderr(() => logger.warn("warn message"));
			expect(output.length).toBeGreaterThan(0);
		});

		test("outputs for error()", () => {
			const output = captureStderr(() => logger.error("error message"));
			expect(output.length).toBeGreaterThan(0);
		});

		test("debug() output contains 'DEBUG' label", () => {
			const output = captureStderr(() => logger.debug("trace info"));
			expect(output.join("")).toContain("DEBUG");
		});

		test("info() output contains 'INFO' label", () => {
			const output = captureStderr(() => logger.info("operational"));
			expect(output.join("")).toContain("INFO");
		});

		test("warn() output contains 'WARN' label", () => {
			const output = captureStderr(() => logger.warn("be careful"));
			expect(output.join("")).toContain("WARN");
		});

		test("each level output contains the message", () => {
			const levels = ["debug", "info", "warn", "error"] as const;
			for (const level of levels) {
				const msg = `test-message-for-${level}`;
				const output = captureStderr(() => logger[level](msg));
				expect(output.join("")).toContain(msg);
			}
		});
	});

	// -------------------------------------------------------------------------
	// Level "warn" (default-like) - only warn and error produce output
	// -------------------------------------------------------------------------

	describe('Logger with level "warn"', () => {
		let logger: Logger;

		beforeEach(() => {
			logger = new Logger("warn");
		});

		test("does NOT output for debug()", () => {
			const output = captureStderr(() => logger.debug("debug message"));
			expect(output).toHaveLength(0);
		});

		test("does NOT output for info()", () => {
			const output = captureStderr(() => logger.info("info message"));
			expect(output).toHaveLength(0);
		});

		test("outputs for warn()", () => {
			const output = captureStderr(() => logger.warn("warn message"));
			expect(output.length).toBeGreaterThan(0);
		});

		test("outputs for error()", () => {
			const output = captureStderr(() => logger.error("error message"));
			expect(output.length).toBeGreaterThan(0);
		});
	});

	// -------------------------------------------------------------------------
	// Level "info" - info, warn, and error produce output
	// -------------------------------------------------------------------------

	describe('Logger with level "info"', () => {
		let logger: Logger;

		beforeEach(() => {
			logger = new Logger("info");
		});

		test("does NOT output for debug()", () => {
			const output = captureStderr(() => logger.debug("debug message"));
			expect(output).toHaveLength(0);
		});

		test("outputs for info()", () => {
			const output = captureStderr(() => logger.info("info message"));
			expect(output.length).toBeGreaterThan(0);
		});

		test("outputs for warn()", () => {
			const output = captureStderr(() => logger.warn("warn message"));
			expect(output.length).toBeGreaterThan(0);
		});

		test("outputs for error()", () => {
			const output = captureStderr(() => logger.error("error message"));
			expect(output.length).toBeGreaterThan(0);
		});
	});

	// -------------------------------------------------------------------------
	// Output format
	// -------------------------------------------------------------------------

	describe("output format", () => {
		test("includes [claudemem] prefix", () => {
			const logger = new Logger("debug");
			const output = captureStderr(() => logger.info("hello"));
			expect(output.join("")).toContain("[claudemem]");
		});

		test("extra arguments are appended to the output", () => {
			const logger = new Logger("debug");
			const output = captureStderr(() =>
				logger.info("message with extra", { key: "value" }),
			);
			const combined = output.join("");
			expect(combined).toContain("message with extra");
			expect(combined).toContain("value");
		});

		test("Error objects in extra args have their message included", () => {
			const logger = new Logger("debug");
			const err = new Error("inner error");
			const output = captureStderr(() => logger.error("outer", err));
			const combined = output.join("");
			expect(combined).toContain("inner error");
		});

		test("output lines end with a newline", () => {
			const logger = new Logger("debug");
			const output = captureStderr(() => logger.info("test"));
			const combined = output.join("");
			expect(combined.endsWith("\n")).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// stderr vs stdout - output goes to stderr not stdout
	// -------------------------------------------------------------------------

	describe("output destination", () => {
		test("does NOT write to stdout for any level", () => {
			const logger = new Logger("debug");
			const stdoutChunks: string[] = [];
			const originalWrite = process.stdout.write.bind(process.stdout);

			(process.stdout as { write: typeof process.stdout.write }).write = (
				chunk: string | Uint8Array,
				...args: unknown[]
			): boolean => {
				stdoutChunks.push(
					typeof chunk === "string" ? chunk : chunk.toString(),
				);
				return true;
			};

			try {
				captureStderr(() => {
					logger.debug("debug");
					logger.info("info");
					logger.warn("warn");
					logger.error("error");
				});
			} finally {
				process.stdout.write = originalWrite;
			}

			// No claudemem log lines should appear on stdout
			const combined = stdoutChunks.join("");
			expect(combined).not.toContain("[claudemem]");
		});
	});
});
