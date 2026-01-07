import React, { useState } from "react";
import { BlockLogo } from "./BlockLogo";

// ============================================================================
// NEW LANDING PAGE - Clean, focused, benefit-first
// ============================================================================

export const LandingPage: React.FC = () => {
	return (
		<div className="min-h-screen bg-[#0a0a0a] text-white">
			<HeroSection />
			<ProblemSection />
			<SolutionSection />
			<HowItWorksSection />
			<DifferentiatorsSection />
			<QuickStartSection />
			<FooterSection />
		</div>
	);
};

// ============================================================================
// HERO SECTION - Benefit-first, clear value proposition
// ============================================================================

const HeroSection: React.FC = () => {
	const [copied, setCopied] = useState(false);

	const handleCopy = () => {
		navigator.clipboard.writeText("bun install -g claude-codemem");
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<section className="relative min-h-[90vh] flex items-center justify-center px-6 overflow-hidden">
			{/* Subtle gradient background */}
			<div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(0,212,170,0.08)_0%,transparent_50%)]" />

			<div className="relative z-10 max-w-4xl mx-auto text-center">
				{/* Badge */}
				<div className="inline-flex items-center gap-2 bg-white/5 border border-white/10 rounded-full px-4 py-1.5 mb-8">
					<span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
					<span className="text-sm text-gray-400 font-mono">
						Open Source • MIT License
					</span>
				</div>

				{/* Block Logo */}
				<div className="mb-8">
					<BlockLogo />
				</div>

				{/* Main Headline - Benefit First */}
				<h1 className="text-3xl md:text-5xl lg:text-6xl font-black tracking-tight mb-6 leading-[1.1]">
					<span className="text-gray-400">Your AI Forgets Your Code</span>
					<br />
					<span className="text-gray-400">Every Session.</span>
					<br />
					<span className="text-white">claudemem</span>{" "}
					<span className="text-[#00d4aa]">Remembers.</span>
				</h1>

				{/* Value Proposition */}
				<p className="text-lg md:text-xl text-gray-400 max-w-2xl mx-auto mb-10 leading-relaxed">
					Give{" "}
					<span className="text-white font-medium">Claude Code</span>,{" "}
					<span className="text-white font-medium">Cursor</span>, and AI
					assistants persistent understanding of your codebase.{" "}
					<span className="text-[#00d4aa]">
						Pre-indexed. Instant. 100% Local.
					</span>
				</p>

				{/* Key Stats */}
				<div className="flex flex-wrap justify-center gap-6 md:gap-10 mb-10">
					<div className="text-center">
						<div className="text-2xl md:text-3xl font-black text-[#00d4aa]">
							200ms
						</div>
						<div className="text-xs text-gray-500 uppercase tracking-wider">
							Retrieval
						</div>
					</div>
					<div className="text-center">
						<div className="text-2xl md:text-3xl font-black text-white">
							28+
						</div>
						<div className="text-xs text-gray-500 uppercase tracking-wider">
							Languages
						</div>
					</div>
					<div className="text-center">
						<div className="text-2xl md:text-3xl font-black text-white">
							100%
						</div>
						<div className="text-xs text-gray-500 uppercase tracking-wider">
							Local & Private
						</div>
					</div>
					<div className="text-center">
						<div className="text-2xl md:text-3xl font-black text-white">
							Free
						</div>
						<div className="text-xs text-gray-500 uppercase tracking-wider">
							Open Source
						</div>
					</div>
				</div>

				{/* Install Command */}
				<div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-8">
					<button
						onClick={handleCopy}
						className="group flex items-center gap-3 bg-[#111] border border-white/10 rounded-lg px-5 py-3 hover:border-[#00d4aa]/50 transition-all"
					>
						<span className="text-[#00d4aa] font-mono font-bold">$</span>
						<code className="text-gray-300 font-mono">
							bun install -g claude-codemem
						</code>
						<span className="text-gray-500 group-hover:text-[#00d4aa] transition-colors">
							{copied ? "✓" : "⎘"}
						</span>
					</button>

					<a
						href="https://github.com/MadAppGang/claudemem"
						target="_blank"
						rel="noreferrer"
						className="flex items-center gap-2 bg-white text-black font-bold px-6 py-3 rounded-lg hover:bg-gray-100 transition-colors"
					>
						<svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
							<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
						</svg>
						View on GitHub
					</a>
				</div>
			</div>
		</section>
	);
};

