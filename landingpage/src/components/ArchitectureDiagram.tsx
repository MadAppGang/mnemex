import React, { useState } from "react";

interface LayerStep {
	id: number;
	name: string;
	type: "local" | "ai" | "output";
	time: string;
	cost: string;
	description: string;
	detail: string;
}

const indexingSteps: LayerStep[] = [
	{
		id: 1,
		name: "File Discovery",
		type: "local",
		time: "< 1s",
		cost: "Free",
		description:
			"Intelligent source code scanning that respects .gitignore patterns",
		detail:
			"Recursively walks your project directory, automatically filtering for 28+ programming languages while skipping node_modules, build artifacts, and binary files. Your code indexing starts with clean, relevant source files only.",
	},
	{
		id: 2,
		name: "AST Parsing",
		type: "local",
		time: "~5s",
		cost: "Free",
		description:
			"Tree-sitter transforms source code into structured syntax trees",
		detail:
			"Unlike naive text splitting, AST parsing understands your code's actual structure - functions, classes, imports, and type definitions. This semantic code analysis is the foundation for intelligent AI code assistance.",
	},
	{
		id: 3,
		name: "Semantic Chunking",
		type: "local",
		time: "~2s",
		cost: "Free",
		description:
			"Context-aware splitting at natural code boundaries (300-500 tokens)",
		detail:
			"Code chunks are created at function and class boundaries, never cutting logic in half. Each chunk maintains semantic coherence, ensuring your AI code assistant receives complete, meaningful context.",
	},
	{
		id: 4,
		name: "Symbol Graph",
		type: "local",
		time: "~3s",
		cost: "Free",
		description:
			"Maps every definition, reference, and call relationship in your codebase",
		detail:
			"Builds a comprehensive dependency graph showing which symbols call which, what imports what, and how code flows through your project. Essential for understanding code architecture and impact analysis.",
	},
	{
		id: 5,
		name: "PageRank Scoring",
		type: "local",
		time: "< 1s",
		cost: "Free",
		description:
			"Google's algorithm adapted to rank code symbol importance",
		detail:
			"Applies eigenvector centrality analysis to identify critical infrastructure (high PageRank) vs isolated utilities (low PageRank). Your AI assistant now knows which code matters most to your architecture.",
	},
	{
		id: 6,
		name: "Summary Generation",
		type: "ai",
		time: "2-10m",
		cost: "LLM",
		description:
			"LLM creates intent-focused natural language summaries per chunk",
		detail:
			"Goes beyond syntax to capture semantic meaning: 'validates user authentication tokens' vs 'regex pattern match'. These summaries power concept-based semantic code search, not just keyword matching.",
	},
	{
		id: 7,
		name: "Embedding Generation",
		type: "ai",
		time: "1-5m",
		cost: "Model",
		description:
			"Converts code + summaries into high-dimensional vector embeddings",
		detail:
			"Transforms your code into 1536-dimensional vectors that capture semantic meaning. Enables true semantic code search - find 'authentication logic' even when the code says 'validateJWT'.",
	},
	{
		id: 8,
		name: "Local Storage",
		type: "local",
		time: "~2s",
		cost: "Free",
		description: "Persists vectors, graph, and metadata in local LanceDB",
		detail:
			"Your entire code index lives on your machine - no cloud uploads, no vendor lock-in. Fast columnar storage optimized for vector similarity search. Privacy-first code intelligence.",
	},
];

