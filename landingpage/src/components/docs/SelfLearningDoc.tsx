import React from "react";
import { TerminalWindow } from "../TerminalWindow";
import { DocTable } from "./DocTable";

export const SelfLearningDoc: React.FC<{
	onNavigate: (section: string) => void;
}> = ({ onNavigate }) => {
	return (
		<div className="space-y-12 animate-fadeIn">
			<div>
				<div className="flex items-center gap-3 mb-4">
					<span className="text-xs bg-purple-500/20 text-purple-400 px-2 py-1 rounded font-mono uppercase font-bold">
						Experimental
					</span>
				</div>
				<h1 className="text-4xl font-black text-white mb-4 tracking-tight">
					Self-Learning System
				</h1>
				<p className="text-xl text-gray-400 leading-relaxed mb-6">
					A smart system that learns from your interactions to get better over
					time—just like a human developer would.
				</p>

				{/* Key Benefits */}
				<div className="grid md:grid-cols-3 gap-4">
					<div className="bg-[#151515] border border-white/5 p-4 rounded-xl">
						<div className="text-purple-400 font-bold mb-1 flex items-center gap-2">
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
									d="M13 10V3L4 14h7v7l9-11h-7z"
								/>
							</svg>
							Adapts to You
						</div>
						<p className="text-xs text-gray-400">
							If you correct it, it learns. It notices when its code is rejected
							or rewritten.
						</p>
					</div>
					<div className="bg-[#151515] border border-white/5 p-4 rounded-xl">
						<div className="text-green-400 font-bold mb-1 flex items-center gap-2">
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
									d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
								/>
							</svg>
							Safe by Design
						</div>
						<p className="text-xs text-gray-400">
							Changes are rigorously tested against a Red Team before deployment
							using A/B tests.
						</p>
					</div>
					<div className="bg-[#151515] border border-white/5 p-4 rounded-xl">
						<div className="text-blue-400 font-bold mb-1 flex items-center gap-2">
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
									d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
								/>
							</svg>
							Private & Local
						</div>
						<p className="text-xs text-gray-400">
							All learning happens 100% locally on your machine. No data leaves
							your control.
						</p>
					</div>
				</div>
			</div>

			{/* How It Works (Visual Steps) */}
			<div className="space-y-6">
				<h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">
					The Learning Cycle
				</h2>
				<div className="grid grid-cols-2 md:grid-cols-5 gap-2 md:gap-4 relative">
					{[
						{ title: "Collect", desc: "Observes sessions", color: "gray" },
						{ title: "Detect", desc: "Finds patterns", color: "blue" },
						{ title: "Generate", desc: "Creates fixes", color: "purple" },
						{ title: "Validate", desc: "Safety tests", color: "yellow" },
						{ title: "Deploy", desc: "Updates system", color: "green" },
					].map((step, i) => (
						<div
							key={i}
							className={`relative p-4 rounded-lg bg-[#0c0c0c] border border-white/10 flex flex-col items-center text-center z-10`}
						>
							<div
								className={`w-8 h-8 rounded-full mb-2 flex items-center justify-center font-bold text-sm bg-${step.color === "gray" ? "gray" : step.color + "-500"}/20 text-${step.color === "gray" ? "gray-400" : step.color + "-400"}`}
							>
								{i + 1}
							</div>
							<div className="text-white font-bold text-sm mb-1">
								{step.title}
							</div>
							<div className="text-[10px] text-gray-500">{step.desc}</div>
						</div>
					))}
					{/* Connector Line (Desktop) */}
					<div className="hidden md:block absolute top-[28px] left-[10%] right-[10%] h-[2px] bg-white/5 -z-0"></div>
				</div>

				<div className="bg-[#151515] border border-white/5 rounded-xl p-4 mt-4">
					<div className="text-claude-ish font-bold text-sm mb-2">
						Implicit Feedback
					</div>
					<p className="text-xs text-gray-500">
						No ratings needed—learns from corrections, rewrites, and code
						survival.
					</p>
				</div>
			</div>

			{/* The Challenge */}
			<div className="space-y-6">
				<h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">
					The Challenge
				</h2>
				<p className="text-gray-400">
					Traditional ML validation assumes millions of samples and explicit
					labels. Our context is different:
				</p>
				<DocTable
					headers={["Traditional ML", "claudemem Context"]}
					rows={[
						["Millions of samples", "50-500 sessions per project"],
						["Explicit labels/ratings", "No explicit user feedback"],
						["Centralized data", "Data stays on user's machine"],
						["Static distributions", "Codebases change constantly"],
					]}
				/>
				<div className="bg-claude-ish/10 border border-claude-ish/20 rounded-lg p-4">
					<div className="text-xs text-claude-ish font-bold uppercase tracking-widest mb-2">
						Our Solution
					</div>
					<p className="text-sm text-gray-400">
						Combine{" "}
						<strong className="text-white">implicit feedback signals</strong>,{" "}
						<strong className="text-white">Bayesian statistics</strong>, and
						novel metrics like{" "}
						<strong className="text-claude-ish">"Code Survival Rate"</strong> to
						validate improvements with smaller sample sizes.
					</p>
				</div>
			</div>

			{/* Implicit Feedback Detection */}
			<div className="space-y-6">
				<h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">
					Implicit Feedback Detection
				</h2>
				<p className="text-gray-400">
					We detect correction signals without requiring explicit ratings:
				</p>
				<DocTable
					headers={["Signal Type", "How Detected", "Weight"]}
					rows={[
						[
							'<strong class="text-white">Lexical Correction</strong>',
							'User says "no", "wrong", "actually"',
							'<span class="text-claude-ish">0.30</span>',
						],
						[
							'<strong class="text-white">Strategy Pivot</strong>',
							"Sudden change in tool usage after failure",
							'<span class="text-claude-ish">0.20</span>',
						],
						[
							'<strong class="text-white">Overwrite</strong>',
							"User edits same file region agent modified",
							'<span class="text-claude-ish">0.35</span>',
						],
						[
							'<strong class="text-white">Reask</strong>',
							"User repeats similar prompt",
							'<span class="text-claude-ish">0.15</span>',
						],
					]}
				/>
				<div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4">
					<div className="text-xs text-green-400 font-bold uppercase tracking-widest mb-2">
						Code Survival Rate — Strongest Signal
					</div>
					<div className="font-mono text-sm text-gray-300 mb-2">
						code_survival_rate = lines_kept / lines_written_by_agent
					</div>
					<p className="text-xs text-gray-500">
						If a user keeps the agent's code in their git commit, the agent did
						well. If they rewrite everything, it failed.
					</p>
				</div>
			</div>

			{/* Improvement Generation */}
			<div className="space-y-6">
				<h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">
					Improvement Generation
				</h2>
				<p className="text-gray-400">
					Three types of improvements are automatically generated from patterns:
				</p>
				<div className="grid md:grid-cols-3 gap-6">
					<div className="bg-[#151515] border border-white/5 rounded-xl p-5 space-y-3">
						<div className="flex items-center gap-2">
							<div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center text-blue-400 text-xs font-bold">
								S
							</div>
							<div className="text-white font-bold">Skills</div>
						</div>
						<p className="text-xs text-gray-500">
							Automatable sequences become slash commands
						</p>
						<div className="bg-black/50 p-3 rounded border border-white/10 font-mono text-[10px] text-gray-400">
							<div className="text-blue-400">name:</div> "quick-component"
							<br />
							<div className="text-blue-400">steps:</div>
							<br />
							&nbsp;&nbsp;- Glob → Read → Write
						</div>
					</div>
					<div className="bg-[#151515] border border-white/5 rounded-xl p-5 space-y-3">
						<div className="flex items-center gap-2">
							<div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center text-purple-400 text-xs font-bold">
								A
							</div>
							<div className="text-white font-bold">Subagents</div>
						</div>
						<p className="text-xs text-gray-500">
							Error clusters become specialized agents
						</p>
						<div className="bg-black/50 p-3 rounded border border-white/10 font-mono text-[10px] text-gray-400">
							<div className="text-purple-400">name:</div> "typescript-fixer"
							<br />
							<div className="text-purple-400">triggers:</div>
							<br />
							&nbsp;&nbsp;["TS2339", "TS2345"]
						</div>
					</div>
					<div className="bg-[#151515] border border-white/5 rounded-xl p-5 space-y-3">
						<div className="flex items-center gap-2">
							<div className="w-8 h-8 rounded-lg bg-green-500/20 flex items-center justify-center text-green-400 text-xs font-bold">
								P
							</div>
							<div className="text-white font-bold">Prompt Optimizations</div>
						</div>
						<p className="text-xs text-gray-500">
							Correction patterns become prompt additions
						</p>
						<div className="bg-black/50 p-3 rounded border border-white/10 font-mono text-[10px] text-gray-400">
							<div className="text-green-400">From:</div> "use async/await" × 12
							<br />
							<div className="text-green-400">Add:</div> "Prefer async/await
							<br />
							&nbsp;&nbsp;over .then() chains"
						</div>
					</div>
				</div>
			</div>

			{/* Safety Validation */}
			<div className="space-y-6">
				<h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">
					Adversarial Safety Testing
				</h2>
				<div className="bg-[#0c0c0c] border border-white/10 rounded-lg p-6">
					<div className="flex flex-col md:flex-row gap-4 items-center justify-center text-xs font-mono">
						<div className="border border-red-500/30 p-4 rounded bg-red-500/10 text-red-400 text-center w-full md:w-auto">
							<strong>RED TEAM</strong>
							<br />
							Attacks with edge cases,
							<br />
							malformed data, injections
						</div>
						<div className="text-gray-500 text-2xl">→</div>
						<div className="border border-blue-500/30 p-4 rounded bg-blue-500/10 text-blue-400 text-center w-full md:w-auto">
							<strong>BLUE TEAM</strong>
							<br />
							Defends with validation,
							<br />
							sanitization, limits
						</div>
						<div className="text-gray-500 text-2xl">→</div>
						<div className="border border-green-500/30 p-4 rounded bg-green-500/10 text-green-400 text-center w-full md:w-auto">
							<strong>SAFETY SCORE</strong>
							<br />
							{">"} 0.90 = Deploy
							<br />
							{"<"} 0.70 = Reject
						</div>
					</div>
				</div>
			</div>

			{/* A/B Testing */}
			<div className="space-y-6">
				<h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">
					A/B Testing
				</h2>
				<p className="text-gray-400">
					Baseline vs Treatment comparisons using synthetic agents:
				</p>
				<div className="grid md:grid-cols-2 gap-6">
					<div className="bg-[#151515] border border-white/5 rounded-xl p-5">
						<div className="text-gray-500 text-xs uppercase tracking-widest mb-3">
							Baseline (Control)
						</div>
						<div className="text-2xl font-black text-white mb-1">
							100 sessions
						</div>
						<div className="text-sm text-gray-400">No improvements applied</div>
					</div>
					<div className="bg-claude-ish/10 border border-claude-ish/20 rounded-xl p-5">
						<div className="text-claude-ish text-xs uppercase tracking-widest mb-3">
							Treatment (Test)
						</div>
						<div className="text-2xl font-black text-white mb-1">
							100 sessions
						</div>
						<div className="text-sm text-gray-400">
							With improvement applied
						</div>
					</div>
				</div>
			</div>

			{/* Deployment */}
			<div className="space-y-6">
				<h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">
					Controlled Deployment
				</h2>
				<p className="text-gray-400">Gradual rollout with auto-rollback:</p>
				<div className="flex flex-wrap items-center justify-center gap-4 py-6">
					{["5% Propose", "10% Testing", "25% Gradual", "50% Expanding"].map(
						(step, i) => (
							<React.Fragment key={i}>
								<div className="bg-[#151515] border border-white/5 rounded-lg px-4 py-3 text-center">
									<div className="text-white font-bold">
										{step.split(" ")[0]}
									</div>
									<div className="text-[10px] text-gray-500">
										{step.split(" ")[1]}
									</div>
								</div>
								<div className="text-gray-600">→</div>
							</React.Fragment>
						),
					)}
					<div className="bg-green-500/20 border border-green-500/30 rounded-lg px-4 py-3 text-center">
						<div className="text-green-400 font-bold">100%</div>
						<div className="text-[10px] text-gray-500">Graduated</div>
					</div>
				</div>
			</div>

			{/* Metrics */}
			<div className="space-y-6">
				<h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">
					Key Metrics
				</h2>
				<DocTable
					headers={["Metric", "Description", "Target"]}
					rows={[
						[
							'<strong class="text-white">Correction Rate</strong>',
							"User corrections / total actions",
							'<span class="text-green-400">&lt; 15%</span>',
						],
						[
							'<strong class="text-white">Autonomy Rate</strong>',
							"Autonomous actions / total",
							'<span class="text-green-400">&gt; 80%</span>',
						],
						[
							'<strong class="text-white">Error Rate</strong>',
							"Failed tools / total tool uses",
							'<span class="text-green-400">&lt; 5%</span>',
						],
						[
							'<strong class="text-white">Success Rate</strong>',
							"Successful sessions / total",
							'<span class="text-green-400">&gt; 85%</span>',
						],
					]}
				/>
			</div>

			{/* Privacy */}
			<div className="space-y-6">
				<h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">
					Privacy & Data
				</h2>
				<div className="grid md:grid-cols-2 gap-6">
					<div className="bg-green-500/10 border border-green-500/20 rounded-xl p-5">
						<div className="text-green-400 font-bold mb-3">
							What's Collected
						</div>
						<ul className="text-sm text-gray-400 space-y-1">
							<li>• Session metadata (duration, outcome)</li>
							<li>• Anonymized tool sequences</li>
							<li>• Correction signals (patterns, not messages)</li>
							<li>• Code survival metrics (percentages only)</li>
						</ul>
					</div>
					<div className="bg-red-500/10 border border-red-500/20 rounded-xl p-5">
						<div className="text-red-400 font-bold mb-3">
							What's NOT Collected
						</div>
						<ul className="text-sm text-gray-400 space-y-1">
							<li>• User messages (only hashed patterns)</li>
							<li>• Code content (only structural metadata)</li>
							<li>• File contents (only paths and types)</li>
							<li>• Personal identifiers</li>
						</ul>
					</div>
				</div>
			</div>

			{/* Configuration */}
			<div className="space-y-6">
				<h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">
					Configuration
				</h2>
				<p className="text-gray-400">
					The self-learning system is{" "}
					<strong className="text-white">disabled by default</strong>. To
					enable:
				</p>
				<TerminalWindow title="terminal" className="bg-[#0c0c0c]" noPadding>
					<div className="p-4 text-sm text-gray-300 font-mono space-y-2">
						<div>
							<span className="text-gray-500">
								# Enable interaction tracking
							</span>
						</div>
						<div>
							<span className="text-claude-ish">$</span> claudemem config set
							learning.enabled true
						</div>
						<div className="mt-3">
							<span className="text-gray-500">
								# Enable pattern analysis (runs nightly)
							</span>
						</div>
						<div>
							<span className="text-claude-ish">$</span> claudemem config set
							learning.analysis.enabled true
						</div>
						<div className="mt-3">
							<span className="text-gray-500">
								# Enable automatic improvement generation
							</span>
						</div>
						<div>
							<span className="text-claude-ish">$</span> claudemem config set
							learning.generation.enabled true
						</div>
					</div>
				</TerminalWindow>
			</div>

			{/* CTA */}
			<div className="bg-gradient-to-r from-purple-900/20 to-blue-900/20 border border-white/5 rounded-2xl p-8 text-center">
				<h3 className="text-2xl font-bold text-white mb-3">See the Results</h3>
				<p className="text-gray-400 mb-6">
					Learn how we validate that the self-learning system actually works.
				</p>
				<button
					onClick={() => onNavigate("validation-results")}
					className="bg-claude-ish text-black px-6 py-3 rounded-full font-bold text-sm hover:bg-white transition-colors"
				>
					View Validation & Results →
				</button>
			</div>
		</div>
	);
};
