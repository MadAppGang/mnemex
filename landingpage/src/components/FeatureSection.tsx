import React, { useState, useEffect, useRef } from "react";
import { RESEARCH_LEVELS, COMPARISON_MATRIX } from "../constants";
import { TerminalWindow } from "./TerminalWindow";
import { PipelineVisualizer } from "./PipelineVisualizer";
import { ArchitectureDiagram } from "./ArchitectureDiagram";

const FeatureSection: React.FC = () => {
	return (
		<div className="bg-[#050505] relative font-sans">
			<ProblemStorySection />
			<ProblemSynthesisSection />
			<GranularitySection />
			<ArchitectureDiagram />
			<PipelineVisualizer />
			<FeatureDeepDive />
			<ContextWinSection />
			<ComparisonSection />
			<ResearchFooter />
		</div>
	);
};

// --- VISUALS FOR PROBLEM STORY ---

const AmnesiaVisual: React.FC = () => (
	<div className="w-full h-full flex flex-col items-center justify-center p-8 bg-[#151515] border border-white/5 rounded-xl relative overflow-hidden">
		<div className="absolute inset-0 bg-gradient-to-b from-transparent to-[#050505]/80 z-10"></div>
		<div className="space-y-4 w-full max-w-[200px] z-0 opacity-50 blur-[1px]">
			<div className="h-2 w-full bg-gray-700 rounded animate-pulse"></div>
			<div className="h-2 w-3/4 bg-gray-700 rounded animate-pulse delay-75"></div>
			<div className="h-2 w-5/6 bg-gray-700 rounded animate-pulse delay-150"></div>
		</div>
		<div className="absolute z-20 flex flex-col items-center">
			<div className="text-6xl mb-4 animate-bounce">🧠</div>
			<div className="bg-red-500/10 border border-red-500/50 text-red-500 px-4 py-2 rounded-lg font-mono text-sm font-bold uppercase tracking-widest shadow-[0_0_20px_rgba(239,68,68,0.3)]">
				Memory Wiped
			</div>
			<div className="text-gray-500 text-xs font-mono mt-4 text-center">
				Session terminated.
				<br />
				Context lost.
			</div>
		</div>
	</div>
);

const ContextTaxVisual: React.FC = () => (
	<div className="w-full h-full flex flex-col items-center justify-center p-8 bg-[#151515] border border-white/5 rounded-xl relative overflow-hidden">
		{/* Token Stream Animation */}
		<div className="absolute inset-0 flex items-end justify-center gap-1 opacity-30">
			{[...Array(10)].map((_, i) => (
				<div
					key={i}
					className="w-2 bg-yellow-500/50 rounded-t-sm animate-flow-up"
					style={{
						height: `${Math.random() * 100}%`,
						animationDuration: `${1 + Math.random()}s`,
					}}
				></div>
			))}
		</div>

		<div className="relative z-20 bg-[#0c0c0c] p-6 rounded-2xl border border-white/10 shadow-2xl text-center">
			<div className="text-gray-400 text-xs font-mono uppercase mb-2">
				Cost per session
			</div>
			<div className="text-4xl font-black text-white mb-1 flex items-center justify-center gap-1">
				<span className="text-red-500">↑</span> $4.20
			</div>
			<div className="text-[10px] text-red-400 font-mono bg-red-500/10 px-2 py-1 rounded inline-block">
				+60% REDUNDANT TOKENS
			</div>
		</div>
	</div>
);

const CodeRotVisual: React.FC = () => (
	<div className="w-full h-full flex flex-col items-center justify-center p-8 bg-[#151515] border border-white/5 rounded-xl relative overflow-hidden">
		<div className="grid grid-cols-2 gap-4 w-full max-w-sm">
			<div className="bg-[#0c0c0c] border border-gray-800 p-4 rounded-lg opacity-50">
				<div className="h-2 w-12 bg-blue-500/50 rounded mb-2"></div>
				<div className="space-y-1">
					<div className="h-1.5 w-full bg-gray-700 rounded"></div>
					<div className="h-1.5 w-2/3 bg-gray-700 rounded"></div>
				</div>
			</div>
			<div className="bg-[#0c0c0c] border border-red-900/50 p-4 rounded-lg relative overflow-hidden">
				<div className="absolute inset-0 bg-red-500/5 animate-pulse"></div>
				<div className="h-2 w-12 bg-red-500/50 rounded mb-2"></div>
				<div className="space-y-1">
					<div className="h-1.5 w-full bg-gray-700 rounded"></div>
					<div className="h-1.5 w-2/3 bg-gray-700 rounded"></div>
				</div>
				<div className="absolute bottom-2 right-2 text-[8px] text-red-500 font-bold uppercase border border-red-500 px-1 rounded">
					Duplicate
				</div>
			</div>
			<div className="bg-[#0c0c0c] border border-red-900/50 p-4 rounded-lg relative overflow-hidden col-span-2">
				<div
					className="absolute inset-0 bg-red-500/5 animate-pulse"
					style={{ animationDelay: "0.5s" }}
				></div>
				<div className="h-2 w-24 bg-red-500/50 rounded mb-2"></div>
				<div className="space-y-1">
					<div className="h-1.5 w-full bg-gray-700 rounded"></div>
					<div className="h-1.5 w-full bg-gray-700 rounded"></div>
					<div className="h-1.5 w-1/2 bg-gray-700 rounded"></div>
				</div>
			</div>
		</div>
	</div>
);

// --- 1. PROBLEM STORYTELLING (Sticky Scroll) ---

const ProblemStorySection: React.FC = () => {
	const [activeStep, setActiveStep] = useState(0);
	const step1Ref = useRef<HTMLDivElement>(null);
	const step2Ref = useRef<HTMLDivElement>(null);
	const step3Ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const observer = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting) {
						if (entry.target === step1Ref.current) setActiveStep(0);
						if (entry.target === step2Ref.current) setActiveStep(1);
						if (entry.target === step3Ref.current) setActiveStep(2);
					}
				});
			},
			{ threshold: 0.6, rootMargin: "-20% 0px -20% 0px" },
		);

		if (step1Ref.current) observer.observe(step1Ref.current);
		if (step2Ref.current) observer.observe(step2Ref.current);
		if (step3Ref.current) observer.observe(step3Ref.current);

		return () => observer.disconnect();
	}, []);

	return (
		<section className="relative pt-32 pb-32 max-w-7xl mx-auto px-6">
			<div className="text-center mb-32">
				<h2 className="text-5xl md:text-7xl font-black text-white tracking-tighter leading-[0.95] mb-8">
					Why Your AI <br />
					<span className="text-[#ff5f56]">Keeps Failing.</span>
				</h2>
				<p className="text-xl text-gray-500 font-medium">
					The hidden costs of stateless coding assistants.
				</p>
			</div>

			<div className="flex flex-col lg:flex-row gap-12 lg:gap-24">
				{/* Left: Text Content (Scrolls) */}
				<div className="lg:w-1/2 space-y-[40vh] py-[10vh]">
					{/* Step 1 */}
					<div
						ref={step1Ref}
						className={`transition-opacity duration-500 ${activeStep === 0 ? "opacity-100" : "opacity-30 blur-sm"}`}
					>
						<div className="inline-block mb-4 px-3 py-1 rounded-full bg-[#ff5f56]/10 border border-[#ff5f56]/20 text-[#ff5f56] font-mono text-xs font-bold uppercase tracking-widest">
							Problem 01
						</div>
						<h3 className="text-4xl font-bold text-white mb-6">
							The Amnesia Loop
						</h3>
						<p className="text-xl text-gray-400 leading-relaxed">
							AI assistants are stateless. Close the tab, and they forget your
							architecture. Every new session triggers a slow, repetitive
							"discovery" phase where it reads the same files it read yesterday.
						</p>
					</div>

					{/* Step 2 */}
					<div
						ref={step2Ref}
						className={`transition-opacity duration-500 ${activeStep === 1 ? "opacity-100" : "opacity-30 blur-sm"}`}
					>
						<div className="inline-block mb-4 px-3 py-1 rounded-full bg-[#d97757]/10 border border-[#d97757]/20 text-[#d97757] font-mono text-xs font-bold uppercase tracking-widest">
							Problem 02
						</div>
						<h3 className="text-4xl font-bold text-white mb-6">
							The Context Tax
						</h3>
						<p className="text-xl text-gray-400 leading-relaxed">
							You pay for this amnesia. Watch your logs: 60% of your tokens are
							burned just re-feeding context. You are paying double for half the
							actual coding work.
						</p>
					</div>

					{/* Step 3 */}
					<div
						ref={step3Ref}
						className={`transition-opacity duration-500 ${activeStep === 2 ? "opacity-100" : "opacity-30 blur-sm"}`}
					>
						<div className="inline-block mb-4 px-3 py-1 rounded-full bg-[#c084fc]/10 border border-[#c084fc]/20 text-[#c084fc] font-mono text-xs font-bold uppercase tracking-widest">
							Problem 03
						</div>
						<h3 className="text-4xl font-bold text-white mb-6">The Code Rot</h3>
						<p className="text-xl text-gray-400 leading-relaxed">
							Because it doesn't "know" your codebase, it guesses. It implements
							a utility that already exists in{" "}
							<code className="bg-gray-800 px-1 rounded text-gray-300">
								/lib
							</code>
							. Now you have duplicates, drift, and technical debt.
						</p>
					</div>
				</div>

				{/* Right: Visuals (Sticky) */}
				<div className="lg:w-1/2 relative hidden lg:block">
					<div className="sticky top-1/3 h-[500px] w-full bg-[#0c0c0c] border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
						{/* Visual 1: Amnesia Loop */}
						<div
							className={`absolute inset-0 transition-opacity duration-700 p-8 flex flex-col items-center justify-center ${activeStep === 0 ? "opacity-100 z-10" : "opacity-0 z-0"}`}
						>
							<AmnesiaVisual />
						</div>

						{/* Visual 2: Context Tax */}
						<div
							className={`absolute inset-0 transition-opacity duration-700 p-8 flex flex-col items-center justify-center ${activeStep === 1 ? "opacity-100 z-10" : "opacity-0 z-0"}`}
						>
							<ContextTaxVisual />
						</div>

						{/* Visual 3: Code Rot */}
						<div
							className={`absolute inset-0 transition-opacity duration-700 p-8 flex flex-col items-center justify-center ${activeStep === 2 ? "opacity-100 z-10" : "opacity-0 z-0"}`}
						>
							<CodeRotVisual />
						</div>
					</div>
				</div>
			</div>
		</section>
	);
};

