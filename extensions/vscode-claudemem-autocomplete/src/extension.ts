import * as vscode from "vscode";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";

type RpcResponse =
	| { id: string; result: any }
	| { id: string; error: { message: string } };

interface CompletionResult {
	completion: string;
	provider: string;
	model: string;
	latencyMs: number;
}

function sleep(ms: number, token: vscode.CancellationToken): Promise<boolean> {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve(true), ms);
		const sub = token.onCancellationRequested(() => {
			clearTimeout(t);
			sub.dispose();
			resolve(false);
		});
	});
}

function getConfig() {
	const cfg = vscode.workspace.getConfiguration("claudememAutocomplete");
	return {
		enable: cfg.get<boolean>("enable", true),
		binaryPath: cfg.get<string>("binaryPath", "claudemem"),
		debounceMs: cfg.get<number>("debounceMs", 120),
		maxPrefixChars: cfg.get<number>("maxPrefixChars", 4000),
		maxSuffixChars: cfg.get<number>("maxSuffixChars", 2000),
		maxTokens: cfg.get<number>("maxTokens", 200),
		temperature: cfg.get<number>("temperature", 0.2),
		llmProvider: cfg.get<string>("llmProvider", ""),
		llmModel: cfg.get<string>("llmModel", ""),
		llmEndpoint: cfg.get<string>("llmEndpoint", ""),
	};
}

class JsonlRpcClient implements vscode.Disposable {
	private proc: ChildProcessWithoutNullStreams;
	private rl: readline.Interface;
	private pending = new Map<
		string,
		{ resolve: (v: any) => void; reject: (e: any) => void }
	>();

	constructor(
		args: { binaryPath: string; projectPath: string; env: NodeJS.ProcessEnv },
		private readonly output: vscode.OutputChannel,
	) {
		this.proc = spawn(
			args.binaryPath,
			["--autocomplete-server", "--project", args.projectPath],
			{
				env: args.env,
				stdio: "pipe",
			},
		);

		this.output.appendLine(
			`[spawn] ${args.binaryPath} --autocomplete-server --project ${args.projectPath}`,
		);

		this.proc.on("error", (err) => {
			for (const { reject } of this.pending.values()) reject(err);
			this.pending.clear();
		});

		this.proc.on("exit", (code, signal) => {
			const err = new Error(
				`claudemem autocomplete server exited (${code ?? "null"} / ${signal ?? "null"})`,
			);
			for (const { reject } of this.pending.values()) reject(err);
			this.pending.clear();
		});

		this.proc.stderr.on("data", (chunk) => {
			this.output.appendLine(chunk.toString());
		});

		this.rl = readline.createInterface({
			input: this.proc.stdout,
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		this.rl.on("line", (line) => {
			let msg: RpcResponse;
			try {
				msg = JSON.parse(line) as RpcResponse;
			} catch {
				return;
			}

			const pending = this.pending.get(msg.id);
			if (!pending) return;
			this.pending.delete(msg.id);
			if ("error" in msg) pending.reject(new Error(msg.error.message));
			else pending.resolve(msg.result);
		});
	}

	request<T = any>(
		method: string,
		params: any,
		requestId?: string,
	): Promise<T> {
		const id = requestId || randomUUID();
		const payload = JSON.stringify({ id, method, params });

		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.proc.stdin.write(payload + "\n", (err) => {
				if (err) {
					this.pending.delete(id);
					reject(err);
				}
			});
		});
	}

	cancel(targetId: string): void {
		const id = randomUUID();
		this.proc.stdin.write(
			JSON.stringify({ id, method: "cancel", params: { id: targetId } }) + "\n",
		);
	}

	dispose(): void {
		try {
			this.rl.close();
		} catch {}

		try {
			this.proc.kill();
		} catch {}
	}
}

