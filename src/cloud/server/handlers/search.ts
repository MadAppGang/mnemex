/**
 * POST /v1/search
 * Semantic vector search against a commit's indexed chunks using pgvector.
 */

import type { CloudSearchRequest, CloudSearchResult } from "../../types.js";
import type { RequestContext } from "../router.js";
import { json } from "../router.js";

export async function search(ctx: RequestContext): Promise<Response> {
	let body: CloudSearchRequest;
	try {
		body = (await ctx.req.json()) as CloudSearchRequest;
	} catch {
		ctx.metrics.errorCode = "invalid_json";
		return json({ error: "invalid_json" }, 400);
	}

	const {
		repoSlug: rawRepoSlug,
		commitSha,
		queryVector,
		queryText = "",
		limit: rawLimit,
		language,
		chunkType,
		suppressPaths = [],
	} = body as CloudSearchRequest & { suppressPaths?: string[] };

	if (!rawRepoSlug || !commitSha) {
		ctx.metrics.errorCode = "missing_field";
		return json({ error: "missing_field" }, 400);
	}

	// queryVector is required for vector search
	if (!queryVector || !Array.isArray(queryVector)) {
		ctx.metrics.errorCode = "missing_field";
		return json({ error: "missing_field", field: "queryVector" }, 400);
	}

	const limit = Math.min(rawLimit ?? 10, 100);

	// repoSlug may be "orgSlug/repoSlug" or just "repoSlug"
	const slashIdx = rawRepoSlug.indexOf("/");
	let orgSlug: string;
	let repoSlug: string;
	if (slashIdx !== -1) {
		orgSlug = rawRepoSlug.slice(0, slashIdx);
		repoSlug = rawRepoSlug.slice(slashIdx + 1);
	} else {
		ctx.metrics.errorCode = "invalid_field";
		return json(
			{
				error: "invalid_field",
				field: "repoSlug",
				expected: "orgSlug/repoSlug",
			},
			400,
		);
	}

	// Step 1 — resolve repo and commit
	const repoCommit = await ctx.sql<
		{
			repo_id: number;
			embedding_dim: number;
			commit_id: number;
			status: string;
		}[]
	>`
		SELECT r.id AS repo_id, r.embedding_dim, c.id AS commit_id, c.status
		FROM repos r
		JOIN orgs o ON r.org_id = o.id
		JOIN commits c ON c.repo_id = r.id
		WHERE o.slug = ${orgSlug}
		  AND r.slug = ${repoSlug}
		  AND c.sha = ${commitSha}
		LIMIT 1
	`;

	if (repoCommit.length === 0) {
		ctx.metrics.orgSlug = orgSlug;
		ctx.metrics.repoSlug = repoSlug;
		ctx.metrics.commitSha = commitSha;
		ctx.metrics.errorCode = "commit_not_found";
		return json({ error: "commit_not_found" }, 404);
	}

	const {
		repo_id: _repoId,
		embedding_dim: embeddingDim,
		commit_id: commitId,
		status,
	} = repoCommit[0]!;

	// Validate query vector dimension
	if (queryVector.length !== embeddingDim) {
		ctx.metrics.orgSlug = orgSlug;
		ctx.metrics.repoSlug = repoSlug;
		ctx.metrics.commitSha = commitSha;
		ctx.metrics.queryDim = queryVector.length;
		ctx.metrics.errorCode = "dimension_mismatch";
		return json(
			{
				error: "dimension_mismatch",
				expected: embeddingDim,
				received: queryVector.length,
			},
			422,
		);
	}

	if (status !== "ready") {
		ctx.metrics.orgSlug = orgSlug;
		ctx.metrics.repoSlug = repoSlug;
		ctx.metrics.commitSha = commitSha;
		ctx.metrics.errorCode = "commit_not_ready";
		return json({ error: "commit_not_ready", status }, 409);
	}

	const startMs = Date.now();

	// Format query vector for pgvector
	const vecStr = `[${queryVector.join(",")}]`;

	// Vector search combining commit_files and chunks
	const suppressPathsArray = suppressPaths.length > 0 ? suppressPaths : null;

	let rows: {
		content_hash: string;
		file_path: string;
		chunk_type: string;
		name: string | null;
		language: string;
		start_line: number;
		end_line: number;
		summary: string | null;
		score: number;
	}[];

	if (suppressPathsArray) {
		rows = await ctx.sql<typeof rows>`
			SELECT
				ch.content_hash,
				cf_map.file_path,
				COALESCE(ch.chunk_type, ch.kind, 'unknown') AS chunk_type,
				ch.name,
				COALESCE(ch.language, 'unknown') AS language,
				ch.start_line,
				ch.end_line,
				ed.content AS summary,
				1 - (ch.vector <=> ${vecStr}::vector) AS score
			FROM chunks ch
			JOIN (
				SELECT DISTINCT cf.file_path, UNNEST(cf.chunk_hashes) AS content_hash
				FROM commit_files cf
				WHERE cf.commit_id = ${commitId}
				  AND cf.file_path != ALL(${suppressPathsArray}::text[])
			) AS cf_map ON cf_map.content_hash = ch.content_hash
			LEFT JOIN enrichment_docs ed
				ON ed.content_hash = ch.content_hash AND ed.doc_type = 'symbol_summary'
			WHERE ch.vector IS NOT NULL
			  AND (${language ?? null}::text IS NULL OR ch.language = ${language ?? null})
			  AND (${chunkType ?? null}::text IS NULL OR ch.chunk_type = ${chunkType ?? null})
			ORDER BY ch.vector <=> ${vecStr}::vector
			LIMIT ${limit}
		`;
	} else {
		rows = await ctx.sql<typeof rows>`
			SELECT
				ch.content_hash,
				cf_map.file_path,
				COALESCE(ch.chunk_type, ch.kind, 'unknown') AS chunk_type,
				ch.name,
				COALESCE(ch.language, 'unknown') AS language,
				ch.start_line,
				ch.end_line,
				ed.content AS summary,
				1 - (ch.vector <=> ${vecStr}::vector) AS score
			FROM chunks ch
			JOIN (
				SELECT DISTINCT cf.file_path, UNNEST(cf.chunk_hashes) AS content_hash
				FROM commit_files cf
				WHERE cf.commit_id = ${commitId}
			) AS cf_map ON cf_map.content_hash = ch.content_hash
			LEFT JOIN enrichment_docs ed
				ON ed.content_hash = ch.content_hash AND ed.doc_type = 'symbol_summary'
			WHERE ch.vector IS NOT NULL
			  AND (${language ?? null}::text IS NULL OR ch.language = ${language ?? null})
			  AND (${chunkType ?? null}::text IS NULL OR ch.chunk_type = ${chunkType ?? null})
			ORDER BY ch.vector <=> ${vecStr}::vector
			LIMIT ${limit}
		`;
	}

	const searchDurationMs = Date.now() - startMs;

	// Suppress queryText warning — only used for BM25 which isn't implemented
	void queryText;

	const results: CloudSearchResult[] = rows.map((row) => ({
		contentHash: row.content_hash,
		filePath: row.file_path,
		startLine: row.start_line,
		endLine: row.end_line,
		language: row.language,
		chunkType: row.chunk_type,
		name: row.name ?? undefined,
		score:
			typeof row.score === "number"
				? row.score
				: Number.parseFloat(String(row.score)),
		summary: row.summary ?? undefined,
	}));

	// Populate telemetry before returning
	ctx.metrics.orgSlug = orgSlug;
	ctx.metrics.repoSlug = repoSlug;
	ctx.metrics.commitSha = commitSha;
	ctx.metrics.queryDim = queryVector.length;
	ctx.metrics.resultsReturned = results.length;
	ctx.metrics.searchMs = searchDurationMs;

	return json(results);
}
