import React, { useState, useRef, useEffect } from "react";
import { TerminalWindow } from "./TerminalWindow";
import { HERO_SEQUENCE } from "../constants";
import { TypingAnimation } from "./TypingAnimation";
import { BlockLogo } from "./BlockLogo";

const AsciiGhost = () => {
	return (
		<pre
			className="text-[#d97757] font-bold select-none"
			style={{
				fontFamily: "'JetBrains Mono', monospace",
				fontSize: "18px",
				lineHeight: 0.95,
			}}
		>
			{` ▐▛███▜▌
▝▜█████▛▘
  ▘▘ ▝▝`}
		</pre>
	);
};

interface HeroSectionProps {
	onNavigateToBenchmarks?: () => void;
	onNavigateToDocs?: () => void;
}

const HeroSection: React.FC<HeroSectionProps> = ({
	onNavigateToBenchmarks,
	onNavigateToDocs,
}) => {
	const [rotation, setRotation] = useState({ x: 0, y: 0 });
	const [visibleLines, setVisibleLines] = useState<number>(0);
	const [status, setStatus] = useState({
		model: "Opus 4.5",
		cost: "$0.00",
		context: "1.2k",
	});

	const containerRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);

	const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
		if (!containerRef.current) return;
		const rect = containerRef.current.getBoundingClientRect();
		const xPct = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
		const yPct = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
		setRotation({ x: yPct * -5, y: xPct * 5 });
	};

	const handleMouseLeave = () => setRotation({ x: 0, y: 0 });

	useEffect(() => {
		const timeouts: ReturnType<typeof setTimeout>[] = [];
		const runSequence = () => {
			setVisibleLines(0);
			setStatus({ model: "Opus 4.5", cost: "$0.00", context: "1.2k" });

			HERO_SEQUENCE.forEach((line, index) => {
				timeouts.push(
					setTimeout(() => {
						setVisibleLines((prev) => Math.max(prev, index + 1));

						// Dynamic status updates based on events
						if (line.type === "tool") {
							setStatus((prev) => ({
								...prev,
								cost: "$0.02",
								context: "14.5k",
							}));
						}
					}, line.delay),
				);
			});

			timeouts.push(setTimeout(runSequence, 15000));
		};
		runSequence();
		return () => timeouts.forEach(clearTimeout);
	}, []);

	// Auto-scroll to bottom
	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [visibleLines]);

	return (
		<section className="relative min-h-screen flex flex-col items-center justify-start pt-20 pb-24 px-4 overflow-hidden">
			{/* Animated Background Orbs */}
			<div className="absolute top-0 left-0 w-full h-full -z-10 pointer-events-none">
				<div className="absolute top-[-10%] left-[20%] w-[600px] h-[600px] bg-claude-accent/10 rounded-full blur-[120px] animate-pulse" />
				<div
					className="absolute top-[10%] right-[20%] w-[500px] h-[500px] bg-claude-ish/5 rounded-full blur-[100px] animate-pulse"
					style={{ animationDelay: "1s" }}
				/>
			</div>

			<div className="text-center mb-12 max-w-5xl mx-auto z-10 flex flex-col items-center w-full">
				{/* Logo Container */}
				<div className="mb-10 w-full flex justify-center scale-[0.6] sm:scale-75 md:scale-90 origin-center">
					<BlockLogo />
				</div>

				{/* Main Headline */}
				<h1 className="text-4xl md:text-7xl font-sans font-black tracking-tighter text-white mb-8 leading-[0.95] drop-shadow-2xl">
					Local Semantic <br className="hidden md:block" />
					Code Search <br />
					<span className="text-transparent bg-clip-text bg-gradient-to-r from-claude-ish to-[#4fffa7]">
						for AI Agents
					</span>
				</h1>

				{/* Subtext */}
				<div className="mb-8 text-lg md:text-2xl text-[#999] font-medium leading-relaxed max-w-4xl mx-auto px-4">
					<p>
						Give{" "}
						<span className="text-white font-bold border-b-2 border-white/10 hover:border-claude-ish/50 transition-colors">
							Claude Code
						</span>
						,{" "}
						<span className="text-white font-bold border-b-2 border-white/10 hover:border-claude-ish/50 transition-colors">
							Cursor
						</span>
						, and AI assistants deep understanding of your codebase.
						Privacy-first indexing with PageRank-powered symbol importance —{" "}
						<span className="text-gray-400">
							and benchmarks to find the best model for your code.
						</span>
					</p>
				</div>

				{/* Name Similarity Notice */}
				<div className="mb-10 px-4">
					<a
						href="https://github.com/thedotmack/claude-mem"
						target="_blank"
						rel="noreferrer"
						className="inline-flex items-center gap-3 bg-[#1a1a1a]/80 border border-white/10 rounded-full px-5 py-2.5 text-sm text-gray-400 hover:border-white/20 hover:bg-[#1a1a1a] transition-all group"
					>
						<span className="text-yellow-500/80">⚠</span>
						<span>
							Not to be confused with{" "}
							<span className="text-white font-semibold group-hover:text-claude-ish transition-colors">
								claude-mem
							</span>{" "}
							— a session memory plugin (9.3k ★).
							<span className="text-gray-500 ml-1">We do code search.</span>
						</span>
						<span className="text-gray-600 group-hover:text-gray-400 transition-colors">
							→
						</span>
					</a>
				</div>

				{/* CTAs */}
				<div className="flex flex-col sm:flex-row gap-4 items-center justify-center mb-16 w-full">
					<button
						onClick={onNavigateToDocs}
						className="px-8 py-4 bg-claude-ish text-[#0f0f0f] font-bold text-lg rounded-lg shadow-[0_0_20px_rgba(0,212,170,0.3)] hover:bg-claude-ish/90 hover:scale-105 transition-all w-full sm:w-auto"
					>
						Get Started Free <span className="ml-2">→</span>
					</button>
					<button
						onClick={onNavigateToBenchmarks}
						className="px-8 py-4 bg-transparent border border-white/20 text-white font-medium text-lg rounded-lg hover:bg-white/5 transition-all w-full sm:w-auto flex items-center justify-center gap-2"
					>
						Best models for your code
					</button>
				</div>

				{/* Install Code Block - Compact & Aesthetic */}
				<div className="flex flex-col items-center animate-float">
					<div className="bg-[#1a1a1a] border border-white/10 rounded-xl p-5 shadow-2xl relative group min-w-[280px] md:min-w-[360px]">
						<div className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-[#d97757] text-[#0f0f0f] text-[9px] md:text-[10px] font-bold px-2.5 py-0.5 rounded shadow-lg uppercase tracking-wider">
							GET STARTED
						</div>
						<div className="flex flex-col gap-2.5 font-mono text-[13px] md:text-[14px] text-left">
							<div className="flex items-center gap-3 text-gray-300 group-hover:text-white transition-colors">
								<span className="text-claude-ish select-none font-bold">$</span>
								<span>npm install -g claude-codemem</span>
							</div>
							<div className="w-full h-[1px] bg-white/5"></div>
							<div className="flex items-center gap-3 text-white font-bold">
								<span className="text-claude-ish select-none font-bold">$</span>
								<span>claudemem index</span>
							</div>
						</div>
					</div>
				</div>
			</div>

			{/* 3D Interactive Terminal - Background context */}
			<div
				ref={containerRef}
				className="perspective-container w-full max-w-5xl relative h-[550px] group/terminal mt-24 opacity-80 hover:opacity-100 transition-opacity"
				onMouseMove={handleMouseMove}
				onMouseLeave={handleMouseLeave}
			>
				<div
					className="w-full h-full transition-transform duration-300 ease-out preserve-3d"
					style={{
						transform: `rotateX(${rotation.x}deg) rotateY(${rotation.y}deg)`,
					}}
				>
					<TerminalWindow
						className="h-full w-full bg-[#0d1117] shadow-[0_0_50px_rgba(0,0,0,0.6)] border-[#30363d]"
						title="claudemem — -zsh — 140×45"
						noPadding={true}
					>
						<div className="flex flex-col h-full font-mono text-[13px] md:text-sm">
							{/* Terminal Flow - Scrollable Area */}
							<div
								ref={scrollRef}
								className="flex-1 overflow-y-auto scrollbar-hide scroll-smooth p-4 md:p-6 pb-2"
							>
								{HERO_SEQUENCE.map((line, idx) => {
									if (idx >= visibleLines) return null;

									return (
										<div key={line.id} className="leading-normal mb-2">
											{/* System / Boot Output */}
											{line.type === "system" && (
												<div className="text-gray-400 font-semibold px-2">
													<span className="text-[#3fb950]">➜</span>{" "}
													{line.content}
												</div>
											)}

											{/* Rich Welcome Screen */}
											{line.type === "welcome" && (
												<div className="my-4 border border-[#d97757] rounded p-1 mx-2 relative animate-fadeIn">
													<div className="absolute top-[-10px] left-4 bg-[#0d1117] px-2 text-[#d97757] text-xs font-bold uppercase tracking-wider">
														Claudish
													</div>
													<div className="flex gap-2 md:gap-6 p-4">
														{/* Left Side: Logo & Info */}
														<div className="flex-1 border-r border-[#30363d] pr-4 md:pr-6 flex items-center justify-center">
															<div className="flex items-center gap-4 md:gap-6">
																<AsciiGhost />
																<div className="flex flex-col text-left space-y-0.5 md:space-y-1">
																	<div className="font-bold text-gray-200">
																		Claude Code {line.data.version}
																	</div>
																	<div className="text-xs text-gray-400">
																		{line.data.model} • Claude Max
																	</div>
																	<div className="text-xs text-gray-600">
																		~/dev/claudemem-landing
																	</div>
																</div>
															</div>
														</div>

														{/* Right Side: Activity */}
														<div className="hidden md:block flex-1 text-xs space-y-3 pl-2">
															<div className="text-[#d97757] font-bold">
																Recent activity
															</div>
															<div className="flex gap-2 text-gray-400">
																<span className="text-gray-600">1m ago</span>
																<span>Tracking Real OpenRouter Cost</span>
															</div>
															<div className="flex gap-2 text-gray-400">
																<span className="text-gray-600">39m ago</span>
																<span>Refactoring Auth Middleware</span>
															</div>
															<div className="w-full h-[1px] bg-[#30363d] my-2"></div>
															<div className="text-[#d97757] font-bold">
																What's new
															</div>
															<div className="text-gray-400">
																Fixed duplicate message display when using
																Gemini.
															</div>
														</div>
													</div>
												</div>
											)}

											{/* Rich Input */}
											{line.type === "rich-input" && (
												<div className="mt-4 mb-2 px-2">
													<div className="flex items-start text-white group">
														<span className="text-[#ff5f56] mr-3 font-bold select-none text-base">
															{">>"}
														</span>
														<TypingAnimation
															text={line.content}
															speed={25}
															className="text-gray-100 font-medium"
														/>
													</div>
												</div>
											)}

											{/* Thinking Block */}
											{line.type === "thinking" && (
												<div className="text-gray-500 px-2 flex items-center gap-2 text-xs my-2">
													<span className="animate-spin">⠋</span>
													{line.content}
												</div>
											)}

											{/* Tool Execution */}
											{line.type === "tool" && (
												<div className="my-2 px-2 animate-fadeIn">
													<div className="flex items-center gap-2">
														<div className="w-2 h-2 rounded-full bg-blue-500"></div>
														<span className="bg-[#1f2937] text-blue-400 px-1 rounded text-xs font-bold">
															{line.content.split("(")[0]}
														</span>
														<span className="text-gray-400 text-xs">
															({line.content.split("(")[1]}
														</span>
													</div>
													{line.data?.details && (
														<div className="border-l border-gray-700 ml-3 pl-3 mt-1 text-gray-500 text-xs py-1">
															{line.data.details}
														</div>
													)}
												</div>
											)}

											{/* Standard Output/Success/Info */}
											{line.type === "info" && (
												<div className="text-gray-400 px-2 py-1">
													{line.content}
												</div>
											)}

											{line.type === "success" && (
												<div className="text-[#3fb950] px-2">
													{line.content}
												</div>
											)}
										</div>
									);
								})}

								{/* Interactive Cursor line if active */}
								<div className="flex items-center text-white mt-1 px-2 pb-4">
									<span className="text-[#ff5f56] mr-3 font-bold text-base opacity-0">
										{">"}
									</span>
									<div className="h-4 w-2.5 bg-gray-500/50 animate-cursor-blink" />
								</div>
							</div>

							{/* Persistent Footer Status Bar */}
							<div className="bg-[#161b22] border-t border-[#30363d] px-3 py-1.5 flex justify-between items-center text-[10px] md:text-[11px] font-mono leading-none shrink-0 select-none z-20 rounded-b-xl">
								<div className="flex items-center gap-2 md:gap-3">
									<span className="font-bold text-claude-ish">claudemem</span>
									<span className="text-[#484f58]">●</span>
									<span className="text-[#e2b340]">{status.model}</span>
									<span className="text-[#484f58]">●</span>
									<span className="text-[#3fb950]">{status.cost}</span>
									<span className="text-[#484f58]">●</span>
									<span className="text-[#a371f7]">{status.context}</span>
								</div>
								<div className="flex items-center gap-2 text-gray-500">
									<span className="hidden sm:inline">
										bypass permissions{" "}
										<span className="text-[#ff5f56]">on</span>
									</span>
									<span className="text-[#484f58] hidden sm:inline">|</span>
									<span className="hidden sm:inline">(shift+tab to cycle)</span>
								</div>
							</div>
						</div>
					</TerminalWindow>
				</div>
			</div>
		</section>
	);
};

export default HeroSection;