// ============================================================================
// PROBLEM SECTION - Why you need this
// ============================================================================

const ProblemSection: React.FC = () => {
	const problems = [
		{
			icon: "🧠",
			title: "The Amnesia Loop",
			description:
				"AI assistants are stateless. Close the tab, and they forget your architecture. Every new session triggers slow, repetitive file discovery.",
			stat: "60%",
			statLabel: "of tokens wasted on re-learning",
		},
		{
			icon: "💸",
			title: "The Context Tax",
			description:
				"You pay for this amnesia. Watch your logs: most tokens are burned just re-feeding context. You're paying double for half the coding work.",
			stat: "$4+",
			statLabel: "per session on redundant context",
		},
		{
			icon: "📋",
			title: "The Code Rot",
			description:
				"Because it doesn't 'know' your codebase, it guesses. It implements utilities that already exist. Now you have duplicates and technical debt.",
			stat: "30%",
			statLabel: "of AI suggestions are redundant",
		},
	];

	return (
		<section className="py-24 px-6 bg-[#080808] border-t border-white/5">
			<div className="max-w-6xl mx-auto">
				{/* Section Header */}
				<div className="text-center mb-16">
					<h2 className="text-3xl md:text-5xl font-black text-white mb-4">
						Why Your AI{" "}
						<span className="text-red-500">Keeps Failing</span>
					</h2>
					<p className="text-gray-500 text-lg max-w-2xl mx-auto">
						The hidden costs of stateless coding assistants
					</p>
				</div>

				{/* Problem Cards */}
				<div className="grid md:grid-cols-3 gap-6">
					{problems.map((problem, i) => (
						<div
							key={i}
							className="bg-[#0c0c0c] border border-white/5 rounded-2xl p-6 hover:border-white/10 transition-colors"
						>
							<div className="text-4xl mb-4">{problem.icon}</div>
							<h3 className="text-xl font-bold text-white mb-3">
								{problem.title}
							</h3>
							<p className="text-gray-400 text-sm leading-relaxed mb-4">
								{problem.description}
							</p>
							<div className="pt-4 border-t border-white/5">
								<div className="text-2xl font-black text-red-500">
									{problem.stat}
								</div>
								<div className="text-xs text-gray-600 uppercase">
									{problem.statLabel}
								</div>
							</div>
						</div>
					))}
				</div>
			</div>
		</section>
	);
};

// ============================================================================
// SOLUTION SECTION - How claudemem fixes it
// ============================================================================