// --- 2. PROBLEM SYNTHESIS (INTERACTIVE DASHBOARD) ---

const ProblemSynthesisSection = () => {
	const [activeFeature, setActiveFeature] = useState(0);
	const [autoPlay, setAutoPlay] = useState(true);

	const features = [
		{
			id: "critical",
			title: "Critical Paths",
			desc: "Identify production-critical flows.",
			icon: <BoltIcon />,
			color: "#f59e0b",
		},
		{
			id: "dead",
			title: "Dead Code",
			desc: "Prune unused legacy functions.",
			icon: <SkullIcon />,
			color: "#9ca3af",
		},
		{
			id: "connections",
			title: "Symbol Graph",
			desc: "Map dependencies across files.",
			icon: <LinkIcon />,
			color: "#38bdf8",
		},
		{
			id: "patterns",
			title: "Team Patterns",
			desc: "Enforce idiomatic styles.",
			icon: <BrainIcon />,
			color: "#f472b6",
		},
		{
			id: "intent",
			title: "True Intent",
			desc: "Understand purpose, not just syntax.",
			icon: <TargetIcon />,
			color: "#ef4444",
		},
		{
			id: "duplication",
			title: "Deduplication",
			desc: "Find copy-pasted logic.",
			icon: <DnaIcon />,
			color: "#8b5cf6",
		},
	];

	useEffect(() => {
		if (!autoPlay) return;
		const interval = setInterval(() => {
			setActiveFeature((prev) => (prev + 1) % features.length);
		}, 4000);
		return () => clearInterval(interval);
	}, [autoPlay, features.length]);

	const handleFeatureClick = (index: number) => {
		setActiveFeature(index);
		setAutoPlay(false);
	};

	return (
		<section className="py-32 bg-[#050505] border-t border-white/5 relative overflow-hidden">
			<div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-claude-ish/5 blur-[120px] pointer-events-none"></div>

			<div className="max-w-7xl mx-auto px-6 relative z-10">
				<div className="mb-24 text-center">
					<h3 className="text-4xl md:text-6xl font-black text-white mb-6 tracking-tight leading-tight">
						Imagine if the AI{" "}
						<span className="text-[#00D4AA]">already knew</span>:
					</h3>
					<p className="text-gray-500 font-mono text-lg">
						Claudemem pre-indexes your codebase so your agent doesn't have to
						guess.
					</p>
				</div>

				<div className="grid lg:grid-cols-12 gap-8 lg:gap-16 items-start">
					{/* Left Column: Feature List */}
					<div className="lg:col-span-5 flex flex-col gap-2">
						{features.map((feature, idx) => (
							<button
								key={idx}
								onClick={() => handleFeatureClick(idx)}
								className={`
                                    group flex items-center gap-4 p-5 rounded-2xl text-left transition-all duration-300
                                    ${
																			activeFeature === idx
																				? "bg-white/10 border border-white/10 shadow-2xl scale-[1.02]"
																				: "hover:bg-white/5 border border-transparent opacity-60 hover:opacity-100"
																		}
                                `}
							>
								<div
									className={`
                                        w-12 h-12 rounded-xl flex items-center justify-center transition-colors duration-300
                                        ${activeFeature === idx ? "bg-[#0f0f0f] text-white" : "bg-[#1a1a1a] text-gray-500"}
                                    `}
									style={{
										color: activeFeature === idx ? feature.color : undefined,
									}}
								>
									{feature.icon}
								</div>
								<div>
									<h4
										className={`text-lg font-bold transition-colors ${activeFeature === idx ? "text-white" : "text-gray-400"}`}
									>
										{feature.title}
									</h4>
									<p className="text-sm text-gray-500 font-mono mt-0.5">
										{feature.desc}
									</p>
								</div>
								{activeFeature === idx && (
									<div className="ml-auto w-1.5 h-1.5 rounded-full bg-white animate-pulse"></div>
								)}
							</button>
						))}
					</div>

					{/* Right Column: Dynamic Visualizer */}
					<div className="lg:col-span-7">
						<div className="bg-[#0c0c0c] border border-white/10 rounded-3xl h-[500px] md:h-[600px] relative overflow-hidden shadow-2xl flex flex-col">
							{/* Window Header */}
							<div className="h-12 border-b border-white/5 flex items-center px-6 justify-between shrink-0 bg-[#0f0f0f]">
								<div className="flex gap-2">
									<div className="w-3 h-3 rounded-full bg-red-500/20 border border-red-500/50"></div>
									<div className="w-3 h-3 rounded-full bg-yellow-500/20 border border-yellow-500/50"></div>
									<div className="w-3 h-3 rounded-full bg-green-500/20 border border-green-500/50"></div>
								</div>
								<div className="font-mono text-[10px] text-gray-600 uppercase tracking-widest">
									SEMANTIC_INDEX_VIEWER
								</div>
								<div className="w-10"></div>
							</div>

							{/* Visualization Stage */}
							<div className="flex-1 relative overflow-hidden p-8 flex items-center justify-center">
								{/* Grid Background */}
								<div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none"></div>

								{/* Active Visual Render */}
								<div className="relative w-full h-full max-w-lg mx-auto flex items-center justify-center">
									{activeFeature === 0 && <VisualCriticalPath />}
									{activeFeature === 1 && <VisualDeadCode />}
									{activeFeature === 2 && <VisualConnections />}
									{activeFeature === 3 && <VisualPatterns />}
									{activeFeature === 4 && <VisualIntent />}
									{activeFeature === 5 && <VisualDuplication />}
								</div>
							</div>

							{/* Footer Status */}
							<div className="h-10 border-t border-white/5 bg-[#0f0f0f] px-6 flex items-center justify-between text-[10px] font-mono text-gray-500">
								<div>
									status: <span className="text-claude-ish">online</span>
								</div>
								<div>
									mode:{" "}
									<span className="text-white">
										{features[activeFeature].id.toUpperCase()}_ANALYSIS
									</span>
								</div>
							</div>
						</div>
					</div>
				</div>

				<div className="mt-24 text-center flex justify-center">
					<div className="inline-flex items-center gap-3 bg-[#0a0a0a] px-6 py-3 rounded-full border border-white/10 shadow-2xl hover:border-claude-ish/50 transition-colors cursor-default">
						<span className="text-gray-500 font-mono text-sm tracking-wide">
							Not re-learning it.
						</span>
						<span className="text-gray-700 mx-1">•</span>
						<span className="text-white font-bold font-mono text-sm tracking-wide">
							Knowing it instantly.
						</span>
					</div>
				</div>
			</div>
		</section>
	);
};

// --- 3. SOLUTION SECTION (FORMERLY GRANULARITY) ---

