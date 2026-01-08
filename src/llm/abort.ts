/**
 * Abort helpers
 *
 * Combines multiple AbortSignals into a single signal for fetch/spawn cancellation.
 */

export function combineAbortSignals(
	...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
	const active = signals.filter(Boolean) as AbortSignal[];
	if (active.length === 0) return undefined;
	if (active.length === 1) return active[0];

	const anyFn = (
		AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }
	).any;
	if (typeof anyFn === "function") {
		return anyFn(active);
	}

	const controller = new AbortController();
	const onAbort = () => controller.abort();

	for (const signal of active) {
		if (signal.aborted) {
			controller.abort();
			break;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	}

	return controller.signal;
}