const retrievalSteps: LayerStep[] = [
	{
		id: 1,
		name: "Query Embedding",
		type: "ai",
		time: "100ms",
		cost: "Tiny",
		description:
			"Transforms natural language query into vector representation",
		detail:
			"Your question becomes a point in the same semantic space as your code. 'Where is authentication handled?' maps to vectors near your auth logic, regardless of variable names.",
	},
	{
		id: 2,
		name: "Hybrid Search",
		type: "local",
		time: "30ms",
		cost: "Free",
		description:
			"Parallel vector similarity + BM25 keyword search for best results",
		detail:
			"Vector search finds conceptual matches ('auth' finds JWT validation). BM25 catches exact matches ('validateToken'). Hybrid search combines both for superior code retrieval accuracy.",
	},
	{
		id: 3,
		name: "Score Fusion",
		type: "local",
		time: "5ms",
		cost: "Free",
		description:
			"Weighted ranking: 50% semantic + 30% keyword + 20% PageRank",
		detail:
			"Results are ranked by relevance AND architectural importance. A high-PageRank match in core infrastructure ranks above a low-importance utility, surfacing critical code first.",
	},
	{
		id: 4,
		name: "Context Expansion",
		type: "local",
		time: "20ms",
		cost: "Free",
		description:
			"Enriches results with imports, type definitions, and callers",
		detail:
			"Beyond the matched code, retrieves surrounding context: what it imports, what types it uses, what calls it. Your AI code assistant gets complete understanding, not isolated snippets.",
	},
	{
		id: 5,
		name: "Response Assembly",
		type: "local",
		time: "5ms",
		cost: "Free",
		description: "Formats context as optimized XML prompt for LLM consumption",
		detail:
			"Structures the retrieved code, summaries, and metadata into a format Claude and GPT can instantly parse. Token-efficient formatting maximizes context within model limits.",
	},
	{
		id: 6,
		name: "Delivered to Agent",
		type: "output",
		time: "~200ms",
		cost: "Free",
		description:
			"Complete code intelligence delivered to your AI assistant",
		detail:
			"Zero file exploration needed. Your AI code assistant starts with the exact relevant code, its dependencies, and architectural context. From question to answer in 200ms.",
	},
];

const StepCard: React.FC<{
	step: LayerStep;
	isExpanded: boolean;
	onClick: () => void;
	accentColor: string;
}> = ({ step, isExpanded, onClick, accentColor }) => {
	const typeColors = {
		local: {
			bg: "bg-green-500/10",
			border: "border-green-500/30",
			text: "text-green-400",
			badge: "bg-green-500/20 text-green-400 border-green-500/40",
		},
		ai: {
			bg: "bg-purple-500/10",
			border: "border-purple-500/30",
			text: "text-purple-400",
			badge: "bg-purple-500/20 text-purple-400 border-purple-500/40",
		},
		output: {
			bg: "bg-blue-500/10",
			border: "border-blue-500/30",
			text: "text-blue-400",
			badge: "bg-blue-500/20 text-blue-400 border-blue-500/40",
		},
	};

	const colors = typeColors[step.type];

	return (
		<button
			onClick={onClick}
			className={`
        w-full text-left p-3 rounded-xl border transition-all duration-300
        ${isExpanded ? `${colors.bg} ${colors.border}` : "bg-[#0a0a0a] border-white/5 hover:border-white/10"}
      `}
		>
			<div className="flex items-start gap-3">
				{/* Step Number */}
				<div
					className={`
            w-7 h-7 rounded-full flex items-center justify-center font-mono text-xs font-bold shrink-0
            ${isExpanded ? `${accentColor} text-black` : "bg-[#1a1a1a] text-gray-400"}
          `}
				>
					{step.id}
				</div>

				{/* Content */}
				<div className="flex-1 min-w-0">
					<div className="flex items-center justify-between gap-2 mb-0.5">
						<h4
							className={`font-bold text-sm ${isExpanded ? "text-white" : "text-gray-300"}`}
						>
							{step.name}
						</h4>
						<span
							className={`text-[8px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${colors.badge}`}
						>
							{step.type.toUpperCase()}
						</span>
					</div>

					<p className="text-[11px] text-gray-500 leading-snug">
						{step.description}
					</p>

					{/* Timing & Cost - compact */}
					<div className="flex items-center gap-2 text-[9px] font-mono mt-1.5">
						<span className={isExpanded ? colors.text : "text-gray-500"}>
							{step.time}
						</span>
						<span className="text-gray-700">|</span>
						<span className={isExpanded ? colors.text : "text-gray-500"}>
							{step.cost}
						</span>
					</div>

					{/* Expanded Detail */}
					{isExpanded && (
						<div className="mt-2 pt-2 border-t border-white/10">
							<p className="text-[11px] text-gray-300 leading-relaxed">
								{step.detail}
							</p>
						</div>
					)}
				</div>
			</div>
		</button>
	);
};