class ClientManager implements vscode.Disposable {
	private clients = new Map<string, JsonlRpcClient>();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly output: vscode.OutputChannel,
	) {}

	async getClient(folder: vscode.WorkspaceFolder): Promise<JsonlRpcClient> {
		const key = folder.uri.fsPath;
		const existing = this.clients.get(key);
		if (existing) return existing;

		const cfg = getConfig();
		const env: NodeJS.ProcessEnv = { ...process.env };

		if (cfg.llmProvider) env.CLAUDEMEM_LLM_PROVIDER = cfg.llmProvider;
		if (cfg.llmModel) env.CLAUDEMEM_LLM_MODEL = cfg.llmModel;
		if (cfg.llmEndpoint) env.CLAUDEMEM_LLM_ENDPOINT = cfg.llmEndpoint;

		const openRouterKey = await this.context.secrets.get(
			"claudemem.openrouterApiKey",
		);
		if (openRouterKey) env.OPENROUTER_API_KEY = openRouterKey;

		const client = new JsonlRpcClient(
			{
				binaryPath: cfg.binaryPath,
				projectPath: folder.uri.fsPath,
				env,
			},
			this.output,
		);

		this.clients.set(key, client);
		try {
			await client.request("initialize", { projectPath: folder.uri.fsPath });
		} catch (e) {
			client.dispose();
			this.clients.delete(key);
			throw e;
		}

		return client;
	}

	restartAll(): void {
		for (const client of this.clients.values()) client.dispose();
		this.clients.clear();
	}

	dispose(): void {
		this.restartAll();
	}
}

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel("claudemem Autocomplete");
	context.subscriptions.push(output);

	const manager = new ClientManager(context, output);
	context.subscriptions.push(manager);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"claudememAutocomplete.restartServer",
			async () => {
				manager.restartAll();
				vscode.window.showInformationMessage(
					"claudemem autocomplete server restarted.",
				);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"claudememAutocomplete.setOpenRouterKey",
			async () => {
				const value = await vscode.window.showInputBox({
					title: "OpenRouter API Key",
					password: true,
					ignoreFocusOut: true,
					placeHolder: "sk-or-v1-…",
				});
				if (!value) return;
				await context.secrets.store("claudemem.openrouterApiKey", value);
				manager.restartAll();
				vscode.window.showInformationMessage(
					"OpenRouter API key saved (VS Code Secret Storage).",
				);
			},
		),
	);

	const inFlightByDoc = new Map<
		string,
		{ requestId: string; client: JsonlRpcClient }
	>();

	const provider: vscode.InlineCompletionItemProvider = {
		async provideInlineCompletionItems(document, position, _ctx, token) {
			const cfg = getConfig();
			if (!cfg.enable) return;

			const folder = vscode.workspace.getWorkspaceFolder(document.uri);
			if (!folder) return;

			if (cfg.debounceMs > 0) {
				const ok = await sleep(cfg.debounceMs, token);
				if (!ok || token.isCancellationRequested) return;
			}

			const offset = document.offsetAt(position);
			const startOffset = Math.max(0, offset - cfg.maxPrefixChars);
			const endOffset = Math.min(
				document.getText().length,
				offset + cfg.maxSuffixChars,
			);

			const prefixRange = new vscode.Range(
				document.positionAt(startOffset),
				position,
			);
			const suffixRange = new vscode.Range(
				position,
				document.positionAt(endOffset),
			);

			const prefix = document.getText(prefixRange);
			const suffix = document.getText(suffixRange);

			const client = await manager.getClient(folder);

			const docKey = document.uri.toString();
			const prev = inFlightByDoc.get(docKey);
			if (prev) {
				prev.client.cancel(prev.requestId);
				inFlightByDoc.delete(docKey);
			}

			const requestId = randomUUID();
			inFlightByDoc.set(docKey, { requestId, client });

			token.onCancellationRequested(() => {
				client.cancel(requestId);
				inFlightByDoc.delete(docKey);
			});

			let result: CompletionResult;
			try {
				result = await client.request(
					"complete",
					{
						projectPath: folder.uri.fsPath,
						filePath: document.uri.fsPath,
						languageId: document.languageId,
						prefix,
						suffix,
						options: {
							maxPrefixChars: cfg.maxPrefixChars,
							maxSuffixChars: cfg.maxSuffixChars,
							maxTokens: cfg.maxTokens,
							temperature: cfg.temperature,
						},
					},
					requestId,
				);
			} catch {
				return;
			} finally {
				inFlightByDoc.delete(docKey);
			}

			const text = (result?.completion || "").toString();
			if (!text.trim()) return;

			const item = new vscode.InlineCompletionItem(
				text,
				new vscode.Range(position, position),
			);
			return [item];
		},
	};

	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider(
			{ pattern: "**" },
			provider,
		),
	);
}

export function deactivate() {}