const GranularitySection = () => {
	const [activeLevel, setActiveLevel] = useState(0);
	const [isHovering, setIsHovering] = useState(false);

	useEffect(() => {
		if (isHovering) return;
		const interval = setInterval(() => {
			setActiveLevel((prev) => (prev + 1) % 3);
		}, 5000);
		return () => clearInterval(interval);
	}, [isHovering]);

	return (
		<section className="py-40 bg-[#080808] border-y border-white/5 relative overflow-hidden">
			{/* Background Ambience */}
			<div className="absolute inset-0 opacity-10 pointer-events-none bg-[radial-gradient(circle_at_center,#00D4AA_0%,transparent_70%)]"></div>

			<div className="max-w-7xl mx-auto px-6 relative z-10">
				{/* Headline */}
				<div className="text-center mb-24 space-y-6">
					<div className="inline-block px-4 py-1.5 bg-claude-ish/10 border border-claude-ish/20 text-claude-ish font-mono text-[11px] font-black uppercase tracking-[0.2em] rounded-full mb-4">
						The Solution
					</div>
					<h2 className="text-4xl md:text-7xl font-extrabold text-white leading-tight">
						Persistent Understanding.
						<br />
						Instant Context.
						<br />
						<span className="text-gray-600">Zero Rediscovery.</span>
					</h2>
					<p className="text-lg md:text-xl text-gray-400 font-mono max-w-3xl mx-auto leading-relaxed">
						claudemem indexes your codebase once. Understands it deeply. Serves
						that understanding to AI agents instantly — session after session.
					</p>

					{/* Enhanced Link */}
					<div className="pt-8 flex justify-center">
						<a
							href="https://arxiv.org/abs/2410.17435"
							target="_blank"
							rel="noreferrer"
							className="group flex items-center gap-4 bg-[#0a0a0a] border border-white/10 px-8 py-4 rounded-full hover:border-claude-ish/50 hover:bg-claude-ish/5 transition-all shadow-lg hover:shadow-claude-ish/10"
						>
							<div className="w-10 h-10 bg-claude-ish/10 rounded-full flex items-center justify-center text-claude-ish group-hover:scale-110 transition-transform">
								<svg
									className="w-5 h-5"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth="2"
										d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
									/>
								</svg>
							</div>
							<div className="flex flex-col text-left">
								<span className="text-[10px] text-gray-500 uppercase tracking-widest font-bold group-hover:text-claude-ish transition-colors">
									Research Backed
								</span>
								<span className="text-sm font-mono text-gray-300 group-hover:text-white">
									Based on{" "}
									<span className="underline decoration-claude-ish/50 underline-offset-4 decoration-2">
										JP Morgan's 2025 Meta-RAG Study
									</span>
								</span>
							</div>
							<div className="ml-2 w-8 h-8 rounded-full border border-white/10 flex items-center justify-center group-hover:border-claude-ish/30 group-hover:bg-white/5">
								<svg
									className="w-4 h-4 text-gray-500 group-hover:text-claude-ish transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth="2"
										d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
									/>
								</svg>
							</div>
						</a>
					</div>
				</div>

				{/* Split Visualizer */}
				<div className="grid lg:grid-cols-2 gap-16 items-center">
					{/* Left: Narrative Control */}
					<div
						className="space-y-4"
						onMouseEnter={() => setIsHovering(true)}
						onMouseLeave={() => setIsHovering(false)}
					>
						{RESEARCH_LEVELS.map((level, idx) => (
							<div
								key={idx}
								onClick={() => setActiveLevel(idx)}
								className={`
                                    cursor-pointer p-6 rounded-xl border transition-all duration-500 relative overflow-hidden group
                                    ${
																			activeLevel === idx
																				? "bg-[#121212] border-claude-ish/30 shadow-[0_0_30px_-10px_rgba(0,212,170,0.1)]"
																				: "bg-transparent border-transparent hover:bg-white/5 hover:border-white/5 opacity-60 hover:opacity-100"
																		}
                                `}
							>
								{/* Progress Bar for Active Item */}
								{activeLevel === idx && (
									<div className="absolute bottom-0 left-0 h-[2px] bg-claude-ish animate-[strikethrough_5s_linear_forwards] w-full origin-left"></div>
								)}

								<div className="flex items-center justify-between mb-2">
									<h3
										className={`text-xl font-bold font-mono ${activeLevel === idx ? "text-white" : "text-gray-400"}`}
									>
										{level.level}
									</h3>
									<div
										className={`text-xs font-black uppercase tracking-widest px-2 py-1 rounded ${activeLevel === idx ? "bg-claude-ish text-black" : "bg-gray-800 text-gray-500"}`}
									>
										Level 0{idx + 1}
									</div>
								</div>
								<div className="space-y-3">
									<div className="text-sm text-gray-300">
										<span className="text-gray-500 font-bold uppercase text-[10px] tracking-widest mr-2">
											Captures:
										</span>
										{level.capture}
									</div>
									<div
										className={`text-sm transition-colors ${activeLevel === idx ? "text-claude-ish" : "text-gray-500"}`}
									>
										<span className="text-gray-500 font-bold uppercase text-[10px] tracking-widest mr-2">
											Benefit:
										</span>
										{/* Auto-highlight percentages */}
										{level.benefit.split(/(~?\d+%)/).map((part, i) =>
											part.match(/~?\d+%/) ? (
												<span
													key={i}
													className="text-white bg-white/10 px-1.5 py-0.5 rounded font-black mx-1 inline-block border border-white/10"
												>
													{part}
												</span>
											) : (
												part
											),
										)}
									</div>
								</div>
							</div>
						))}
					</div>

					{/* Right: Holographic Scanner */}
					<div className="relative aspect-square md:aspect-video lg:aspect-square bg-[#0c0c0c] border border-white/10 rounded-2xl overflow-hidden shadow-2xl flex flex-col">
						<div className="absolute inset-0 bg-[linear-gradient(rgba(0,212,170,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(0,212,170,0.03)_1px,transparent_1px)] bg-[size:20px_20px]"></div>

						{/* Header */}
						<div className="h-12 border-b border-white/10 bg-[#0f0f0f] flex items-center justify-between px-6 z-10">
							<div className="flex gap-2 text-[10px] font-mono text-gray-500">
								<span>SCAN_TARGET: src/auth/AuthService.ts</span>
							</div>
							<div className="text-claude-ish text-[10px] font-bold animate-pulse">
								LIVE_INDEXING
							</div>
						</div>

						{/* Visual Stage */}
						<div className="flex-1 relative flex items-center justify-center p-8">
							{/* Shared Background Nodes */}
							<div className="absolute inset-0 opacity-20 pointer-events-none">
								{/* Abstract decorative nodes */}
								<svg className="w-full h-full">
									<circle cx="20%" cy="20%" r="2" fill="#fff" />
									<circle cx="80%" cy="80%" r="2" fill="#fff" />
									<line
										x1="20%"
										y1="20%"
										x2="80%"
										y2="80%"
										stroke="#fff"
										strokeWidth="0.5"
										strokeDasharray="4"
									/>
								</svg>
							</div>

							{/* Level 1: File Visual */}
							{activeLevel === 0 && (
								<div className="relative w-64 h-80 bg-[#151515] border border-gray-700 rounded-lg p-4 flex flex-col gap-4 animate-fadeIn shadow-2xl">
									{/* File Header */}
									<div className="flex items-center gap-3 border-b border-gray-700 pb-2">
										<div className="w-8 h-8 bg-blue-500/20 rounded flex items-center justify-center text-blue-400">
											<svg
												className="w-4 h-4"
												fill="none"
												viewBox="0 0 24 24"
												stroke="currentColor"
											>
												<path
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth="2"
													d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
												/>
											</svg>
										</div>
										<div className="font-mono text-xs">
											<div className="text-white">AuthService.ts</div>
											<div className="text-gray-500">2.4kb • TypeScript</div>
										</div>
									</div>

									{/* Imports / Exports */}
									<div className="space-y-2 font-mono text-[10px]">
										<div className="text-gray-500 uppercase tracking-widest">
											Imports
										</div>
										<div className="bg-gray-800/50 p-2 rounded text-blue-300">
											import {"{"} User {"}"} from './models';
										</div>
										<div className="bg-gray-800/50 p-2 rounded text-blue-300">
											import {"{"} Config {"}"} from '../config';
										</div>

										<div className="text-gray-500 uppercase tracking-widest mt-4">
											Exports
										</div>
										<div className="bg-claude-ish/10 p-2 rounded text-claude-ish border border-claude-ish/20">
											export class AuthService
										</div>
									</div>

									{/* Scanline */}
									<div className="absolute top-0 left-0 w-full h-1 bg-claude-ish/50 shadow-[0_0_15px_rgba(0,212,170,0.5)] animate-flow-down opacity-50"></div>

									{/* Badge */}
									<div className="absolute -right-12 top-10 bg-[#0c0c0c] border border-green-500 text-green-500 px-3 py-1 text-[10px] font-bold rounded rotate-12 shadow-xl z-20">
										~80% TOKEN REDUCTION
									</div>
								</div>
							)}

							{/* Level 2: Module Visual */}
							{activeLevel === 1 && (
								<div className="relative w-72 h-auto bg-[#1a1a1a] border-2 border-claude-ish/30 rounded-lg p-0 animate-fadeIn shadow-[0_0_30px_-5px_rgba(0,212,170,0.1)]">
									<div className="bg-claude-ish/10 px-4 py-2 border-b border-claude-ish/20 flex justify-between items-center">
										<span className="font-mono text-xs font-bold text-claude-ish">
											class AuthService
										</span>
										<span className="w-2 h-2 rounded-full bg-claude-ish animate-pulse"></span>
									</div>
									<div className="p-4 space-y-3 font-mono text-[11px]">
										<div className="flex items-center gap-2">
											<span className="text-purple-400">+ login(creds)</span>
											<span className="ml-auto text-gray-500 italic">Core</span>
										</div>
										<div className="flex items-center gap-2">
											<span className="text-purple-400">+ logout()</span>
											<span className="ml-auto text-gray-500 italic">
												State
											</span>
										</div>
										<div className="flex items-center gap-2 bg-white/5 p-1 rounded -mx-1">
											<span className="text-purple-400 font-bold">
												+ validate(token)
											</span>
											<span className="ml-auto text-claude-ish text-[9px] uppercase tracking-wider font-bold">
												Primary Interface
											</span>
										</div>
										<div className="pt-2 border-t border-white/5 text-gray-500">
											- cache: RedisCache
											<br />- db: Database
										</div>
									</div>

									{/* Floating Info */}
									<div className="absolute -bottom-4 -left-4 bg-[#0c0c0c] border border-purple-500/50 text-purple-400 px-3 py-2 rounded-lg text-[10px] shadow-xl flex gap-2 items-center z-20">
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
												d="M13 10V3L4 14h7v7l9-11h-7z"
											/>
										</svg>
										Responsibility: Auth Logic
									</div>
								</div>
							)}

							{/* Level 3: Function Visual */}
							{activeLevel === 2 && (
								<div className="relative w-full max-w-sm animate-fadeIn">
									<div className="bg-[#111] p-5 rounded-lg border border-gray-800 font-mono text-[11px] leading-loose text-gray-400 relative overflow-hidden">
										<div className="absolute left-0 top-0 bottom-0 w-1 bg-yellow-500"></div>
										<div>
											<span className="text-purple-400">async function</span>{" "}
											<span className="text-yellow-400">validate</span>(token:
											string) {"{"}
										</div>
										<div className="pl-4">
											<span className="text-blue-400">if</span> (!token){" "}
											<span className="text-purple-400">return</span> false;
										</div>
										<div className="pl-4">
											<span className="text-blue-400">try</span> {"{"}
										</div>
										<div className="pl-8 text-white bg-white/5 rounded px-1">
											const decoded = jwt.verify(token);
										</div>
										<div className="pl-8">
											return decoded.exp &gt; Date.now();
										</div>
										<div className="pl-4">
											{"}"} <span className="text-blue-400">catch</span> {"{"}{" "}
											<span className="text-purple-400">return</span> false;{" "}
											{"}"}
										</div>
										<div>{"}"}</div>
									</div>

									{/* Semantic Intent Overlay */}
									<div className="absolute -top-6 right-0 bg-blue-600 text-white px-3 py-1.5 rounded-lg shadow-lg text-[10px] font-bold tracking-wide animate-float z-20">
										SEMANTIC INTENT DETECTED
									</div>

									{/* New Badge for Accuracy */}
									<div className="absolute -right-8 bottom-4 bg-[#0c0c0c] border border-blue-400 text-blue-400 px-3 py-1 text-[10px] font-bold rounded -rotate-6 shadow-xl z-20">
										+53% ACCURACY
									</div>

									{/* Arrow */}
									<div className="absolute top-1/2 right-[-20px] translate-x-full w-32 hidden lg:block">
										<div className="text-[10px] text-gray-500 mb-1 border-b border-gray-700 pb-1">
											AI Interpretation:
										</div>
										<div className="text-xs text-white">
											"Validates JWT expiration safely"
										</div>
									</div>
								</div>
							)}
						</div>
					</div>
				</div>
			</div>
		</section>
	);
};

// --- 4. FEATURE DEEP DIVE (INTERACTIVE) ---

