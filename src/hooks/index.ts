/**
 * Claude Code Hooks Module
 *
 * Handles Claude Code hook events for tool interception and session management.
 * Entry point: `mnemex hook` command reads JSON from stdin.
 */

export { handleHook } from "./dispatcher.js";
export type {
	HookInput,
	HookOutput,
	HookOptions,
	HookHandler,
	ToolInput,
	ToolResponse,
	PreToolUseOutput,
	IndexStatus,
} from "./types.js";