const SolutionSection: React.FC = () => {
	return (
		<section className="py-24 px-6 bg-[#0a0a0a]">
			<div className="max-w-6xl mx-auto">
				{/* Section Header */}
				<div className="text-center mb-16">
					<div className="inline-block px-4 py-1.5 bg-[#00d4aa]/10 border border-[#00d4aa]/20 text-[#00d4aa] text-sm font-bold rounded-full mb-6">
						The Solution
					</div>
					<h2 className="text-3xl md:text-5xl font-black text-white mb-4">
						Index Once.{" "}
						<span className="text-[#00d4aa]">Understand Forever.</span>
					</h2>
					<p className="text-gray-500 text-lg max-w-2xl mx-auto">
						claudemem pre-indexes your codebase locally, giving AI agents instant
						context every session.
					</p>
				</div>

				{/* Before/After Comparison */}
				<div className="grid md:grid-cols-2 gap-8 mb-16">
					{/* Before */}
					<div className="bg-[#0c0c0c] border border-red-500/20 rounded-2xl p-6">
						<div className="flex items-center gap-2 mb-4">
							<div className="w-3 h-3 bg-red-500 rounded-full" />
							<span className="text-red-400 font-bold uppercase text-sm">
								Without claudemem
							</span>
						</div>
						<div className="space-y-3 text-sm">
							<div className="flex items-start gap-3">
								<span className="text-red-500">✗</span>
								<span className="text-gray-400">
									AI explores files every session (10-30 seconds)
								</span>
							</div>
							<div className="flex items-start gap-3">
								<span className="text-red-500">✗</span>
								<span className="text-gray-400">
									Guesses at code structure and patterns
								</span>
							</div>
							<div className="flex items-start gap-3">
								<span className="text-red-500">✗</span>
								<span className="text-gray-400">
									Misses existing utilities, creates duplicates
								</span>
							</div>
							<div className="flex items-start gap-3">
								<span className="text-red-500">✗</span>
								<span className="text-gray-400">
									Pays context tax on every interaction
								</span>
							</div>
						</div>
					</div>

					{/* After */}
					<div className="bg-[#0c0c0c] border border-[#00d4aa]/20 rounded-2xl p-6">
						<div className="flex items-center gap-2 mb-4">
							<div className="w-3 h-3 bg-[#00d4aa] rounded-full" />
							<span className="text-[#00d4aa] font-bold uppercase text-sm">
								With claudemem
							</span>
						</div>
						<div className="space-y-3 text-sm">
							<div className="flex items-start gap-3">
								<span className="text-[#00d4aa]">✓</span>
								<span className="text-gray-300">
									Instant context retrieval (~200ms)
								</span>
							</div>
							<div className="flex items-start gap-3">
								<span className="text-[#00d4aa]">✓</span>
								<span className="text-gray-300">
									Knows your architecture via symbol graph
								</span>
							</div>
							<div className="flex items-start gap-3">
								<span className="text-[#00d4aa]">✓</span>
								<span className="text-gray-300">
									Finds existing code with semantic search
								</span>
							</div>
							<div className="flex items-start gap-3">
								<span className="text-[#00d4aa]">✓</span>
								<span className="text-gray-300">
									Ranks by importance with PageRank
								</span>
							</div>
						</div>
					</div>
				</div>

				{/* Speed Comparison */}
				<div className="bg-[#00d4aa]/5 border border-[#00d4aa]/20 rounded-2xl p-8 text-center">
					<div className="flex flex-col md:flex-row items-center justify-center gap-8">
						<div>
							<div className="text-4xl font-black text-gray-500 line-through">
								10-30s
							</div>
							<div className="text-sm text-gray-600">Traditional RAG</div>
						</div>
						<div className="text-4xl text-[#00d4aa]">→</div>
						<div>
							<div className="text-5xl font-black text-[#00d4aa]">200ms</div>
							<div className="text-sm text-gray-400">claudemem</div>
						</div>
						<div className="bg-[#00d4aa]/10 px-4 py-2 rounded-full">
							<span className="text-[#00d4aa] font-bold">100x faster</span>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
};

// ============================================================================
// HOW IT WORKS - 5-step pipeline with AI Enrichment (Multi-model winner)
// ============================================================================

const HowItWorksSection: React.FC = () => {
	const [currentStep, setCurrentStep] = useState(0);

	React.useEffect(() => {
		const timer = setInterval(() => {
			setCurrentStep((prev) => (prev + 1) % 5);
		}, 4000);
		return () => clearInterval(timer);
	}, []);

	const steps = [
		{
			id: 1,
			icon: "🌳",
			title: "AST Parsing",
			subtitle: "Deep Code Understanding",
			description:
				"Tree-sitter parses your entire codebase into Abstract Syntax Trees, extracting every function, class, type, and module relationship.",
			tech: "tree-sitter",
			stat: "28+ languages",
			gradient: "from-emerald-500/20 to-teal-500/20",
		},
		{
			id: 2,
			icon: "🕸️",
			title: "Symbol Graph",
			subtitle: "Architectural Intelligence",
			description:
				"Builds a complete graph of definitions, references, and call hierarchies. PageRank algorithm scores each symbol by architectural importance.",
			tech: "PageRank",
			stat: "Importance scoring",
			gradient: "from-blue-500/20 to-cyan-500/20",
		},
		{
			id: 3,
			icon: "✨",
			title: "AI Enrichment",
			subtitle: "Semantic Understanding",
			description:
				"LLMs generate natural language summaries for symbols and files. Self-learning adapts to your team's patterns and terminology over time.",
			tech: "LLM summaries",
			stat: "Self-learning",
			gradient: "from-purple-500/20 to-pink-500/20",
		},
		{
			id: 4,
			icon: "🧠",
			title: "Vector Embeddings",
			subtitle: "Semantic Search",
			description:
				'Creates dense vector embeddings for every code unit. Search by meaning, not just keywords—"auth flow" finds authentication logic.',
			tech: "LanceDB",
			stat: "100% local",
			gradient: "from-violet-500/20 to-purple-500/20",
		},
		{
			id: 5,
			icon: "⚡",
			title: "Hybrid Retrieval",
			subtitle: "Instant Context",
			description:
				"Combines vector similarity, BM25 keyword matching, and PageRank importance. Returns the most relevant code in under 200ms.",
			tech: "Hybrid search",
			stat: "200ms retrieval",
			gradient: "from-amber-500/20 to-orange-500/20",
		},
	];

	return (
		<section className="relative py-28 px-6 bg-[#080808] overflow-hidden border-t border-white/5">
			{/* Animated background grid */}
			<div className="absolute inset-0 bg-[linear-gradient(rgba(0,212,170,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(0,212,170,0.03)_1px,transparent_1px)] bg-[size:60px_60px]" />

			<div className="max-w-7xl mx-auto relative z-10">
				{/* Section Header */}
				<div className="text-center mb-20">
					<div className="inline-flex items-center gap-2 px-4 py-2 bg-[#00d4aa]/10 border border-[#00d4aa]/20 rounded-full mb-6">
						<span className="w-2 h-2 bg-[#00d4aa] rounded-full animate-pulse" />
						<span className="text-sm font-mono text-[#00d4aa]">
							Pre-indexed Intelligence
						</span>
					</div>

					<h2 className="text-4xl md:text-6xl font-black text-white mb-6 tracking-tight">
						How claudemem{" "}
						<span className="text-transparent bg-clip-text bg-gradient-to-r from-[#00d4aa] to-cyan-400">
							Works
						</span>
					</h2>

					<p className="text-xl text-gray-400 max-w-3xl mx-auto leading-relaxed">
						One-time indexing builds a complete knowledge graph of your
						codebase. Every query after that takes{" "}
						<span className="text-[#00d4aa] font-bold">200ms</span>—not 10-30
						seconds like real-time RAG.
					</p>
				</div>

				{/* Interactive Pipeline Visualization */}
				<div className="relative mb-20">
					{/* Desktop: Horizontal Pipeline */}
					<div className="hidden lg:block">
						{/* Steps Row with Connection Line */}
						<div className="relative">
							{/* Connection Line - elegant thin line with glow */}
							<div className="absolute top-8 left-[10%] right-[10%] z-0">
								{/* Background track - dashed for inactive area */}
								<div className="absolute inset-0 h-[2px] top-1/2 -translate-y-1/2">
									<div
										className="h-full w-full"
										style={{
											background: 'repeating-linear-gradient(90deg, #374151 0px, #374151 8px, transparent 8px, transparent 16px)'
										}}
									/>
								</div>
								{/* Active progress line with glow */}
								<div className="absolute inset-y-0 left-0 h-[2px] top-1/2 -translate-y-1/2 overflow-visible">
									<div
										className="h-full bg-gradient-to-r from-[#00d4aa] via-[#00d4aa] to-cyan-400 transition-all duration-1000 ease-out"
										style={{
											width: `${currentStep * 25}%`,
											boxShadow: '0 0 12px rgba(0,212,170,0.6), 0 0 24px rgba(0,212,170,0.3)'
										}}
									/>
								</div>
								{/* Animated traveling dot at current step */}
								<div
									className="absolute top-1/2 w-3 h-3 bg-white rounded-full transition-all duration-1000 ease-out"
									style={{
										left: `${currentStep * 25}%`,
										transform: 'translate(-50%, -50%)',
										boxShadow: '0 0 12px rgba(255,255,255,0.8), 0 0 24px rgba(0,212,170,0.6)'
									}}
								/>
							</div>

							{/* Steps */}
							<div className="flex justify-between items-start relative z-10">
								{steps.map((step, index) => (
									<div
										key={step.id}
										className={`flex flex-col items-center w-[18%] transition-all duration-500 ${
											index <= currentStep ? "opacity-100" : "opacity-40"
										}`}
									>
										{/* Step Circle */}
										<div
											className={`w-16 h-16 rounded-full flex items-center justify-center text-3xl transition-all duration-500 ${
												index === currentStep
													? "bg-[#00d4aa] scale-125 shadow-[0_0_40px_rgba(0,212,170,0.5)]"
													: index < currentStep
														? "bg-[#00d4aa]/30 border-2 border-[#00d4aa]"
														: "bg-gray-800 border-2 border-gray-700"
											}`}
										>
											{step.icon}
										</div>

										{/* Step Label */}
										<div className="text-xs font-mono text-[#00d4aa]/60 mt-4 mb-2">
											STEP {step.id}
										</div>

										{/* Step Content */}
										<div className="text-center">
											<h3 className="text-lg font-bold text-white mb-1">
												{step.title}
											</h3>
											<p className="text-xs text-gray-500 mb-3">{step.subtitle}</p>

											{/* Expanded info on current step */}
											<div
												className={`transition-all duration-500 overflow-hidden ${
													index === currentStep
														? "max-h-40 opacity-100"
														: "max-h-0 opacity-0"
												}`}
											>
												<p className="text-sm text-gray-400 mb-3 leading-relaxed">
													{step.description}
												</p>
												<div className="flex gap-2 justify-center flex-wrap">
													<span className="px-2 py-1 bg-gray-800 rounded text-[10px] font-mono text-gray-400">
														{step.tech}
													</span>
													<span className="px-2 py-1 bg-[#00d4aa]/10 rounded text-[10px] font-mono text-[#00d4aa]">
														{step.stat}
													</span>
												</div>
											</div>
										</div>
									</div>
								))}
							</div>
						</div>
					</div>

					{/* Mobile: Vertical Pipeline */}
					<div className="lg:hidden space-y-6">
						{steps.map((step, index) => (
							<div
								key={step.id}
								className={`flex gap-4 items-start p-4 rounded-xl border transition-all duration-300 cursor-pointer ${
									index === currentStep
										? `bg-gradient-to-r ${step.gradient} border-[#00d4aa]/50`
										: "bg-gray-900/30 border-gray-800"
								}`}
								onClick={() => setCurrentStep(index)}
								onKeyDown={(e) => e.key === "Enter" && setCurrentStep(index)}
								role="button"
								tabIndex={0}
							>
								<div
									className={`w-12 h-12 rounded-full flex items-center justify-center text-2xl flex-shrink-0 ${
										index === currentStep ? "bg-[#00d4aa]" : "bg-gray-800"
									}`}
								>
									{step.icon}
								</div>
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2 mb-1">
										<span className="text-[10px] font-mono text-[#00d4aa]/60">
											STEP {step.id}
										</span>
										<span className="text-xs text-gray-500">•</span>
										<span className="text-[10px] font-mono text-[#00d4aa]">
											{step.stat}
										</span>
									</div>
									<h3 className="text-white font-bold mb-1">{step.title}</h3>
									<p className="text-sm text-gray-400 leading-relaxed">
										{step.description}
									</p>
								</div>
							</div>
						))}
					</div>
				</div>

				{/* Why This Matters */}
				<div className="relative">
					<div className="absolute inset-0 bg-gradient-to-r from-[#00d4aa]/10 via-transparent to-cyan-500/10 rounded-3xl" />

					<div className="relative bg-[#0a0a0a]/80 backdrop-blur-sm border border-[#00d4aa]/20 rounded-3xl p-8 md:p-12">
						<div className="flex flex-col md:flex-row gap-8 items-start">
							<div className="flex-shrink-0">
								<div className="w-20 h-20 bg-gradient-to-br from-[#00d4aa] to-cyan-500 rounded-2xl flex items-center justify-center text-4xl shadow-[0_0_40px_rgba(0,212,170,0.3)]">
									💡
								</div>
							</div>

							<div className="flex-1">
								<h3 className="text-3xl font-black text-white mb-4">
									Why Pre-Indexing{" "}
									<span className="text-[#00d4aa]">Changes Everything</span>
								</h3>

								<p className="text-gray-400 text-lg mb-8 leading-relaxed">
									Traditional RAG systems re-analyze your code on{" "}
									<em>every single query</em>. claudemem builds understanding
									once—then your AI assistant has instant, PageRank-ranked
									context every time it needs it.
								</p>

								{/* Comparison Grid */}
								<div className="grid grid-cols-1 md:grid-cols-3 gap-6">
									<div className="bg-[#080808] border border-gray-800 rounded-xl p-6 text-center">
										<div className="text-4xl font-black text-[#00d4aa] mb-2">
											200ms
										</div>
										<div className="text-sm text-gray-400 mb-1">
											vs 10-30 seconds
										</div>
										<div className="text-xs text-gray-600">Context retrieval</div>
									</div>

									<div className="bg-[#080808] border border-gray-800 rounded-xl p-6 text-center">
										<div className="text-4xl font-black text-[#00d4aa] mb-2">
											100%
										</div>
										<div className="text-sm text-gray-400 mb-1">
											Local & Private
										</div>
										<div className="text-xs text-gray-600">
											Code never uploaded
										</div>
									</div>

									<div className="bg-[#080808] border border-gray-800 rounded-xl p-6 text-center">
										<div className="text-4xl font-black text-[#00d4aa] mb-2">
											28+
										</div>
										<div className="text-sm text-gray-400 mb-1">Languages</div>
										<div className="text-xs text-gray-600">Full AST parsing</div>
									</div>
								</div>

								{/* Self-Learning Callout */}
								<div className="mt-8 p-4 bg-purple-500/10 border border-purple-500/20 rounded-xl">
									<div className="flex items-start gap-3">
										<span className="text-2xl">✨</span>
										<div>
											<h4 className="font-bold text-white mb-1">
												Self-Learning Intelligence
											</h4>
											<p className="text-sm text-gray-400">
												claudemem learns from your corrections and adapts to
												your team's patterns. The more you use it, the smarter
												your AI context becomes.
											</p>
										</div>
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>

				{/* Technical Footer */}
				<div className="text-center mt-12">
					<p className="text-gray-600 text-sm font-mono">
						Built with tree-sitter • LanceDB • PageRank • No cloud dependencies
					</p>
				</div>
			</div>
		</section>
	);
};

// ============================================================================
// DIFFERENTIATORS - What makes claudemem unique
// ============================================================================

const DifferentiatorsSection: React.FC = () => {
	const features = [
		{
			icon: "⭐",
			title: "PageRank for Code",
			description:
				"Like Google ranks web pages, we rank code by architectural importance. Your AI gets critical code first, not random utilities.",
			highlight: "Unique",
		},
		{
			icon: "🔍",
			title: "Hybrid Search",
			description:
				"Combines vector similarity (find concepts) + BM25 keywords (find exact matches) + PageRank (prioritize important code).",
			highlight: "Best-in-class",
		},
		{
			icon: "🔒",
			title: "100% Local",
			description:
				"Everything runs on your machine. LanceDB stores vectors locally. No cloud uploads, no vendor lock-in, no privacy concerns.",
			highlight: "Privacy-first",
		},
		{
			icon: "🤖",
			title: "Model Freedom",
			description:
				"Works with any LLM provider: OpenRouter, Ollama, Anthropic. Switch models without re-indexing. Benchmark to find your best fit.",
			highlight: "Flexible",
		},
	];

	return (
		<section className="py-24 px-6 bg-[#0a0a0a]">
			<div className="max-w-6xl mx-auto">
				{/* Section Header */}
				<div className="text-center mb-16">
					<h2 className="text-3xl md:text-5xl font-black text-white mb-4">
						Why claudemem?
					</h2>
					<p className="text-gray-500 text-lg max-w-2xl mx-auto">
						Built different from traditional RAG systems
					</p>
				</div>

				{/* Feature Grid */}
				<div className="grid md:grid-cols-2 gap-6">
					{features.map((feature, i) => (
						<div
							key={i}
							className="bg-[#0c0c0c] border border-white/5 rounded-2xl p-6 hover:border-[#00d4aa]/20 transition-colors group"
						>
							<div className="flex items-start gap-4">
								<div className="text-3xl">{feature.icon}</div>
								<div className="flex-1">
									<div className="flex items-center gap-2 mb-2">
										<h3 className="text-lg font-bold text-white">
											{feature.title}
										</h3>
										<span className="text-[10px] bg-[#00d4aa]/10 text-[#00d4aa] px-2 py-0.5 rounded-full font-bold uppercase">
											{feature.highlight}
										</span>
									</div>
									<p className="text-gray-400 text-sm leading-relaxed">
										{feature.description}
									</p>
								</div>
							</div>
						</div>
					))}
				</div>
			</div>
		</section>
	);
};

// ============================================================================
// QUICK START - Get started in 3 steps
// ============================================================================

const QuickStartSection: React.FC = () => {
	const commands = [
		{
			step: 1,
			label: "Install",
			command: "bun install -g claude-codemem",
			description: "Install the CLI globally",
		},
		{
			step: 2,
			label: "Index",
			command: "claudemem index",
			description: "Index your codebase (~15 seconds)",
		},
		{
			step: 3,
			label: "Search",
			command: 'claudemem search "auth logic"',
			description: "Get instant semantic results",
		},
	];

	return (
		<section className="py-24 px-6 bg-[#080808] border-t border-white/5">
			<div className="max-w-4xl mx-auto">
				{/* Section Header */}
				<div className="text-center mb-12">
					<h2 className="text-3xl md:text-5xl font-black text-white mb-4">
						Get Started in{" "}
						<span className="text-[#00d4aa]">60 Seconds</span>
					</h2>
					<p className="text-gray-500 text-lg">
						Three commands. That's all it takes.
					</p>
				</div>

				{/* Commands */}
				<div className="space-y-4 mb-12">
					{commands.map((cmd) => (
						<div
							key={cmd.step}
							className="bg-[#0c0c0c] border border-white/10 rounded-xl p-4 flex items-center gap-4"
						>
							<div className="w-10 h-10 bg-[#00d4aa] rounded-full flex items-center justify-center text-black font-bold shrink-0">
								{cmd.step}
							</div>
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-3 mb-1">
									<span className="text-white font-bold">{cmd.label}</span>
									<span className="text-gray-600 text-sm">
										{cmd.description}
									</span>
								</div>
								<code className="text-[#00d4aa] font-mono text-sm">
									$ {cmd.command}
								</code>
							</div>
						</div>
					))}
				</div>

				{/* CTA */}
				<div className="text-center">
					<a
						href="https://github.com/MadAppGang/claudemem#readme"
						target="_blank"
						rel="noreferrer"
						className="inline-flex items-center gap-2 bg-[#00d4aa] text-black font-bold px-8 py-4 rounded-lg hover:bg-[#00d4aa]/90 transition-colors text-lg"
					>
						Read the Docs
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
								d="M14 5l7 7m0 0l-7 7m7-7H3"
							/>
						</svg>
					</a>
				</div>
			</div>
		</section>
	);
};

// ============================================================================
// FOOTER - Links and credits
// ============================================================================

const FooterSection: React.FC = () => {
	return (
		<footer className="py-16 px-6 bg-[#050505] border-t border-white/5">
			<div className="max-w-6xl mx-auto">
				{/* Main Footer */}
				<div className="flex flex-col md:flex-row justify-between items-start gap-12 mb-12">
					{/* Brand */}
					<div className="space-y-4">
						<div className="text-white font-black text-2xl flex items-center gap-2">
							<div className="w-8 h-8 bg-[#00d4aa] rounded flex items-center justify-center text-black text-sm font-bold">
								M
							</div>
							claudemem
						</div>
						<p className="text-gray-500 text-sm max-w-xs">
							Local-first semantic code intelligence for AI agents. Open source,
							privacy-first, MIT licensed.
						</p>
					</div>

					{/* Links */}
					<div className="flex gap-16">
						<div>
							<h4 className="text-white font-bold mb-4 text-sm uppercase tracking-wider">
								Product
							</h4>
							<ul className="space-y-2 text-sm text-gray-500">
								<li>
									<a
										href="#"
										className="hover:text-[#00d4aa] transition-colors"
									>
										Documentation
									</a>
								</li>
								<li>
									<a
										href="#"
										className="hover:text-[#00d4aa] transition-colors"
									>
										CLI Reference
									</a>
								</li>
								<li>
									<a
										href="#"
										className="hover:text-[#00d4aa] transition-colors"
									>
										Benchmarks
									</a>
								</li>
							</ul>
						</div>
						<div>
							<h4 className="text-white font-bold mb-4 text-sm uppercase tracking-wider">
								Community
							</h4>
							<ul className="space-y-2 text-sm text-gray-500">
								<li>
									<a
										href="https://github.com/MadAppGang/claudemem"
										className="hover:text-[#00d4aa] transition-colors"
									>
										GitHub
									</a>
								</li>
								<li>
									<a
										href="#"
										className="hover:text-[#00d4aa] transition-colors"
									>
										Contributing
									</a>
								</li>
								<li>
									<a
										href="#"
										className="hover:text-[#00d4aa] transition-colors"
									>
										Issues
									</a>
								</li>
							</ul>
						</div>
					</div>
				</div>

				{/* Disclaimer - Moved here from hero */}
				<div className="bg-[#0a0a0a] border border-white/5 rounded-lg p-4 mb-8">
					<p className="text-gray-500 text-sm text-center">
						<span className="text-yellow-500">Note:</span> Not to be confused
						with{" "}
						<a
							href="https://github.com/thedotmack/claude-mem"
							target="_blank"
							rel="noreferrer"
							className="text-white hover:text-[#00d4aa] underline"
						>
							claude-mem
						</a>{" "}
						— a session memory plugin. We do semantic code search.
					</p>
				</div>

				{/* Bottom Bar */}
				<div className="flex flex-col md:flex-row justify-between items-center gap-4 pt-8 border-t border-white/5">
					<p className="text-gray-600 text-xs">
						© 2025 MadAppGang. MIT License.
					</p>
					<p className="text-gray-700 text-xs">
						Built on research from JP Morgan Meta-RAG & Aider
					</p>
				</div>
			</div>
		</footer>
	);
};

export default LandingPage;