const FeatureDeepDive: React.FC = () => {
	const [activeTab, setActiveTab] = useState(0);
	const [autoRotate, setAutoRotate] = useState(true);

	const tabs = [
		{
			id: "chunking",
			title: "Smart Code Chunking",
			subtitle: "AST-based Semantic Boundaries",
		},
		{
			id: "pagerank",
			title: "PageRank Importance",
			subtitle: "Graph-based Relevance Scoring",
		},
		{
			id: "intent",
			title: "Intent Summaries",
			subtitle: "Implementation vs. Purpose",
		},
		{
			id: "hybrid",
			title: "Hybrid Retrieval",
			subtitle: "Vector + Keyword + Rank",
		},
		{
			id: "learning",
			title: "Adaptive Learning",
			subtitle: "Improves with Your Feedback",
		},
		{
			id: "local",
			title: "100% Local & Private",
			subtitle: "No Cloud. No Leakage.",
		},
	];

	useEffect(() => {
		if (!autoRotate) return;
		const interval = setInterval(() => {
			setActiveTab((prev) => (prev + 1) % tabs.length);
		}, 5000);
		return () => clearInterval(interval);
	}, [autoRotate, tabs.length]);

	const handleTabClick = (idx: number) => {
		setActiveTab(idx);
		setAutoRotate(false);
	};

	return (
		<section className="py-24 bg-[#050505] relative">
			<div className="max-w-7xl mx-auto px-6">
				<div className="text-center mb-16">
					<h2 className="text-4xl md:text-5xl font-black text-white mb-6">
						Engineered for Understanding
					</h2>
					<p className="text-gray-500 font-mono text-lg">
						The technical architecture behind claudemem.
					</p>
				</div>

				<div className="grid lg:grid-cols-12 gap-12 h-[600px]">
					{/* Left: Navigation */}
					<div className="lg:col-span-4 flex flex-col justify-center gap-2">
						{tabs.map((tab, idx) => (
							<button
								key={idx}
								onClick={() => handleTabClick(idx)}
								className={`
                                    text-left px-6 py-4 rounded-xl border transition-all duration-300 relative group
                                    ${
																			activeTab === idx
																				? "bg-[#121212] border-claude-ish/20 shadow-lg"
																				: "bg-transparent border-transparent hover:bg-white/5 opacity-60 hover:opacity-100"
																		}
                                `}
							>
								<div
									className={`text-lg font-bold transition-colors ${activeTab === idx ? "text-white" : "text-gray-400"}`}
								>
									{tab.title}
								</div>
								<div className="text-xs font-mono text-gray-500 mt-1">
									{tab.subtitle}
								</div>
								{activeTab === idx && (
									<div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-2/3 bg-claude-ish rounded-r"></div>
								)}
							</button>
						))}
					</div>

					{/* Right: Visual Stage */}
					<div className="lg:col-span-8 bg-[#0c0c0c] border border-white/10 rounded-3xl relative overflow-hidden shadow-2xl flex flex-col">
						<div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:32px_32px] pointer-events-none"></div>

						{/* Tab Content Rendering */}
						<div className="flex-1 p-8 md:p-12 flex flex-col justify-center">
							{activeTab === 0 && <FeatureChunking />}
							{activeTab === 1 && <FeaturePageRank />}
							{activeTab === 2 && <FeatureSummaries />}
							{activeTab === 3 && <FeatureHybrid />}
							{activeTab === 4 && <FeatureLearning />}
							{activeTab === 5 && <FeatureLocal />}
						</div>
					</div>
				</div>
			</div>
		</section>
	);
};

// --- VISUALIZERS FOR FEATURES ---

const FeatureChunking = () => (
	<div className="flex flex-col gap-8 animate-fadeIn">
		<div>
			<h3 className="text-2xl font-bold text-white mb-2">
				Smart Code Chunking
			</h3>
			<p className="text-gray-400 leading-relaxed max-w-2xl">
				Naive splitters cut code at character limits, breaking logic. We use{" "}
				<span className="text-claude-ish">Tree-sitter AST</span> to respect
				semantic boundaries, keeping functions and classes intact.
			</p>
		</div>
		<div className="relative border border-gray-800 bg-[#111] rounded-lg p-6 font-mono text-xs overflow-hidden">
			<div className="absolute top-0 right-0 bg-claude-ish text-[#050505] text-[10px] font-bold px-2 py-1">
				AST MODE
			</div>
			<div className="text-purple-400">class AuthenticationHandler {"{"}</div>

			{/* Chunk 1 */}
			<div className="my-2 border border-blue-500/30 bg-blue-500/5 p-2 rounded relative">
				<div className="absolute -right-1 top-0 text-[9px] text-blue-400 bg-[#111] px-1 border border-blue-500/30 rounded">
					Chunk A
				</div>
				<div className="text-blue-300">
					{" "}
					async validateUser(id: string) {"{"}
				</div>
				<div className="pl-4 text-gray-500">// ... logic ...</div>
				<div className="text-blue-300"> {"}"}</div>
			</div>

			{/* Chunk 2 */}
			<div className="my-2 border border-green-500/30 bg-green-500/5 p-2 rounded relative">
				<div className="absolute -right-1 top-0 text-[9px] text-green-400 bg-[#111] px-1 border border-green-500/30 rounded">
					Chunk B
				</div>
				<div className="text-green-300">
					{" "}
					private hashToken(t: string) {"{"}
				</div>
				<div className="pl-4 text-gray-500">// ... logic ...</div>
				<div className="text-green-300"> {"}"}</div>
			</div>

			<div className="text-purple-400">{"}"}</div>

			{/* Contrast Line */}
			<div className="absolute top-1/2 left-0 w-full h-[1px] bg-red-500/50 border-t border-dashed border-red-500 flex items-center justify-center">
				<span className="bg-[#111] text-red-500 px-2 text-[10px] font-bold">
					NAIVE SPLIT WOULD CUT HERE
				</span>
			</div>
		</div>
	</div>
);

const FeaturePageRank = () => (
	<div className="flex flex-col gap-8 animate-fadeIn h-full justify-center">
		<div>
			<h3 className="text-2xl font-bold text-white mb-2">
				PageRank Importance
			</h3>
			<p className="text-gray-400 leading-relaxed max-w-2xl">
				Not all code is equal. We build a dependency graph and run PageRank.
				Central nodes get higher relevance scores, solving the "dead code"
				problem.
			</p>
		</div>
		<div className="relative h-64 w-full flex items-center justify-center">
			{/* Nodes */}
			<div className="absolute w-24 h-24 bg-claude-ish/20 rounded-full flex items-center justify-center border-2 border-claude-ish shadow-[0_0_30px_rgba(0,212,170,0.3)] z-20 animate-pulse">
				<div className="text-center">
					<div className="text-[10px] font-bold text-claude-ish uppercase">
						Core
					</div>
					<div className="text-xl font-black text-white">0.95</div>
				</div>
			</div>

			<div className="absolute top-0 right-10 w-16 h-16 bg-blue-500/10 rounded-full flex items-center justify-center border border-blue-500/50 z-10">
				<span className="text-xs text-blue-400">0.42</span>
			</div>

			<div className="absolute bottom-10 left-10 w-12 h-12 bg-gray-500/10 rounded-full flex items-center justify-center border border-gray-500/30 z-10">
				<span className="text-xs text-gray-400">0.11</span>
			</div>

			<div className="absolute -top-4 left-20 w-14 h-14 bg-purple-500/10 rounded-full flex items-center justify-center border border-purple-500/40 z-10">
				<span className="text-xs text-purple-400">0.38</span>
			</div>

			{/* Lines */}
			<svg className="absolute inset-0 w-full h-full pointer-events-none z-0">
				<line
					x1="50%"
					y1="50%"
					x2="75%"
					y2="20%"
					stroke="#00D4AA"
					strokeWidth="2"
					strokeOpacity="0.3"
				/>
				<line
					x1="50%"
					y1="50%"
					x2="20%"
					y2="80%"
					stroke="#00D4AA"
					strokeWidth="1"
					strokeOpacity="0.3"
				/>
				<line
					x1="50%"
					y1="50%"
					x2="30%"
					y2="10%"
					stroke="#00D4AA"
					strokeWidth="1.5"
					strokeOpacity="0.3"
				/>
			</svg>
		</div>
	</div>
);

const FeatureSummaries = () => (
	<div className="flex flex-col gap-8 animate-fadeIn">
		<div>
			<h3 className="text-2xl font-bold text-white mb-2">
				Intent-Based Summaries
			</h3>
			<p className="text-gray-400 leading-relaxed max-w-2xl">
				We bridge the gap between "how it's written" and "what it does."
			</p>
		</div>
		<div className="grid md:grid-cols-2 gap-4">
			<div className="bg-[#1a1a1a] border border-red-500/20 p-6 rounded-xl relative opacity-60">
				<div className="absolute -top-3 left-4 bg-[#0c0c0c] px-2 text-[10px] font-bold text-red-500 border border-red-500/30 uppercase">
					Raw Implementation
				</div>
				<div className="font-mono text-xs text-gray-500 space-y-4 mt-2">
					<p>"Iterates through array and checks elements"</p>
					<p>"Calls database and returns result"</p>
					<p>"Uses regex to process string"</p>
				</div>
				<div className="mt-4 text-red-500 text-sm font-bold">
					❌ Low Retrieval Value
				</div>
			</div>

			<div className="bg-[#1a1a1a] border border-claude-ish/30 p-6 rounded-xl relative shadow-lg">
				<div className="absolute -top-3 left-4 bg-[#0c0c0c] px-2 text-[10px] font-bold text-claude-ish border border-claude-ish/50 uppercase">
					Semantic Intent
				</div>
				<div className="font-mono text-xs text-gray-200 space-y-4 mt-2">
					<p>"Filters elements exceeding threshold"</p>
					<p>"Retrieves user by email for auth"</p>
					<p>"Validates email format"</p>
				</div>
				<div className="mt-4 text-claude-ish text-sm font-bold">
					✅ High Retrieval Value
				</div>
			</div>
		</div>
	</div>
);

