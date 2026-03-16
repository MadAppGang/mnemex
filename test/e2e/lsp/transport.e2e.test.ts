import { describe, test, expect, beforeEach } from "bun:test";
import { LspTransport } from "../../../src/lsp/transport.js";

// Helper: create a Content-Length framed message
function frame(body: object): Buffer {
	const json = JSON.stringify(body);
	const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
	return Buffer.from(header + json);
}

// Mock ChildProcess for sendRequest/sendNotification
function mockProcess(): any {
	const written: Buffer[] = [];
	return {
		stdin: {
			destroyed: false,
			write(data: string | Buffer) {
				written.push(Buffer.from(data));
			},
		},
		_written: written,
	};
}

describe("LspTransport E2E", () => {
	let transport: LspTransport;

	beforeEach(() => {
		transport = new LspTransport();
	});

	test("onData: parses a single complete message", () => {
		let received: any = null;
		transport.onNotification = (method, params) => {
			received = { method, params };
		};

		const msg = frame({
			jsonrpc: "2.0",
			method: "test/notification",
			params: { value: 42 },
		});
		transport.onData(msg);

		expect(received).not.toBeNull();
		expect(received.method).toBe("test/notification");
		expect(received.params).toEqual({ value: 42 });
	});

	test("onData: handles fragmented delivery", () => {
		let received: any = null;
		transport.onNotification = (method, params) => {
			received = { method, params };
		};

		const msg = frame({ jsonrpc: "2.0", method: "test/frag", params: {} });

		// Split into two chunks
		const mid = Math.floor(msg.length / 2);
		transport.onData(msg.subarray(0, mid));
		expect(received).toBeNull(); // Not yet complete

		transport.onData(msg.subarray(mid));
		expect(received).not.toBeNull();
		expect(received.method).toBe("test/frag");
	});

	test("onData: handles multiple messages in one chunk", () => {
		const notifications: string[] = [];
		transport.onNotification = (method) => {
			notifications.push(method);
		};

		const msg1 = frame({ jsonrpc: "2.0", method: "first", params: {} });
		const msg2 = frame({ jsonrpc: "2.0", method: "second", params: {} });

		transport.onData(Buffer.concat([msg1, msg2]));

		expect(notifications).toEqual(["first", "second"]);
	});

	test("sendRequest: resolves on response", async () => {
		const proc = mockProcess();

		// Start request
		const promise = transport.sendRequest<{ result: string }>(
			proc,
			"test/method",
			{ x: 1 },
			5000,
		);

		// Simulate response (id: 1 because nextId starts at 1)
		transport.onData(
			frame({ jsonrpc: "2.0", id: 1, result: { result: "ok" } }),
		);

		const result = await promise;
		expect(result).toEqual({ result: "ok" });
	});

	test("sendRequest: rejects on timeout", async () => {
		const proc = mockProcess();

		const promise = transport.sendRequest(proc, "test/slow", {}, 50); // 50ms timeout

		await expect(promise).rejects.toThrow(/timed out/);
	});

	test("cancelAll: rejects all pending requests", async () => {
		const proc = mockProcess();

		const p1 = transport.sendRequest(proc, "req1", {}, 5000);
		const p2 = transport.sendRequest(proc, "req2", {}, 5000);

		transport.cancelAll(new Error("server crashed"));

		await expect(p1).rejects.toThrow(/server crashed/);
		await expect(p2).rejects.toThrow(/server crashed/);
		expect(transport.hasPending()).toBe(false);
	});
});
