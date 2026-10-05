/**
 * The one clock the branch registry reads (architecture §4.3, §9).
 *
 * `src/core/branch-registry.ts` never calls `Date.now()` or an argument-less
 * `new Date()`, and a static sweep pins that. Every timestamp it writes comes
 * from `now()`, so a test can move time past a grace period by injecting a
 * clock instead of sleeping. Phase 3b's confirm pass is the second consumer.
 *
 * `__setClockForTests` swaps a VALUE (what time the registry believes it is).
 * It gates nothing, so it is not the shape CLAUDE.md #24 records as a bypass (a
 * test seam able to write a production security default). Pass `null` to
 * restore the real clock.
 */

let injected: (() => number) | null = null;

/** Milliseconds since the epoch: the injected clock's value, or the real one. */
export function now(): number {
	return injected !== null ? injected() : Date.now();
}

/** Replace the clock; `null` restores the real one. Tests only. */
export function __setClockForTests(fn: (() => number) | null): void {
	injected = fn;
}