const FeatureHybrid = () => (
	<div className="flex flex-col gap-8 animate-fadeIn h-full justify-center">
		<div>
			<h3 className="text-2xl font-bold text-white mb-2">Hybrid Retrieval</h3>
			<p className="text-gray-400 leading-relaxed max-w-2xl">
				Vector search misses keywords. Keywords miss meaning. We combine{" "}
				<span className="text-white">Vector + Keyword + PageRank</span> for the
				perfect match.
			</p>
		</div>
		<div className="bg-[#111] border border-gray-800 p-6 rounded-xl max-w-lg mx-auto w-full">
			<div className="space-y-6">
				<div className="space-y-2">
					<div className="flex justify-between text-xs font-mono text-gray-400">
						<span>Vector Similarity</span>
						<span className="text-white">0.5 weight</span>
					</div>
					<div className="h-2 bg-gray-800 rounded-full overflow-hidden">
						<div className="h-full bg-blue-500 w-[50%]"></div>
					</div>
				</div>
				<div className="space-y-2">
					<div className="flex justify-between text-xs font-mono text-gray-400">
						<span>Keyword Match (BM25)</span>
						<span className="text-white">0.3 weight</span>
					</div>
					<div className="h-2 bg-gray-800 rounded-full overflow-hidden">
						<div className="h-full bg-claude-ish w-[30%]"></div>
					</div>
				</div>
				<div className="space-y-2">
					<div className="flex justify-between text-xs font-mono text-gray-400">
						<span>PageRank Importance</span>
						<span className="text-white">0.2 weight</span>
					</div>
					<div className="h-2 bg-gray-800 rounded-full overflow-hidden">
						<div className="h-full bg-purple-500 w-[20%]"></div>
					</div>
				</div>
				<div className="pt-4 border-t border-gray-800 flex justify-between items-center">
					<span className="text-gray-500 font-mono text-sm">
						Composite Score
					</span>
					<span className="text-2xl font-black text-white">0.98</span>
				</div>
			</div>
		</div>
	</div>
);

const FeatureLearning = () => (
	<div className="flex flex-col gap-8 animate-fadeIn h-full justify-center">
		<div>
			<h3 className="text-2xl font-bold text-white mb-2">Adaptive Learning</h3>
			<p className="text-gray-400 leading-relaxed max-w-2xl">
				Mark search results as helpful or unhelpful. claudemem learns which
				files and document types work best for your codebase using{" "}
				<span className="text-claude-ish">
					Exponential Moving Average (EMA)
				</span>
				.
			</p>
		</div>
		<div className="bg-[#111] border border-gray-800 p-6 rounded-xl max-w-lg mx-auto w-full">
			<div className="space-y-5">
				{/* Feedback Animation */}
				<div className="flex items-center gap-4 p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
					<div className="text-green-400 text-2xl">👍</div>
					<div className="flex-1">
						<div className="text-sm text-white font-mono">
							src/auth/SecurityService.ts
						</div>
						<div className="text-xs text-green-400">Marked as helpful</div>
					</div>
					<div className="text-xs text-green-400 font-mono">+boost</div>
				</div>

				<div className="flex items-center gap-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg opacity-60">
					<div className="text-red-400 text-2xl">👎</div>
					<div className="flex-1">
						<div className="text-sm text-white font-mono">
							test/fixtures/mock.ts
						</div>
						<div className="text-xs text-red-400">Not relevant</div>
					</div>
					<div className="text-xs text-red-400 font-mono">-weight</div>
				</div>

				{/* Learning Stats */}
				<div className="pt-4 border-t border-gray-800 space-y-3">
					<div className="flex justify-between text-xs font-mono">
						<span className="text-gray-500">Vector Weight</span>
						<span className="text-white">
							0.6 → <span className="text-claude-ish">0.65</span>
						</span>
					</div>
					<div className="flex justify-between text-xs font-mono">
						<span className="text-gray-500">BM25 Weight</span>
						<span className="text-white">
							0.4 → <span className="text-claude-ish">0.35</span>
						</span>
					</div>
					<div className="flex justify-between text-xs font-mono">
						<span className="text-gray-500">File Boost (auth/*)</span>
						<span className="text-white">
							1.0 → <span className="text-claude-ish">1.2</span>
						</span>
					</div>
				</div>

				<div className="pt-3 text-center">
					<div className="inline-block bg-claude-ish/10 border border-claude-ish/30 text-claude-ish text-xs font-bold px-3 py-1.5 rounded-full">
						RANKING IMPROVED
					</div>
				</div>
			</div>
		</div>
	</div>
);

const FeatureLocal = () => (
	<div className="flex flex-col gap-8 animate-fadeIn h-full justify-center items-center text-center">
		<div>
			<h3 className="text-2xl font-bold text-white mb-2">
				100% Local & Private
			</h3>
			<p className="text-gray-400 leading-relaxed max-w-md mx-auto">
				No cloud upload. No account required. Your code never leaves your
				machine.
			</p>
		</div>
		<div className="w-48 h-48 rounded-full border border-gray-700 flex items-center justify-center relative bg-[#111]">
			<div className="absolute inset-0 rounded-full border-4 border-transparent border-t-claude-ish animate-spin duration-[3s]"></div>
			<div className="text-6xl">🛡️</div>
			<div className="absolute -bottom-8 bg-[#0a0a0a] border border-green-500/50 text-green-500 px-3 py-1 text-[10px] font-bold rounded-full uppercase tracking-widest shadow-lg">
				Air-Gapped Capable
			</div>
		</div>
	</div>
);

// --- 5. CONTEXT WIN SECTION ---

const ContextWinSection = () => {
	return (
		<section className="py-32 bg-[#0a0a0a] relative overflow-hidden">
			<div className="max-w-7xl mx-auto px-6 relative z-10">
				<div className="grid md:grid-cols-2 gap-16 items-center">
					<div className="space-y-8">
						<div className="inline-block px-4 py-1.5 bg-gradient-to-r from-claude-ish to-blue-500 text-black font-black text-[11px] uppercase tracking-[0.2em] rounded-full">
							The Real Win
						</div>
						<h2 className="text-4xl md:text-6xl font-black text-white leading-tight">
							Context Window <br />
							<span className="text-transparent bg-clip-text bg-gradient-to-r from-claude-ish to-blue-400">
								Liberation.
							</span>
						</h2>
						<p className="text-xl text-gray-400 leading-relaxed">
							Stop wasting 50% of your context window on "exploration." With
							claudemem, the AI starts with understanding, leaving the full
							window for reasoning and code generation.
						</p>
					</div>

					<div className="bg-[#111] border border-gray-800 rounded-2xl p-8 shadow-2xl space-y-8">
						{/* Before */}
						<div className="space-y-2">
							<div className="flex justify-between text-sm font-mono text-gray-400">
								<span>Without claudemem</span>
								<span className="text-red-500 font-bold">Inefficient</span>
							</div>
							<div className="h-12 bg-gray-900 rounded-lg overflow-hidden flex text-[10px] font-bold text-white/80 uppercase tracking-wider">
								<div
									className="h-full bg-red-500/20 text-red-500 flex items-center justify-center border-r border-gray-900"
									style={{ width: "60%" }}
								>
									Exploration Noise (60%)
								</div>
								<div
									className="h-full bg-gray-800 text-gray-500 flex items-center justify-center"
									style={{ width: "40%" }}
								>
									Actual Work
								</div>
							</div>
						</div>

						{/* After */}
						<div className="space-y-2">
							<div className="flex justify-between text-sm font-mono text-gray-400">
								<span>With claudemem</span>
								<span className="text-claude-ish font-bold">Optimized</span>
							</div>
							<div className="h-12 bg-gray-900 rounded-lg overflow-hidden flex text-[10px] font-bold text-white/80 uppercase tracking-wider relative shadow-[0_0_30px_rgba(0,212,170,0.1)]">
								<div
									className="h-full bg-claude-ish flex items-center justify-center text-black"
									style={{ width: "95%" }}
								>
									Pure Reasoning & Code Gen (95%)
								</div>
								<div
									className="h-full bg-blue-500 flex items-center justify-center"
									style={{ width: "5%" }}
								></div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
};

// --- 6. COMPARISON SECTION (Redesigned) ---

