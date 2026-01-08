import React, { useState, useEffect, useRef } from "react";
import { TypingAnimation } from "./TypingAnimation";

export const PipelineVisualizer: React.FC = () => {
	const [mode, setMode] = useState<"indexing" | "retrieval">("indexing");
	const [activeStep, setActiveStep] = useState(0);
	const [isVisible, setIsVisible] = useState(false);
	const sectionRef = useRef<HTMLDivElement>(null);

	// Enhanced Data Definitions with Rich Info
	const indexingSteps = [
		{
			id: "1",
			title: "File Discovery",
			type: "LOCAL",
			visual: "files",
			time: "< 1s",
			cost: "Free",
			technical:
				"Walks directory tree. Respects .gitignore. Filters for source extensions.",
			value:
				"Ensures only relevant source code is indexed, skipping node_modules/build artifacts.",
		},
		{
			id: "2",
			title: "AST Parsing",
			type: "LOCAL",
			visual: "ast",
			time: "~5s",
			cost: "Free",
			technical: "Parses files into Abstract Syntax Trees using Tree-sitter.",
			value:
				"Understands code structure (functions, classes) rather than just reading raw text.",
		},
		{
			id: "3",
			title: "Semantic Chunking",
			type: "LOCAL",
			visual: "chunks",
			time: "~2s",
			cost: "Free",
			technical: "Splits code at function/class boundaries (300-500 tokens).",
			value:
				"Keeps related logic together. Naive splitters cut functions in half; we don't.",
		},
		{
			id: "4",
			title: "Symbol Graph",
			type: "LOCAL",
			visual: "graph",
			time: "~3s",
			cost: "Free",
			technical: "Builds a graph of definitions, references, and calls.",
			value:
				'Maps the "nervous system" of your code to understand dependencies.',
		},
		{
			id: "5",
			title: "PageRank Scoring",
			type: "LOCAL",
			visual: "pagerank",
			time: "< 1s",
			cost: "Free",
			technical: "Calculates eigen-centrality for every symbol.",
			value:
				"Identifies critical infrastructure (high rank) vs isolated utilities (low rank).",
		},
		{
			id: "6",
			title: "Summary Generation",
			type: "AI",
			visual: "ai-summary",
			time: "2-10m",
			cost: "Requires LLM",
			technical: "LLM generates intent-focused summaries for each chunk.",
			value:
				'Captures "intent" ("validates user") vs "implementation" ("regex check").',
		},
		{
			id: "7",
			title: "Embedding Gen",
			type: "AI",
			visual: "embedding",
			time: "1-5m",
			cost: "Requires Model",
			technical: "Converts code + summary into high-dimensional vectors.",
			value:
				"Enables semantic search (finding concepts) rather than just keyword matching.",
		},
		{
			id: "8",
			title: "Local Storage",
			type: "LOCAL",
			visual: "storage",
			time: "~2s",
			cost: "Free",
			technical: "Stores vectors, graph, and metadata in LanceDB locally.",
			value: "Your index lives on your machine. Fast, private, and persistent.",
		},
	];

	const retrievalSteps = [
		{
			id: "1",
			title: "Query Embedding",
			type: "AI",
			visual: "query-vec",
			time: "100ms",
			cost: "Negligible",
			technical: "Converts user query into a vector.",
			value:
				"Translates your question into the same mathematical space as your code.",
		},
		{
			id: "2",
			title: "Hybrid Search",
			type: "LOCAL",
			visual: "hybrid",
			time: "30ms",
			cost: "Free",
			technical: "Runs Vector Search + BM25 Keyword Search in parallel.",
			value:
				'Vectors find concepts ("auth"); BM25 finds exact matches ("validateToken").',
		},
		{
			id: "3",
			title: "Score Fusion",
			type: "LOCAL",
			visual: "fusion",
			time: "5ms",
			cost: "Free",
			technical: "Combines scores: 0.5 Vector + 0.3 Keyword + 0.2 PageRank.",
			value: "Boosts relevant results that are also architecturally important.",
		},
		{
			id: "4",
			title: "Context Expansion",
			type: "LOCAL",
			visual: "context",
			time: "20ms",
			cost: "Free",
			technical: "Retrieves imports, types, and callers for top results.",
			value:
				"Provides the LLM with the surrounding context needed to understand the code.",
		},
		{
			id: "5",
			title: "Response Assembly",
			type: "LOCAL",
			visual: "assembly",
			time: "5ms",
			cost: "Free",
			technical: "Formats retrieval results into an optimized XML prompt.",
			value:
				"Packages everything into a format Claude/GPT can instantly process.",
		},
		{
			id: "6",
			title: "Delivered",
			type: "OUTPUT",
			visual: "delivered",
			time: "Total: ~200ms",
			cost: "Free",
			technical: "Hands off context to the agent.",
			value: "Zero exploration needed. The agent starts with the answer.",
		},
	];

	const steps = mode === "indexing" ? indexingSteps : retrievalSteps;

	// Intersection Observer
	useEffect(() => {
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting) {
					setIsVisible(true);
				}
			},
			{ threshold: 0.2 },
		);
		if (sectionRef.current) observer.observe(sectionRef.current);
		return () => observer.disconnect();
	}, []);

	// Animation Loop
	useEffect(() => {
		if (!isVisible) return;

		const interval = setInterval(() => {
			setActiveStep((prev) => (prev + 1) % steps.length);
		}, 4000); // 4 seconds per step to allow reading

		return () => clearInterval(interval);
	}, [isVisible, mode, steps.length]);

	// Manual step selection
	const handleStepClick = (index: number) => {
		setActiveStep(index);
	};

	return (
		<section
			ref={sectionRef}
			className="py-32 bg-[#080808] border-t border-white/5 relative overflow-hidden"
		>
			<div className="max-w-7xl mx-auto px-6 relative z-10">
				<div className="text-center mb-16">
					<h2 className="text-4xl md:text-5xl font-black text-white mb-6">
						See Under the Hood
					</h2>
					<p className="text-gray-500 font-mono text-lg max-w-2xl mx-auto">
						A transparent look at the indexing and retrieval pipeline.
					</p>

					{/* Toggle */}
					<div className="flex justify-center mt-8">
						<div className="bg-[#111] p-1 rounded-lg border border-white/10 inline-flex shadow-lg relative z-20">
							<button
								onClick={() => {
									setMode("indexing");
									setActiveStep(0);
								}}
								className={`px-6 py-2 rounded-md text-sm font-bold font-mono transition-all ${mode === "indexing" ? "bg-claude-ish text-[#050505]" : "text-gray-500 hover:text-white"}`}
							>
								Part 1: Indexing
							</button>
							<button
								onClick={() => {
									setMode("retrieval");
									setActiveStep(0);
								}}
								className={`px-6 py-2 rounded-md text-sm font-bold font-mono transition-all ${mode === "retrieval" ? "bg-blue-500 text-white" : "text-gray-500 hover:text-white"}`}
							>
								Part 2: Retrieval
							</button>
						</div>
					</div>
				</div>

				<div className="grid lg:grid-cols-12 gap-8 lg:gap-12 items-start h-[700px] lg:h-[650px]">
					{/* LEFT: Pipeline Steps (Controller) */}
					<div className="lg:col-span-4 flex flex-col h-full overflow-hidden">
						<div className="overflow-y-auto pr-2 scrollbar-hide space-y-2 h-full py-2">
							{steps.map((step, idx) => (
								<button
									key={idx}
									onClick={() => handleStepClick(idx)}
									className={`
                                        w-full flex items-center gap-4 p-4 rounded-xl border text-left transition-all duration-300 group
                                        ${
																					idx === activeStep
																						? "bg-[#151515] border-white/20 translate-x-2 opacity-100"
																						: "bg-transparent border-transparent opacity-40 hover:opacity-80 hover:bg-white/5"
																				}
                                    `}
								>
									<div
										className={`
                                        w-8 h-8 rounded-full flex items-center justify-center font-mono text-xs font-bold transition-colors border shrink-0
                                        ${
																					idx === activeStep
																						? step.type === "AI"
																							? "bg-purple-500/20 text-purple-400 border-purple-500/50"
																							: "bg-claude-ish/20 text-claude-ish border-claude-ish/50"
																						: "bg-[#1a1a1a] text-gray-500 border-transparent group-hover:border-gray-700"
																				}
                                    `}
									>
										{idx + 1}
									</div>
									<div className="flex-1 min-w-0">
										<div className="flex items-center justify-between mb-0.5">
											<div
												className={`font-bold text-sm truncate ${idx === activeStep ? "text-white" : "text-gray-400"}`}
											>
												{step.title}
											</div>
											{idx === activeStep && (
												<span
													className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
														step.type === "AI"
															? "bg-purple-500/20 text-purple-400"
															: step.type === "LOCAL"
																? "bg-gray-800 text-gray-400"
																: "bg-green-500/20 text-green-400"
													}`}
												>
													{step.type}
												</span>
											)}
										</div>
									</div>
								</button>
							))}
						</div>
					</div>

					{/* RIGHT: Visual Engine (The "TV") */}
					<div className="lg:col-span-8 h-full">
						<div className="bg-[#0c0c0c] border border-white/10 rounded-2xl shadow-2xl h-full flex flex-col relative overflow-hidden ring-1 ring-white/5">
							{/* Grid BG */}
							<div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:40px_40px]"></div>

							{/* Header */}
							<div className="h-12 border-b border-white/10 bg-[#111]/80 backdrop-blur flex items-center justify-between px-6 z-10 shrink-0">
								<div className="font-mono text-xs text-gray-400 uppercase tracking-widest flex items-center gap-2">
									<span
										className={`w-2 h-2 rounded-full animate-pulse ${steps[activeStep].type === "AI" ? "bg-purple-500" : "bg-green-500"}`}
									></span>
									PROCESS: {steps[activeStep].title}
								</div>
								<div className="font-mono text-[10px] text-gray-600">
									ENGINE_V1.4.2
								</div>
							</div>

							{/* Dynamic Visual Stage */}
							<div className="flex-1 relative flex items-center justify-center p-8 overflow-hidden bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.03)_0%,transparent_70%)]">
								{/* HUD Overlay */}
								<div className="absolute top-6 right-6 flex flex-col gap-2 z-20 items-end pointer-events-none">
									<div className="bg-[#0a0a0a]/90 backdrop-blur border border-white/10 px-3 py-2 rounded-lg flex items-center gap-3 shadow-xl">
										<div className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">
											Time
										</div>
										<div className="text-xs font-mono text-white">
											{steps[activeStep].time}
										</div>
									</div>
									<div className="bg-[#0a0a0a]/90 backdrop-blur border border-white/10 px-3 py-2 rounded-lg flex items-center gap-3 shadow-xl">
										<div className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">
											Cost
										</div>
										<div
											className={`text-xs font-mono ${steps[activeStep].type === "AI" ? "text-purple-400" : "text-green-400"}`}
										>
											{steps[activeStep].cost}
										</div>
									</div>
								</div>

								<div
									key={activeStep}
									className="scale-125 md:scale-150 transform transition-all duration-500"
								>
									<EngineVisualizer visual={steps[activeStep].visual} />
								</div>
							</div>

							{/* Enhanced Footer / Console Output */}
							<div className="border-t border-white/10 bg-[#080808] z-20">
								<div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-white/10">
									{/* System Log */}
									<div className="p-5 space-y-2">
										<div className="text-[10px] font-bold text-gray-600 uppercase tracking-widest mb-1 flex items-center gap-2">
											<svg
												className="w-3 h-3"
												fill="none"
												viewBox="0 0 24 24"
												stroke="currentColor"
											>
												<path
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth="2"
													d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
												/>
											</svg>
											System Log
										</div>
										<p className="text-xs text-gray-400 font-mono leading-relaxed h-8 flex items-center">
											<span className="text-claude-ish mr-2">$</span>
											<span className="animate-pulse">
												{steps[activeStep].technical}
											</span>
										</p>
									</div>

									{/* Intelligence Report */}
									<div className="p-5 space-y-2 bg-[#0a0a0a]">
										<div className="text-[10px] font-bold text-gray-600 uppercase tracking-widest mb-1 flex items-center gap-2">
											<svg
												className="w-3 h-3"
												fill="none"
												viewBox="0 0 24 24"
												stroke="currentColor"
											>
												<path
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth="2"
													d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
												/>
											</svg>
											Why this matters
										</div>
										<p className="text-xs text-gray-300 leading-relaxed h-8 flex items-center">
											{steps[activeStep].value}
										</p>
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
};

// --- ENGINE VISUALIZER COMPONENT ---

const EngineVisualizer: React.FC<{ visual: string }> = ({ visual }) => {
	switch (visual) {
		case "files":
			return <VisualFiles />;
		case "ast":
			return <VisualAST />;
		case "chunks":
			return <VisualChunking />;
		case "graph":
			return <VisualGraphBuilding />;
		case "pagerank":
			return <VisualPageRankActive />;
		case "ai-summary":
			return <VisualAISummary />;
		case "embedding":
			return <VisualEmbedding />;
		case "storage":
			return <VisualStorage />;

		// Retrieval
		case "query-vec":
			return <VisualQueryVec />;
		case "hybrid":
			return <VisualHybridSearch />;
		case "fusion":
			return <VisualScoreFusion />;
		case "context":
			return <VisualContextExpansion />;
		case "assembly":
			return <VisualAssembly />;
		case "delivered":
			return <VisualDelivered />;

		default:
			return <div className="text-gray-600 font-mono">Processing...</div>;
	}
};

// --- VISUALIZERS ---

const VisualFiles = () => (
	<div className="w-full max-w-sm space-y-2 relative overflow-hidden h-64">
		{/* Scrolling list effect */}
		<div className="absolute inset-0 bg-gradient-to-b from-[#0c0c0c] via-transparent to-[#0c0c0c] z-10 pointer-events-none"></div>
		<div className="animate-[flow-up_2s_linear_infinite] space-y-2">
			{[...Array(10)].map((_, i) => (
				<div
					key={i}
					className="flex items-center gap-3 p-2 border border-white/5 rounded bg-[#111]"
				>
					<div className="w-4 h-4 bg-blue-500/20 rounded"></div>
					<div className="h-2 w-32 bg-gray-700 rounded"></div>
					<div className="ml-auto text-[10px] text-gray-500 font-mono">2kb</div>
				</div>
			))}
		</div>
	</div>
);

const VisualAST = () => (
	<div className="flex items-center justify-center gap-8 w-full">
		{/* Code */}
		<div className="w-32 bg-[#111] p-3 rounded border border-white/10 space-y-2 opacity-50">
			<div className="h-2 w-20 bg-purple-500/50 rounded"></div>
			<div className="ml-4 h-2 w-16 bg-gray-600 rounded"></div>
			<div className="ml-4 h-2 w-12 bg-gray-600 rounded"></div>
			<div className="h-2 w-4 bg-gray-700 rounded"></div>
		</div>

		{/* Arrow */}
		<div className="text-gray-600">→</div>

		{/* Tree */}
		<div className="relative w-40 h-40 flex items-center justify-center">
			<svg className="w-full h-full overflow-visible">
				<g className="animate-fadeIn">
					<circle cx="50%" cy="10%" r="4" fill="#d97757" />
					<path d="M 50% 10% L 30% 40%" stroke="#333" />
					<path d="M 50% 10% L 70% 40%" stroke="#333" />

					<circle
						cx="30%"
						cy="40%"
						r="3"
						fill="#3fb950"
						className="animate-pulse"
					/>
					<circle cx="70%" cy="40%" r="3" fill="#3fb950" />

					<path d="M 30% 40% L 10% 70%" stroke="#333" />
					<path d="M 30% 40% L 50% 70%" stroke="#333" />

					<circle cx="10%" cy="70%" r="2" fill="#888" />
					<circle cx="50%" cy="70%" r="2" fill="#888" />
				</g>
			</svg>
		</div>
	</div>
);

const VisualChunking = () => (
	<div className="w-64 bg-[#111] border border-white/10 rounded p-4 font-mono text-[10px] text-gray-500 relative overflow-hidden">
		<div className="absolute inset-0 bg-transparent z-20 flex flex-col">
			{/* Chunk 1 Overlay */}
			<div className="flex-1 border-2 border-claude-ish/30 bg-claude-ish/5 m-1 rounded flex items-center justify-center relative">
				<span className="bg-black text-claude-ish px-1 rounded absolute top-0 right-0">
					Chunk 1
				</span>
			</div>
			{/* Chunk 2 Overlay */}
			<div className="flex-1 border-2 border-blue-500/30 bg-blue-500/5 m-1 rounded flex items-center justify-center relative">
				<span className="bg-black text-blue-500 px-1 rounded absolute top-0 right-0">
					Chunk 2
				</span>
			</div>
		</div>
		<div className="space-y-1 opacity-50">
			<div>function auth() {"{"}</div>
			<div className="pl-2">const user = ...</div>
			<div className="pl-2">return true</div>
			<div>{"}"}</div>
			<div className="h-2"></div>
			<div>function log() {"{"}</div>
			<div className="pl-2">console.log(...)</div>
			<div>{"}"}</div>
		</div>
	</div>
);

const VisualGraphBuilding = () => (
	<div className="relative w-full h-64 flex items-center justify-center">
		<svg className="w-full h-full overflow-visible">
			{/* Central Node */}
			<circle
				cx="50%"
				cy="50%"
				r="8"
				fill="#fff"
				className="animate-ping absolute opacity-20"
			/>
			<circle cx="50%" cy="50%" r="6" fill="#fff" />

			{/* Satellites */}
			<g
				className="animate-[spin_10s_linear_infinite] origin-center"
				style={{ transformBox: "fill-box" }}
			>
				<circle cx="50%" cy="20%" r="4" fill="#444" />
				<line
					x1="50%"
					y1="50%"
					x2="50%"
					y2="20%"
					stroke="#333"
					strokeDasharray="4"
				/>

				<circle cx="80%" cy="50%" r="4" fill="#444" />
				<line
					x1="50%"
					y1="50%"
					x2="80%"
					y2="50%"
					stroke="#333"
					strokeDasharray="4"
				/>

				<circle cx="20%" cy="80%" r="4" fill="#444" />
				<line
					x1="50%"
					y1="50%"
					x2="20%"
					y2="80%"
					stroke="#333"
					strokeDasharray="4"
				/>
			</g>
		</svg>
	</div>
);

const VisualPageRankActive = () => (
	<div className="relative w-full h-64 flex items-center justify-center">
		{/* Nodes resizing based on importance */}
		<div className="relative w-64 h-64">
			{/* Big Node */}
			<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-20 h-20 bg-claude-ish rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(0,212,170,0.4)] animate-pulse z-10">
				<span className="text-black font-bold">0.9</span>
			</div>

			{/* Small Nodes */}
			<div className="absolute top-10 left-10 w-8 h-8 bg-gray-700 rounded-full flex items-center justify-center text-[10px] text-gray-300">
				0.1
			</div>
			<div className="absolute bottom-10 right-20 w-12 h-12 bg-gray-600 rounded-full flex items-center justify-center text-[10px] text-gray-300">
				0.3
			</div>
			<div className="absolute top-20 right-10 w-6 h-6 bg-gray-800 rounded-full flex items-center justify-center text-[8px] text-gray-500">
				0.05
			</div>

			{/* Connections */}
			<svg className="absolute inset-0 w-full h-full pointer-events-none -z-10">
				<line
					x1="50%"
					y1="50%"
					x2="20%"
					y2="20%"
					stroke="#333"
					strokeWidth="2"
				/>
				<line
					x1="50%"
					y1="50%"
					x2="70%"
					y2="80%"
					stroke="#333"
					strokeWidth="4"
					className="stroke-claude-ish/30"
				/>
				<line
					x1="50%"
					y1="50%"
					x2="80%"
					y2="30%"
					stroke="#333"
					strokeWidth="1"
				/>
			</svg>
		</div>
	</div>
);

const VisualAISummary = () => (
	<div className="flex flex-col items-center gap-4 w-full max-w-md">
		<div className="flex items-center gap-4 w-full">
			<div className="w-12 h-12 bg-purple-500/20 border border-purple-500/50 rounded-lg flex items-center justify-center text-xl">
				🤖
			</div>
			<div className="flex-1 bg-[#111] p-3 rounded border border-white/10 h-20 relative overflow-hidden">
				<div className="text-[10px] text-gray-400 font-mono">
					<TypingAnimation
						text="Analyzing intent: This function handles JWT validation and expiry checks..."
						speed={30}
					/>
				</div>
			</div>
		</div>
		<div className="flex gap-2">
			<span className="text-[10px] bg-gray-800 px-2 py-1 rounded text-gray-400">
				Context: 4k
			</span>
			<span className="text-[10px] bg-purple-900/30 text-purple-400 px-2 py-1 rounded">
				Model: Haiku
			</span>
		</div>
	</div>
);

const VisualEmbedding = () => (
	<div className="flex items-center gap-6">
		<div className="bg-[#111] p-2 border border-white/10 rounded text-[10px] text-gray-500">
			"Auth Logic"
		</div>
		<div className="text-gray-600">→</div>
		<div className="w-48 bg-[#0a0a0a] border border-gray-800 p-2 rounded font-mono text-[10px] text-blue-400 break-all leading-tight shadow-inner">
			[0.12, -0.45, 0.88, 0.02, -0.11, 0.94, ... 1536 dim]
		</div>
	</div>
);

const VisualStorage = () => (
	<div className="flex flex-col items-center justify-center h-40">
		<div className="w-20 h-24 border-2 border-gray-600 rounded-lg relative flex items-center justify-center bg-[#111] shadow-xl">
			{/* Cylinder graphic simulation */}
			<div className="absolute top-0 w-full h-4 bg-gray-600 rounded-[50%] -translate-y-1/2"></div>
			<div className="absolute bottom-0 w-full h-4 bg-gray-600 rounded-[50%] translate-y-1/2"></div>

			{/* Data flying in */}
			<div className="absolute -top-12 animate-bounce">
				<div className="w-8 h-10 bg-claude-ish/20 border border-claude-ish rounded flex items-center justify-center text-[10px] text-claude-ish">
					DATA
				</div>
			</div>
		</div>
		<div className="mt-6 text-xs text-gray-500 font-mono">LanceDB (Local)</div>
	</div>
);

// Retrieval Visuals

const VisualQueryVec = () => (
	<div className="space-y-4 w-full max-w-sm">
		<div className="flex items-center gap-2">
			<span className="text-gray-500 text-xs">User:</span>
			<div className="bg-[#1a1a1a] px-3 py-1 rounded text-white text-sm border border-white/10">
				"Where is auth?"
			</div>
		</div>
		<div className="h-8 w-[2px] bg-gray-700 mx-auto"></div>
		<div className="bg-blue-900/10 border border-blue-500/30 p-2 rounded text-[10px] text-blue-400 font-mono break-all">
			vector: [0.82, -0.11, 0.44 ...]
		</div>
	</div>
);

const VisualHybridSearch = () => (
	<div className="grid grid-cols-3 gap-2 w-full max-w-md">
		<div className="bg-[#111] border border-blue-500/30 p-3 rounded flex flex-col items-center gap-2">
			<div className="text-[10px] text-gray-500 uppercase">Vector</div>
			<div className="w-full bg-gray-800 h-1 rounded">
				<div className="bg-blue-500 w-[80%] h-full"></div>
			</div>
		</div>
		<div className="bg-[#111] border border-green-500/30 p-3 rounded flex flex-col items-center gap-2">
			<div className="text-[10px] text-gray-500 uppercase">BM25</div>
			<div className="w-full bg-gray-800 h-1 rounded">
				<div className="bg-green-500 w-[40%] h-full"></div>
			</div>
		</div>
		<div className="bg-[#111] border border-purple-500/30 p-3 rounded flex flex-col items-center gap-2">
			<div className="text-[10px] text-gray-500 uppercase">Graph</div>
			<div className="w-full bg-gray-800 h-1 rounded">
				<div className="bg-purple-500 w-[60%] h-full"></div>
			</div>
		</div>
	</div>
);

const VisualScoreFusion = () => (
	<div className="flex flex-col gap-2 w-full max-w-xs">
		<div className="flex items-center gap-2 opacity-50">
			<div className="w-8 h-8 bg-gray-800 rounded"></div>
			<div className="h-2 w-32 bg-gray-800 rounded"></div>
		</div>
		{/* Winner */}
		<div className="flex items-center gap-2 scale-110 transition-transform bg-[#1a1a1a] p-2 rounded border border-claude-ish/50 shadow-lg">
			<div className="w-8 h-8 bg-claude-ish rounded flex items-center justify-center text-black font-bold text-xs">
				#1
			</div>
			<div className="flex-1">
				<div className="h-2 w-24 bg-gray-700 rounded mb-1"></div>
				<div className="flex gap-0.5 h-1 w-full rounded overflow-hidden">
					<div className="bg-blue-500 w-[50%]"></div>
					<div className="bg-green-500 w-[30%]"></div>
					<div className="bg-purple-500 w-[20%]"></div>
				</div>
			</div>
		</div>
		<div className="flex items-center gap-2 opacity-50">
			<div className="w-8 h-8 bg-gray-800 rounded"></div>
			<div className="h-2 w-32 bg-gray-800 rounded"></div>
		</div>
	</div>
);

const VisualContextExpansion = () => (
	<div className="relative w-full h-40 flex items-center justify-center">
		<div className="w-16 h-12 bg-white text-black font-bold text-xs flex items-center justify-center rounded border-2 border-claude-ish z-20">
			Target
		</div>
		{/* Expanded nodes */}
		<div className="absolute top-4 left-1/4 w-12 h-8 bg-[#1a1a1a] border border-gray-700 rounded text-[8px] flex items-center justify-center text-gray-500 animate-fadeIn">
			Import
		</div>
		<div className="absolute bottom-4 right-1/4 w-12 h-8 bg-[#1a1a1a] border border-gray-700 rounded text-[8px] flex items-center justify-center text-gray-500 animate-fadeIn">
			Caller
		</div>
		{/* Lines */}
		<svg className="absolute inset-0 w-full h-full pointer-events-none z-10">
			<line x1="50%" y1="50%" x2="30%" y2="20%" stroke="#444" />
			<line x1="50%" y1="50%" x2="70%" y2="80%" stroke="#444" />
		</svg>
	</div>
);

const VisualAssembly = () => (
	<div className="font-mono text-[10px] text-gray-400 bg-[#111] p-4 rounded border border-gray-800 w-64 shadow-lg">
		<div className="text-purple-400">{"{"}</div>
		<div className="pl-4">
			<span className="text-blue-400">"file"</span>: "src/auth.ts",
		</div>
		<div className="pl-4">
			<span className="text-blue-400">"rank"</span>: 0.94,
		</div>
		<div className="pl-4">
			<span className="text-blue-400">"context"</span>: "...",
		</div>
		<div className="pl-4">
			<span className="text-blue-400">"summary"</span>: "Validates..."
		</div>
		<div className="text-purple-400">{"}"}</div>
	</div>
);

const VisualDelivered = () => (
	<div className="flex flex-col items-center justify-center">
		<div className="w-20 h-20 bg-green-500 rounded-full flex items-center justify-center shadow-[0_0_40px_rgba(34,197,94,0.6)] animate-bounce">
			<svg
				className="w-10 h-10 text-black"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth="3"
					d="M5 13l4 4L19 7"
				/>
			</svg>
		</div>
		<div className="mt-6 text-xl font-bold text-white">Ready for Agent</div>
		<div className="text-gray-500 font-mono text-sm mt-1">Latency: 180ms</div>
	</div>
);
