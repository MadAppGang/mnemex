/**
 * Debug test for iterative refinement
 * Traces exactly what's happening with competitors and ranking
 */

import { createEmbeddingsClient } from "../core/embeddings.js";
import { cosineSimilarity } from "../core/enrichment/refinement/index.js";

async function testIterativeLogic() {
	console.log("=== ITERATIVE REFINEMENT DEBUG ===\n");

	// Create embeddings client
	const embeddingsClient = createEmbeddingsClient();

	// Simulate 2 models with summaries for the same code unit
	const summaries = [
		{
			modelId: "haiku",
			summary: "Adds two numbers together and returns the sum",
		},
		{
			modelId: "deepseek",
			summary: "A function that computes the addition of two numeric values",
		},
	];

	console.log("Summaries to compare:");
	for (const s of summaries) {
		console.log(`  ${s.modelId}: "${s.summary}"`);
	}
	console.log();

	// Generate a test query
	const query = "function add numbers typescript";
	console.log(`Test query: "${query}"\n`);

	// Embed everything
	console.log("Embedding summaries and query...");
	const [summaryEmbeddings, queryEmbedding] = await Promise.all([
		embeddingsClient.embed(summaries.map((s) => s.summary)),
		embeddingsClient.embedOne(query),
	]);
	console.log("Done.\n");

	// For each summary, calculate its rank against competitors
	for (let i = 0; i < summaries.length; i++) {
		const testSummary = summaries[i];
		const competitors = summaries.filter((_, j) => j !== i);

		console.log(`=== Testing ${testSummary.modelId}'s summary ===`);
		console.log(`Competitors: ${competitors.map((c) => c.modelId).join(", ")}`);

		const totalCandidates = competitors.length + 1;
		console.log(`Total candidates: ${totalCandidates}`);

		// Calculate target rank adjustment
		const configuredTargetRank = 3;
		const effectiveTargetRank = Math.min(
			configuredTargetRank,
			Math.max(1, Math.ceil(totalCandidates * 0.5)),
		);
		console.log(`Configured targetRank: ${configuredTargetRank}`);
		console.log(`Effective targetRank: ${effectiveTargetRank}`);

		// Calculate similarities
		const testSimilarity = cosineSimilarity(
			queryEmbedding,
			summaryEmbeddings.embeddings[i],
		);
		console.log(`Test summary similarity: ${testSimilarity.toFixed(4)}`);

		const allSimilarities: Array<{
			modelId: string;
			similarity: number;
			isTest: boolean;
		}> = [
			{
				modelId: testSummary.modelId,
				similarity: testSimilarity,
				isTest: true,
			},
		];

		for (let j = 0; j < competitors.length; j++) {
			const compIndex = summaries.findIndex(
				(s) => s.modelId === competitors[j].modelId,
			);
			const compSimilarity = cosineSimilarity(
				queryEmbedding,
				summaryEmbeddings.embeddings[compIndex],
			);
			allSimilarities.push({
				modelId: competitors[j].modelId,
				similarity: compSimilarity,
				isTest: false,
			});
			console.log(
				`Competitor ${competitors[j].modelId} similarity: ${compSimilarity.toFixed(4)}`,
			);
		}

		// Sort by similarity (descending)
		allSimilarities.sort((a, b) => b.similarity - a.similarity);
		console.log("\nRanking:");
		allSimilarities.forEach((s, idx) => {
			const marker = s.isTest ? " <-- TEST" : "";
			console.log(
				`  #${idx + 1}: ${s.modelId} (${s.similarity.toFixed(4)})${marker}`,
			);
		});

		// Find rank of test summary
		const rank = allSimilarities.findIndex((s) => s.isTest) + 1;
		const passed = rank <= effectiveTargetRank;

		console.log(`\nResult: Rank ${rank}, Passed: ${passed}`);
		if (!passed) {
			console.log(
				`  → Would trigger refinement (rank ${rank} > target ${effectiveTargetRank})`,
			);
		} else {
			console.log(
				`  → Passes without refinement (rank ${rank} <= target ${effectiveTargetRank})`,
			);
		}
		console.log();
	}

	// Now check if BOTH models could pass simultaneously
	// (This would mean 0 rounds for both, which is what we're seeing)
	console.log("=== ANALYSIS ===");
	console.log(
		"If both models' summaries rank #1 when tested against each other,",
	);
	console.log("then both would pass without refinement → 0.0 rnd for both.");
	console.log("\nThis can happen if:");
	console.log(
		"  1. Embeddings are very similar (both summaries semantically equivalent)",
	);
	console.log(
		"  2. Query favors one model consistently but we test each separately",
	);
	console.log(
		"\nThe fix should work IF rank > effectiveTargetRank for some summaries.",
	);
}

testIterativeLogic().catch(console.error);
