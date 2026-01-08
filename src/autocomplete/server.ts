import readline from "node:readline";
import { resolve } from "node:path";
import { AutocompleteEngine } from "./engine.js";
import type {
	AutocompleteRequest,
	AutocompleteResponse,
	AutocompleteCompleteParams,
} from "./protocol.js";

function writeResponse(res: AutocompleteResponse): void {
	process.stdout.write(`${JSON.stringify(res)}\n`);
}

function errorResponse(id: string, message: string): AutocompleteResponse {
	return { id, error: { message } };
}

export async function startAutocompleteServer(
	args: { projectPath?: string } = {},
): Promise<void> {
	const projectPath = resolve(args.projectPath || process.cwd());
	const engine = new AutocompleteEngine(projectPath);

	const pending = new Map<string, AbortController>();

	const rl = readline.createInterface({
		input: process.stdin,
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	rl.on("line", async (line) => {
		if (!line.trim()) return;

		let req: AutocompleteRequest;
		try {
			req = JSON.parse(line) as AutocompleteRequest;
		} catch {
			return;
		}

		const id = req.id;
		try {
			switch (req.method) {
				case "initialize": {
					await engine.initialize();
					writeResponse({ id, result: { ok: true, projectPath } });
					break;
				}

				case "complete": {
					const params = req.params as AutocompleteCompleteParams;
					if (!params || !params.filePath) {
						writeResponse(errorResponse(id, "Invalid complete params"));
						break;
					}

					const hasTextMode = !!params.text && !!params.position;
					const hasFimMode =
						params.prefix !== undefined && params.suffix !== undefined;
					if (!hasTextMode && !hasFimMode) {
						writeResponse(
							errorResponse(
								id,
								"Invalid complete params: provide {text, position} or {prefix, suffix}",
							),
						);
						break;
					}

					if (
						params.projectPath &&
						resolve(params.projectPath) !== projectPath
					) {
						writeResponse(
							errorResponse(id, `Server projectPath mismatch (${projectPath})`),
						);
						break;
					}

					const controller = new AbortController();
					pending.set(id, controller);

					try {
						const result = await engine.complete({
							...params,
							abortSignal: controller.signal,
						});
						writeResponse({ id, result });
					} finally {
						pending.delete(id);
					}
					break;
				}

				case "cancel": {
					const params = (req.params || {}) as { id?: string };
					const targetId = params.id;
					if (!targetId) {
						writeResponse(errorResponse(id, "Invalid cancel params"));
						break;
					}

					const controller = pending.get(targetId);
					if (controller) controller.abort();
					writeResponse({ id, result: { ok: true } });
					break;
				}

				case "shutdown": {
					for (const controller of pending.values()) controller.abort();
					pending.clear();
					await engine.close();
					writeResponse({ id, result: { ok: true } });
					rl.close();
					break;
				}

				default:
					writeResponse(errorResponse(id, `Unknown method: ${req.method}`));
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			writeResponse(errorResponse(id, msg));
		}
	});

	rl.on("close", async () => {
		for (const controller of pending.values()) controller.abort();
		pending.clear();
		await engine.close();
		process.exit(0);
	});

	process.on("SIGTERM", () => rl.close());
	process.on("SIGINT", () => rl.close());
}