const ComparisonSection: React.FC = () => {
	const [category, setCategory] = useState<"local" | "cloud">("local");

	return (
		<section
			className="py-32 bg-[#050505] border-t border-white/5 relative"
			id="benchmarks"
		>
			<div className="max-w-7xl mx-auto px-6">
				<div className="text-center mb-16">
					<div className="inline-block px-4 py-1.5 bg-gray-800 text-gray-400 font-mono text-[11px] font-black uppercase tracking-[0.2em] rounded-full mb-4">
						Market Analysis
					</div>
					<h2 className="text-4xl md:text-6xl font-black text-white mb-6">
						How claudemem Compares
					</h2>
					<p className="text-xl text-gray-500 font-mono max-w-2xl mx-auto mb-10">
						The code understanding landscape has exploded. claudemem is
						different. You pick the models. You run the benchmarks. You own the
						stack.
					</p>

					{/* Toggle Controls */}
					<div className="inline-flex bg-[#111] p-1 rounded-lg border border-white/10 relative overflow-hidden">
						{/* Sliding Pill Background - simplified for React without motion lib */}
						<div
							className={`absolute top-1 bottom-1 w-[140px] bg-[#222] rounded-md transition-all duration-300 ease-out ${category === "local" ? "left-1" : "left-[145px]"}`}
						></div>

						<button
							onClick={() => setCategory("local")}
							className={`relative px-6 py-2.5 rounded-md text-sm font-bold transition-colors z-10 w-[140px] ${category === "local" ? "text-white" : "text-gray-500 hover:text-gray-300"}`}
						>
							vs Open Source
						</button>
						<button
							onClick={() => setCategory("cloud")}
							className={`relative px-6 py-2.5 rounded-md text-sm font-bold transition-colors z-10 w-[140px] ${category === "cloud" ? "text-white" : "text-gray-500 hover:text-gray-300"}`}
						>
							vs Cloud / SaaS
						</button>
					</div>
				</div>

				{/* --- TABLE MATRIX --- */}
				<div className="overflow-hidden relative shadow-2xl rounded-2xl border border-white/10 bg-[#0c0c0c] mb-24">
					<div className="overflow-x-auto scrollbar-dark pb-2">
						<table className="w-full text-left border-collapse min-w-[800px]">
							<thead>
								<tr className="border-b border-white/10 bg-[#111]">
									<th className="p-6 font-mono text-xs text-gray-500 uppercase tracking-widest min-w-[180px] sticky left-0 bg-[#111] z-20 shadow-[2px_0_10px_-2px_rgba(0,0,0,0.5)]">
										Feature
									</th>

									{/* Claudemem Column - Always Visible & Highlighted */}
									<th className="p-6 font-mono text-xs text-claude-ish uppercase tracking-widest font-bold bg-claude-ish/5 border-l border-r border-claude-ish/20 min-w-[200px]">
										<div className="flex items-center gap-2">
											<div className="w-2 h-2 rounded-full bg-claude-ish"></div>
											claudemem
										</div>
									</th>

									{/* Dynamic Columns based on Category */}
									{category === "local" ? (
										<>
											<th className="p-6 font-mono text-xs text-gray-500 uppercase tracking-widest min-w-[160px]">
												claude-context
											</th>
											<th className="p-6 font-mono text-xs text-gray-500 uppercase tracking-widest min-w-[160px]">
												Brokk
											</th>
											<th className="p-6 font-mono text-xs text-gray-500 uppercase tracking-widest min-w-[160px]">
												Code-Graph
											</th>
										</>
									) : (
										<>
											<th className="p-6 font-mono text-xs text-gray-500 uppercase tracking-widest min-w-[180px]">
												Greptile
											</th>
											<th className="p-6 font-mono text-xs text-gray-500 uppercase tracking-widest min-w-[180px]">
												Sourcegraph AMP
											</th>
										</>
									)}
								</tr>
							</thead>
							<tbody className="divide-y divide-white/5 text-sm font-mono">
								{COMPARISON_MATRIX.map((row, i) => (
									<tr
										key={i}
										className="hover:bg-white/[0.02] transition-colors group"
									>
										{/* Feature Name */}
										<td className="p-6 font-bold text-white sticky left-0 bg-[#0c0c0c] z-10 group-hover:bg-[#111] transition-colors border-r border-white/5 shadow-[2px_0_10px_-2px_rgba(0,0,0,0.5)]">
											{row.feature}
										</td>

										{/* Claudemem Value */}
										<td className="p-6 text-white bg-claude-ish/5 border-l border-r border-claude-ish/20 font-bold relative">
											{/* Hover Highlight Effect */}
											<div className="absolute inset-0 bg-claude-ish/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"></div>

											<span className="relative z-10 flex items-center gap-2">
												{row.claudemem.includes("✅") ? (
													<>
														<span className="text-claude-ish text-lg">●</span>
														<span>{row.claudemem.replace(/✅ ?/, "")}</span>
													</>
												) : (
													row.claudemem
												)}
											</span>
										</td>

										{/* Competitor Values */}
										{category === "local" ? (
											<>
												<td className="p-6 text-gray-400">
													{row.context.includes("❌") ? (
														<span className="opacity-20 text-lg">●</span>
													) : (
														row.context.replace(/✅ ?/, "")
													)}
												</td>
												<td className="p-6 text-gray-400">
													{row.brokk.includes("❌") ? (
														<span className="opacity-20 text-lg">●</span>
													) : (
														row.brokk.replace(/✅ ?/, "")
													)}
												</td>
												<td className="p-6 text-gray-400">
													{row.graph.includes("❌") ? (
														<span className="opacity-20 text-lg">●</span>
													) : (
														row.graph.replace(/✅ ?/, "")
													)}
												</td>
											</>
										) : (
											<>
												<td className="p-6 text-gray-400">
													{row.greptile.includes("❌") ? (
														<span className="opacity-20 text-lg">●</span>
													) : (
														row.greptile.replace(/✅ ?/, "")
													)}
												</td>
												<td className="p-6 text-gray-400">
													{row.amp.includes("❌") ? (
														<span className="opacity-20 text-lg">●</span>
													) : (
														row.amp.replace(/✅ ?/, "")
													)}
												</td>
											</>
										)}
									</tr>
								))}
							</tbody>
						</table>
					</div>

					{/* Legend / Info Footer for Table */}
					<div className="bg-[#111] border-t border-white/5 p-4 flex justify-between items-center text-xs font-mono text-gray-600 px-6">
						<div>
							<span className="text-claude-ish">●</span> Included/Supported
						</div>
						<div>
							<span className="opacity-20">●</span> Not available
						</div>
					</div>
				</div>

				{/* --- MODEL FREEDOM --- */}
				<div className="grid md:grid-cols-2 gap-12 mb-32 items-center">
					<div className="space-y-6">
						<h3 className="text-3xl font-bold text-white">
							The Model Freedom Difference
						</h3>
						<p className="text-gray-400 leading-relaxed text-lg">
							Every other tool makes model choices for you. claudemem doesn't.
						</p>
						<div className="space-y-6 text-sm font-mono text-gray-400 leading-relaxed bg-[#0c0c0c] p-8 rounded-xl border border-white/5">
							<h4 className="text-white font-bold uppercase tracking-widest mb-4">
								Why this matters
							</h4>
							<p>
								<strong className="text-white">Air-gapped?</strong> Everything
								must run locally. Done — use Ollama for both embeddings and
								summaries.
							</p>
							<p>
								<strong className="text-white">Best quality?</strong> Use Voyage
								embeddings + GPT-4o summaries for maximum retrieval accuracy.
							</p>
							<p>
								<strong className="text-white">
									Already paying for Claude?
								</strong>{" "}
								Use your Claude Code subscription for keyless access.
							</p>
							<p className="pt-4 border-t border-white/5 text-gray-500 italic">
								claudemem doesn't care. Plug in what works for you.
							</p>
						</div>
					</div>

					{/* Visual placeholder - component removed */}
				</div>

				{/* --- COMPETITOR BREAKDOWNS --- */}
				<div className="mb-32">
					{/* Section 1: Local / Open Source */}
					<div className="mb-12">
						<h4 className="text-white text-lg font-bold mb-6 flex items-center gap-3">
							<span className="w-2 h-2 rounded-full bg-green-500"></span>
							vs Open Source & Local Tools
						</h4>
						<div className="grid md:grid-cols-2 gap-6">
							{/* vs claude-context */}
							<div className="bg-[#111] p-6 rounded-xl border border-gray-800 hover:border-gray-700 transition-colors">
								<div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">
									Original Context Tool
								</div>
								<h4 className="text-xl font-bold text-white mb-4">
									vs claude-context
								</h4>
								<p className="text-sm text-gray-400 mb-4">
									We build on their foundation (tree-sitter parsing).
								</p>
								<ul className="text-sm text-gray-300 space-y-2 font-mono">
									<li className="flex gap-2">
										<span className="text-claude-ish">+</span>{" "}
										<span>PageRank importance sorting</span>
									</li>
									<li className="flex gap-2">
										<span className="text-claude-ish">+</span>{" "}
										<span>Hierarchical summaries</span>
									</li>
									<li className="flex gap-2">
										<span className="text-claude-ish">+</span>{" "}
										<span>Built-in benchmarks</span>
									</li>
								</ul>
							</div>

							{/* vs Brokk */}
							<div className="bg-[#111] p-6 rounded-xl border border-gray-800 hover:border-gray-700 transition-colors">
								<div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">
									Enterprise Analysis
								</div>
								<h4 className="text-xl font-bold text-white mb-4">vs Brokk</h4>
								<p className="text-sm text-gray-400 mb-4">
									Brokk uses Joern for deep CPG analysis. Great for security,
									heavy for RAG.
								</p>
								<ul className="text-sm text-gray-300 space-y-2 font-mono">
									<li className="flex gap-2">
										<span className="text-claude-ish">+</span>{" "}
										<span>28+ Languages (Brokk is Java focused)</span>
									</li>
									<li className="flex gap-2">
										<span className="text-claude-ish">+</span>{" "}
										<span>Interactive CLI</span>
									</li>
									<li className="flex gap-2">
										<span className="text-claude-ish">+</span>{" "}
										<span>MIT License (Brokk is GPL)</span>
									</li>
								</ul>
							</div>
						</div>
					</div>

					{/* Section 2: Cloud / SaaS */}
					<div>
						<h4 className="text-white text-lg font-bold mb-6 flex items-center gap-3">
							<span className="w-2 h-2 rounded-full bg-blue-500"></span>
							vs Cloud & SaaS
						</h4>
						<div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
							{/* vs Greptile */}
							<div className="bg-[#111] p-6 rounded-xl border border-gray-800 hover:border-gray-700 transition-colors">
								<div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">
									The SaaS API
								</div>
								<h4 className="text-xl font-bold text-white mb-4">
									vs Greptile
								</h4>
								<p className="text-sm text-gray-400 mb-4">
									Greptile is a powerful cloud API ($30/mo).
								</p>
								<ul className="text-sm text-gray-300 space-y-2 font-mono">
									<li className="flex gap-2">
										<span className="text-claude-ish">+</span>{" "}
										<span>Free and Open Source</span>
									</li>
									<li className="flex gap-2">
										<span className="text-claude-ish">+</span>{" "}
										<span>100% Local (Air-gapped ready)</span>
									</li>
									<li className="flex gap-2">
										<span className="text-claude-ish">+</span>{" "}
										<span>You choose the models</span>
									</li>
								</ul>
							</div>

							{/* vs Sourcegraph AMP */}
							<div className="bg-[#111] p-6 rounded-xl border border-gray-800 hover:border-gray-700 transition-colors lg:col-span-2">
								<div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">
									The Gold Standard
								</div>
								<h4 className="text-xl font-bold text-white mb-4">
									vs Sourcegraph AMP
								</h4>
								<div className="grid md:grid-cols-2 gap-8">
									<div>
										<p className="text-sm text-gray-400 mb-4">
											AMP is incredible for enterprise. We bring that power to
											individuals.
										</p>
										<div className="flex items-center gap-4 text-sm font-mono text-white mb-2">
											<span className="text-red-500">$1,000+ min</span>
											<span>vs</span>
											<span className="text-claude-ish">Free / MIT</span>
										</div>
									</div>
									<ul className="text-sm text-gray-300 space-y-2 font-mono">
										<li className="flex gap-2">
											<span className="text-claude-ish">+</span>{" "}
											<span>Any model (AMP is fixed)</span>
										</li>
										<li className="flex gap-2">
											<span className="text-claude-ish">+</span>{" "}
											<span>5 min deployment (vs days)</span>
										</li>
										<li className="flex gap-2">
											<span className="text-claude-ish">+</span>{" "}
											<span>Full CLI toolkit</span>
										</li>
									</ul>
								</div>
							</div>
						</div>
					</div>
				</div>

				{/* --- REAL DIFFERENTIATORS --- */}
				<div className="mb-32">
					<h3 className="text-3xl font-bold text-white mb-12 text-center">
						The Real Differentiators
					</h3>
					<div className="grid lg:grid-cols-3 gap-8">
						{/* 1. CLI First */}
						<div className="space-y-4">
							<h4 className="text-xl font-bold text-white">
								1. CLI-first design
							</h4>
							<p className="text-sm text-gray-400">
								Not just an MCP server. A full toolkit.
							</p>
							<TerminalWindow
								title="terminal"
								className="h-64 bg-[#0a0a0a]"
								noPadding
							>
								<div className="p-4 font-mono text-xs space-y-4 text-gray-300">
									<div>
										<div className="text-gray-500 mb-1">
											# Search from terminal
										</div>
										<div>
											<span className="text-claude-ish">$</span> claudemem
											search "payment"
										</div>
									</div>
									<div>
										<div className="text-gray-500 mb-1"># See dependencies</div>
										<div>
											<span className="text-claude-ish">$</span> claudemem
											callers "validate"
										</div>
									</div>
									<div>
										<div className="text-gray-500 mb-1">
											# Visualise PageRank
										</div>
										<div>
											<span className="text-claude-ish">$</span> claudemem map
										</div>
									</div>
								</div>
							</TerminalWindow>
						</div>

						{/* 2. Any Model */}
						<div className="space-y-4">
							<h4 className="text-xl font-bold text-white">
								2. Any model, anywhere
							</h4>
							<p className="text-sm text-gray-400">Your stack. Your choice.</p>
							<TerminalWindow
								title="config"
								className="h-64 bg-[#0a0a0a]"
								noPadding
							>
								<div className="p-4 font-mono text-xs space-y-4 text-gray-300">
									<div>
										<div className="text-gray-500 mb-1">
											# Go fully local (Ollama)
										</div>
										<div>
											<span className="text-claude-ish">$</span> claudemem
											config --embeddings ollama/nomic --summarizer
											ollama/llama3
										</div>
									</div>
									<div>
										<div className="text-gray-500 mb-1">
											# Or use Claude Code sub
										</div>
										<div>
											<span className="text-claude-ish">$</span> claudemem
											config --summarizer claude-code
										</div>
									</div>
								</div>
							</TerminalWindow>
						</div>

						{/* 3. Benchmarks */}
						<div className="space-y-4">
							<h4 className="text-xl font-bold text-white">
								3. Benchmarks included
							</h4>
							<p className="text-sm text-gray-400">
								Not marketing claims. Measured results.
							</p>
							<TerminalWindow
								title="benchmark"
								className="h-64 bg-[#0a0a0a]"
								noPadding
							>
								<div className="p-4 font-mono text-xs space-y-4 text-gray-300">
									<div>
										<div className="text-gray-500 mb-1">
											# Test on YOUR code
										</div>
										<div>
											<span className="text-claude-ish">$</span> claudemem
											benchmark --full
										</div>
									</div>
									<div>
										<div className="text-gray-500 mb-1">
											# Compare specific models
										</div>
										<div>
											<span className="text-claude-ish">$</span> claudemem
											benchmark --models "voyage-3,text-3-large"
										</div>
									</div>
								</div>
							</TerminalWindow>
						</div>
					</div>
				</div>

				{/* --- SUMMARY TABLE --- */}
				<div className="bg-[#111] rounded-2xl border border-white/10 p-8 md:p-12">
					<h3 className="text-2xl font-bold text-white mb-8 text-center">
						Summary: Why claudemem?
					</h3>
					<div className="overflow-x-auto">
						<table className="w-full text-left border-collapse font-mono text-sm">
							<thead>
								<tr className="border-b border-white/10">
									<th className="py-4 px-4 text-gray-500 uppercase tracking-widest text-xs">
										If you need...
									</th>
									<th className="py-4 px-4 text-claude-ish uppercase tracking-widest text-xs">
										claudemem delivers
									</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-white/5">
								<tr>
									<td className="py-4 px-4 text-gray-300">Terminal workflow</td>
									<td className="py-4 px-4 text-white">Full CLI toolkit</td>
								</tr>
								<tr>
									<td className="py-4 px-4 text-gray-300">
										Claude Code integration
									</td>
									<td className="py-4 px-4 text-white">Native MCP server</td>
								</tr>
								<tr>
									<td className="py-4 px-4 text-gray-300">Model flexibility</td>
									<td className="py-4 px-4 text-white">
										Any embedding model (cloud or local)
									</td>
								</tr>
								<tr>
									<td className="py-4 px-4 text-gray-300">Cost optimization</td>
									<td className="py-4 px-4 text-white">
										Benchmark to find cheapest effective model
									</td>
								</tr>
								<tr>
									<td className="py-4 px-4 text-gray-300">
										Air-gapped deployment
									</td>
									<td className="py-4 px-4 text-white">
										100% local with Ollama
									</td>
								</tr>
								<tr>
									<td className="py-4 px-4 text-gray-300">
										Zero extra API costs
									</td>
									<td className="py-4 px-4 text-white">
										Use existing Claude Code subscription
									</td>
								</tr>
								<tr>
									<td className="py-4 px-4 text-gray-300">Proof it works</td>
									<td className="py-4 px-4 text-white">
										Built-in benchmarks on your actual code
									</td>
								</tr>
							</tbody>
						</table>
					</div>
					<div className="mt-8 text-center">
						<p className="text-gray-500 text-sm">
							Other tools pick models for you. We give you the choice — and the
							data to choose.
						</p>
					</div>
				</div>
			</div>
		</section>
	);
};

