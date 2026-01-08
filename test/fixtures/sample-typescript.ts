/**
 * Sample TypeScript file for integration testing
 * Tests hierarchical extraction: file -> class -> method
 */

import { EventEmitter } from "events";

// Type definitions
export type UserRole = "admin" | "user" | "guest";

export interface User {
	id: string;
	name: string;
	email: string;
	role: UserRole;
}

// Exported class with methods
export class UserService extends EventEmitter {
	private users: Map<string, User> = new Map();
	private readonly maxUsers: number;

	constructor(maxUsers: number = 1000) {
		super();
		this.maxUsers = maxUsers;
	}

	/**
	 * Create a new user
	 * @param userData - User data without ID
	 * @returns Created user with generated ID
	 */
	async createUser(userData: Omit<User, "id">): Promise<User> {
		if (this.users.size >= this.maxUsers) {
			throw new Error("Max users limit reached");
		}

		const id = crypto.randomUUID();
		const user: User = { ...userData, id };
		this.users.set(id, user);
		this.emit("userCreated", user);
		return user;
	}

	/**
	 * Find user by ID
	 */
	getUser(id: string): User | undefined {
		return this.users.get(id);
	}

	/**
	 * Delete a user
	 */
	async deleteUser(id: string): Promise<boolean> {
		const user = this.users.get(id);
		if (!user) return false;

		this.users.delete(id);
		this.emit("userDeleted", user);
		return true;
	}

	/**
	 * Get all users with optional role filter
	 */
	listUsers(role?: UserRole): User[] {
		const allUsers = Array.from(this.users.values());
		if (role) {
			return allUsers.filter((u) => u.role === role);
		}
		return allUsers;
	}
}

// Standalone async function
export async function validateEmail(email: string): Promise<boolean> {
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return emailRegex.test(email);
}

// Internal helper (not exported)
function generateAuditLog(action: string, userId: string): string {
	return `[${new Date().toISOString()}] ${action} by ${userId}`;
}

// Arrow function exported
export const hashPassword = async (password: string): Promise<string> => {
	// Simplified for testing
	return Buffer.from(password).toString("base64");
};