export const ArchitectureDiagram: React.FC = () => {
	const [expandedIndexing, setExpandedIndexing] = useState<number | null>(null);
	const [expandedRetrieval, setExpandedRetrieval] = useState<number | null>(
		null,
	);

	return (
		<section className="py-24 bg-[#080808] border-t border-white/5 relative overflow-hidden">
			{/* Background Gradient */}
			<div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(0,212,170,0.03)_0%,transparent_50%)] pointer-events-none" />

			<div className="max-w-7xl mx-auto px-6 relative z-10">
				{/* Header */}
				<div className="text-center mb-12">
					<div className="inline-block px-4 py-1.5 bg-white/5 border border-white/10 text-gray-400 font-mono text-[11px] font-bold uppercase tracking-[0.2em] rounded-full mb-6">
						System Architecture
					</div>
					<h2 className="text-3xl md:text-5xl font-black text-white mb-4">
						How Semantic Code Search Works
					</h2>
					<p className="text-gray-500 text-base max-w-3xl mx-auto leading-relaxed">
						claudemem combines{" "}
						<span className="text-white">AST parsing</span>,{" "}
						<span className="text-white">PageRank scoring</span>, and{" "}
						<span className="text-white">vector embeddings</span> to give AI
						code assistants deep understanding of your codebase.
					</p>
				</div>

				{/* Legend */}
				<div className="flex flex-wrap justify-center gap-6 mb-10">
					<div className="flex items-center gap-2">
						<div className="w-3 h-3 bg-green-500 rounded-full" />
						<span className="text-xs text-gray-400 font-mono">
							Local Processing (Free)
						</span>
					</div>
					<div className="flex items-center gap-2">
						<div className="w-3 h-3 bg-purple-500 rounded-full" />
						<span className="text-xs text-gray-400 font-mono">
							AI Processing (LLM Required)
						</span>
					</div>
					<div className="flex items-center gap-2">
						<div className="w-3 h-3 bg-blue-500 rounded-full" />
						<span className="text-xs text-gray-400 font-mono">
							Output to Agent
						</span>
					</div>
				</div>

				{/* Two-Column Layout - No Scroll */}
				<div className="grid lg:grid-cols-2 gap-6 lg:gap-8">
					{/* Indexing Column */}
					<div className="bg-[#0c0c0c] border border-white/10 rounded-2xl overflow-hidden">
						{/* Column Header */}
						<div className="bg-[#111] border-b border-white/10 px-5 py-3">
							<div className="flex items-center justify-between">
								<div>
									<h3 className="text-lg font-bold text-claude-ish">
										Part 1: Code Indexing Pipeline
									</h3>
									<p className="text-[11px] text-gray-500 font-mono mt-0.5">
										One-time setup • Runs locally on your machine
									</p>
								</div>
								<div className="text-right">
									<div className="text-xl font-black text-white">~15s</div>
									<div className="text-[9px] text-gray-500 uppercase">
										Total
									</div>
								</div>
							</div>
						</div>

						{/* Steps - No scroll constraint */}
						<div className="p-3 space-y-1.5">
							{indexingSteps.map((step) => (
								<StepCard
									key={step.id}
									step={step}
									isExpanded={expandedIndexing === step.id}
									onClick={() =>
										setExpandedIndexing(
											expandedIndexing === step.id ? null : step.id,
										)
									}
									accentColor="bg-claude-ish"
								/>
							))}
						</div>

						{/* Column Footer */}
						<div className="bg-[#0a0a0a] border-t border-white/10 px-5 py-2.5">
							<div className="flex items-center justify-between text-[10px] font-mono">
								<span className="text-gray-600">
									8 steps for complete code intelligence
								</span>
								<span className="text-gray-500">
									<span className="text-green-400">6 local</span> +{" "}
									<span className="text-purple-400">2 AI</span>
								</span>
							</div>
						</div>
					</div>

					{/* Retrieval Column */}
					<div className="bg-[#0c0c0c] border border-white/10 rounded-2xl overflow-hidden">
						{/* Column Header */}
						<div className="bg-[#111] border-b border-white/10 px-5 py-3">
							<div className="flex items-center justify-between">
								<div>
									<h3 className="text-lg font-bold text-blue-400">
										Part 2: Retrieval Pipeline
									</h3>
									<p className="text-[11px] text-gray-500 font-mono mt-0.5">
										Every query • Instant semantic search
									</p>
								</div>
								<div className="text-right">
									<div className="text-xl font-black text-green-400">
										~200ms
									</div>
									<div className="text-[9px] text-gray-500 uppercase">
										Latency
									</div>
								</div>
							</div>
						</div>

						{/* Speed Comparison Banner */}
						<div className="mx-3 mt-3 bg-green-500/10 border border-green-500/30 rounded-lg p-2.5">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<span className="text-xl">⚡</span>
									<div>
										<div className="text-sm font-bold text-green-400">
											100x Faster Than Traditional RAG
										</div>
										<div className="text-[10px] text-gray-500">
											Pre-indexed codebase = zero discovery overhead
										</div>
									</div>
								</div>
							</div>
						</div>

						{/* Steps - No scroll constraint */}
						<div className="p-3 space-y-1.5">
							{retrievalSteps.map((step) => (
								<StepCard
									key={step.id}
									step={step}
									isExpanded={expandedRetrieval === step.id}
									onClick={() =>
										setExpandedRetrieval(
											expandedRetrieval === step.id ? null : step.id,
										)
									}
									accentColor="bg-blue-500"
								/>
							))}
						</div>

						{/* Column Footer */}
						<div className="bg-[#0a0a0a] border-t border-white/10 px-5 py-2.5">
							<div className="flex items-center justify-between text-[10px] font-mono">
								<span className="text-gray-600">
									6 steps from query to context
								</span>
								<span className="text-gray-500">
									<span className="text-green-400">4 local</span> +{" "}
									<span className="text-purple-400">1 AI</span> +{" "}
									<span className="text-blue-400">1 output</span>
								</span>
							</div>
						</div>
					</div>
				</div>

				{/* Key Metrics Bar */}
				<div className="mt-10 grid grid-cols-2 md:grid-cols-4 gap-3">
					<div className="bg-[#0c0c0c] border border-white/10 rounded-xl p-4 text-center">
						<div className="text-2xl font-black text-white mb-0.5">28+</div>
						<div className="text-[10px] text-gray-500 uppercase tracking-wider">
							Programming Languages
						</div>
					</div>
					<div className="bg-[#0c0c0c] border border-white/10 rounded-xl p-4 text-center">
						<div className="text-2xl font-black text-green-400 mb-0.5">
							200ms
						</div>
						<div className="text-[10px] text-gray-500 uppercase tracking-wider">
							Retrieval Latency
						</div>
					</div>
					<div className="bg-[#0c0c0c] border border-white/10 rounded-xl p-4 text-center">
						<div className="text-2xl font-black text-white mb-0.5">100%</div>
						<div className="text-[10px] text-gray-500 uppercase tracking-wider">
							Local & Private
						</div>
					</div>
					<div className="bg-[#0c0c0c] border border-white/10 rounded-xl p-4 text-center">
						<div className="text-2xl font-black text-claude-ish mb-0.5">
							Hybrid
						</div>
						<div className="text-[10px] text-gray-500 uppercase tracking-wider">
							Vector + PageRank
						</div>
					</div>
				</div>

				{/* SEO-Rich Description */}
				<div className="mt-10 bg-[#0a0a0a] border border-white/5 rounded-xl p-6">
					<h3 className="text-lg font-bold text-white mb-3">
						Why This Architecture Matters for AI Code Assistance
					</h3>
					<div className="grid md:grid-cols-3 gap-6 text-sm text-gray-400 leading-relaxed">
						<div>
							<h4 className="text-white font-semibold mb-2">
								Semantic Understanding
							</h4>
							<p>
								Traditional code search relies on keyword matching. claudemem
								combines AST parsing with vector embeddings to understand code
								intent - finding authentication logic even when searching for
								"login validation".
							</p>
						</div>
						<div>
							<h4 className="text-white font-semibold mb-2">
								Architectural Awareness
							</h4>
							<p>
								PageRank scoring identifies your codebase's critical
								infrastructure. AI assistants receive context about high-importance
								code first, avoiding irrelevant utility functions that pollute
								context windows.
							</p>
						</div>
						<div>
							<h4 className="text-white font-semibold mb-2">
								Privacy-First Design
							</h4>
							<p>
								All indexing and retrieval runs locally. Your code never leaves
								your machine. LanceDB stores vectors on disk, persisting between
								sessions without cloud dependencies.
							</p>
						</div>
					</div>
				</div>

				{/* Call to Action */}
				<div className="mt-8 text-center">
					<p className="text-gray-500 font-mono text-sm mb-4">
						See the pipeline in action with our interactive visualization below
					</p>
					<div className="flex items-center justify-center gap-2 text-gray-600 animate-bounce">
						<svg
							className="w-5 h-5"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M19 14l-7 7m0 0l-7-7m7 7V3"
							/>
						</svg>
					</div>
				</div>
			</div>
		</section>
	);
};

export default ArchitectureDiagram;