// --- RESEARCH FOOTER ---

const ResearchFooter: React.FC = () => (
	<div className="bg-[#050505] py-24 border-t border-white/5" id="research">
		<div className="max-w-5xl mx-auto px-6">
			<h3 className="text-2xl font-bold text-white mb-12 text-center">
				Research Behind the Approach
			</h3>

			<div className="grid md:grid-cols-3 gap-12 text-sm text-gray-400 leading-relaxed font-mono">
				<div className="space-y-4">
					<h4 className="text-white font-bold uppercase tracking-widest text-xs border-b border-white/10 pb-2">
						Granularity
					</h4>
					<p>
						<strong className="text-claude-ish">
							JP Morgan's Meta-RAG (2025)
						</strong>{" "}
						proved that hierarchical retrieval outperforms flat approaches.
					</p>
					<ul className="list-disc pl-4 space-y-2 text-xs">
						<li>File-level: 80% reduction in noise.</li>
						<li>Function-level: 53% accuracy boost for precise queries.</li>
					</ul>
				</div>

				<div className="space-y-4">
					<h4 className="text-white font-bold uppercase tracking-widest text-xs border-b border-white/10 pb-2">
						PageRank
					</h4>
					<p>
						<strong className="text-claude-ish">Aider</strong> pioneered
						repo-maps using PageRank. We extend this to symbol-level
						granularity.
					</p>
					<p className="text-xs">
						When context is limited, high-rank symbols (critical infrastructure)
						are prioritized over isolated utility functions.
					</p>
				</div>

				<div className="space-y-4">
					<h4 className="text-white font-bold uppercase tracking-widest text-xs border-b border-white/10 pb-2">
						Evaluation
					</h4>
					<p>
						We use <strong className="text-claude-ish">LLM-as-a-Judge</strong>{" "}
						(GPT-4) which achieves 85% alignment with human judgment—higher than
						human-to-human agreement (81%).
					</p>
					<p className="text-xs">
						Benchmarks adapted from DeepEval and Ragas frameworks for code.
					</p>
				</div>
			</div>

			<div className="mt-20 pt-10 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-6">
				<div className="text-xs text-gray-600 font-mono">
					Based on academic research. Built for production.
				</div>
				<div className="flex gap-6">
					<a
						href="https://arxiv.org/abs/2410.17435"
						className="text-xs font-bold text-white hover:text-claude-ish transition-colors"
					>
						Read Meta-RAG Paper
					</a>
					<a
						href="https://aider.chat/docs/repomap.html"
						className="text-xs font-bold text-white hover:text-claude-ish transition-colors"
					>
						Read Aider Docs
					</a>
				</div>
			</div>
		</div>
	</div>
);

// --- VISUALIZERS & ICONS (Preserved) ---

const VisualCriticalPath = () => (
	<div className="w-full h-full flex items-center justify-center relative animate-fadeIn">
		{/* Nodes */}
		<div className="absolute top-[10%] left-[50%] -translate-x-1/2 w-32 h-16 bg-[#1a1a1a] border border-white/20 rounded-lg flex items-center justify-center z-20">
			<span className="text-white font-mono text-xs">Entry Point</span>
		</div>
		<div className="absolute top-[45%] left-[20%] w-32 h-16 bg-[#1a1a1a] border border-white/5 rounded-lg flex items-center justify-center z-10 opacity-30">
			<span className="text-gray-500 font-mono text-xs">Util A</span>
		</div>
		<div className="absolute top-[45%] left-[50%] -translate-x-1/2 w-32 h-16 bg-[#1a1a1a] border-2 border-[#f59e0b] shadow-[0_0_20px_rgba(245,158,11,0.2)] rounded-lg flex items-center justify-center z-20">
			<span className="text-white font-mono text-xs font-bold">Core Logic</span>
		</div>
		<div className="absolute top-[45%] right-[20%] w-32 h-16 bg-[#1a1a1a] border border-white/5 rounded-lg flex items-center justify-center z-10 opacity-30">
			<span className="text-gray-500 font-mono text-xs">Util B</span>
		</div>
		<div className="absolute bottom-[10%] left-[50%] -translate-x-1/2 w-32 h-16 bg-[#1a1a1a] border border-white/20 rounded-lg flex items-center justify-center z-20">
			<span className="text-white font-mono text-xs">Database</span>
		</div>

		{/* Connecting Lines (SVG) */}
		<svg className="absolute inset-0 w-full h-full pointer-events-none z-0">
			<path d="M50% 25% L 50% 38%" stroke="#333" strokeWidth="2" />
			<path
				d="M50% 25% L 28% 40%"
				stroke="#333"
				strokeWidth="2"
				strokeDasharray="4"
			/>
			<path
				d="M50% 25% L 72% 40%"
				stroke="#333"
				strokeWidth="2"
				strokeDasharray="4"
			/>

			{/* Active Path */}
			<path
				d="M50% 25% L 50% 38%"
				stroke="#f59e0b"
				strokeWidth="3"
				className="animate-draw"
			/>
			<path
				d="M50% 60% L 50% 80%"
				stroke="#f59e0b"
				strokeWidth="3"
				className="animate-draw"
				style={{ animationDelay: "0.5s" }}
			/>
		</svg>
	</div>
);

