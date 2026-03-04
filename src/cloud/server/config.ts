/**
 * Server configuration for the claudemem cloud test server.
 */

export interface ServerConfig {
	/** HTTP port to listen on (default: 4510) */
	port: number;
	/** PostgreSQL connection string */
	databaseUrl: string;
	/** Embedding vector dimension (default: 8 for tests) */
	embeddingDim: number;
	/** Master API key from MASTER_API_KEY env var. undefined = auth disabled. */
	masterApiKey?: string;
}

/**
 * Load server config from environment variables with defaults.
 */
export function loadConfig(): ServerConfig {
	return {
		port: Number.parseInt(process.env.PORT ?? "4510", 10),
		databaseUrl:
			process.env.DATABASE_URL ??
			"postgresql://neondb_owner:npg_EI36BnzJUaAl@ep-broad-frog-a7tco5g6-pooler.ap-southeast-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
		embeddingDim: Number.parseInt(process.env.EMBEDDING_DIM ?? "8", 10),
		masterApiKey: process.env.MASTER_API_KEY || undefined,
	};
}
