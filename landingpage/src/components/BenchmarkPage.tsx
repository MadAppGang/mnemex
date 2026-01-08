import React, { useEffect } from "react";
import { TerminalWindow } from "./TerminalWindow";

const BenchmarkPage: React.FC = () => {
	useEffect(() => {
		window.scrollTo(0, 0);
	}, []);

	return (
		<div className="pt-32 pb-24 px-4 md:px-8 min-h-screen bg-[#0f0f0f]">
			<div className="max-w-4xl mx-auto space-y-16">
				{/* Header */}
				<div className="text-center space-y-6">
					<div className="inline-block px-4 py-1.5 bg-claude-ish/10 border border-claude-ish/20 text-claude-ish font-mono text-[11px] font-black uppercase tracking-[0.2em] rounded-full">
						Methodology
					</div>
					<h1 className="text-4xl md:text-6xl font-black text-white tracking-tight">
						Benchmark Methodology
					</h1>
					<p className="text-xl text-gray-400 font-mono max-w-2xl mx-auto">
						Why we built our own, how it works, and how to run it on your code.
					</p>
				</div>

				{/* Why We Built This */}
				<section className="space-y-6">
					<h2 className="text-2xl font-bold text-white border-l-4 border-claude-ish pl-4">
						Why We Built Our Own Benchmarks
					</h2>
					<div className="prose prose-invert max-w-none text-gray-400 leading-relaxed space-y-4 font-sans text-lg">
						<p>
							Most code search tools pick a model and ship it. Maybe they ran
							some internal tests. Maybe they just picked whatever had good
							marketing.
						</p>
						<p>
							We wanted to know what actually works. Not on HumanEval. Not on
							some vendor's cherry-picked dataset. On{" "}
							<span className="text-white font-bold">real code</span>.
						</p>
						<p>
							So we built a benchmark suite. Run it on your codebase. See which
							models work for your code, your languages, your patterns.
						</p>
						<p>
							Turns out, the results are surprising. "Code-optimized" models
							sometimes lose to general-purpose ones. Expensive doesn't always
							mean better. Local models match cloud performance more often than
							you'd expect.
						</p>
						<p className="text-claude-ish font-bold">
							The only honest answer: test it yourself.
						</p>
					</div>
				</section>

				{/* Overview */}
				<section className="space-y-6">
					<h2 className="text-2xl font-bold text-white">What We Test</h2>
					<div className="grid md:grid-cols-2 gap-6">
						<div className="bg-[#151515] p-6 rounded-xl border border-white/5">
							<div className="text-claude-ish font-mono font-bold mb-2">01</div>
							<h3 className="text-white font-bold text-lg mb-2">
								Embedding Model Quality
							</h3>
							<p className="text-gray-400 text-sm">
								Can the model find the right code chunk given a query?
							</p>
							<div className="mt-4 bg-[#0a0a0a] p-2 rounded text-xs font-mono text-gray-500">
								$ claudemem benchmark
							</div>
						</div>
						<div className="bg-[#151515] p-6 rounded-xl border border-white/5">
							<div className="text-purple-400 font-mono font-bold mb-2">02</div>
							<h3 className="text-white font-bold text-lg mb-2">
								LLM Summarizer Quality
							</h3>
							<p className="text-gray-400 text-sm">
								Does the model understand what the code actually does?
							</p>
							<div className="mt-4 bg-[#0a0a0a] p-2 rounded text-xs font-mono text-gray-500">
								$ claudemem benchmark-llm
							</div>
						</div>
					</div>
				</section>

				<hr className="border-white/5" />

				{/* PART 1: EMBEDDINGS */}
				<section className="space-y-8">
					<div>
						<div className="text-sm font-mono text-gray-500 uppercase tracking-widest mb-2">
							Part 1
						</div>
						<h2 className="text-3xl font-bold text-white mb-4">
							Embedding Model Benchmark
						</h2>
						<p className="text-gray-400">
							Embedding models convert code and queries into vectors. Good
							embeddings mean "authentication handling" finds your auth code,
							not random files with "auth" in a comment.
						</p>
					</div>

					<div className="space-y-4">
						<h3 className="text-xl font-bold text-white">What We Measure</h3>
						<p className="text-gray-400">
							We sample code chunks, generate natural language queries (via{" "}
							<code className="bg-white/10 px-1 rounded text-white text-xs">
								--auto
							</code>{" "}
							or manual), and test if the correct chunk appears in search
							results.
						</p>

						<div className="overflow-x-auto">
							<table className="w-full text-left border-collapse font-mono text-xs md:text-sm border border-white/10 rounded-lg overflow-hidden">
								<thead className="bg-[#1a1a1a] text-gray-300">
									<tr>
										<th className="p-4 border-b border-white/10 w-32">
											Metric
										</th>
										<th className="p-4 border-b border-white/10">
											What It Tells You
										</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-white/5 text-gray-400 bg-[#0c0c0c]">
									<tr>
										<td className="p-4 font-bold text-white">NDCG</td>
										<td className="p-4">
											Normalized Discounted Cumulative Gain — overall ranking
											quality. Higher means relevant results appear higher.
										</td>
									</tr>
									<tr>
										<td className="p-4 font-bold text-white">MRR</td>
										<td className="p-4">
											Mean Reciprocal Rank — on average, how high does the
											correct result appear? MRR of 0.5 means correct answer is
											typically 2nd.
										</td>
									</tr>
									<tr>
										<td className="p-4 font-bold text-white">Hit@5</td>
										<td className="p-4">
											Is the correct answer anywhere in top 5 results? Most RAG
											systems use top-k retrieval.
										</td>
									</tr>
								</tbody>
							</table>
						</div>
					</div>

					<div className="space-y-4">
						<h3 className="text-xl font-bold text-white">
							Running Embedding Benchmarks
						</h3>
						<TerminalWindow
							title="claudemem-benchmark"
							className="bg-[#0c0c0c]"
							noPadding
						>
							<div className="p-6 font-mono text-xs text-gray-300 space-y-4">
								<div>
									<div className="text-gray-500 mb-1">
										# Test default embedding models
									</div>
									<div>
										<span className="text-claude-ish">$</span> claudemem
										benchmark
									</div>
								</div>
								<div>
									<div className="text-gray-500 mb-1">
										# Auto-generate queries from docstrings (works on any
										codebase)
									</div>
									<div>
										<span className="text-claude-ish">$</span> claudemem
										benchmark --auto
									</div>
								</div>
								<div>
									<div className="text-gray-500 mb-1">
										# Test specific embedding models
									</div>
									<div>
										<span className="text-claude-ish">$</span> claudemem
										benchmark --models="voyage-code-3,text-embedding-3-large"
									</div>
								</div>
								<div>
									<div className="text-gray-500 mb-1"># Test local models</div>
									<div>
										<span className="text-claude-ish">$</span> claudemem
										benchmark --models="ollama/nomic-embed-text"
									</div>
								</div>
							</div>
						</TerminalWindow>
					</div>

					<div className="space-y-4">
						<h3 className="text-xl font-bold text-white">Example Output</h3>
						<div className="bg-[#0c0c0c] border border-white/10 rounded-lg p-6 font-mono text-xs overflow-x-auto whitespace-pre text-gray-300">
							{`Model                        Speed   Cost    Ctx    Dim    NDCG   MRR    Hit@5
─────────────────────────────────────────────────────────────────────────────
voyage-code-3                2.5s    N/A     8K     1024d  85%    78%    92%
text-embedding-3-large       1.8s    N/A     8K     3072d  82%    74%    89%
text-embedding-3-small       1.2s    N/A     8K     768d   72%    65%    85%
nomic-embed-text (local)     2.1s    N/A     8K     768d   68%    60%    80%

Summary:
🏆 Best Quality: voyage-code-3 (NDCG: 85%)
⚡ Fastest: text-embedding-3-small (1.2s)`}
						</div>
					</div>
				</section>

				<hr className="border-white/5" />

				{/* PART 2: LLM SUMMARIZERS */}
				<section className="space-y-8">
					<div>
						<div className="text-sm font-mono text-gray-500 uppercase tracking-widest mb-2">
							Part 2
						</div>
						<h2 className="text-3xl font-bold text-white mb-4">
							LLM Summarizer Benchmark
						</h2>
						<p className="text-gray-400">
							LLM summarizers generate natural language descriptions of code.
							Good summaries capture intent ("validates email format") not just
							implementation. We use 6 evaluation methods.
						</p>
					</div>

					{/* Evaluation Grid */}
					<div className="grid md:grid-cols-2 gap-6">
						{[
							{
								title: "1. Judge (Pointwise)",
								desc: "An LLM judge evaluates each summary on Accuracy, Completeness, Semantic Richness, Abstraction, and Conciseness (1-5 scale).",
							},
							{
								title: "2. Judge (Pairwise)",
								desc: "Head-to-head comparisons using Bradley-Terry ranking. More reliable than absolute scoring for subtle quality differences.",
							},
							{
								title: "3. Contrastive Discrimination",
								desc: "Can the model tell similar code apart? Distinguishes between similar functions (e.g., authenticateUser vs validateUserInput).",
							},
							{
								title: "4. Retrieval",
								desc: "The ultimate test. We embed the generated summaries and test if queries find the correct code using them.",
							},
							{
								title: "5. Downstream Tasks",
								desc: "Tests Code Completion, Bug Localization, and Function Selection tasks given the summary context.",
							},
							{
								title: "6. Self-Evaluation",
								desc: "Can the model effectively use its own summaries? Tests internal consistency.",
							},
						].map((item, i) => (
							<div
								key={i}
								className="bg-[#151515] p-6 rounded-xl border border-white/5"
							>
								<h4 className="text-white font-bold mb-2">{item.title}</h4>
								<p className="text-gray-400 text-sm">{item.desc}</p>
							</div>
						))}
					</div>

					<div className="space-y-4">
						<h3 className="text-xl font-bold text-white">
							Running LLM Benchmarks
						</h3>
						<TerminalWindow
							title="claudemem-benchmark-llm"
							className="bg-[#0c0c0c]"
							noPadding
						>
							<div className="p-6 font-mono text-xs text-gray-300 space-y-4">
								<div>
									<div className="text-gray-500 mb-1">
										# Test specific generator models
									</div>
									<div>
										<span className="text-claude-ish">$</span> claudemem
										benchmark-llm --generators="openrouter/openai/gpt-4o-mini"
									</div>
								</div>
								<div>
									<div className="text-gray-500 mb-1">
										# Add judge models for evaluation
									</div>
									<div>
										<span className="text-claude-ish">$</span> claudemem
										benchmark-llm --generators="gpt-4o-mini" --judges="gpt-4o"
									</div>
								</div>
								<div>
									<div className="text-gray-500 mb-1">
										# Run local models in parallel
									</div>
									<div>
										<span className="text-claude-ish">$</span> claudemem
										benchmark-llm --generators="ollama/llama3.1:8b"
										--local-parallelism=4
									</div>
								</div>
							</div>
						</TerminalWindow>
					</div>

					<div className="space-y-4">
						<h3 className="text-xl font-bold text-white">
							Latest Benchmark Run
						</h3>
						<div className="bg-[#0c0c0c] border border-white/10 rounded-lg p-6 font-mono text-xs overflow-x-auto whitespace-pre text-gray-300 leading-relaxed max-h-[800px] overflow-y-auto scrollbar-dark">
							{`📊 Benchmark Run: b2531c4c-bc08-4b71-ad72-fa316b97f0d3

Status:     completed
Started:    12/24/2025, 12:10:59 AM
Project:    /Users/jack/mag/claudemem
Cases:      50

╔═══════════════════════════════════════════════════════════════════════════╗
║                         QUALITY SCORES                                    ║
╚═══════════════════════════════════════════════════════════════════════════╝

How well summaries serve LLM agents for code understanding. Higher is better.

  Model                      Retr.     Contr.    Judge     Overall
  ────────────────────────── ───────── ───────── ───────── ─────────
  gpt-5.1-codex-max          23%       83%       78%       57%
  nova-premier-v1            27%       79%       51%       56%
  qwen3-235b-a22b-2507       13%       92%       79%       55%
  gpt-oss-120b               13%       91%       60%       54%
  opus                       16%       80%       71%       54%
  gemini-3-pro-preview       11%       89%       67%       53%
  deepseek-v3.2              13%       82%       74%       52%
  qwen3-max                  7%        92%       84%       52%
  minimax-m2.1               13%       82%       57%       52%
  kimi-k2-0905               7%        91%       67%       51%
  qwen3-coder                12%       83%       57%       51%
  glm-4.7                    11%       80%       60%       51%
  qwen3-coder-plus           10%       84%       72%       50%
  gemini-3-flash-preview     16%       75%       43%       50%
  gpt-5.2                    7%        81%       82%       49%
  haiku                      7%        82%       69%       49%
  gpt-5-mini                 7%        83%       85%       49%
  grok-code-fast-1           7%        82%       56%       48%

Quality metrics (used for ranking):
  • Retr. (45%):  Can agents FIND the right code? (P@K, MRR)
  • Contr. (30%): Can agents DISTINGUISH similar code?
  • Judge (25%):  Is summary accurate and complete?

┌───────────────────────────────────────────────────────────────────────────┐
│                      OPERATIONAL METRICS                                  │
└───────────────────────────────────────────────────────────────────────────┘

Production efficiency metrics. Don't affect quality ranking.

  Model                      Latency    Cost       Refine     Self-Eval
  ────────────────────────── ───────── ───────── ───────── ─────────
  gpt-5.1-codex-max          38.8s      $0.211     2.7 rnd    96%
  nova-premier-v1            25.1s      $0.106     2.1 rnd    100%
  qwen3-235b-a22b-2507       7.9s       $0.44¢     1.8 rnd    93%
  gpt-oss-120b               7.1s       $0.91¢     3.0 rnd    100%
  opus                       6.6s       SUB        2.4 rnd    100%
  gemini-3-pro-preview       40.9s      $0.460     2.4 rnd    52%
  deepseek-v3.2              33.7s      $0.41¢     1.8 rnd    92%
  qwen3-max                  24.6s      $0.046     2.1 rnd    100%
  minimax-m2.1               13.6s      $0.024     2.4 rnd    93%
  kimi-k2-0905               13.4s      $0.027     3.0 rnd    96%
  qwen3-coder                7.9s       $0.012     2.1 rnd    93%
  glm-4.7                    57.2s      $0.085     2.7 rnd    52%
  qwen3-coder-plus           7.0s       $0.042     2.4 rnd    100%
  gemini-3-flash-preview     36.1s      $0.017     3.0 rnd    100%
  gpt-5.2                    36.8s      $0.087     2.7 rnd    100%
  haiku                      3.7s       SUB        2.7 rnd    100%
  gpt-5-mini                 16.0s      $0.060     3.0 rnd    100%
  grok-code-fast-1           39.7s      $0.025     2.4 rnd    96%

Operational metrics (for production decisions):
  • Latency:   Avg generation time (lower = faster)
  • Cost:      Total generation cost (lower = cheaper)
  • Refine:    Avg refinement rounds needed (lower = better first-try quality)
  • Self-Eval: Can model use its own summaries? (internal consistency check)

┌──────────────────────────────────────────────────────────────────────────┐
│                         JUDGE BREAKDOWN                                  │
└──────────────────────────────────────────────────────────────────────────┘

LLM judges rate summary quality on 5 criteria (1-5 scale, shown as %).

  Model                      Pointwise  Pairwise   Combined
  ────────────────────────── ───────── ───────── ─────────
  gpt-5.1-codex-max          87%        69%        78%
  nova-premier-v1            83%        20%        51%
  qwen3-235b-a22b-2507       85%        72%        79%
  gpt-oss-120b               85%        35%        60%
  opus                       88%        53%        71%
  gemini-3-pro-preview       86%        47%        67%
  deepseek-v3.2              86%        63%        74%
  qwen3-max                  86%        81%        84%
  minimax-m2.1               85%        28%        57%
  kimi-k2-0905               85%        50%        67%
  qwen3-coder                83%        30%        57%
  glm-4.7                    87%        32%        60%
  qwen3-coder-plus           83%        61%        72%
  gemini-3-flash-preview     83%        4%         43%
  gpt-5.2                    88%        77%        82%
  haiku                      87%        51%        69%
  gpt-5-mini                 83%        88%        85%
  grok-code-fast-1           83%        29%        56%

┌──────────────────────────────────────────────────────────────────────────┐
│                      SELF-EVALUATION DETAILS                             │
└──────────────────────────────────────────────────────────────────────────┘

Can models effectively use their own summaries for code tasks?

  Model                      Retrieval  Func.Sel.  Overall
  ────────────────────────── ───────── ───────── ─────────
  gpt-5.1-codex-max          93%        100%       96%
  nova-premier-v1            100%       100%       100%
  qwen3-235b-a22b-2507       93%        93%        93%
  gpt-oss-120b               100%       100%       100%
  opus                       100%       100%       100%
  gemini-3-pro-preview       47%        60%        52%
  deepseek-v3.2              87%        100%       92%
  qwen3-max                  100%       100%       100%
  minimax-m2.1               93%        93%        93%
  kimi-k2-0905               93%        100%       96%
  qwen3-coder                93%        93%        93%
  glm-4.7                    33%        80%        52%
  qwen3-coder-plus           100%       100%       100%
  gemini-3-flash-preview     100%       100%       100%
  gpt-5.2                    100%       100%       100%
  haiku                      100%       100%       100%
  gpt-5-mini                 100%       100%       100%
  grok-code-fast-1           93%        100%       96%

┌──────────────────────────────────────────────────────────────────────────┐
│                    ITERATIVE REFINEMENT DETAILS                          │
└──────────────────────────────────────────────────────────────────────────┘

How many refinement rounds were needed to achieve target retrieval rank?

  Model                      Avg Rounds  Success    Score
  ────────────────────────── ────────── ───────── ─────────
  gpt-5.1-codex-max          2.7 rnd     10%        49%
  nova-premier-v1            2.1 rnd     30%        60%
  qwen3-235b-a22b-2507       1.8 rnd     40%        66%
  gpt-oss-120b               3.0 rnd     0%         43%
  opus                       2.4 rnd     20%        54%
  gemini-3-pro-preview       2.4 rnd     20%        54%
  deepseek-v3.2              1.8 rnd     40%        66%
  qwen3-max                  2.1 rnd     30%        60%
  minimax-m2.1               2.4 rnd     20%        54%
  kimi-k2-0905               3.0 rnd     0%         43%
  qwen3-coder                2.1 rnd     30%        60%
  glm-4.7                    2.7 rnd     10%        49%
  qwen3-coder-plus           2.4 rnd     20%        54%
  gemini-3-flash-preview     3.0 rnd     0%         43%
  gpt-5.2                    2.7 rnd     10%        49%
  haiku                      2.7 rnd     10%        49%
  gpt-5-mini                 3.0 rnd     0%         43%
  grok-code-fast-1           2.4 rnd     20%        54%

┌──────────────────────────────────────────────────────────────────────────┐
│                            SUMMARY                                       │
└──────────────────────────────────────────────────────────────────────────┘

  Quality leaders:
    🏆 Overall:   gpt-5.1-codex-max (57%)
    🔍 Retrieval: nova-premier-v1 (27%)
    ⚖️  Contrast:  qwen3-max (92%)
    ⭐ Judge:     gpt-5-mini (85%)

  Operational leaders:
    ⚡ Fastest:  haiku (3.7s)
    💰 Cheapest: deepseek-v3.2 ($0.41¢)

  Benchmark cost:
    💵 Total:    $1.22 (generation only, excludes judge costs)`}
						</div>
					</div>
				</section>

				<hr className="border-white/5" />

				{/* Interpretation & Recommendations */}
				<section className="space-y-8">
					<h2 className="text-3xl font-bold text-white">
						Interpreting Results
					</h2>

					<div className="space-y-6">
						<div>
							<h4 className="text-white font-bold mb-4">
								Cost vs. Quality Tiers
							</h4>
							<div className="grid md:grid-cols-3 gap-6">
								<div className="bg-[#151515] p-5 rounded-lg border border-purple-500/20">
									<div className="text-purple-400 font-bold uppercase text-xs tracking-widest mb-2">
										Tier 1: Max Quality
									</div>
									<ul className="text-sm text-gray-400 space-y-2">
										<li>• GPT-5.1 Codex Max</li>
										<li>• Nova Premier v1</li>
										<li>• ~55-57% Overall Score</li>
									</ul>
								</div>
								<div className="bg-[#151515] p-5 rounded-lg border border-blue-500/20">
									<div className="text-blue-400 font-bold uppercase text-xs tracking-widest mb-2">
										Tier 2: Best Value
									</div>
									<ul className="text-sm text-gray-400 space-y-2">
										<li>• Qwen3 Max</li>
										<li>• Deepseek V3.2</li>
										<li>• High contrast scores at low cost</li>
									</ul>
								</div>
								<div className="bg-[#151515] p-5 rounded-lg border border-green-500/20">
									<div className="text-green-400 font-bold uppercase text-xs tracking-widest mb-2">
										Tier 3: Efficient
									</div>
									<ul className="text-sm text-gray-400 space-y-2">
										<li>• Haiku / Qwen3 Coder</li>
										<li>• Sub-4s Latency</li>
										<li>• Ideal for real-time indexing</li>
									</ul>
								</div>
							</div>
						</div>

						<div>
							<h4 className="text-white font-bold mb-4">Quick Reference</h4>
							<div className="bg-[#0c0c0c] border border-white/10 rounded-lg p-6 font-mono text-xs overflow-x-auto text-gray-400">
								{`# EMBEDDING BENCHMARK
claudemem benchmark                           # Test default models
claudemem benchmark --auto                    # Auto-generate queries
claudemem benchmark --real                    # Use 100 chunks (vs 50)

# LLM BENCHMARK
claudemem benchmark-llm                              # Test defaults
claudemem benchmark-llm --generators="model1,model2" # Test specific models
claudemem benchmark-llm --sample-size=100            # Set sample size

# HISTORY
claudemem benchmark-list                      # List all runs
claudemem benchmark-show RUN_ID               # Show specific run`}
							</div>
						</div>
					</div>
				</section>
			</div>
		</div>
	);
};

export default BenchmarkPage;