const VisualDeadCode = () => (
	<div className="w-full max-w-sm space-y-3 font-mono text-xs animate-fadeIn">
		<div className="bg-[#151515] p-3 rounded border border-white/10 flex justify-between items-center">
			<span className="text-blue-400">function processUser()</span>
			<span className="text-green-500 text-[10px]">ACTIVE</span>
		</div>
		<div className="bg-[#151515] p-3 rounded border border-white/10 flex justify-between items-center opacity-40 relative overflow-hidden group">
			<span className="text-gray-500 line-through decoration-red-500/50">
				function legacyAuth_v1()
			</span>
			<span className="text-red-500 text-[10px] font-bold">DEAD</span>
			<div className="absolute inset-0 bg-red-500/5"></div>
		</div>
		<div className="bg-[#151515] p-3 rounded border border-white/10 flex justify-between items-center">
			<span className="text-blue-400">function validateInput()</span>
			<span className="text-green-500 text-[10px]">ACTIVE</span>
		</div>
		<div className="bg-[#151515] p-3 rounded border border-white/10 flex justify-between items-center opacity-40 relative">
			<span className="text-gray-500 line-through decoration-red-500/50">
				var temp_fix_2023 = ...
			</span>
			<span className="text-red-500 text-[10px] font-bold">DEAD</span>
			<div className="absolute inset-0 bg-red-500/5"></div>
		</div>
	</div>
);

const VisualConnections = () => {
	// Coordinate space 100x100
	const nodes = [
		{ id: "AuthService", x: 50, y: 50, type: "core" },
		{ id: "User", x: 20, y: 30, type: "leaf" },
		{ id: "Database", x: 20, y: 70, type: "leaf" },
		{ id: "Logger", x: 80, y: 20, type: "leaf" },
		{ id: "API", x: 80, y: 80, type: "leaf" },
		{ id: "Config", x: 50, y: 15, type: "leaf" },
		{ id: "Session", x: 85, y: 50, type: "leaf" },
		{ id: "Cache", x: 15, y: 50, type: "leaf" },
	];

	const links = [
		{ from: "AuthService", to: "User" },
		{ from: "AuthService", to: "Database" },
		{ from: "AuthService", to: "Session" },
		{ from: "AuthService", to: "Logger" },
		{ from: "AuthService", to: "Config" },
		{ from: "API", to: "AuthService" },
		{ from: "User", to: "Database" },
		{ from: "User", to: "Cache" },
		{ from: "Logger", to: "API" },
	];

	return (
		<div className="w-full h-full flex items-center justify-center relative animate-fadeIn p-8">
			<svg
				className="w-full h-full"
				viewBox="0 0 100 100"
				preserveAspectRatio="xMidYMid meet"
			>
				{/* Links */}
				{links.map((link, i) => {
					const start = nodes.find((n) => n.id === link.from)!;
					const end = nodes.find((n) => n.id === link.to)!;
					return (
						<g key={i}>
							<line
								x1={start.x}
								y1={start.y}
								x2={end.x}
								y2={end.y}
								stroke="#1e293b"
								strokeWidth="0.5"
							/>
							{/* Animated Dash */}
							<line
								x1={start.x}
								y1={start.y}
								x2={end.x}
								y2={end.y}
								stroke="#38bdf8"
								strokeWidth="0.5"
								strokeDasharray="2 4"
								className="opacity-60"
							>
								<animate
									attributeName="stroke-dashoffset"
									values="6;0"
									dur={`${2 + (i % 3)}s`}
									repeatCount="indefinite"
								/>
							</line>
						</g>
					);
				})}

				{/* Nodes */}
				{nodes.map((node, i) => (
					<g key={i} className="hover:cursor-pointer group">
						<circle
							cx={node.x}
							cy={node.y}
							r={node.type === "core" ? 3 : 1.5}
							fill={node.type === "core" ? "#0ea5e9" : "#475569"}
							className="transition-all duration-300 group-hover:scale-150 group-hover:fill-white"
						/>
						{/* Glow for core */}
						{node.type === "core" && (
							<circle
								cx={node.x}
								cy={node.y}
								r="6"
								fill="#0ea5e9"
								opacity="0.2"
							>
								<animate
									attributeName="r"
									values="6;8;6"
									dur="3s"
									repeatCount="indefinite"
								/>
								<animate
									attributeName="opacity"
									values="0.2;0.1;0.2"
									dur="3s"
									repeatCount="indefinite"
								/>
							</circle>
						)}

						<text
							x={node.x}
							y={node.y + (node.type === "core" ? 6 : 4)}
							textAnchor="middle"
							fill={node.type === "core" ? "#93c5fd" : "#64748b"}
							fontSize={node.type === "core" ? "3" : "2.5"}
							fontFamily="monospace"
							className="pointer-events-none select-none"
						>
							{node.id}
						</text>
					</g>
				))}
			</svg>

			<div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-[#0c0c0c] border border-blue-500/20 rounded-full px-4 py-1 flex items-center gap-2 shadow-lg">
				<div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse"></div>
				<span className="text-[10px] text-blue-200 font-mono tracking-wide">
					GRAPH_RANK: calculating...
				</span>
			</div>
		</div>
	);
};

const VisualPatterns = () => (
	<div className="w-full max-w-md font-mono text-xs animate-fadeIn">
		<div className="mb-2 text-gray-500 flex justify-between">
			<span>detecting_style.ts</span>
			<span>Match: 98%</span>
		</div>
		<div className="bg-[#111] border border-gray-800 rounded p-4 space-y-2 relative">
			<div className="text-purple-400">
				const calculateTotal = (items) =&gt; {"{"}
			</div>
			<div className="pl-4 text-gray-300">
				return items.reduce((acc, item) =&gt; acc + item, 0);
			</div>
			<div className="text-purple-400">{"}"}</div>

			{/* Overlay checkmark */}
			<div className="absolute -right-2 -top-2 bg-green-500 text-black p-1 rounded-full shadow-lg">
				<svg
					className="w-4 h-4"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth="3"
						d="M5 13l4 4L19 7"
					></path>
				</svg>
			</div>
		</div>
		<div className="mt-4 opacity-50">
			<div className="text-gray-500">// Preferred over:</div>
			<div className="text-gray-600 line-through">
				function calc(i) {"{"} var sum=0; ... {"}"}
			</div>
		</div>
	</div>
);

const VisualIntent = () => (
	<div className="w-full max-w-md relative animate-fadeIn">
		{/* Code Block */}
		<div className="bg-[#111] p-4 rounded-lg border border-gray-800 font-mono text-xs text-gray-400 space-y-1 blur-[1px]">
			<div>function h(t) {"{"}</div>
			<div className="pl-4">if (!t) return false;</div>
			<div className="pl-4">const n = Date.now();</div>
			<div className="pl-4">return t.exp &gt; n;</div>
			<div>{"}"}</div>
		</div>

		{/* Intent Popover */}
		<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-[#0c0c0c] border border-red-500/50 p-4 rounded-xl shadow-[0_0_30px_rgba(239,68,68,0.2)] w-[110%] animate-float">
			<div className="text-[10px] text-red-500 font-bold uppercase tracking-wider mb-1">
				True Intent Detected
			</div>
			<div className="text-white font-medium text-sm">
				Checks if the authentication token is expired.
			</div>
		</div>
	</div>
);

const VisualDuplication = () => (
	<div className="flex gap-4 items-center justify-center w-full animate-fadeIn">
		{/* Block A */}
		<div className="w-32 bg-[#1a1a1a] border border-gray-700 p-3 rounded space-y-2 opacity-60">
			<div className="h-2 w-3/4 bg-purple-500/40 rounded"></div>
			<div className="h-2 w-full bg-gray-700 rounded"></div>
			<div className="h-2 w-1/2 bg-gray-700 rounded"></div>
		</div>

		{/* Merge Icon */}
		<div className="flex flex-col items-center gap-2 text-purple-500">
			<div className="w-8 h-8 rounded-full bg-purple-500/20 flex items-center justify-center">
				<svg
					className="w-4 h-4"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth="2"
						d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
					></path>
				</svg>
			</div>
			<span className="text-[10px] font-mono">99% MATCH</span>
		</div>

		{/* Block B */}
		<div className="w-32 bg-[#1a1a1a] border border-gray-700 p-3 rounded space-y-2 opacity-60">
			<div className="h-2 w-3/4 bg-purple-500/40 rounded"></div>
			<div className="h-2 w-full bg-gray-700 rounded"></div>
			<div className="h-2 w-1/2 bg-gray-700 rounded"></div>
		</div>
	</div>
);

// --- HELPER COMPONENTS & ICONS ---

const BoltIcon: React.FC<{ className?: string }> = ({ className }) => (
	<svg
		className={className}
		xmlns="http://www.w3.org/2000/svg"
		width="20"
		height="20"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
	</svg>
);
const SkullIcon: React.FC<{ className?: string }> = ({ className }) => (
	<svg
		className={className}
		xmlns="http://www.w3.org/2000/svg"
		width="20"
		height="20"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<circle cx="9" cy="12" r="1" />
		<circle cx="15" cy="12" r="1" />
		<path d="M8 20v2h8v-2" />
		<path d="M12.5 17l-.5-4" />
		<path d="M16 20a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20" />
	</svg>
);
const LinkIcon = () => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="20"
		height="20"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
		<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
	</svg>
);
const BrainIcon = () => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="20"
		height="20"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
		<path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
		<path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
		<path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
		<path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
		<path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
		<path d="M19.938 10.5a4 4 0 0 1 .585.396" />
		<path d="M6 18a4 4 0 0 1-1.937-.5" />
		<path d="M19.937 17.5A4 4 0 0 1 18 18" />
	</svg>
);
const TargetIcon = () => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="20"
		height="20"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<circle cx="12" cy="12" r="10" />
		<circle cx="12" cy="12" r="6" />
		<circle cx="12" cy="12" r="2" />
		<line x1="22" x2="18" y1="12" y2="12" />
		<line x1="6" x2="2" y1="12" y2="12" />
		<line x1="12" x2="12" y1="6" y2="2" />
		<line x1="12" x2="12" y1="22" y2="18" />
	</svg>
);
const DnaIcon: React.FC<{ className?: string }> = ({ className }) => (
	<svg
		className={className}
		xmlns="http://www.w3.org/2000/svg"
		width="20"
		height="20"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<path d="M2 15c6.667-6 13.333 0 20-6" />
		<path d="M9 22c1.798-1.998 2.518-3.995 2.807-5.993" />
		<path d="M15 2c-1.798 1.998-2.518 3.995-2.807 5.993" />
		<path d="M17 12a5.702 5.702 0 0 1-.92 3.106" />
	</svg>
);

export default FeatureSection;
