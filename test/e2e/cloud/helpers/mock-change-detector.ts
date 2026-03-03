/**
 * MockChangeDetector — implements IChangeDetector with pre-seeded fixture data.
 *
 * Returns controlled data without running git subprocesses.
 * Stateless after construction — tests construct a new instance per scenario.
 */

import type {
	IChangeDetector,
	DirtyFile,
	ChangedFile,
} from "../../../../src/cloud/types.js";

// ============================================================================
// Options
// ============================================================================

export interface MockChangeDetectorOptions {
	headSha: string;
	dirtyFiles?: DirtyFile[];
	parentShas?: string[];
	changedFiles?: ChangedFile[];
}

// ============================================================================
// MockChangeDetector
// ============================================================================

export class MockChangeDetector implements IChangeDetector {
	private readonly _headSha: string;
	private readonly _dirtyFiles: DirtyFile[];
	private readonly _parentShas: string[];
	private readonly _changedFiles: ChangedFile[];

	constructor(options: MockChangeDetectorOptions) {
		this._headSha = options.headSha;
		this._dirtyFiles = options.dirtyFiles ?? [];
		this._parentShas = options.parentShas ?? [];
		this._changedFiles = options.changedFiles ?? [];
	}

	async getDirtyFiles(): Promise<DirtyFile[]> {
		return this._dirtyFiles;
	}

	async getHeadSha(): Promise<string> {
		return this._headSha;
	}

	async getParentShas(_sha: string): Promise<string[]> {
		return this._parentShas;
	}

	async getChangedFiles(
		_fromSha: string | null,
		_toSha: string,
	): Promise<ChangedFile[]> {
		return this._changedFiles;
	}
}
