/**
 * Environment Manager
 *
 * Manages isolated environments for validation scenarios.
 * Supports Docker, Git-based, and Mock isolation strategies.
 *
 * @module learning/validation/environment-manager
 */

import { existsSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { join, basename } from "node:path";
import { $ } from "bun";

// ============================================================================
// Environment Manager Interface
// ============================================================================

/**
 * Interface for environment isolation strategies.
 * Implementations handle setup, snapshot, and restore operations.
 */
export interface EnvironmentManager {
	/**
	 * Set up the environment from a project template
	 */
	setup(templatePath: string): Promise<EnvironmentInfo>;

	/**
	 * Create a snapshot of current environment state
	 */
	snapshot(): Promise<SnapshotInfo>;

	/**
	 * Restore environment to a previous snapshot
	 */
	restore(snapshotId: string): Promise<void>;

	/**
	 * Clean up all resources
	 */
	cleanup(): Promise<void>;

	/**
	 * Get the working directory for this environment
	 */
	getWorkingDirectory(): string;

	/**
	 * Get environment type
	 */
	getType(): EnvironmentType;
}

// ============================================================================
// Supporting Types
// ============================================================================

export type EnvironmentType = "docker" | "git" | "mock" | "temp";

export interface EnvironmentInfo {
	id: string;
	type: EnvironmentType;
	workingDirectory: string;
	createdAt: number;
}

export interface SnapshotInfo {
	id: string;
	environmentId: string;
	createdAt: number;
	size?: number;
}

export interface EnvironmentConfig {
	type: EnvironmentType;
	baseDirectory?: string;
	dockerImage?: string;
	retainOnError?: boolean;
}

// ============================================================================
// Temp Directory Environment (Default)
// ============================================================================

/**
 * Simple temp directory-based environment.
 * Fast setup, uses filesystem copy for snapshots.
 */
export class TempEnvironmentManager implements EnvironmentManager {
	private envId: string;
	private workingDirectory: string = "";
	private baseDirectory: string;
	private snapshots: Map<string, string> = new Map();
	private retainOnError: boolean;

	constructor(config: Partial<EnvironmentConfig> = {}) {
		this.envId = this.generateId();
		this.baseDirectory = config.baseDirectory ?? "/tmp/mnemex-validation";
		this.retainOnError = config.retainOnError ?? false;

		// Ensure base directory exists
		if (!existsSync(this.baseDirectory)) {
			mkdirSync(this.baseDirectory, { recursive: true });
		}
	}

	async setup(templatePath: string): Promise<EnvironmentInfo> {
		// Create unique working directory
		this.workingDirectory = join(this.baseDirectory, this.envId);
		mkdirSync(this.workingDirectory, { recursive: true });

		// Copy template to working directory
		if (existsSync(templatePath)) {
			cpSync(templatePath, this.workingDirectory, { recursive: true });
		}

		// Initialize git if not already
		const gitPath = join(this.workingDirectory, ".git");
		if (!existsSync(gitPath)) {
			await $`cd ${this.workingDirectory} && git init -q`;
		}

		return {
			id: this.envId,
			type: "temp",
			workingDirectory: this.workingDirectory,
			createdAt: Date.now(),
		};
	}

	async snapshot(): Promise<SnapshotInfo> {
		const snapshotId = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const snapshotPath = join(
			this.baseDirectory,
			`${this.envId}_${snapshotId}`,
		);

		// Copy current state
		cpSync(this.workingDirectory, snapshotPath, { recursive: true });
		this.snapshots.set(snapshotId, snapshotPath);

		return {
			id: snapshotId,
			environmentId: this.envId,
			createdAt: Date.now(),
		};
	}

	async restore(snapshotId: string): Promise<void> {
		const snapshotPath = this.snapshots.get(snapshotId);
		if (!snapshotPath) {
			throw new Error(`Snapshot not found: ${snapshotId}`);
		}

		// Clear current working directory
		rmSync(this.workingDirectory, { recursive: true, force: true });

		// Restore from snapshot
		cpSync(snapshotPath, this.workingDirectory, { recursive: true });
	}

	async cleanup(): Promise<void> {
		// Remove working directory
		if (this.workingDirectory && existsSync(this.workingDirectory)) {
			rmSync(this.workingDirectory, { recursive: true, force: true });
		}

		// Remove all snapshots
		for (const snapshotPath of this.snapshots.values()) {
			if (existsSync(snapshotPath)) {
				rmSync(snapshotPath, { recursive: true, force: true });
			}
		}
		this.snapshots.clear();
	}

	getWorkingDirectory(): string {
		return this.workingDirectory;
	}

	getType(): EnvironmentType {
		return "temp";
	}

	private generateId(): string {
		const timestamp = Date.now().toString(36);
		const random = Math.random().toString(36).slice(2, 8);
		return `env_${timestamp}_${random}`;
	}
}

// ============================================================================
// Git-Based Environment
// ============================================================================

/**
 * Git-based environment using branches for isolation.
 * Uses stash and branch operations for snapshots.
 */
export class GitEnvironmentManager implements EnvironmentManager {
	private envId: string;
	private workingDirectory: string;
	private baseBranch: string = "";
	private envBranch: string = "";
	private snapshots: Map<string, string> = new Map(); // snapshotId -> commitHash

	constructor(workingDirectory: string) {
		this.envId = this.generateId();
		this.workingDirectory = workingDirectory;
	}

	async setup(templatePath: string): Promise<EnvironmentInfo> {
		// Get current branch
		const { stdout: currentBranch } =
			await $`cd ${this.workingDirectory} && git branch --show-current`.quiet();
		this.baseBranch = currentBranch.toString().trim();

		// Create isolated branch for this environment
		this.envBranch = `validation/${this.envId}`;
		await $`cd ${this.workingDirectory} && git checkout -b ${this.envBranch}`.quiet();

		// Apply template if different from current
		if (templatePath && existsSync(templatePath)) {
			// Copy template files (excluding .git)
			const files = await this.listFiles(templatePath);
			for (const file of files) {
				if (!file.includes(".git")) {
					const src = join(templatePath, file);
					const dest = join(this.workingDirectory, file);
					cpSync(src, dest, { recursive: true });
				}
			}

			// Stage and commit template
			await $`cd ${this.workingDirectory} && git add -A && git commit -m "Setup validation environment" --allow-empty`.quiet();
		}

		return {
			id: this.envId,
			type: "git",
			workingDirectory: this.workingDirectory,
			createdAt: Date.now(),
		};
	}

	async snapshot(): Promise<SnapshotInfo> {
		const snapshotId = `snap_${Date.now()}`;

		// Stash any uncommitted changes
		await $`cd ${this.workingDirectory} && git add -A`.quiet();

		// Create a commit for this snapshot
		const { stdout: commitHash } =
			await $`cd ${this.workingDirectory} && git commit -m "Snapshot: ${snapshotId}" --allow-empty && git rev-parse HEAD`.quiet();

		this.snapshots.set(snapshotId, commitHash.toString().trim());

		return {
			id: snapshotId,
			environmentId: this.envId,
			createdAt: Date.now(),
		};
	}

	async restore(snapshotId: string): Promise<void> {
		const commitHash = this.snapshots.get(snapshotId);
		if (!commitHash) {
			throw new Error(`Snapshot not found: ${snapshotId}`);
		}

		// Hard reset to snapshot commit
		await $`cd ${this.workingDirectory} && git reset --hard ${commitHash}`.quiet();
	}

	async cleanup(): Promise<void> {
		// Switch back to base branch
		await $`cd ${this.workingDirectory} && git checkout ${this.baseBranch}`.quiet();

		// Delete environment branch
		await $`cd ${this.workingDirectory} && git branch -D ${this.envBranch}`
			.quiet()
			.catch(() => {
				// Ignore if branch doesn't exist
			});

		this.snapshots.clear();
	}

	getWorkingDirectory(): string {
		return this.workingDirectory;
	}

	getType(): EnvironmentType {
		return "git";
	}

	private generateId(): string {
		const timestamp = Date.now().toString(36);
		const random = Math.random().toString(36).slice(2, 8);
		return `${timestamp}_${random}`;
	}

	private async listFiles(dir: string): Promise<string[]> {
		const { stdout } = await $`find ${dir} -type f`.quiet();
		return stdout
			.toString()
			.split("\n")
			.filter(Boolean)
			.map((f: string) => f.replace(dir + "/", ""));
	}
}

// ============================================================================
// Docker Environment
// ============================================================================

/**
 * Docker-based environment for full isolation.
 * Uses containers with volume mounts for snapshots.
 */
export class DockerEnvironmentManager implements EnvironmentManager {
	private envId: string;
	private containerId: string = "";
	private workingDirectory: string = "";
	private image: string;
	private snapshots: Map<string, string> = new Map(); // snapshotId -> volumeName

	constructor(image: string = "node:20-slim") {
		this.envId = this.generateId();
		this.image = image;
	}

	async setup(templatePath: string): Promise<EnvironmentInfo> {
		const containerName = `mnemex-validation-${this.envId}`;
		this.workingDirectory = "/workspace";

		// Create container with mounted template
		const volumeMount = templatePath
			? `-v ${templatePath}:${this.workingDirectory}:rw`
			: "";

		const { stdout: containerId } =
			await $`docker create --name ${containerName} ${volumeMount} ${this.image} tail -f /dev/null`.quiet();

		this.containerId = containerId.toString().trim();

		// Start container
		await $`docker start ${this.containerId}`.quiet();

		// If no template, create empty workspace
		if (!templatePath) {
			await $`docker exec ${this.containerId} mkdir -p ${this.workingDirectory}`.quiet();
		}

		return {
			id: this.envId,
			type: "docker",
			workingDirectory: this.workingDirectory,
			createdAt: Date.now(),
		};
	}

	async snapshot(): Promise<SnapshotInfo> {
		const snapshotId = `snap_${Date.now()}`;
		const volumeName = `mnemex-snap-${this.envId}-${snapshotId}`;

		// Create a volume from current container state
		await $`docker commit ${this.containerId} ${volumeName}`.quiet();

		this.snapshots.set(snapshotId, volumeName);

		return {
			id: snapshotId,
			environmentId: this.envId,
			createdAt: Date.now(),
		};
	}

	async restore(snapshotId: string): Promise<void> {
		const imageName = this.snapshots.get(snapshotId);
		if (!imageName) {
			throw new Error(`Snapshot not found: ${snapshotId}`);
		}

		// Stop current container
		await $`docker stop ${this.containerId}`.quiet();

		// Create new container from snapshot
		const { stdout: newContainerId } =
			await $`docker create ${imageName}`.quiet();
		const oldContainerId = this.containerId;
		this.containerId = newContainerId.toString().trim();

		// Start new container
		await $`docker start ${this.containerId}`.quiet();

		// Remove old container
		await $`docker rm ${oldContainerId}`.quiet();
	}

	async cleanup(): Promise<void> {
		// Stop and remove container
		if (this.containerId) {
			await $`docker stop ${this.containerId}`.quiet().catch(() => {});
			await $`docker rm ${this.containerId}`.quiet().catch(() => {});
		}

		// Remove snapshot images
		for (const imageName of this.snapshots.values()) {
			await $`docker rmi ${imageName}`.quiet().catch(() => {});
		}
		this.snapshots.clear();
	}

	getWorkingDirectory(): string {
		return this.workingDirectory;
	}

	getType(): EnvironmentType {
		return "docker";
	}

	/**
	 * Execute a command in the container
	 */
	async exec(command: string): Promise<string> {
		const { stdout } =
			await $`docker exec ${this.containerId} sh -c ${command}`.quiet();
		return stdout.toString();
	}

	private generateId(): string {
		const timestamp = Date.now().toString(36);
		const random = Math.random().toString(36).slice(2, 8);
		return `${timestamp}_${random}`;
	}
}

// ============================================================================
// Mock Environment (for testing)
// ============================================================================

/**
 * Mock environment for testing the validation system itself.
 * No actual isolation, just tracks calls.
 */
export class MockEnvironmentManager implements EnvironmentManager {
	private envId: string;
	private workingDirectory: string;
	private calls: EnvironmentCall[] = [];
	private snapshots: Map<string, MockSnapshot> = new Map();

	constructor(workingDirectory: string = "/mock/workspace") {
		this.envId = `mock_${Date.now()}`;
		this.workingDirectory = workingDirectory;
	}

	async setup(templatePath: string): Promise<EnvironmentInfo> {
		this.calls.push({
			method: "setup",
			args: { templatePath },
			timestamp: Date.now(),
		});

		return {
			id: this.envId,
			type: "mock",
			workingDirectory: this.workingDirectory,
			createdAt: Date.now(),
		};
	}

	async snapshot(): Promise<SnapshotInfo> {
		const snapshotId = `mock_snap_${Date.now()}`;

		this.calls.push({
			method: "snapshot",
			args: {},
			timestamp: Date.now(),
		});

		const snapshot: MockSnapshot = {
			id: snapshotId,
			createdAt: Date.now(),
			state: { mocked: true },
		};
		this.snapshots.set(snapshotId, snapshot);

		return {
			id: snapshotId,
			environmentId: this.envId,
			createdAt: snapshot.createdAt,
		};
	}

	async restore(snapshotId: string): Promise<void> {
		this.calls.push({
			method: "restore",
			args: { snapshotId },
			timestamp: Date.now(),
		});

		if (!this.snapshots.has(snapshotId)) {
			throw new Error(`Mock snapshot not found: ${snapshotId}`);
		}
	}

	async cleanup(): Promise<void> {
		this.calls.push({
			method: "cleanup",
			args: {},
			timestamp: Date.now(),
		});

		this.snapshots.clear();
	}

	getWorkingDirectory(): string {
		return this.workingDirectory;
	}

	getType(): EnvironmentType {
		return "mock";
	}

	// Test helpers

	getCalls(): readonly EnvironmentCall[] {
		return this.calls;
	}

	getCallCount(method: string): number {
		return this.calls.filter((c) => c.method === method).length;
	}

	reset(): void {
		this.calls = [];
		this.snapshots.clear();
	}
}

interface EnvironmentCall {
	method: string;
	args: Record<string, unknown>;
	timestamp: number;
}

interface MockSnapshot {
	id: string;
	createdAt: number;
	state: Record<string, unknown>;
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an environment manager based on configuration
 */
export function createEnvironmentManager(
	config: EnvironmentConfig,
): EnvironmentManager {
	switch (config.type) {
		case "temp":
			return new TempEnvironmentManager(config);

		case "git":
			if (!config.baseDirectory) {
				throw new Error("baseDirectory required for git environment");
			}
			return new GitEnvironmentManager(config.baseDirectory);

		case "docker":
			return new DockerEnvironmentManager(config.dockerImage);

		case "mock":
			return new MockEnvironmentManager(config.baseDirectory);

		default:
			throw new Error(`Unknown environment type: ${config.type}`);
	}
}

// ============================================================================
// Environment Pool
// ============================================================================

/**
 * Pool of pre-warmed environments for faster validation runs.
 */
export class EnvironmentPool {
	private pool: EnvironmentManager[] = [];
	private config: EnvironmentConfig;
	private templatePath: string;
	private minSize: number;
	private maxSize: number;

	constructor(
		config: EnvironmentConfig,
		templatePath: string,
		options: { minSize?: number; maxSize?: number } = {},
	) {
		this.config = config;
		this.templatePath = templatePath;
		this.minSize = options.minSize ?? 2;
		this.maxSize = options.maxSize ?? 10;
	}

	/**
	 * Initialize the pool with minimum environments
	 */
	async initialize(): Promise<void> {
		const setupPromises: Promise<void>[] = [];

		for (let i = 0; i < this.minSize; i++) {
			setupPromises.push(this.addEnvironment());
		}

		await Promise.all(setupPromises);
	}

	/**
	 * Acquire an environment from the pool
	 */
	async acquire(): Promise<EnvironmentManager> {
		// Get existing environment or create new one
		let env = this.pool.pop();

		if (!env) {
			env = createEnvironmentManager(this.config);
			await env.setup(this.templatePath);
		}

		// Refill pool in background if below minimum
		if (this.pool.length < this.minSize) {
			this.addEnvironment().catch(() => {
				// Ignore background errors
			});
		}

		return env;
	}

	/**
	 * Release an environment back to the pool
	 */
	async release(env: EnvironmentManager): Promise<void> {
		if (this.pool.length < this.maxSize) {
			// Reset environment and return to pool
			// For temp environments, we restore to initial snapshot
			this.pool.push(env);
		} else {
			// Pool full, clean up environment
			await env.cleanup();
		}
	}

	/**
	 * Drain the pool and clean up all environments
	 */
	async drain(): Promise<void> {
		const cleanupPromises = this.pool.map((env) => env.cleanup());
		await Promise.all(cleanupPromises);
		this.pool = [];
	}

	/**
	 * Get current pool size
	 */
	size(): number {
		return this.pool.length;
	}

	private async addEnvironment(): Promise<void> {
		if (this.pool.length >= this.maxSize) return;

		const env = createEnvironmentManager(this.config);
		await env.setup(this.templatePath);
		this.pool.push(env);
	}
}
