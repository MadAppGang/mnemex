import React, { useState, useEffect, useRef } from "react";
import { TerminalWindow } from "./TerminalWindow";

export const MultiModelAnimation: React.FC = () => {
	const [stage, setStage] = useState(0);
	const containerRef = useRef<HTMLDivElement>(null);
	const [isVisible, setIsVisible] = useState(false);

	// Intersection Observer
	useEffect(() => {
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting) {
					setIsVisible(true);
					observer.disconnect();
				}
			},
			{ threshold: 0.3 },
		);

		if (containerRef.current) {
			observer.observe(containerRef.current);
		}

		return () => observer.disconnect();
	}, []);

	// Animation Sequence
	useEffect(() => {
		if (!isVisible) return;

		const timeline = [
			{ s: 1, delay: 500 }, // Start typing command
			{ s: 2, delay: 1300 }, // Opus line
			{ s: 3, delay: 1900 }, // Sonnet line
			{ s: 4, delay: 2500 }, // Haiku line
			{ s: 5, delay: 3100 }, // Subagent line
			{ s: 6, delay: 3600 }, // Connected success
			{ s: 7, delay: 4200 }, // Draw lines
			{ s: 8, delay: 5000 }, // Msg 1
			{ s: 9, delay: 5500 }, // Msg 2
			{ s: 10, delay: 6000 }, // Msg 3
			{ s: 11, delay: 7000 }, // Tagline 1
			{ s: 12, delay: 7500 }, // Tagline 2
			{ s: 13, delay: 8200 }, // Tagline 3
		];

		let timeouts: ReturnType<typeof setTimeout>[] = [];

		timeline.forEach((step) => {
			timeouts.push(setTimeout(() => setStage(step.s), step.delay));
		});

		return () => timeouts.forEach(clearTimeout);
	}, [isVisible]);

	return (
		<div ref={containerRef} className="max-w-6xl mx-auto my-16 relative">
			{/* Background Ambience */}
			<div
				className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[120%] h-[120%] bg-claude-ish/5 blur-[120px] rounded-full transition-opacity duration-1000 pointer-events-none ${stage >= 6 ? "opacity-100" : "opacity-0"}`}
			/>

			<div className="bg-[#050505] rounded-3xl p-1 border border-white/5 shadow-2xl relative overflow-hidden flex flex-col gap-8">
				{/* Terminal Section */}
				<div className="relative z-10 px-4 pt-4 md:px-12 md:pt-12">
					<TerminalWindow
						title="claudemem — zsh — 120×24"
						className="w-full shadow-2xl border-white/10 min-h-[300px] bg-[#0c0c0c]"
						noPadding={false}
					>
						<div className="font-mono text-xs md:text-[13px] space-y-2.5 leading-relaxed text-gray-300">
							{/* Command */}
							<div
								className={`transition-opacity duration-300 flex items-center ${stage >= 1 ? "opacity-100" : "opacity-0"}`}
							>
								<span className="text-claude-ish mr-2 font-bold">➜</span>
								<span className="text-white font-semibold">claudemem</span>
								<span className="text-gray-600 ml-2">\</span>
							</div>

							{/* Flags */}
							<div className="flex flex-col gap-1.5 ml-1">
								<CommandRow
									visible={stage >= 2}
									flag="--model-opus"
									flagColor="text-purple-400"
									value="google/gemini-3-pro-preview"
									comment="Complex planning & vision"
								/>
								<CommandRow
									visible={stage >= 3}
									flag="--model-sonnet"
									flagColor="text-blue-400"
									value="openai/gpt-5.1-codex"
									comment="Main coding logic"
								/>
								<CommandRow
									visible={stage >= 4}
									flag="--model-haiku"
									flagColor="text-green-400"
									value="x-ai/grok-code-fast-1"
									comment="Fast context processing"
								/>
								<CommandRow
									visible={stage >= 5}
									flag="--model-subagent"
									flagColor="text-orange-400"
									value="minimax/minimax-m2"
									comment="Background worker agents"
								/>
							</div>

							{/* Success State */}
							<div
								className={`pt-6 space-y-1 transition-opacity duration-500 ${stage >= 6 ? "opacity-100" : "opacity-0"}`}
							>
								<div className="flex items-center gap-2 text-[#3fb950]">
									<span>✓</span> Connection established to 4 distinct providers
								</div>
								<div className="flex items-center gap-2 text-[#3fb950]">
									<span>✓</span> Semantic complexity router: <b>Active</b>
								</div>
							</div>

							{/* Ready State */}
							<div
								className={`pt-4 transition-all duration-500 flex items-center ${stage >= 6 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"}`}
							>
								<span className="text-claude-ish font-bold mr-2 text-base">
									»
								</span>
								<span className="text-white font-bold">
									Ready. Orchestrating multi-model mesh.
								</span>
								<span
									className={`inline-block w-2.5 h-4 bg-claude-ish/50 ml-2 ${stage >= 13 ? "hidden" : "animate-cursor-blink"}`}
								></span>
							</div>
						</div>
					</TerminalWindow>
				</div>

				{/* Visual Badges & Lines */}
				<div className="relative pb-12 px-2 md:px-8">
					{/* Connection Lines (SVG) */}
					<svg
						className="absolute inset-0 w-full h-full pointer-events-none z-0"
						overflow="visible"
					>
						<defs>
							<filter
								id="neon-glow"
								x="-20%"
								y="-20%"
								width="140%"
								height="140%"
							>
								<feGaussianBlur stdDeviation="3" result="coloredBlur" />
								<feMerge>
									<feMergeNode in="coloredBlur" />
									<feMergeNode in="SourceGraphic" />
								</feMerge>
							</filter>
							<linearGradient
								id="line-gradient"
								x1="0%"
								y1="0%"
								x2="100%"
								y2="0%"
							>
								<stop offset="0%" stopColor="rgba(168, 85, 247, 0.4)" />
								<stop offset="33%" stopColor="rgba(59, 130, 246, 0.4)" />
								<stop offset="66%" stopColor="rgba(34, 197, 94, 0.4)" />
								<stop offset="100%" stopColor="rgba(249, 115, 22, 0.4)" />
							</linearGradient>
						</defs>
						{stage >= 7 && (
							<g
								className="stroke-[url(#line-gradient)] stroke-[2] fill-none opacity-60"
								style={{
									filter: "drop-shadow(0 0 4px rgba(0, 212, 170, 0.3))",
								}}
							>
								{/* Desktop: Connecting Top to Bottom */}
								<path
									d="M15% 90 Q 15% 120, 38% 120"
									className="hidden md:block animate-draw [stroke-dasharray:1000] [stroke-dashoffset:1000]"
								/>
								<path
									d="M38% 120 L 62% 120"
									className="hidden md:block animate-draw [stroke-dasharray:1000] [stroke-dashoffset:1000]"
								/>
								<path
									d="M85% 90 Q 85% 120, 62% 120"
									className="hidden md:block animate-draw [stroke-dasharray:1000] [stroke-dashoffset:1000]"
								/>

								{/* Mobile: Simple connections */}
								<path
									d="M25% 120 L 75% 120"
									className="md:hidden animate-draw"
								/>
							</g>
						)}
					</svg>

					{/* Badges Grid */}
					<div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6 relative z-10 px-2 md:px-4">
						<Badge
							active={stage >= 2}
							color="purple"
							role="PLANNING NODE"
							modelName="GEMINI 3"
							icon="◈"
							mapping="maps to --model-opus"
						/>
						<Badge
							active={stage >= 3}
							color="blue"
							role="CODING NODE"
							modelName="GPT 5.1"
							icon="❖"
							mapping="maps to --model-sonnet"
						/>
						<Badge
							active={stage >= 4}
							color="green"
							role="FAST NODE"
							modelName="GROK FAST"
							icon="⚡"
							mapping="maps to --model-haiku"
						/>
						<Badge
							active={stage >= 5}
							color="orange"
							role="BACKGROUND"
							modelName="MINIMAX M2"
							icon="⟁"
							mapping="maps to --model-subagent"
						/>
					</div>

					{/* Info Pills */}
					<div className="flex flex-wrap justify-center gap-4 mt-8 md:mt-12 relative z-10">
						<InfoPill
							visible={stage >= 8}
							text="Unified Context Window"
							delay={0}
						/>
						<InfoPill
							visible={stage >= 9}
							text="Standardized Tool Use"
							delay={100}
						/>
						<InfoPill
							visible={stage >= 10}
							text="Complexity Routing"
							delay={200}
						/>
					</div>

					{/* Tagline Reveal */}
					<div className="mt-12 text-center min-h-[4rem] flex flex-col md:flex-row items-center justify-center gap-2 md:gap-8">
						<div
							className={`text-xl md:text-2xl font-bold transition-opacity duration-300 ${stage >= 11 ? "opacity-100" : "opacity-0"} ${stage >= 13 ? "text-gray-600 line-through decoration-gray-700" : "text-gray-400"}`}
						>
							Not switching.
						</div>
						<div
							className={`text-xl md:text-2xl font-bold transition-opacity duration-300 ${stage >= 12 ? "opacity-100" : "opacity-0"} ${stage >= 13 ? "text-gray-600 line-through decoration-gray-700" : "text-gray-400"}`}
						>
							Not merging.
						</div>
						<div
							className={`text-2xl md:text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-claude-ish to-white transition-all duration-500 ${stage >= 13 ? "opacity-100 scale-110 blur-0" : "opacity-0 scale-90 blur-md"}`}
						>
							Collaborating.
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};

// Helper: Command Row in Terminal
const CommandRow: React.FC<{
	visible: boolean;
	flag: string;
	flagColor: string;
	value: string;
	comment: string;
}> = ({ visible, flag, flagColor, value, comment }) => (
	<div
		className={`pl-6 md:pl-8 flex flex-wrap items-baseline gap-x-3 gap-y-1 transition-all duration-300 ${visible ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-4"}`}
	>
		<span className={`${flagColor} font-bold tracking-tight min-w-[140px]`}>
			{flag}
		</span>
		<span className="text-gray-200">{value}</span>
		<span className="text-gray-600 italic text-[11px] md:text-xs">
			# {comment}
		</span>
	</div>
);

// Helper: Badge Component
const Badge: React.FC<{
	active: boolean;
	color: "purple" | "blue" | "green" | "orange";
	role: string;
	modelName: string;
	icon: string;
	mapping: string;
}> = ({ active, color, role, modelName, icon, mapping }) => {
	const colors = {
		purple: {
			border: "border-purple-500",
			text: "text-purple-400",
			bg: "bg-purple-500/10",
			glow: "shadow-purple-500/20",
		},
		blue: {
			border: "border-blue-500",
			text: "text-blue-400",
			bg: "bg-blue-500/10",
			glow: "shadow-blue-500/20",
		},
		green: {
			border: "border-green-500",
			text: "text-green-400",
			bg: "bg-green-500/10",
			glow: "shadow-green-500/20",
		},
		orange: {
			border: "border-orange-500",
			text: "text-orange-400",
			bg: "bg-orange-500/10",
			glow: "shadow-orange-500/20",
		},
	};

	const c = colors[color];

	return (
		<div
			className={`
            relative overflow-hidden rounded-xl border transition-all duration-700 ease-out group
            ${
							active
								? `${c.border} ${c.bg} shadow-[0_0_40px_-10px_rgba(0,0,0,0)] ${c.glow} translate-y-0 opacity-100`
								: "border-white/5 bg-[#0f0f0f] shadow-none translate-y-4 opacity-40"
						}
        `}
		>
			<div className="p-5 flex flex-col h-full min-h-[140px]">
				<div className="flex justify-between items-start mb-4">
					<span
						className={`text-[10px] font-bold tracking-[0.2em] uppercase ${active ? c.text : "text-gray-600"}`}
					>
						{role}
					</span>
					<span
						className={`text-lg transition-all duration-500 ${active ? "text-white scale-110 drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]" : "text-gray-700"}`}
					>
						{icon}
					</span>
				</div>

				<div
					className={`text-2xl md:text-3xl font-bold tracking-tight mb-auto transition-colors duration-500 ${active ? "text-white" : "text-gray-600"}`}
				>
					{modelName}
				</div>

				<div className="mt-4 pt-3 border-t border-white/5">
					<div className="text-[10px] font-mono text-gray-500 flex items-center gap-1.5">
						<span
							className={`w-1 h-1 rounded-full ${active ? `bg-${color}-500` : "bg-gray-700"}`}
						></span>
						{mapping}
					</div>
				</div>
			</div>

			{/* Active Glow Line */}
			<div
				className={`absolute bottom-0 left-0 h-[2px] w-full transition-all duration-1000 ${active ? `bg-${color}-500 opacity-100` : "opacity-0"}`}
			/>
		</div>
	);
};

// Helper: Info Pill
const InfoPill: React.FC<{ visible: boolean; text: string; delay: number }> = ({
	visible,
	text,
	delay,
}) => (
	<div
		className={`
            border border-white/10 bg-[#111] rounded-full py-2 px-6 text-xs md:text-sm font-mono text-gray-400
            transition-all duration-700 backdrop-blur-md shadow-lg
            ${visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}
        `}
		style={{ transitionDelay: `${delay}ms` }}
	>
		{text}
	</div>
);
