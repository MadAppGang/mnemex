import React, { useState, useEffect } from 'react';
import { TerminalWindow } from './TerminalWindow';
import { SelfLearningDoc } from './docs/SelfLearningDoc';
import { ValidationResultsDoc } from './docs/ValidationResultsDoc';
import { DocTable as Table } from './docs/DocTable';

const DocsPage: React.FC = () => {
  const [activeSection, setActiveSection] = useState<
    'installation' | 'cli' | 'integration' | 'framework-docs' | 'self-learning' | 'validation-results' |
    'comparisons-claude-mem' | 'comparisons-claude-context' | 'comparisons-context-engine' | 'comparisons-greptile' | 'comparisons-brokk' |
    'comparisons-serena' | 'comparisons-amp' | 'comparisons-supermemory'
  >('installation');
  const [expandedCategories, setExpandedCategories] = useState<string[]>(['system', 'comparisons']);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const toggleCategory = (category: string) => {
    setExpandedCategories(prev =>
      prev.includes(category)
        ? prev.filter(c => c !== category)
        : [...prev, category]
    );
  };

  const navItems = [
    { id: 'installation', label: 'Installation & Setup' },
    { id: 'cli', label: 'CLI Usage' },
    { id: 'framework-docs', label: 'Framework Docs' },
    { id: 'integration', label: 'Claude Code Integration' },
  ];

  const systemItems = [
    { id: 'self-learning', label: 'Self-Learning System' },
    { id: 'validation-results', label: 'Validation & Results' },
  ];

  const comparisonItems = [
    { id: 'comparisons-claude-mem', label: 'vs claude-mem ⚠️' },
    { id: 'comparisons-claude-context', label: 'vs claude-context' },
    { id: 'comparisons-context-engine', label: 'vs Context-Engine' },
    { id: 'comparisons-greptile', label: 'vs Greptile' },
    { id: 'comparisons-brokk', label: 'vs Brokk' },
    { id: 'comparisons-serena', label: 'vs Serena' },
    { id: 'comparisons-amp', label: 'vs Amp' },
    { id: 'comparisons-supermemory', label: 'vs Supermemory' },
  ];

  return (
    <div className="pt-28 pb-24 px-4 md:px-8 min-h-screen bg-[#0f0f0f]">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row gap-12">
        
        {/* Sidebar Navigation */}
        <aside className="md:w-64 flex-shrink-0">
          <div className="sticky top-32 space-y-8">
            <div>
              <h3 className="text-sm font-bold text-white uppercase tracking-widest mb-4">Documentation</h3>
              <nav className="flex flex-col space-y-1">
                {navItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setActiveSection(item.id as any)}
                    className={`text-left px-4 py-2 rounded-lg text-sm font-mono transition-colors ${
                      activeSection === item.id
                        ? 'bg-claude-ish/10 text-claude-ish font-bold border border-claude-ish/20'
                        : 'text-gray-500 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}

                {/* Self Improving System Category */}
                <div className="pt-2">
                  <button
                    onClick={() => toggleCategory('system')}
                    className={`w-full text-left px-4 py-2 rounded-lg text-sm font-mono transition-colors flex items-center justify-between ${
                      ['self-learning', 'validation-results'].includes(activeSection)
                        ? 'text-white'
                        : 'text-gray-500 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <span>Self Improving System</span>
                    <svg
                      className={`w-4 h-4 transition-transform ${expandedCategories.includes('system') ? 'rotate-180' : ''}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {expandedCategories.includes('system') && (
                    <div className="ml-4 mt-1 space-y-1 border-l border-white/10 pl-2">
                      {systemItems.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => setActiveSection(item.id as any)}
                          className={`w-full text-left px-3 py-1.5 rounded-lg text-xs font-mono transition-colors ${
                            activeSection === item.id
                              ? 'bg-claude-ish/10 text-claude-ish font-bold border border-claude-ish/20'
                              : 'text-gray-500 hover:text-white hover:bg-white/5'
                          }`}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Comparisons Category */}
                <div className="pt-2">
                  <button
                    onClick={() => toggleCategory('comparisons')}
                    className={`w-full text-left px-4 py-2 rounded-lg text-sm font-mono transition-colors flex items-center justify-between ${
                      activeSection.startsWith('comparisons')
                        ? 'text-white'
                        : 'text-gray-500 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <span>Comparisons</span>
                    <svg
                      className={`w-4 h-4 transition-transform ${expandedCategories.includes('comparisons') ? 'rotate-180' : ''}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {expandedCategories.includes('comparisons') && (
                    <div className="ml-4 mt-1 space-y-1 border-l border-white/10 pl-2">
                      {comparisonItems.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => setActiveSection(item.id as any)}
                          className={`w-full text-left px-3 py-1.5 rounded-lg text-xs font-mono transition-colors ${
                            activeSection === item.id
                              ? 'bg-claude-ish/10 text-claude-ish font-bold border border-claude-ish/20'
                              : 'text-gray-500 hover:text-white hover:bg-white/5'
                          }`}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </nav>
            </div>
            
            <div className="p-4 rounded-xl bg-gradient-to-br from-purple-900/10 to-blue-900/10 border border-white/5 hidden md:block">
                <div className="text-xs text-gray-400 mb-2">Need help?</div>
                <a href="https://github.com/MadAppGang/claudemem/issues" target="_blank" rel="noreferrer" className="text-xs font-bold text-white hover:text-claude-ish flex items-center gap-2">
                    Open an issue <span aria-hidden="true">→</span>
                </a>
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <div className="flex-1 min-w-0">
            {activeSection === 'installation' && (
                <div className="space-y-12 animate-fadeIn">
                    {/* Title */}
                    <div>
                        <h1 className="text-4xl font-black text-white mb-4 tracking-tight">Installation & Setup</h1>
                        <p className="text-xl text-gray-400 leading-relaxed">
                            Local semantic code search for Claude Code. Index your codebase once, search it with natural language.
                        </p>
                    </div>

                    {/* Installation Methods */}
                    <div className="space-y-6">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">1. Install</h2>
                        
                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="space-y-4">
                                <h3 className="text-lg font-bold text-gray-200">NPM (Recommended)</h3>
                                <TerminalWindow title="bash" className="bg-[#0c0c0c]" noPadding>
                                    <div className="p-4 text-sm text-gray-300 font-mono">
                                        <div className="flex gap-2">
                                            <span className="text-claude-ish select-none">$</span>
                                            <span>npm install -g claude-codemem</span>
                                        </div>
                                    </div>
                                </TerminalWindow>
                            </div>

                            <div className="space-y-4">
                                <h3 className="text-lg font-bold text-gray-200">Homebrew (macOS)</h3>
                                <TerminalWindow title="bash" className="bg-[#0c0c0c]" noPadding>
                                    <div className="p-4 text-sm text-gray-300 font-mono">
                                        <div className="flex gap-2">
                                            <span className="text-claude-ish select-none">$</span>
                                            <span>brew tap MadAppGang/claude-mem</span>
                                        </div>
                                        <div className="flex gap-2 mt-2">
                                            <span className="text-claude-ish select-none">$</span>
                                            <span>brew install --cask claudemem</span>
                                        </div>
                                    </div>
                                </TerminalWindow>
                            </div>
                        </div>

                        <div className="mt-4">
                            <h3 className="text-lg font-bold text-gray-200 mb-2">Curl (Linux/macOS)</h3>
                            <div className="bg-[#111] border border-white/10 rounded-lg p-4 font-mono text-sm text-gray-400 break-all">
                                curl -fsSL https://raw.githubusercontent.com/MadAppGang/claudemem/main/install.sh | bash
                            </div>
                        </div>

                        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
                            <h4 className="text-blue-400 font-bold text-sm uppercase tracking-wider mb-2">Requirements</h4>
                            <ul className="list-disc pl-5 text-sm text-gray-300 space-y-1 font-mono">
                                <li>Node.js 18+ (for npm install)</li>
                                <li>macOS 12+ or Linux (glibc 2.31+)</li>
                                <li>An embedding provider (OpenRouter, Ollama, etc.)</li>
                            </ul>
                        </div>
                    </div>

                    {/* Quick Start */}
                    <div className="space-y-6">
                         <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">2. Quick Start</h2>
                         <TerminalWindow title="terminal" className="bg-[#0c0c0c]" noPadding>
                             <div className="p-6 text-sm text-gray-300 font-mono space-y-4">
                                <div>
                                    <div className="text-gray-500 mb-1"># Initialize configuration (select provider)</div>
                                    <div className="flex gap-2">
                                        <span className="text-claude-ish select-none">$</span>
                                        <span>claudemem init</span>
                                    </div>
                                </div>
                                <div>
                                    <div className="text-gray-500 mb-1"># Index your project</div>
                                    <div className="flex gap-2">
                                        <span className="text-claude-ish select-none">$</span>
                                        <span>claudemem index</span>
                                    </div>
                                </div>
                                <div>
                                    <div className="text-gray-500 mb-1"># Search</div>
                                    <div className="flex gap-2">
                                        <span className="text-claude-ish select-none">$</span>
                                        <span>claudemem search "authentication flow"</span>
                                    </div>
                                </div>
                             </div>
                         </TerminalWindow>
                    </div>

                    {/* Embedding Providers */}
                    <div className="space-y-6">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">3. Configure Embeddings</h2>
                        <p className="text-gray-400">claudemem needs an embedding provider to generate vector representations of your code.</p>
                        
                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="bg-[#151515] p-6 rounded-xl border border-white/5 space-y-4">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-lg font-bold text-white">OpenRouter</h3>
                                    <span className="text-[10px] bg-claude-ish/20 text-claude-ish px-2 py-1 rounded border border-claude-ish/30 uppercase font-bold">Recommended</span>
                                </div>
                                <p className="text-sm text-gray-400">Best quality and easiest setup for cloud usage.</p>
                                <div className="bg-black/50 p-3 rounded border border-white/10 font-mono text-xs text-gray-300">
                                    export OPENROUTER_API_KEY="your-key"<br/>
                                    claudemem init <span className="text-gray-500"># select "OpenRouter"</span>
                                </div>
                                <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="text-xs text-claude-ish hover:underline">Get API Key →</a>
                            </div>

                            <div className="bg-[#151515] p-6 rounded-xl border border-white/5 space-y-4">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-lg font-bold text-white">Ollama</h3>
                                    <span className="text-[10px] bg-blue-500/20 text-blue-400 px-2 py-1 rounded border border-blue-500/30 uppercase font-bold">Local & Free</span>
                                </div>
                                <p className="text-sm text-gray-400">Run entirely offline. Requires <a href="https://ollama.ai" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">Ollama</a> installed.</p>
                                <div className="bg-black/50 p-3 rounded border border-white/10 font-mono text-xs text-gray-300">
                                    ollama pull nomic-embed-text<br/>
                                    claudemem init <span className="text-gray-500"># select "Ollama"</span>
                                </div>
                                <div className="text-[10px] text-gray-500 font-mono">
                                    Recommended: nomic-embed-text (768d)
                                </div>
                            </div>
                        </div>
                        
                        <div className="bg-[#151515] p-4 rounded-xl border border-white/5">
                             <h4 className="text-white font-bold text-sm mb-2">Custom Endpoint</h4>
                             <p className="text-xs text-gray-400 mb-2">Compatible with any OpenAI-style embedding endpoint.</p>
                             <div className="font-mono text-xs text-gray-500">claudemem init # select "Custom endpoint"</div>
                        </div>
                    </div>

                    {/* LLM Enrichment */}
                    <div className="space-y-6">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">4. LLM Enrichment</h2>
                        <p className="text-gray-400">
                            Configure which LLM to use for generating semantic summaries. Use the unified spec format: <code className="text-claude-ish">provider/model</code>
                        </p>

                        <div className="overflow-x-auto">
                            <table className="w-full text-left border-collapse font-mono text-sm border border-white/10 rounded-lg">
                                <thead className="bg-[#1a1a1a] text-gray-300">
                                    <tr>
                                        <th className="p-3 border-b border-white/10">Prefix</th>
                                        <th className="p-3 border-b border-white/10">Provider</th>
                                        <th className="p-3 border-b border-white/10">Example</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/5 text-gray-400 bg-[#0c0c0c]">
                                    <tr>
                                        <td className="p-3 text-claude-ish font-bold">cc/</td>
                                        <td className="p-3">Claude Code (Subscription)</td>
                                        <td className="p-3 text-gray-500">cc/sonnet, cc/opus</td>
                                    </tr>
                                    <tr>
                                        <td className="p-3 text-claude-ish font-bold">a/</td>
                                        <td className="p-3">Anthropic API</td>
                                        <td className="p-3 text-gray-500">a/sonnet, a/opus</td>
                                    </tr>
                                    <tr>
                                        <td className="p-3 text-claude-ish font-bold">or/</td>
                                        <td className="p-3">OpenRouter</td>
                                        <td className="p-3 text-gray-500">or/openai/gpt-4o</td>
                                    </tr>
                                    <tr>
                                        <td className="p-3 text-claude-ish font-bold">ollama/</td>
                                        <td className="p-3">Ollama (Local)</td>
                                        <td className="p-3 text-gray-500">ollama/llama3.2</td>
                                    </tr>
                                     <tr>
                                        <td className="p-3 text-claude-ish font-bold">lmstudio/</td>
                                        <td className="p-3">LM Studio (Local)</td>
                                        <td className="p-3 text-gray-500">lmstudio/</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        <div className="bg-[#151515] p-6 rounded-xl border border-white/5 space-y-4">
                            <h3 className="text-lg font-bold text-white">Using Claude Code Subscription</h3>
                            <p className="text-sm text-gray-400">
                                If you have a Claude Pro/Teams subscription via Claude Code CLI, we can use it directly. Zero extra API cost.
                            </p>
                            <div className="bg-black/50 p-4 rounded border border-white/10 font-mono text-sm text-gray-300">
                                <span className="text-claude-ish">export</span> CLAUDEMEM_LLM="cc/sonnet"
                            </div>
                        </div>
                    </div>

                    {/* Reference */}
                     <div className="space-y-6">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Reference</h2>
                        
                        <div className="grid lg:grid-cols-2 gap-8">
                            <div className="space-y-4">
                                <h3 className="text-lg font-bold text-white">Environment Variables</h3>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-left font-mono text-xs border border-white/10 rounded-lg">
                                        <tbody className="divide-y divide-white/5 bg-[#0c0c0c] text-gray-400">
                                            <tr>
                                                <td className="p-3 text-blue-300">OPENROUTER_API_KEY</td>
                                                <td className="p-3">Embeddings + LLM</td>
                                            </tr>
                                            <tr>
                                                <td className="p-3 text-blue-300">ANTHROPIC_API_KEY</td>
                                                <td className="p-3">Anthropic LLM</td>
                                            </tr>
                                            <tr>
                                                <td className="p-3 text-blue-300">VOYAGE_API_KEY</td>
                                                <td className="p-3">Voyage AI embeddings</td>
                                            </tr>
                                            <tr>
                                                <td className="p-3 text-blue-300">CLAUDEMEM_MODEL</td>
                                                <td className="p-3">Override embedding model</td>
                                            </tr>
                                            <tr>
                                                <td className="p-3 text-blue-300">CLAUDEMEM_LLM</td>
                                                <td className="p-3">Enrichment LLM Spec</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            <div className="space-y-4">
                                <h3 className="text-lg font-bold text-white">Config Files</h3>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-left font-mono text-xs border border-white/10 rounded-lg">
                                        <tbody className="divide-y divide-white/5 bg-[#0c0c0c] text-gray-400">
                                            <tr>
                                                <td className="p-3 text-yellow-300">~/.claudemem/config.json</td>
                                                <td className="p-3">Global config</td>
                                            </tr>
                                            <tr>
                                                <td className="p-3 text-yellow-300">.claudemem/</td>
                                                <td className="p-3">Project index (add to .gitignore)</td>
                                            </tr>
                                            <tr>
                                                <td className="p-3 text-yellow-300">claudemem.json</td>
                                                <td className="p-3">Project-specific config</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {activeSection === 'cli' && (
                <div className="space-y-12 animate-fadeIn">
                    <div>
                        <h1 className="text-4xl font-black text-white mb-4 tracking-tight">CLI Reference</h1>
                        <p className="text-xl text-gray-400 leading-relaxed">
                            Complete command-line interface documentation for claudemem.
                        </p>
                    </div>

                    <div className="space-y-6">
                         <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Quick Start</h2>
                         <TerminalWindow title="terminal" className="bg-[#0c0c0c]" noPadding>
                             <div className="p-6 text-sm text-gray-300 font-mono space-y-4">
                                <div><span className="text-gray-500"># 1. First time setup</span></div>
                                <div className="flex gap-2 mb-4"><span className="text-claude-ish">$</span> claudemem init</div>
                                
                                <div><span className="text-gray-500"># 2. Index your project</span></div>
                                <div className="flex gap-2 mb-4"><span className="text-claude-ish">$</span> claudemem index</div>
                                
                                <div><span className="text-gray-500"># 3. Search</span></div>
                                <div className="flex gap-2"><span className="text-claude-ish">$</span> claudemem search "authentication flow"</div>
                             </div>
                         </TerminalWindow>
                    </div>

                    {/* Core Commands */}
                    <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Core Commands</h2>
                        
                        <div className="space-y-4">
                            <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">init</span></h3>
                            <p className="text-gray-400">Configure embedding and LLM providers interactively.</p>
                            <TerminalWindow title="bash" className="bg-[#0c0c0c]" noPadding>
                                <div className="p-4 text-sm text-gray-300 font-mono">
                                    <span className="text-claude-ish">$</span> claudemem init
                                </div>
                            </TerminalWindow>
                        </div>
                        
                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">index</span> <span className="text-gray-500 text-sm">[path]</span></h3>
                             <p className="text-gray-400">Parse and index your codebase for semantic search.</p>
                             <Table 
                                headers={['Flag', 'Description']}
                                rows={[
                                    ['<code class="text-white">-f, --force</code>', 'Force re-index all files (ignore cache)'],
                                    ['<code class="text-white">--no-llm</code>', 'Disable LLM enrichment (faster, code-only)'],
                                ]}
                             />
                        </div>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">search</span> <span className="text-gray-500 text-sm">&lt;query&gt;</span></h3>
                             <p className="text-gray-400">Search indexed code using natural language queries.</p>
                             <Table 
                                headers={['Flag', 'Description']}
                                rows={[
                                    ['<code class="text-white">-n, --limit &lt;n&gt;</code>', 'Maximum results (default: 10)'],
                                    ['<code class="text-white">-l, --language &lt;lang&gt;</code>', 'Filter by programming language'],
                                    ['<code class="text-white">--no-reindex</code>', 'Skip auto-reindexing changed files'],
                                    ['<code class="text-white">-k, --keyword</code>', 'Keyword-only search (BM25, no embeddings)'],
                                ]}
                             />
                        </div>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">status</span></h3>
                             <p className="text-gray-400">Display information about the current index size, chunks, and embedding model.</p>
                        </div>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">clear</span></h3>
                             <p className="text-gray-400">Remove all indexed data for a project.</p>
                        </div>
                    </div>

                    {/* Symbol Graph Commands */}
                    <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Symbol Graph Commands</h2>
                        <p className="text-gray-400">Query the dependency graph directly. Optimized for agent use.</p>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">map</span> <span className="text-gray-500 text-sm">[query]</span></h3>
                             <p className="text-gray-400">Get a high-level map of the codebase prioritized by PageRank.</p>
                             <div className="font-mono text-sm bg-black/30 p-3 rounded border border-white/10 text-gray-300">
                                <span className="text-claude-ish">$</span> claudemem map "auth"
                             </div>
                        </div>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">callers</span> <span className="text-gray-500 text-sm">&lt;symbol&gt;</span></h3>
                             <p className="text-gray-400">Find what code calls or references a specific symbol.</p>
                        </div>
                        
                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">callees</span> <span className="text-gray-500 text-sm">&lt;symbol&gt;</span></h3>
                             <p className="text-gray-400">Find what dependencies a symbol uses.</p>
                        </div>
                    </div>

                    {/* Code Analysis */}
                    <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Code Analysis</h2>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">dead-code</span></h3>
                             <p className="text-gray-400">Detect potentially dead code (zero callers + low PageRank).</p>
                             <Table 
                                headers={['Flag', 'Description']}
                                rows={[
                                    ['<code class="text-white">--max-pagerank &lt;n&gt;</code>', 'PageRank threshold (default: 0.001)'],
                                    ['<code class="text-white">--include-exported</code>', 'Include exported symbols'],
                                ]}
                             />
                        </div>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">test-gaps</span></h3>
                             <p className="text-gray-400">Find high-importance code that lacks test coverage.</p>
                        </div>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">impact</span> <span className="text-gray-500 text-sm">&lt;symbol&gt;</span></h3>
                             <p className="text-gray-400">Analyze the "blast radius" of changing a symbol.</p>
                        </div>
                    </div>

                    {/* Learning Commands */}
                    <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Learning Commands</h2>
                        <p className="text-gray-400">Adaptive ranking that improves with your search feedback over time.</p>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">feedback</span></h3>
                             <p className="text-gray-400">Report search feedback to improve ranking quality.</p>
                             <div className="font-mono text-sm bg-black/30 p-3 rounded border border-white/10 text-gray-300">
                                <span className="text-claude-ish">$</span> claudemem feedback --query "auth" --helpful chunk1,chunk2 --unhelpful chunk3
                             </div>
                             <Table
                                headers={['Flag', 'Description']}
                                rows={[
                                    ['<code class="text-white">--query &lt;text&gt;</code>', 'The search query that produced these results'],
                                    ['<code class="text-white">--helpful &lt;ids&gt;</code>', 'Comma-separated chunk IDs that were helpful'],
                                    ['<code class="text-white">--unhelpful &lt;ids&gt;</code>', 'Comma-separated chunk IDs that were not relevant'],
                                ]}
                             />
                        </div>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">learn</span> <span className="text-gray-500 text-sm">&lt;action&gt;</span></h3>
                             <p className="text-gray-400">View or manage learning statistics.</p>
                             <div className="font-mono text-sm bg-black/30 p-3 rounded border border-white/10 text-gray-300 space-y-1">
                                <div><span className="text-claude-ish">$</span> claudemem learn stats <span className="text-gray-500"># View current weights and statistics</span></div>
                                <div><span className="text-claude-ish">$</span> claudemem learn reset <span className="text-gray-500"># Reset all learned weights</span></div>
                             </div>
                        </div>

                        <div className="bg-[#151515] border border-white/5 rounded-lg p-5 mt-4">
                            <div className="text-xs text-claude-ish font-bold uppercase tracking-widest mb-2">How Learning Works</div>
                            <p className="text-sm text-gray-400">
                                claudemem uses <strong className="text-white">Exponential Moving Average (EMA)</strong> to adapt search ranking weights based on your feedback.
                                When you mark results as helpful or unhelpful, the system learns which document types, files, and vector/BM25 balance work best for your codebase.
                                After ~5 feedback events, you'll notice improved relevance in search results.
                            </p>
                        </div>
                    </div>

                    {/* Benchmark Commands */}
                    <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Benchmark Commands</h2>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">benchmark</span></h3>
                             <p className="text-gray-400">Compare embedding models for speed and quality on your code.</p>
                             <div className="font-mono text-sm bg-black/30 p-3 rounded border border-white/10 text-gray-300">
                                <span className="text-claude-ish">$</span> claudemem benchmark --models=voyage-code-3,openai/text-embedding-3-small
                             </div>
                        </div>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">benchmark-llm</span></h3>
                             <p className="text-gray-400">Evaluate LLM summarizer quality using LLM-as-a-Judge.</p>
                             <Table 
                                headers={['Flag', 'Description']}
                                rows={[
                                    ['<code class="text-white">--generators=&lt;list&gt;</code>', 'Models to test (comma-separated)'],
                                    ['<code class="text-white">--judges=&lt;list&gt;</code>', 'Judge models for evaluation'],
                                    ['<code class="text-white">--local-parallelism=&lt;n&gt;</code>', 'Concurrency for local models'],
                                ]}
                             />
                        </div>
                    </div>

                     {/* Server Modes */}
                     <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Server Modes</h2>
                        
                        <div className="space-y-4">
                            <h3 className="text-xl font-bold text-white font-mono">MCP Server</h3>
                            <p className="text-gray-400">Run as a Model Context Protocol server for Claude Code.</p>
                            <TerminalWindow title="bash" className="bg-[#0c0c0c]" noPadding>
                                <div className="p-4 text-sm text-gray-300 font-mono">
                                    <span className="text-claude-ish">$</span> claudemem --mcp
                                </div>
                            </TerminalWindow>
                        </div>

                        <div className="space-y-4">
                            <h3 className="text-xl font-bold text-white font-mono">Autocomplete Server</h3>
                            <p className="text-gray-400">Run a JSONL server for editor autocomplete.</p>
                            <TerminalWindow title="bash" className="bg-[#0c0c0c]" noPadding>
                                <div className="p-4 text-sm text-gray-300 font-mono">
                                    <span className="text-claude-ish">$</span> claudemem --autocomplete-server --project .
                                </div>
                            </TerminalWindow>
                        </div>
                    </div>

                    {/* Developer Experience */}
                    <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Developer Experience</h2>
                        
                        <div className="grid md:grid-cols-2 gap-8">
                            <div className="space-y-4">
                                <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">watch</span></h3>
                                <p className="text-gray-400">Run in daemon mode, watching for file changes.</p>
                                <div className="font-mono text-sm bg-black/30 p-3 rounded border border-white/10 text-gray-300">
                                    <span className="text-claude-ish">$</span> claudemem watch
                                </div>
                            </div>
                            
                            <div className="space-y-4">
                                <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">hooks</span></h3>
                                <p className="text-gray-400">Install git post-commit hook for auto-indexing.</p>
                                <div className="font-mono text-sm bg-black/30 p-3 rounded border border-white/10 text-gray-300">
                                    <span className="text-claude-ish">$</span> claudemem hooks install
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Agent Instructions */}
                     <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">AI Agent Instructions</h2>
                         <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">ai</span> <span className="text-gray-500 text-sm">&lt;role&gt;</span></h3>
                             <p className="text-gray-400">Get role-based prompts to teach agents how to use claudemem.</p>
                             <Table 
                                headers={['Role', 'Description']}
                                rows={[
                                    ['<code class="text-white">skill</code>', 'Full tool skill documentation'],
                                    ['<code class="text-white">architect</code>', 'System design & dead-code detection'],
                                    ['<code class="text-white">developer</code>', 'Implementation & impact analysis'],
                                    ['<code class="text-white">tester</code>', 'Test coverage planning'],
                                ]}
                             />
                             <div className="mt-4 font-mono text-sm bg-black/30 p-3 rounded border border-white/10 text-gray-300">
                                <span className="text-gray-500"># Append to CLAUDE.md for Claude Code</span><br/>
                                <span className="text-claude-ish">$</span> claudemem ai skill --raw &gt;&gt; CLAUDE.md
                             </div>
                        </div>
                    </div>

                    {/* Environment Variables */}
                    <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Configuration</h2>
                        <h3 className="text-lg font-bold text-white mb-2">Environment Variables</h3>
                        <div className="overflow-x-auto">
                            <table className="w-full text-left font-mono text-xs border border-white/10 rounded-lg">
                                <thead className="bg-[#1a1a1a] text-gray-300">
                                    <tr>
                                        <th className="p-3 border-b border-white/10">Variable</th>
                                        <th className="p-3 border-b border-white/10">Description</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/5 bg-[#0c0c0c] text-gray-400">
                                    <tr>
                                        <td className="p-3 text-blue-300">OPENROUTER_API_KEY</td>
                                        <td className="p-3">API key for OpenRouter (embeddings + LLM)</td>
                                    </tr>
                                    <tr>
                                        <td className="p-3 text-blue-300">ANTHROPIC_API_KEY</td>
                                        <td className="p-3">API key for Anthropic LLM</td>
                                    </tr>
                                    <tr>
                                        <td className="p-3 text-blue-300">VOYAGE_API_KEY</td>
                                        <td className="p-3">API key for Voyage AI embeddings</td>
                                    </tr>
                                    <tr>
                                        <td className="p-3 text-blue-300">CLAUDEMEM_MODEL</td>
                                        <td className="p-3">Override embedding model</td>
                                    </tr>
                                    <tr>
                                        <td className="p-3 text-blue-300">CLAUDEMEM_LLM</td>
                                        <td className="p-3">LLM spec for enrichment</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                        
                        <h3 className="text-lg font-bold text-white mt-8 mb-2">Supported Languages</h3>
                        <p className="text-sm text-gray-400 mb-4">Full AST-aware parsing is available for:</p>
                        <div className="flex flex-wrap gap-2 font-mono text-xs">
                            {['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'C', 'C++', 'Java'].map(lang => (
                                <span key={lang} className="bg-white/10 text-white px-2 py-1 rounded">{lang}</span>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {activeSection === 'integration' && (
                <div className="space-y-12 animate-fadeIn">
                     {/* Title */}
                     <div>
                        <h1 className="text-4xl font-black text-white mb-4 tracking-tight">Integration Guide</h1>
                        <p className="text-xl text-gray-400 leading-relaxed">
                            Complete guide for using claudemem with Claude Code and the Code Analysis Plugin.
                        </p>
                    </div>

                    {/* Overview & Diagram */}
                    <div className="space-y-6">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Overview</h2>
                        <div className="grid lg:grid-cols-2 gap-8 items-start">
                             <div className="space-y-4">
                                 <p className="text-gray-400 text-sm leading-relaxed">
                                     When combined with the <strong>Code Analysis Plugin</strong>, claudemem gives Claude "detective skills" to navigate your codebase. Instead of guessing files or running grep, it can trace calls, find definitions, and understand architecture.
                                 </p>
                                 <Table 
                                    headers={['Component', 'Purpose']}
                                    rows={[
                                        ['<strong class="text-white">claudemem CLI</strong>', 'Local semantic search engine & graph builder'],
                                        ['<strong class="text-white">Code Analysis Plugin</strong>', 'Claude Code plugin with detective skills'],
                                        ['<strong class="text-white">Detective Skills</strong>', 'Role-based patterns (Architect, Debugger, etc.)'],
                                    ]}
                                 />
                             </div>
                             <div className="bg-[#0c0c0c] border border-white/10 rounded-lg p-4 font-mono text-[10px] text-gray-400 overflow-x-auto leading-relaxed whitespace-pre shadow-2xl">
{`┌────────────────────────────────────────────────────────┐
│               CLAUDE CODE + CLAUDEMEM                  │
├────────────────────────────────────────────────────────┤
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │                  CLAUDE CODE                     │  │
│  │ User Query → Plugin → Detective Skill            │  │
│  └──────────────────────────────────────────────────┘  │
│                           ↓                            │
│  ┌──────────────────────────────────────────────────┐  │
│  │                 CLAUDEMEM CLI                    │  │
│  │ map | symbol | callers | callees | search        │  │
│  └──────────────────────────────────────────────────┘  │
│                           ↓                            │
│  ┌──────────────────────────────────────────────────┐  │
│  │                  LOCAL INDEX                     │  │
│  │ AST Parse → PageRank → Vector DB                 │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘`}
                             </div>
                        </div>
                    </div>

                    {/* Quick Start */}
                    <div className="space-y-6">
                         <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Quick Start</h2>
                         
                         <div className="space-y-4">
                             <h3 className="text-lg font-bold text-white">1. Install & Index</h3>
                             <TerminalWindow title="terminal" className="bg-[#0c0c0c]" noPadding>
                                 <div className="p-4 text-sm text-gray-300 font-mono space-y-2">
                                     <div><span className="text-claude-ish">$</span> npm install -g claude-codemem</div>
                                     <div><span className="text-claude-ish">$</span> claudemem init</div>
                                     <div><span className="text-claude-ish">$</span> claudemem index</div>
                                 </div>
                             </TerminalWindow>
                         </div>

                         <div className="space-y-6">
                             <h3 className="text-lg font-bold text-white">2. Install Plugin</h3>
                             
                             <div className="space-y-4">
                                 <div className="bg-[#151515] border border-white/5 rounded-xl p-6">
                                     <div className="flex items-center gap-4 mb-4">
                                         <div className="w-6 h-6 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center font-bold text-xs">1</div>
                                         <h4 className="font-bold text-white text-sm">Add Marketplace (Global)</h4>
                                     </div>
                                     <TerminalWindow title="claude" className="bg-[#0c0c0c]" noPadding>
                                         <div className="p-3 text-xs text-gray-300 font-mono">
                                             <span className="text-purple-400">/plugin</span> marketplace add MadAppGang/claude-code
                                         </div>
                                     </TerminalWindow>
                                 </div>

                                 <div className="bg-[#151515] border border-white/5 rounded-xl p-6">
                                     <div className="flex items-center gap-4 mb-4">
                                         <div className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center font-bold text-xs">2</div>
                                         <h4 className="font-bold text-white text-sm">Enable for Project</h4>
                                     </div>
                                     <p className="text-xs text-gray-400 mb-2 font-mono">.claude/settings.json</p>
                                     <div className="bg-[#0c0c0c] border border-white/10 rounded-lg p-3 font-mono text-xs text-blue-300">
{`{
  "enabledPlugins": {
    "code-analysis@mag-claude-plugins": true
  }
}`}
                                     </div>
                                 </div>
                                 
                                 <div className="bg-[#151515] border border-white/5 rounded-xl p-6">
                                     <div className="flex items-center gap-4 mb-4">
                                         <div className="w-6 h-6 rounded-full bg-green-500/20 text-green-400 flex items-center justify-center font-bold text-xs">3</div>
                                         <h4 className="font-bold text-white text-sm">Update</h4>
                                     </div>
                                     <TerminalWindow title="claude" className="bg-[#0c0c0c]" noPadding>
                                         <div className="p-3 text-xs text-gray-300 font-mono">
                                             <span className="text-purple-400">/plugin</span> marketplace update mag-claude-plugins
                                         </div>
                                     </TerminalWindow>
                                 </div>
                             </div>
                             
                             <div className="bg-blue-500/10 border border-blue-500/20 p-4 rounded-lg mt-4">
                                 <h4 className="text-blue-400 text-xs font-bold uppercase tracking-widest mb-1">Why this flow?</h4>
                                 <p className="text-xs text-gray-300 leading-relaxed">
                                     Marketplace registration is one-time per developer. Plugin enablement is per-project via <code className="bg-blue-500/20 px-1 rounded">settings.json</code>, ensuring your whole team gets the same tools automatically.
                                 </p>
                             </div>
                         </div>

                         <div className="bg-claude-ish/10 border border-claude-ish/20 p-4 rounded-lg">
                             <p className="text-sm text-gray-300">
                                 <strong className="text-claude-ish">That's it!</strong> Now just ask natural questions like <em>"How does auth work?"</em> or <em>"Find usages of User class"</em>.
                             </p>
                         </div>
                    </div>

                    {/* Detective Skills */}
                    <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Detective Skills</h2>
                        <p className="text-gray-400">
                            The plugin automatically selects the right "detective" based on your question.
                        </p>

                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="bg-[#151515] p-5 rounded-xl border border-white/5 space-y-3">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-lg font-bold text-white">developer-detective</h3>
                                    <span className="text-[10px] bg-blue-500/20 text-blue-400 px-2 py-1 rounded border border-blue-500/30 uppercase font-bold">Implementation</span>
                                </div>
                                <p className="text-sm text-gray-400">Traces code execution and implementation details.</p>
                                <div className="text-xs font-mono text-gray-500 bg-black/30 p-2 rounded">
                                    "How does X work?" • "Trace data flow"
                                </div>
                            </div>

                            <div className="bg-[#151515] p-5 rounded-xl border border-white/5 space-y-3">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-lg font-bold text-white">architect-detective</h3>
                                    <span className="text-[10px] bg-purple-500/20 text-purple-400 px-2 py-1 rounded border border-purple-500/30 uppercase font-bold">Structure</span>
                                </div>
                                <p className="text-sm text-gray-400">Analyzes system design, layers, and dead code.</p>
                                <div className="text-xs font-mono text-gray-500 bg-black/30 p-2 rounded">
                                    "Map the system" • "Find dead code"
                                </div>
                            </div>

                            <div className="bg-[#151515] p-5 rounded-xl border border-white/5 space-y-3">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-lg font-bold text-white">tester-detective</h3>
                                    <span className="text-[10px] bg-green-500/20 text-green-400 px-2 py-1 rounded border border-green-500/30 uppercase font-bold">Coverage</span>
                                </div>
                                <p className="text-sm text-gray-400">Identifies test gaps in critical code.</p>
                                <div className="text-xs font-mono text-gray-500 bg-black/30 p-2 rounded">
                                    "What is untested?" • "Coverage analysis"
                                </div>
                            </div>

                            <div className="bg-[#151515] p-5 rounded-xl border border-white/5 space-y-3">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-lg font-bold text-white">debugger-detective</h3>
                                    <span className="text-[10px] bg-red-500/20 text-red-500 px-2 py-1 rounded border border-red-500/30 uppercase font-bold">Fixing</span>
                                </div>
                                <p className="text-sm text-gray-400">Investigates bugs by tracing error paths.</p>
                                <div className="text-xs font-mono text-gray-500 bg-black/30 p-2 rounded">
                                    "Why is X broken?" • "Trace error"
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Workflows */}
                    <div className="space-y-8">
                         <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Workflow Examples</h2>
                         
                         <div className="space-y-6">
                             <div>
                                 <h3 className="text-lg font-bold text-white mb-2">Refactoring Safely</h3>
                                 <div className="bg-[#0c0c0c] border border-white/10 rounded-lg p-4 font-mono text-sm space-y-2">
                                     <div className="flex gap-2">
                                         <span className="text-claude-ish">User:</span>
                                         <span className="text-gray-300">"I want to rename DatabaseConnection to DatabasePool"</span>
                                     </div>
                                     <div className="w-full h-[1px] bg-white/5 my-2"></div>
                                     <div className="text-gray-500 italic">Claude Actions:</div>
                                     <div className="text-blue-300">1. claudemem symbol DatabaseConnection</div>
                                     <div className="text-blue-300">2. claudemem callers DatabaseConnection</div>
                                     <div className="text-gray-400 pl-4">→ Finds 12 usages in 5 files</div>
                                     <div className="text-blue-300">3. [Edits files]</div>
                                 </div>
                             </div>

                             <div>
                                 <h3 className="text-lg font-bold text-white mb-2">Understanding Architecture</h3>
                                 <div className="bg-[#0c0c0c] border border-white/10 rounded-lg p-4 font-mono text-sm space-y-2">
                                     <div className="flex gap-2">
                                         <span className="text-claude-ish">User:</span>
                                         <span className="text-gray-300">"How is the payment flow structured?"</span>
                                     </div>
                                     <div className="w-full h-[1px] bg-white/5 my-2"></div>
                                     <div className="text-gray-500 italic">Claude Actions:</div>
                                     <div className="text-blue-300">1. claudemem map "payment flow"</div>
                                     <div className="text-gray-400 pl-4">→ Identifies PaymentService (Rank 0.8) and StripeAdapter (Rank 0.4)</div>
                                     <div className="text-blue-300">2. claudemem callees PaymentService</div>
                                     <div className="text-gray-400 pl-4">→ Maps dependencies: User, Config, StripeAdapter</div>
                                 </div>
                             </div>
                         </div>
                    </div>

                    {/* Best Practices */}
                    <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Best Practices</h2>
                        <div className="grid md:grid-cols-2 gap-8">
                            <div className="space-y-4">
                                <h3 className="text-lg font-bold text-[#3fb950] flex items-center gap-2">
                                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg>
                                    DO
                                </h3>
                                <ul className="space-y-3 text-sm text-gray-400">
                                    <li className="flex gap-2"><span className="text-[#3fb950]">•</span> Start with <code>claudemem map</code> to get the big picture.</li>
                                    <li className="flex gap-2"><span className="text-[#3fb950]">•</span> Check <code>callers</code> before changing any shared code.</li>
                                    <li className="flex gap-2"><span className="text-[#3fb950]">•</span> Focus on high PageRank symbols ({">"} 0.05) first.</li>
                                    <li className="flex gap-2"><span className="text-[#3fb950]">•</span> Use <code>--nologo --raw</code> in scripts/hooks.</li>
                                </ul>
                            </div>
                            <div className="space-y-4">
                                <h3 className="text-lg font-bold text-[#ff5f56] flex items-center gap-2">
                                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                                    DON'T
                                </h3>
                                <ul className="space-y-3 text-sm text-gray-400">
                                    <li className="flex gap-2"><span className="text-[#ff5f56]">•</span> Don't use <code>grep</code> for concept searches.</li>
                                    <li className="flex gap-2"><span className="text-[#ff5f56]">•</span> Don't read entire files when you only need a function.</li>
                                    <li className="flex gap-2"><span className="text-[#ff5f56]">•</span> Don't modify code without checking <code>impact</code>.</li>
                                </ul>
                            </div>
                        </div>
                    </div>

                    {/* Requirements */}
                     <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Requirements</h2>
                         <div className="overflow-x-auto">
                            <table className="w-full text-left font-mono text-sm border border-white/10 rounded-lg">
                                <thead className="bg-[#1a1a1a] text-gray-300">
                                    <tr>
                                        <th className="p-3 border-b border-white/10">Requirement</th>
                                        <th className="p-3 border-b border-white/10">Version</th>
                                        <th className="p-3 border-b border-white/10">Notes</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/5 bg-[#0c0c0c] text-gray-400">
                                    <tr>
                                        <td className="p-3 text-white">claudemem</td>
                                        <td className="p-3">0.3.0+</td>
                                        <td className="p-3">Core commands (map, symbol)</td>
                                    </tr>
                                    <tr>
                                        <td className="p-3 text-white">Claude Code</td>
                                        <td className="p-3">Latest</td>
                                        <td className="p-3">Plugin support required</td>
                                    </tr>
                                    <tr>
                                        <td className="p-3 text-white">Node.js</td>
                                        <td className="p-3">18+</td>
                                        <td className="p-3">For installation</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>

                </div>
            )}

            {/* claude-context Comparison */}
            {activeSection === 'comparisons-claude-context' && (
                <div className="space-y-12 animate-fadeIn">
                    <div>
                        <div className="flex items-center gap-3 mb-4">
                            <span className="text-xs bg-white/10 text-gray-400 px-2 py-1 rounded font-mono">Comparisons</span>
                            <span className="text-gray-600">/</span>
                        </div>
                        <h1 className="text-4xl font-black text-white mb-4 tracking-tight">claudemem vs claude-context</h1>
                        <p className="text-xl text-gray-400 leading-relaxed">
                            Local-first embedded storage vs cloud-dependent MCP server.
                        </p>
                    </div>

                    <div className="bg-gradient-to-br from-purple-900/10 to-blue-900/10 border border-white/10 rounded-xl p-6">
                        <p className="text-gray-400 leading-relaxed">
                            <strong className="text-white">claude-context</strong> (<a href="https://github.com/zilliztech/claude-context" className="text-blue-400 hover:underline" target="_blank" rel="noreferrer">~4,900 ★ GitHub</a>, MIT) by Zilliz is a semantic code search MCP server using Milvus/Zilliz Cloud for vectors.
                            <strong className="text-white"> claudemem</strong> uses embedded LanceDB — no cloud signup required, fully local operation possible.
                        </p>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Architecture Philosophy</h3>
                        <Table
                            headers={['Aspect', 'claudemem', 'claude-context (Zilliz)']}
                            rows={[
                                ['<strong class="text-white">Vector Database</strong>', '<span class="text-green-400">LanceDB (embedded, local)</span>', '<span class="text-yellow-400">Milvus / Zilliz Cloud (external)</span>'],
                                ['<strong class="text-white">Cloud Dependency</strong>', '<span class="text-green-400">None (fully local possible)</span>', '<span class="text-yellow-400">Requires Zilliz Cloud + OpenAI signup</span>'],
                                ['<strong class="text-white">Embedding Provider</strong>', 'OpenRouter, Ollama, or custom', 'OpenAI, VoyageAI, Gemini, Ollama'],
                                ['<strong class="text-white">Language</strong>', 'TypeScript (Bun)', 'TypeScript monorepo (3 packages)'],
                                ['<strong class="text-white">Interface</strong>', '<span class="text-green-400">CLI + MCP server</span>', 'MCP server only'],
                            ]}
                        />
                        <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4 mt-4">
                            <div className="text-xs text-green-400 font-bold uppercase tracking-widest mb-2">claudemem's Key Advantage</div>
                            <p className="text-sm text-gray-400">
                                <strong className="text-white">Zero cloud signup required.</strong> claudemem works out-of-the-box with embedded LanceDB.
                                claude-context requires creating accounts on both Zilliz Cloud and OpenAI before first use.
                            </p>
                        </div>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Code Understanding</h3>
                        <Table
                            headers={['Feature', 'claudemem', 'claude-context']}
                            rows={[
                                ['<strong class="text-white">AST Parsing</strong>', 'Tree-sitter (12+ languages)', 'Tree-sitter (9 languages)'],
                                ['<strong class="text-white">Chunking</strong>', 'Functions, classes, methods', 'Functions, classes, methods (2,500 char default)'],
                                ['<strong class="text-white">Hybrid Search</strong>', '<span class="text-green-400">BM25 + vector</span>', '<span class="text-green-400">BM25 + vector + RRF reranking</span>'],
                                ['<strong class="text-white">Symbol Graph</strong>', '<span class="text-green-400">✓ PageRank-ranked</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">Dead Code Detection</strong>', '<span class="text-green-400">✓ Built-in</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">Test Gap Analysis</strong>', '<span class="text-green-400">✓ Built-in</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">Impact Analysis</strong>', '<span class="text-green-400">✓ Transitive callers</span>', '<span class="text-gray-500">✗</span>'],
                            ]}
                        />
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Developer Experience</h3>
                        <Table
                            headers={['Feature', 'claudemem', 'claude-context']}
                            rows={[
                                ['<strong class="text-white">Installation</strong>', '<span class="text-green-400">npm install -g claude-codemem</span>', 'npx + Zilliz Cloud signup + OpenAI key'],
                                ['<strong class="text-white">CLI Commands</strong>', '<span class="text-green-400">map, symbol, callers, callees, context, dead-code, test-gaps</span>', '<span class="text-gray-500">None (MCP only)</span>'],
                                ['<strong class="text-white">MCP Tools</strong>', '4 tools', '4 tools (index, search, status, clear)'],
                                ['<strong class="text-white">Git Hooks</strong>', '<span class="text-green-400">✓ Post-commit auto-index</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">Watch Mode</strong>', '<span class="text-green-400">✓ Native fs.watch</span>', 'Merkle tree change detection'],
                                ['<strong class="text-white">VS Code Extension</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ semanticcodesearch</span>'],
                            ]}
                        />
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Pricing & Requirements</h3>
                        <Table
                            headers={['Aspect', 'claudemem', 'claude-context']}
                            rows={[
                                ['<strong class="text-white">License</strong>', '<span class="text-green-400">MIT</span>', '<span class="text-green-400">MIT</span>'],
                                ['<strong class="text-white">Cost</strong>', '<span class="text-green-400">Free (API costs optional)</span>', 'Free tier + OpenAI API costs'],
                                ['<strong class="text-white">Required Accounts</strong>', '<span class="text-green-400">None (Ollama local option)</span>', '<span class="text-yellow-400">Zilliz Cloud + OpenAI (minimum)</span>'],
                                ['<strong class="text-white">Node.js Version</strong>', 'Any (Bun preferred)', '>=20.0.0 and <24.0.0'],
                            ]}
                        />
                    </div>

                    <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4">
                        <div className="text-xs text-yellow-400 font-bold uppercase tracking-widest mb-2">Known claude-context Limitation</div>
                        <p className="text-sm text-gray-400">
                            <a href="https://github.com/zilliztech/claude-context/issues/226" className="text-blue-400 hover:underline" target="_blank" rel="noreferrer">GitHub Issue #226</a>: search_code may fail with "codebase not indexed" despite successful indexing.
                            Workaround involves re-indexing or clearing cache.
                        </p>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">When to Use Each</h3>
                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="bg-claude-ish/10 border border-claude-ish/20 rounded-xl p-6">
                                <h4 className="text-lg font-bold text-white mb-3">Choose claudemem</h4>
                                <ul className="space-y-2 text-sm text-gray-300">
                                    <li>• Zero-config, instant setup</li>
                                    <li>• Air-gapped / privacy-first environments</li>
                                    <li>• Need CLI tools (map, callers, dead-code)</li>
                                    <li>• Symbol graph with PageRank analysis</li>
                                    <li>• No cloud account requirements</li>
                                </ul>
                            </div>
                            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-6">
                                <h4 className="text-lg font-bold text-white mb-3">Choose claude-context</h4>
                                <ul className="space-y-2 text-sm text-gray-300">
                                    <li>• Already using Zilliz Cloud / Milvus</li>
                                    <li>• Want VS Code extension integration</li>
                                    <li>• Prefer cloud-managed vector storage</li>
                                    <li>• Need RRF (Reciprocal Rank Fusion) reranking</li>
                                    <li>• Team sharing via cloud collections</li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {activeSection === 'comparisons-context-engine' && (
                <div className="space-y-12 animate-fadeIn">
                    {/* Title */}
                    <div>
                        <div className="flex items-center gap-3 mb-4">
                            <span className="text-xs bg-white/10 text-gray-400 px-2 py-1 rounded font-mono">Comparisons</span>
                            <span className="text-gray-600">/</span>
                        </div>
                        <h1 className="text-4xl font-black text-white mb-4 tracking-tight">claudemem vs Context-Engine</h1>
                        <p className="text-xl text-gray-400 leading-relaxed">
                            How claudemem compares to Context-Engine for code intelligence.
                        </p>
                    </div>

                    {/* Context-Engine Comparison */}
                    <div className="space-y-8">

                        <div className="bg-gradient-to-br from-purple-900/10 to-blue-900/10 border border-white/10 rounded-xl p-6">
                            <p className="text-gray-400 leading-relaxed">
                                <strong className="text-white">Context-Engine</strong> (<a href="https://github.com/m1rl0k/Context-Engine" className="text-blue-400 hover:underline" target="_blank" rel="noreferrer">177 ★ GitHub</a>, MIT license) is a Python-based MCP retrieval stack with ReFRAG micro-chunking and 6 Docker services.
                                <strong className="text-white"> claudemem</strong> takes a different approach: single-binary, local-first with embedded LanceDB and PageRank symbol graphs.
                            </p>
                        </div>

                        {/* Architecture Philosophy */}
                        <div className="space-y-4">
                            <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Architecture Philosophy</h3>
                            <Table
                                headers={['Aspect', 'claudemem', 'Context-Engine']}
                                rows={[
                                    ['<strong class="text-white">Language</strong>', '<span class="text-claude-ish">TypeScript (Bun runtime)</span>', 'Python (86.4%), JavaScript (9.8%)'],
                                    ['<strong class="text-white">Deployment</strong>', '<span class="text-green-400">Single binary, zero Docker</span>', 'Docker Compose (6 services: Indexer, Memory, Qdrant, Upload, LLM, Learning)'],
                                    ['<strong class="text-white">Vector DB</strong>', '<span class="text-blue-400">LanceDB (embedded, local)</span>', 'Qdrant (dedicated container, port 6333)'],
                                    ['<strong class="text-white">Protocols</strong>', 'stdio (MCP standard)', 'SSE + RMCP (dual endpoint)'],
                                    ['<strong class="text-white">Complexity</strong>', 'Minimal — one process', 'Multi-service orchestration with health checks'],
                                ]}
                            />
                            <div className="bg-[#151515] border border-white/5 rounded-lg p-4 mt-4">
                                <div className="text-xs text-claude-ish font-bold uppercase tracking-widest mb-2">Design Philosophy</div>
                                <p className="text-sm text-gray-400">
                                    claudemem follows the <strong className="text-white">"SQLite philosophy"</strong> — a single embedded solution that just works.
                                    Context-Engine follows a microservices approach with specialized components. Both are valid but target different user profiles.
                                </p>
                            </div>
                        </div>

                        {/* Code Understanding */}
                        <div className="space-y-4">
                            <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Code Understanding</h3>
                            <Table
                                headers={['Feature', 'claudemem', 'Context-Engine']}
                                rows={[
                                    ['<strong class="text-white">Chunking</strong>', '<span class="text-claude-ish">Tree-sitter AST (functions/classes)</span>', '<span class="text-blue-400">ReFRAG micro-chunking (5-50 lines) with 30x TTFT acceleration</span>'],
                                    ['<strong class="text-white">Symbol Analysis</strong>', '<span class="text-green-400">PageRank graph with callers/callees</span>', 'Workspace-aware query collection'],
                                    ['<strong class="text-white">Dead Code Detection</strong>', '<span class="text-green-400">✓ Built-in</span>', '<span class="text-gray-500">✗</span>'],
                                    ['<strong class="text-white">Test Gap Analysis</strong>', '<span class="text-green-400">✓ Built-in</span>', '<span class="text-gray-500">✗</span>'],
                                    ['<strong class="text-white">Impact Analysis</strong>', '<span class="text-green-400">✓ Transitive callers</span>', '<span class="text-gray-500">✗</span>'],
                                ]}
                            />
                            <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4 mt-4">
                                <div className="text-xs text-green-400 font-bold uppercase tracking-widest mb-2">claudemem's Key Differentiator</div>
                                <p className="text-sm text-gray-400">
                                    While Context-Engine focuses on retrieval, claudemem builds a <strong className="text-white">semantic understanding</strong> of your codebase through the symbol graph.
                                    PageRank rankings identify which code is "central" to your architecture, enabling analysis that pure retrieval can't do.
                                </p>
                            </div>
                        </div>

                        {/* Search Capabilities */}
                        <div className="space-y-4">
                            <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Search Capabilities</h3>
                            <Table
                                headers={['Feature', 'claudemem', 'Context-Engine']}
                                rows={[
                                    ['<strong class="text-white">Hybrid Search</strong>', 'BM25 + vector similarity', '<span class="text-blue-400">Semantic + BM25 + cross-encoder (3-stage)</span>'],
                                    ['<strong class="text-white">Reranking</strong>', '<span class="text-gray-500">✗ No cross-encoder</span>', '<span class="text-green-400">✓ Cross-encoder via Qdrant FastEmbed</span>'],
                                    ['<strong class="text-white">Team Memory</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ Memory MCP service (port 8000)</span>'],
                                    ['<strong class="text-white">MCP Tools</strong>', '4 tools (search, index, status, clear)', '10+ tools (repo_search, context_search, context_answer...)'],
                                    ['<strong class="text-white">Adaptive Learning</strong>', '<span class="text-green-400">✓ EMA-based ranking from search feedback</span>', '<span class="text-green-400">✓ Learning worker improves with usage</span>'],
                                ]}
                            />
                            <p className="text-sm text-gray-500 mt-2">
                                Context-Engine's three-stage retrieval (dense → lexical → reranker) is theoretically more accurate for pure search relevance, but adds latency and complexity.
                            </p>
                        </div>

                        {/* Developer Experience */}
                        <div className="space-y-4">
                            <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Developer Experience</h3>
                            <Table
                                headers={['Feature', 'claudemem', 'Context-Engine']}
                                rows={[
                                    ['<strong class="text-white">Setup Time</strong>', '<span class="text-green-400">npm install -g + claudemem init</span>', 'Docker Compose + VS Code extension'],
                                    ['<strong class="text-white">Watch Mode</strong>', '<span class="text-green-400">✓ Native fs.watch</span>', '✓ Via VS Code extension'],
                                    ['<strong class="text-white">Git Hooks</strong>', '<span class="text-green-400">✓ Built-in post-commit</span>', '<span class="text-gray-500">✗</span>'],
                                    ['<strong class="text-white">Auto-reindex</strong>', '✓ On search', '✓ On file change'],
                                ]}
                            />
                        </div>

                        {/* MCP Integration */}
                        <div className="space-y-4">
                            <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">MCP Integration</h3>
                            <Table
                                headers={['Feature', 'claudemem', 'Context-Engine']}
                                rows={[
                                    ['<strong class="text-white">Transport</strong>', 'stdio (standard MCP)', 'SSE + RMCP (dual)'],
                                    ['<strong class="text-white">Tools</strong>', '4 (search, index, status, clear)', '10+ specialized tools'],
                                    ['<strong class="text-white">Learning</strong>', '<span class="text-green-400">✓ Adaptive ranking</span>', '<span class="text-green-400">✓ Adaptive ranking worker</span>'],
                                ]}
                            />
                        </div>

                        {/* Documentation Indexing */}
                        <div className="space-y-4">
                            <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Documentation Indexing</h3>
                            <Table
                                headers={['Feature', 'claudemem', 'Context-Engine']}
                                rows={[
                                    ['<strong class="text-white">External Docs</strong>', '<span class="text-green-400">✓ Context7, llms.txt, DevDocs</span>', '<span class="text-gray-500">✗ Code only</span>'],
                                    ['<strong class="text-white">Dependency Detection</strong>', '<span class="text-green-400">✓ package.json, requirements.txt, etc.</span>', '<span class="text-gray-500">✗</span>'],
                                ]}
                            />
                            <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4 mt-4">
                                <div className="text-xs text-blue-400 font-bold uppercase tracking-widest mb-2">Unique to claudemem</div>
                                <p className="text-sm text-gray-400">
                                    claudemem's documentation indexing lets you search React docs alongside your React code.
                                    Useful for queries like <em>"how does React's useEffect work?"</em> during development.
                                </p>
                            </div>
                        </div>

                        {/* Performance & Scaling */}
                        <div className="space-y-4">
                            <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Performance & Scaling</h3>
                            <Table
                                headers={['Aspect', 'claudemem', 'Context-Engine']}
                                rows={[
                                    ['<strong class="text-white">Memory</strong>', '<span class="text-green-400">Light (embedded LanceDB)</span>', 'Higher (Qdrant + 5 services)'],
                                    ['<strong class="text-white">Startup</strong>', '<span class="text-green-400">Instant (single process)</span>', 'Slower (container orchestration)'],
                                    ['<strong class="text-white">Large Codebases</strong>', 'Good (LanceDB handles millions)', 'Good (Qdrant built for scale)'],
                                ]}
                            />
                        </div>

                        {/* Summary Cards */}
                        <div className="space-y-6 mt-8">
                            <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">When to Use Each</h3>
                            <div className="grid md:grid-cols-2 gap-6">
                                <div className="bg-claude-ish/10 border border-claude-ish/20 rounded-xl p-6 space-y-4">
                                    <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 bg-claude-ish rounded flex items-center justify-center text-black font-bold text-sm">M</div>
                                        <h4 className="text-lg font-bold text-white">Choose claudemem</h4>
                                    </div>
                                    <ul className="space-y-2 text-sm text-gray-300">
                                        <li className="flex gap-2"><span className="text-claude-ish">•</span> Zero-config, instant setup</li>
                                        <li className="flex gap-2"><span className="text-claude-ish">•</span> Code analysis (dead code, test gaps, impact)</li>
                                        <li className="flex gap-2"><span className="text-claude-ish">•</span> Architecture understanding (symbol graph, PageRank)</li>
                                        <li className="flex gap-2"><span className="text-claude-ish">•</span> Adaptive learning (improves with your feedback)</li>
                                        <li className="flex gap-2"><span className="text-claude-ish">•</span> Single machine / personal projects</li>
                                        <li className="flex gap-2"><span className="text-claude-ish">•</span> Documentation + code unified search</li>
                                    </ul>
                                </div>

                                <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-6 space-y-4">
                                    <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 bg-blue-500/20 rounded flex items-center justify-center text-blue-400 font-bold text-sm">CE</div>
                                        <h4 className="text-lg font-bold text-white">Choose Context-Engine</h4>
                                    </div>
                                    <ul className="space-y-2 text-sm text-gray-300">
                                        <li className="flex gap-2"><span className="text-blue-400">•</span> Team memory (shared knowledge across devs)</li>
                                        <li className="flex gap-2"><span className="text-blue-400">•</span> Highest retrieval accuracy (cross-encoder)</li>
                                        <li className="flex gap-2"><span className="text-blue-400">•</span> Comfortable with Docker infrastructure</li>
                                        <li className="flex gap-2"><span className="text-blue-400">•</span> Cross-encoder reranking (higher accuracy)</li>
                                        <li className="flex gap-2"><span className="text-blue-400">•</span> Multiple IDE users, one backend</li>
                                    </ul>
                                </div>
                            </div>
                        </div>

                        {/* Future Opportunities */}
                        <div className="bg-[#151515] border border-white/5 rounded-xl p-6 mt-8">
                            <h4 className="text-white font-bold text-sm uppercase tracking-widest mb-4">Potential Future Enhancements</h4>
                            <p className="text-sm text-gray-400 mb-4">Based on this comparison, features we might consider for claudemem:</p>
                            <div className="grid md:grid-cols-2 gap-4 text-sm">
                                <div className="bg-black/30 rounded-lg p-3">
                                    <div className="text-claude-ish font-bold mb-1">Cross-encoder reranking</div>
                                    <div className="text-gray-500 text-xs">Improved search precision at the cost of latency</div>
                                </div>
                                <div className="bg-black/30 rounded-lg p-3">
                                    <div className="text-claude-ish font-bold mb-1">Team memory</div>
                                    <div className="text-gray-500 text-xs">Persistent knowledge store across sessions</div>
                                </div>
                            </div>
                        </div>
                    </div>

                </div>
            )}

            {/* Greptile Comparison */}
            {activeSection === 'comparisons-greptile' && (
                <div className="space-y-12 animate-fadeIn">
                    <div>
                        <div className="flex items-center gap-3 mb-4">
                            <span className="text-xs bg-white/10 text-gray-400 px-2 py-1 rounded font-mono">Comparisons</span>
                            <span className="text-gray-600">/</span>
                        </div>
                        <h1 className="text-4xl font-black text-white mb-4 tracking-tight">claudemem vs Greptile</h1>
                        <p className="text-xl text-gray-400 leading-relaxed">
                            Local-first semantic search vs cloud-based AI code review platform.
                        </p>
                    </div>

                    <div className="bg-gradient-to-br from-purple-900/10 to-blue-900/10 border border-white/10 rounded-xl p-6">
                        <p className="text-gray-400 leading-relaxed">
                            <strong className="text-white">Greptile</strong> (<a href="https://greptile.com" className="text-blue-400 hover:underline" target="_blank" rel="noreferrer">YC W24</a>, $29M+ funded) is a cloud PR code review platform claiming 82% bug catch rate via codegraph analysis.
                            <strong className="text-white"> claudemem</strong> is a local-first semantic code search tool with PageRank symbol graphs — different goals, different tradeoffs.
                        </p>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Architecture</h3>
                        <Table
                            headers={['Aspect', 'claudemem', 'Greptile']}
                            rows={[
                                ['<strong class="text-white">Deployment</strong>', '<span class="text-green-400">Local-first, self-hosted</span>', 'Cloud SaaS (Docker Compose/K8s self-hosting available)'],
                                ['<strong class="text-white">Data Handling</strong>', '<span class="text-green-400">100% local, no external calls</span>', 'Cloud (SOC2 Type II certified, air-gapped option)'],
                                ['<strong class="text-white">Indexing</strong>', 'Tree-sitter AST + LanceDB vectors', '<span class="text-blue-400">Full AST parsing → codegraph (functions, classes, dependencies)</span>'],
                                ['<strong class="text-white">Languages</strong>', '12+ (tree-sitter)', '<span class="text-blue-400">30+ (language-agnostic codegraph)</span>'],
                                ['<strong class="text-white">Symbol Analysis</strong>', '<span class="text-green-400">PageRank graph</span>', '<span class="text-blue-400">Full dependency codegraph with cross-file analysis</span>'],
                            ]}
                        />
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Primary Use Case</h3>
                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="bg-claude-ish/10 border border-claude-ish/20 rounded-xl p-5">
                                <div className="text-claude-ish font-bold mb-2">claudemem</div>
                                <p className="text-sm text-gray-400">Developer semantic search, dead-code detection, impact analysis, symbol navigation</p>
                            </div>
                            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-5">
                                <div className="text-blue-400 font-bold mb-2">Greptile</div>
                                <p className="text-sm text-gray-400">Automated PR reviews, incident diagnosis, Sentry/Jira integration, security scanning</p>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Features</h3>
                        <Table
                            headers={['Feature', 'claudemem', 'Greptile']}
                            rows={[
                                ['<strong class="text-white">Semantic Search</strong>', '✓ Hybrid BM25 + vector', '✓ NL-to-code via codegraph embeddings'],
                                ['<strong class="text-white">Dead Code Detection</strong>', '<span class="text-green-400">✓ Built-in</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">Test Gap Analysis</strong>', '<span class="text-green-400">✓ Built-in</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">Adaptive Learning</strong>', '<span class="text-green-400">✓ Learns from search feedback</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">PR Review</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ Primary feature (82% bug catch rate*)</span>'],
                                ['<strong class="text-white">Custom Rules</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ Plain English rules + team learning</span>'],
                                ['<strong class="text-white">Integrations</strong>', 'Claude Code MCP', '<span class="text-blue-400">Jira, Notion, Google Docs, MCP v3</span>'],
                                ['<strong class="text-white">Security Scanning</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ Built-in</span>'],
                            ]}
                        />
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Pricing</h3>
                        <Table
                            headers={['Plan', 'claudemem', 'Greptile']}
                            rows={[
                                ['<strong class="text-white">License</strong>', '<span class="text-green-400">MIT (free)</span>', 'Proprietary (Enterprise self-host available)'],
                                ['<strong class="text-white">Trial</strong>', '<span class="text-green-400">Unlimited</span>', '14-day free trial (no credit card)'],
                                ['<strong class="text-white">Team</strong>', '<span class="text-green-400">Free</span>', '<span class="text-yellow-400">$30/dev/month</span> (2nd highest in market)'],
                                ['<strong class="text-white">Open Source</strong>', '<span class="text-green-400">Free</span>', 'Free for OSS projects'],
                                ['<strong class="text-white">Startups</strong>', '<span class="text-green-400">Free</span>', '50% discount'],
                            ]}
                        />
                    </div>

                    <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4">
                        <div className="text-xs text-yellow-400 font-bold uppercase tracking-widest mb-2">* About the 82% Claim</div>
                        <p className="text-sm text-gray-400">
                            The 82% bug catch rate was <strong className="text-white">self-benchmarked by Greptile</strong> (July 2025) on 50 bugs from 5 OSS repos.
                            Multiple sources note trust concerns; treat as directional, not absolute.
                        </p>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">When to Use Each</h3>
                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="bg-claude-ish/10 border border-claude-ish/20 rounded-xl p-6">
                                <h4 className="text-lg font-bold text-white mb-3">Choose claudemem</h4>
                                <ul className="space-y-2 text-sm text-gray-300">
                                    <li>• Privacy-first / air-gapped environments</li>
                                    <li>• Developer semantic search & navigation</li>
                                    <li>• Code analysis (dead code, test gaps, impact)</li>
                                    <li>• Adaptive learning from your feedback</li>
                                    <li>• Zero recurring costs (MIT license)</li>
                                </ul>
                            </div>
                            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-6">
                                <h4 className="text-lg font-bold text-white mb-3">Choose Greptile</h4>
                                <ul className="space-y-2 text-sm text-gray-300">
                                    <li>• Automated PR code review at scale</li>
                                    <li>• Team-wide code quality rules</li>
                                    <li>• Jira/Notion/Google Docs integration</li>
                                    <li>• Budget for $30/dev/month SaaS</li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Brokk Comparison */}
            {activeSection === 'comparisons-brokk' && (
                <div className="space-y-12 animate-fadeIn">
                    <div>
                        <div className="flex items-center gap-3 mb-4">
                            <span className="text-xs bg-white/10 text-gray-400 px-2 py-1 rounded font-mono">Comparisons</span>
                            <span className="text-gray-600">/</span>
                        </div>
                        <h1 className="text-4xl font-black text-white mb-4 tracking-tight">claudemem vs Brokk</h1>
                        <p className="text-xl text-gray-400 leading-relaxed">
                            Lightweight semantic search vs full Code Property Graph analysis.
                        </p>
                    </div>

                    <div className="bg-gradient-to-br from-purple-900/10 to-blue-900/10 border border-white/10 rounded-xl p-6">
                        <p className="text-gray-400 leading-relaxed">
                            <strong className="text-white">Brokk</strong> (<a href="https://github.com/BrokkAi/brokk" className="text-blue-400 hover:underline" target="_blank" rel="noreferrer">v0.19.0-beta1</a>, GPL-3.0) is a Java Swing IDE using Joern for full Code Property Graph (CPG) analysis with compiler-grade type inference.
                            <strong className="text-white"> claudemem</strong> uses tree-sitter AST with PageRank symbol ranking — lightweight vs. heavy-duty.
                        </p>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Architecture</h3>
                        <Table
                            headers={['Aspect', 'claudemem', 'Brokk']}
                            rows={[
                                ['<strong class="text-white">Runtime</strong>', '<span class="text-green-400">Bun (lightweight CLI)</span>', 'JVM (JDK 21+ required, JetBrains Runtime recommended)'],
                                ['<strong class="text-white">Tech Stack</strong>', 'TypeScript + LanceDB', 'Java Swing (94.5%) + langchain4j + JLama'],
                                ['<strong class="text-white">Analysis Engine</strong>', 'Tree-sitter AST', '<span class="text-blue-400">Joern CPG (AST + CFG + PDG merged)</span>'],
                                ['<strong class="text-white">Type System</strong>', 'Semantic embeddings', '<span class="text-blue-400">Full compiler-grade type inference</span>'],
                                ['<strong class="text-white">Integration</strong>', '<span class="text-green-400">MCP server (Claude Code)</span>', 'Desktop app + MCP client (consumes MCP)'],
                                ['<strong class="text-white">Local Inference</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ JLama (CPU-friendly, no GPU required)</span>'],
                            ]}
                        />
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Code Property Graph vs Symbol Graph</h3>
                        <div className="bg-[#151515] border border-white/5 rounded-lg p-5">
                            <div className="grid md:grid-cols-2 gap-6">
                                <div>
                                    <div className="text-claude-ish font-bold mb-2">claudemem (Symbol Graph)</div>
                                    <ul className="text-sm text-gray-400 space-y-1">
                                        <li>• AST parsing via tree-sitter (12+ languages)</li>
                                        <li>• PageRank importance scoring</li>
                                        <li>• Caller/callee relationships</li>
                                        <li>• Fast indexing (seconds for most projects)</li>
                                    </ul>
                                </div>
                                <div>
                                    <div className="text-blue-400 font-bold mb-2">Brokk (Full CPG via Joern)</div>
                                    <ul className="text-sm text-gray-400 space-y-1">
                                        <li>• AST + Control Flow Graph + Data Dependency</li>
                                        <li>• Full type inference (Java primary)</li>
                                        <li>• Tree-sitter summarization for Python/JS/C#</li>
                                        <li>• Million-line repos in single-digit minutes</li>
                                    </ul>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Features</h3>
                        <Table
                            headers={['Feature', 'claudemem', 'Brokk']}
                            rows={[
                                ['<strong class="text-white">Semantic Search</strong>', '<span class="text-green-400">✓ Hybrid BM25 + vector</span>', '✓ Via MiniLM-L6-v2 embeddings'],
                                ['<strong class="text-white">Type Inference</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ Compiler-grade (Java via Joern)</span>'],
                                ['<strong class="text-white">Languages</strong>', '<span class="text-green-400">12+ (full support)</span>', 'Java (full CPG), Python/JS/C# (summarization only)'],
                                ['<strong class="text-white">Dead Code Detection</strong>', '<span class="text-green-400">✓</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">Adaptive Learning</strong>', '<span class="text-green-400">✓ Learns from feedback</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">Lutz Mode</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ Research → Plan → Build workflow</span>'],
                                ['<strong class="text-white">BlitzForge</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ Parallel refactoring (100s of files)</span>'],
                                ['<strong class="text-white">Dependency Decompilation</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ JAR → readable source</span>'],
                            ]}
                        />
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Pricing</h3>
                        <Table
                            headers={['Aspect', 'claudemem', 'Brokk']}
                            rows={[
                                ['<strong class="text-white">License</strong>', '<span class="text-green-400">MIT (permissive)</span>', 'GPL-3.0 (copyleft obligations)'],
                                ['<strong class="text-white">Cost</strong>', '<span class="text-green-400">Free</span>', '<span class="text-green-400">Free ($5 trial credit at brokk.ai)</span>'],
                                ['<strong class="text-white">LLM Costs</strong>', 'Your API keys (OpenRouter)', 'Usage-based via langchain4j (Gemini, OpenAI, etc.)'],
                                ['<strong class="text-white">Local Models</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ DeepSeek-V3.2, Qwen, via JLama</span>'],
                            ]}
                        />
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">When to Use Each</h3>
                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="bg-claude-ish/10 border border-claude-ish/20 rounded-xl p-6">
                                <h4 className="text-lg font-bold text-white mb-3">Choose claudemem</h4>
                                <ul className="space-y-2 text-sm text-gray-300">
                                    <li>• Multi-language codebases</li>
                                    <li>• Fast semantic search</li>
                                    <li>• Claude Code integration</li>
                                    <li>• Lightweight, no JVM required</li>
                                </ul>
                            </div>
                            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-6">
                                <h4 className="text-lg font-bold text-white mb-3">Choose Brokk</h4>
                                <ul className="space-y-2 text-sm text-gray-300">
                                    <li>• Large Java codebases</li>
                                    <li>• Need full type inference</li>
                                    <li>• AI-assisted refactoring</li>
                                    <li>• Control flow analysis</li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Serena Comparison */}
            {activeSection === 'comparisons-serena' && (
                <div className="space-y-12 animate-fadeIn">
                    <div>
                        <div className="flex items-center gap-3 mb-4">
                            <span className="text-xs bg-white/10 text-gray-400 px-2 py-1 rounded font-mono">Comparisons</span>
                            <span className="text-gray-600">/</span>
                        </div>
                        <h1 className="text-4xl font-black text-white mb-4 tracking-tight">claudemem vs Serena</h1>
                        <p className="text-xl text-gray-400 leading-relaxed">
                            Semantic embeddings vs LSP-based structural analysis.
                        </p>
                    </div>

                    <div className="bg-gradient-to-br from-purple-900/10 to-blue-900/10 border border-white/10 rounded-xl p-6">
                        <p className="text-gray-400 leading-relaxed">
                            <strong className="text-white">Serena</strong> (<a href="https://github.com/oraios/serena" className="text-blue-400 hover:underline" target="_blank" rel="noreferrer">17,780 ★ GitHub</a>, MIT) uses Language Server Protocol for structural code understanding with 35+ MCP tools — no embeddings, pure LSP.
                            <strong className="text-white"> claudemem</strong> combines tree-sitter AST with vector embeddings for hybrid semantic search — fundamentally different approaches.
                        </p>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Fundamental Approach</h3>
                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="bg-claude-ish/10 border border-claude-ish/20 rounded-xl p-5">
                                <div className="text-claude-ish font-bold mb-2">claudemem (Embeddings)</div>
                                <p className="text-sm text-gray-400">AST → Vector embeddings → Semantic similarity search</p>
                                <p className="text-xs text-gray-500 mt-2">Finds "similar authentication patterns" across codebase via fuzzy matching</p>
                            </div>
                            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-5">
                                <div className="text-blue-400 font-bold mb-2">Serena (LSP-based)</div>
                                <p className="text-sm text-gray-400">Language servers → Structural understanding → Precise symbol navigation</p>
                                <p className="text-xs text-gray-500 mt-2">Finds exact definitions, references, types via 35+ MCP tools — deterministic, not fuzzy</p>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Features</h3>
                        <Table
                            headers={['Feature', 'claudemem', 'Serena']}
                            rows={[
                                ['<strong class="text-white">Semantic Search</strong>', '<span class="text-green-400">✓ Hybrid BM25 + vector</span>', '<span class="text-gray-500">✗ No embeddings — pure structural</span>'],
                                ['<strong class="text-white">Symbol Navigation</strong>', '✓ Via AST + PageRank', '<span class="text-green-400">✓ Native LSP (find_symbol, find_referencing_symbols)</span>'],
                                ['<strong class="text-white">Languages</strong>', '12+ (tree-sitter)', '<span class="text-green-400">33 via LSP + JetBrains plugin</span>'],
                                ['<strong class="text-white">Dead Code Detection</strong>', '<span class="text-green-400">✓ Built-in</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">Adaptive Learning</strong>', '<span class="text-green-400">✓ Learns from feedback</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">Importance Ranking</strong>', '<span class="text-green-400">✓ PageRank</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">Code Editing</strong>', 'Text-based', '<span class="text-green-400">✓ Symbol-precise (replace_symbol_body, insert_before_symbol)</span>'],
                                ['<strong class="text-white">MCP Tools</strong>', '4 tools', '<span class="text-green-400">35+ tools (file, symbol, memory, shell, planning)</span>'],
                                ['<strong class="text-white">Refactoring</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ rename_symbol via LSP</span>'],
                            ]}
                        />
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Technical Stack</h3>
                        <Table
                            headers={['Aspect', 'claudemem', 'Serena']}
                            rows={[
                                ['<strong class="text-white">Backend</strong>', 'LanceDB + tree-sitter', 'Language servers via multilspy + Solid-LSP'],
                                ['<strong class="text-white">Dependencies</strong>', '<span class="text-green-400">Self-contained</span>', 'Python 3.11, uv, language servers per language'],
                                ['<strong class="text-white">Setup</strong>', '<span class="text-green-400">npm install -g claudemem</span>', 'uvx from git or Docker'],
                                ['<strong class="text-white">IDE Plugin</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ JetBrains plugin (preferred)</span>'],
                                ['<strong class="text-white">License</strong>', 'MIT', 'MIT'],
                            ]}
                        />
                    </div>

                    <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4 mt-4">
                        <div className="text-xs text-blue-400 font-bold uppercase tracking-widest mb-2">Complementary Tools</div>
                        <p className="text-sm text-gray-400">
                            Serena explicitly positions LSP and RAG as <strong className="text-white">complementary</strong> approaches.
                            You could use both: claudemem for semantic discovery, Serena for precise symbol-level editing.
                        </p>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">When to Use Each</h3>
                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="bg-claude-ish/10 border border-claude-ish/20 rounded-xl p-6">
                                <h4 className="text-lg font-bold text-white mb-3">Choose claudemem</h4>
                                <ul className="space-y-2 text-sm text-gray-300">
                                    <li>• "Find code that does X" queries</li>
                                    <li>• Semantic similarity search</li>
                                    <li>• Dead code / test gap analysis</li>
                                    <li>• Simpler setup (no language servers)</li>
                                </ul>
                            </div>
                            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-6">
                                <h4 className="text-lg font-bold text-white mb-3">Choose Serena</h4>
                                <ul className="space-y-2 text-sm text-gray-300">
                                    <li>• Precise symbol navigation</li>
                                    <li>• Large existing codebases</li>
                                    <li>• Complex refactoring</li>
                                    <li>• Need 30+ language support</li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Amp Comparison */}
            {activeSection === 'comparisons-amp' && (
                <div className="space-y-12 animate-fadeIn">
                    <div>
                        <div className="flex items-center gap-3 mb-4">
                            <span className="text-xs bg-white/10 text-gray-400 px-2 py-1 rounded font-mono">Comparisons</span>
                            <span className="text-gray-600">/</span>
                        </div>
                        <h1 className="text-4xl font-black text-white mb-4 tracking-tight">claudemem vs Amp</h1>
                        <p className="text-xl text-gray-400 leading-relaxed">
                            Local-first open source vs enterprise cloud AI coding agent.
                        </p>
                    </div>

                    <div className="bg-gradient-to-br from-purple-900/10 to-blue-900/10 border border-white/10 rounded-xl p-6">
                        <p className="text-gray-400 leading-relaxed">
                            <strong className="text-white">Amp</strong> by Sourcegraph (<a href="https://ampcode.com" className="text-blue-400 hover:underline" target="_blank" rel="noreferrer">ampcode.com</a>) is an enterprise AI coding agent powered by Claude Opus 4.5 with credit-based pricing, SCIP indexing, and background agents.
                            <strong className="text-white"> claudemem</strong> is free, local-first semantic search focused on code understanding — different scope entirely.
                        </p>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Architecture</h3>
                        <Table
                            headers={['Aspect', 'claudemem', 'Amp']}
                            rows={[
                                ['<strong class="text-white">Deployment</strong>', '<span class="text-green-400">Local, self-hosted</span>', '<span class="text-yellow-400">Cloud-only (no self-hosting)</span>'],
                                ['<strong class="text-white">Data Handling</strong>', '<span class="text-green-400">100% local</span>', 'Cloud (ZDR available for enterprise)'],
                                ['<strong class="text-white">Indexing</strong>', 'Full codebase AST + vectors', '<span class="text-blue-400">SCIP (10x faster, 4x smaller than LSIF)</span>'],
                                ['<strong class="text-white">Context Window</strong>', 'Unlimited (local)', '200k tokens (Claude Opus 4.5), 1M optional'],
                                ['<strong class="text-white">Symbol Analysis</strong>', 'PageRank symbol graph', '<span class="text-blue-400">SCIP via Sourcegraph MCP (cross-repo)</span>'],
                            ]}
                        />
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Features</h3>
                        <Table
                            headers={['Feature', 'claudemem', 'Amp']}
                            rows={[
                                ['<strong class="text-white">Semantic Search</strong>', '✓ Hybrid BM25 + vector', '✓ Via Sourcegraph MCP + Librarian subagent'],
                                ['<strong class="text-white">Dead Code Detection</strong>', '<span class="text-green-400">✓ Built-in</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">Adaptive Learning</strong>', '<span class="text-green-400">✓ Learns from feedback</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">Background Agents</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ 10-15min autonomous tasks</span>'],
                                ['<strong class="text-white">Multi-Model</strong>', 'Via OpenRouter', '<span class="text-green-400">✓ Claude Opus 4.5, Gemini 3, GPT-5</span>'],
                                ['<strong class="text-white">Toolboxes & Skills</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ Custom extensions from GitHub</span>'],
                                ['<strong class="text-white">IDE Support</strong>', 'Claude Code CLI', '<span class="text-green-400">VS Code, Cursor, Windsurf, JetBrains, Neovim</span>'],
                            ]}
                        />
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Pricing</h3>
                        <Table
                            headers={['Plan', 'claudemem', 'Amp']}
                            rows={[
                                ['<strong class="text-white">License</strong>', '<span class="text-green-400">MIT (open source)</span>', 'Proprietary (cloud service)'],
                                ['<strong class="text-white">Free Tier</strong>', '<span class="text-green-400">Unlimited</span>', '$10 free credits (ad-supported tier)'],
                                ['<strong class="text-white">Paid Model</strong>', '<span class="text-green-400">N/A (always free)</span>', '<span class="text-yellow-400">Credit-based (no subscriptions)</span>'],
                                ['<strong class="text-white">Enterprise</strong>', '<span class="text-green-400">Free (self-host)</span>', '<span class="text-yellow-400">$1,000+ purchase = SSO + ZDR</span>'],
                                ['<strong class="text-white">Privacy</strong>', '<span class="text-green-400">Air-gap compatible</span>', 'Zero Data Retention available (enterprise)'],
                            ]}
                        />
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">AGENTS.md vs CLAUDE.md</h3>
                        <div className="bg-[#151515] border border-white/5 rounded-lg p-5">
                            <p className="text-sm text-gray-400 mb-3">
                                Amp uses <code className="text-blue-400">AGENTS.md</code> (an open spec now under Linux Foundation stewardship) for project-level AI guidance.
                                claudemem integrates with Claude Code's <code className="text-claude-ish">CLAUDE.md</code> for similar purposes.
                            </p>
                            <p className="text-xs text-gray-500">Both support: build steps, test commands, coding conventions. AGENTS.md is cross-tool compatible (Codex, Jules, Cursor, Factory).</p>
                        </div>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">When to Use Each</h3>
                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="bg-claude-ish/10 border border-claude-ish/20 rounded-xl p-6">
                                <h4 className="text-lg font-bold text-white mb-3">Choose claudemem</h4>
                                <ul className="space-y-2 text-sm text-gray-300">
                                    <li>• Air-gapped / privacy-first</li>
                                    <li>• No recurring costs</li>
                                    <li>• Code analysis (dead code, test gaps)</li>
                                    <li>• Simple, focused tooling</li>
                                </ul>
                            </div>
                            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-6">
                                <h4 className="text-lg font-bold text-white mb-3">Choose Amp</h4>
                                <ul className="space-y-2 text-sm text-gray-300">
                                    <li>• Enterprise with SSO/RBAC needs</li>
                                    <li>• Long-running background agents</li>
                                    <li>• Multi-IDE teams</li>
                                    <li>• Budget for cloud AI tools</li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* claude-mem Comparison - NAME SIMILARITY WARNING */}
            {activeSection === 'comparisons-claude-mem' && (
                <div className="space-y-12 animate-fadeIn">
                    <div>
                        <div className="flex items-center gap-3 mb-4">
                            <span className="text-xs bg-white/10 text-gray-400 px-2 py-1 rounded font-mono">Comparisons</span>
                            <span className="text-gray-600">/</span>
                        </div>
                        <h1 className="text-4xl font-black text-white mb-4 tracking-tight">claudemem vs claude-mem</h1>
                        <p className="text-xl text-gray-400 leading-relaxed">
                            Similar names, completely different tools — code search vs session memory.
                        </p>
                    </div>

                    <div className="bg-yellow-500/10 border-2 border-yellow-500/30 rounded-xl p-6">
                        <div className="flex items-center gap-3 mb-3">
                            <span className="text-2xl">⚠️</span>
                            <div className="text-lg text-yellow-400 font-bold uppercase tracking-widest">Name Similarity Notice</div>
                        </div>
                        <p className="text-gray-300 leading-relaxed">
                            <strong className="text-white">claude-mem</strong> (<a href="https://github.com/thedotmack/claude-mem" className="text-blue-400 hover:underline" target="_blank" rel="noreferrer">~9.3k ★ GitHub</a>, AGPL-3.0) by <strong>@thedotmack</strong> is a
                            <strong className="text-yellow-400"> session memory plugin</strong> that gives Claude Code persistent memory across sessions.
                            <br/><br/>
                            <strong className="text-white">claudemem</strong> (<a href="https://github.com/MadAppGang/claudemem" className="text-blue-400 hover:underline" target="_blank" rel="noreferrer">GitHub</a>, MIT) by <strong>MadAppGang</strong> is
                            <strong className="text-claude-ish"> semantic code search</strong> with symbol graphs and PageRank.
                            <br/><br/>
                            <span className="text-gray-400">Despite the similar names, these are <strong className="text-white">completely different projects</strong> with different purposes, maintainers, and architectures.</span>
                        </p>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Core Purpose</h3>
                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="bg-claude-ish/10 border border-claude-ish/20 rounded-xl p-5">
                                <div className="text-claude-ish font-bold mb-2">claudemem (this project)</div>
                                <p className="text-sm text-gray-400 mb-3">Semantic code search + symbol analysis</p>
                                <ul className="text-xs text-gray-500 space-y-1">
                                    <li>• Index code with tree-sitter AST parsing</li>
                                    <li>• Search with natural language queries</li>
                                    <li>• PageRank-based symbol importance</li>
                                    <li>• Callers/callees relationship mapping</li>
                                    <li>• Dead code & test gap detection</li>
                                </ul>
                            </div>
                            <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-5">
                                <div className="text-orange-400 font-bold mb-2">claude-mem (@thedotmack)</div>
                                <p className="text-sm text-gray-400 mb-3">Session memory persistence plugin</p>
                                <ul className="text-xs text-gray-500 space-y-1">
                                    <li>• Persist context across Claude Code sessions</li>
                                    <li>• Automatic tool usage observation capture</li>
                                    <li>• AI-compressed memory summaries</li>
                                    <li>• Natural language memory search</li>
                                    <li>• Web viewer UI at localhost:37777</li>
                                </ul>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Technical Architecture</h3>
                        <Table
                            headers={['Aspect', 'claudemem', 'claude-mem']}
                            rows={[
                                ['<strong class="text-white">Primary Function</strong>', '<span class="text-claude-ish">Code search & symbol analysis</span>', '<span class="text-orange-400">Session memory persistence</span>'],
                                ['<strong class="text-white">How It Works</strong>', 'Indexes source code into vector embeddings', 'Captures tool observations, compresses with AI'],
                                ['<strong class="text-white">Storage</strong>', 'LanceDB (embedded vector DB)', 'SQLite + Chroma (vector DB)'],
                                ['<strong class="text-white">Search Backend</strong>', 'Hybrid: LanceDB vectors + BM25 keyword', 'Chroma semantic + keyword hybrid'],
                                ['<strong class="text-white">Runtime</strong>', 'Bun', 'Bun + Python (uv)'],
                                ['<strong class="text-white">Port</strong>', 'CLI only (no server)', 'HTTP API on :37777'],
                            ]}
                        />
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Features Comparison</h3>
                        <Table
                            headers={['Feature', 'claudemem', 'claude-mem']}
                            rows={[
                                ['<strong class="text-white">Semantic Search</strong>', '<span class="text-green-400">✓ Code-focused</span>', '<span class="text-green-400">✓ Memory-focused</span>'],
                                ['<strong class="text-white">Symbol Graph</strong>', '<span class="text-green-400">✓ PageRank callers/callees</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">AST Parsing</strong>', '<span class="text-green-400">✓ tree-sitter (12+ langs)</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">Session Persistence</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ Cross-session memory</span>'],
                                ['<strong class="text-white">Tool Observation</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ Auto-capture & compress</span>'],
                                ['<strong class="text-white">Dead Code Detection</strong>', '<span class="text-green-400">✓</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">Test Gap Analysis</strong>', '<span class="text-green-400">✓</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">Web UI</strong>', '<span class="text-gray-500">✗ CLI only</span>', '<span class="text-green-400">✓ localhost:37777</span>'],
                                ['<strong class="text-white">Privacy Tags</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ &lt;private&gt; exclusion</span>'],
                                ['<strong class="text-white">Citation System</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ Reference by ID</span>'],
                            ]}
                        />
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Integration</h3>
                        <Table
                            headers={['Integration', 'claudemem', 'claude-mem']}
                            rows={[
                                ['<strong class="text-white">Claude Code</strong>', '<span class="text-green-400">✓ MCP server</span>', '<span class="text-green-400">✓ Plugin with hooks</span>'],
                                ['<strong class="text-white">Integration Method</strong>', 'MCP tools (search, index, status)', '5 lifecycle hooks + skill'],
                                ['<strong class="text-white">OpenCode</strong>', '<span class="text-green-400">✓ Plugin support</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">Cursor</strong>', '✓ Via MCP', '<span class="text-gray-500">✗</span>'],
                            ]}
                        />
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Project Details</h3>
                        <Table
                            headers={['Detail', 'claudemem', 'claude-mem']}
                            rows={[
                                ['<strong class="text-white">Maintainer</strong>', 'MadAppGang', '@thedotmack'],
                                ['<strong class="text-white">License</strong>', '<span class="text-green-400">MIT</span>', 'AGPL-3.0 (+ PolyForm NC for ragtime/)'],
                                ['<strong class="text-white">GitHub Stars</strong>', 'Growing', '~9.3k ★'],
                                ['<strong class="text-white">Latest Version</strong>', 'v0.8.0', 'v8.2.5 (146 releases)'],
                                ['<strong class="text-white">Package</strong>', 'npm: claude-codemem', 'npm: claude-mem'],
                            ]}
                        />
                    </div>

                    <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4">
                        <div className="text-xs text-green-400 font-bold uppercase tracking-widest mb-2">Complementary Tools</div>
                        <p className="text-sm text-gray-400">
                            These tools solve <strong className="text-white">different problems</strong> and can be used together:
                            <strong className="text-claude-ish"> claudemem</strong> helps you search and understand your codebase,
                            while <strong className="text-orange-400">claude-mem</strong> helps Claude remember what you worked on across sessions.
                        </p>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">When to Use Each</h3>
                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="bg-claude-ish/10 border border-claude-ish/20 rounded-xl p-6">
                                <h4 className="text-lg font-bold text-white mb-3">Use claudemem for</h4>
                                <ul className="space-y-2 text-sm text-gray-300">
                                    <li>• "Where is authentication handled?"</li>
                                    <li>• "What functions call this method?"</li>
                                    <li>• "Find unused code in this project"</li>
                                    <li>• "What's the architecture of this codebase?"</li>
                                    <li>• Navigating large unfamiliar codebases</li>
                                </ul>
                            </div>
                            <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-6">
                                <h4 className="text-lg font-bold text-white mb-3">Use claude-mem for</h4>
                                <ul className="space-y-2 text-sm text-gray-300">
                                    <li>• "What did I work on yesterday?"</li>
                                    <li>• "Continue where I left off"</li>
                                    <li>• Maintaining context across sessions</li>
                                    <li>• Building institutional memory</li>
                                    <li>• Resuming complex multi-day tasks</li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Supermemory Comparison */}
            {activeSection === 'comparisons-supermemory' && (
                <div className="space-y-12 animate-fadeIn">
                    <div>
                        <div className="flex items-center gap-3 mb-4">
                            <span className="text-xs bg-white/10 text-gray-400 px-2 py-1 rounded font-mono">Comparisons</span>
                            <span className="text-gray-600">/</span>
                        </div>
                        <h1 className="text-4xl font-black text-white mb-4 tracking-tight">claudemem vs Supermemory</h1>
                        <p className="text-xl text-gray-400 leading-relaxed">
                            Code intelligence vs personal knowledge management — different tools for different needs.
                        </p>
                    </div>

                    <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-6">
                        <div className="text-xs text-yellow-400 font-bold uppercase tracking-widest mb-2">Different Categories</div>
                        <p className="text-gray-400 leading-relaxed">
                            <strong className="text-white">Supermemory</strong> (<a href="https://github.com/supermemoryai/supermemory" className="text-blue-400 hover:underline" target="_blank" rel="noreferrer">~13.9k ★ GitHub</a>, MIT) is an <strong className="text-yellow-400">"AI second brain"</strong> for saving URLs, bookmarks, PDFs, and notes.
                            <strong className="text-white"> claudemem</strong> is <strong className="text-claude-ish">semantic code search</strong> with symbol graphs. These are <strong className="text-white">complementary tools</strong>, not competitors.
                        </p>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Fundamental Purpose</h3>
                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="bg-claude-ish/10 border border-claude-ish/20 rounded-xl p-5">
                                <div className="text-claude-ish font-bold mb-2">claudemem</div>
                                <p className="text-sm text-gray-400 mb-3">Semantic code search + symbol analysis</p>
                                <ul className="text-xs text-gray-500 space-y-1">
                                    <li>• Index source code with tree-sitter AST</li>
                                    <li>• Find functions, classes, callers/callees</li>
                                    <li>• PageRank importance ranking</li>
                                    <li>• Dead code & test gap detection</li>
                                </ul>
                            </div>
                            <div className="bg-purple-500/10 border border-purple-500/20 rounded-xl p-5">
                                <div className="text-purple-400 font-bold mb-2">Supermemory</div>
                                <p className="text-sm text-gray-400 mb-3">Personal knowledge management / "Second brain"</p>
                                <ul className="text-xs text-gray-500 space-y-1">
                                    <li>• Save URLs, PDFs, bookmarks, notes</li>
                                    <li>• Organize into collections</li>
                                    <li>• Chat with your saved content</li>
                                    <li>• Cross-platform memory sharing</li>
                                </ul>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Technical Comparison</h3>
                        <Table
                            headers={['Aspect', 'claudemem', 'Supermemory']}
                            rows={[
                                ['<strong class="text-white">Content Type</strong>', '<span class="text-claude-ish">Source code (functions, classes, symbols)</span>', '<span class="text-purple-400">URLs, PDFs, bookmarks, notes, web pages</span>'],
                                ['<strong class="text-white">Analysis</strong>', 'AST parsing + PageRank symbol graph', 'Knowledge graph + RAG pipeline'],
                                ['<strong class="text-white">Storage</strong>', '<span class="text-green-400">Local (LanceDB embedded)</span>', 'Cloud (Cloudflare) or self-hosted'],
                                ['<strong class="text-white">Tech Stack</strong>', 'TypeScript / Bun', 'TypeScript / Remix / Cloudflare Workers'],
                                ['<strong class="text-white">Search Backend</strong>', 'LanceDB + BM25 hybrid', 'Trieve knowledge graph'],
                            ]}
                        />
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Features</h3>
                        <Table
                            headers={['Feature', 'claudemem', 'Supermemory']}
                            rows={[
                                ['<strong class="text-white">Semantic Search</strong>', '✓ Code-focused', '✓ Document-focused'],
                                ['<strong class="text-white">Symbol Graph</strong>', '<span class="text-green-400">✓ PageRank callers/callees</span>', '<span class="text-gray-500">✗</span>'],
                                ['<strong class="text-white">Dead Code Detection</strong>', '<span class="text-green-400">✓</span>', '<span class="text-gray-500">✗ (not applicable)</span>'],
                                ['<strong class="text-white">Browser Extension</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ Chrome/Edge</span>'],
                                ['<strong class="text-white">Collections/Canvas</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ Visual organization</span>'],
                                ['<strong class="text-white">Writing Assistant</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ AI markdown editor</span>'],
                                ['<strong class="text-white">MCP Integration</strong>', '✓ 4 tools', '✓ 4 tools (addMemory, search, etc.)'],
                                ['<strong class="text-white">CLI</strong>', '<span class="text-green-400">✓ Full CLI (map, callers, dead-code)</span>', '<span class="text-gray-500">✗ Web/API only</span>'],
                            ]}
                        />
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Integrations</h3>
                        <Table
                            headers={['Platform', 'claudemem', 'Supermemory']}
                            rows={[
                                ['<strong class="text-white">Claude Code</strong>', '<span class="text-green-400">✓ MCP server</span>', '<span class="text-green-400">✓ MCP server</span>'],
                                ['<strong class="text-white">Cursor</strong>', '✓ Via MCP', '✓ Via MCP'],
                                ['<strong class="text-white">VS Code</strong>', '✓ Via MCP', '✓ Via MCP'],
                                ['<strong class="text-white">Notion</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ Import</span>'],
                                ['<strong class="text-white">Google Drive</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ Import</span>'],
                                ['<strong class="text-white">Twitter/X</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ Bookmark import</span>'],
                                ['<strong class="text-white">Raycast</strong>', '<span class="text-gray-500">✗</span>', '<span class="text-green-400">✓ Extension</span>'],
                            ]}
                        />
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">Pricing</h3>
                        <Table
                            headers={['Tier', 'claudemem', 'Supermemory']}
                            rows={[
                                ['<strong class="text-white">License</strong>', '<span class="text-green-400">MIT (open source)</span>', '<span class="text-green-400">MIT (open source)</span>'],
                                ['<strong class="text-white">Free</strong>', '<span class="text-green-400">Unlimited (local)</span>', '1M tokens, 10K queries'],
                                ['<strong class="text-white">Pro</strong>', '<span class="text-green-400">N/A (always free)</span>', '$19/month (3M tokens)'],
                                ['<strong class="text-white">Scale</strong>', '<span class="text-green-400">N/A</span>', '$399/month (80M tokens)'],
                                ['<strong class="text-white">Self-hosting</strong>', '<span class="text-green-400">✓ Full support</span>', '✓ Available'],
                            ]}
                        />
                    </div>

                    <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4">
                        <div className="text-xs text-green-400 font-bold uppercase tracking-widest mb-2">Using Both Together</div>
                        <p className="text-sm text-gray-400">
                            These tools are <strong className="text-white">complementary</strong>: use <strong className="text-claude-ish">claudemem</strong> to search and analyze your codebase,
                            and <strong className="text-purple-400">Supermemory</strong> to save research, documentation, and notes that inform your development.
                            Both integrate with Claude Code via MCP.
                        </p>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-white border-b border-white/10 pb-3">When to Use Each</h3>
                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="bg-claude-ish/10 border border-claude-ish/20 rounded-xl p-6">
                                <h4 className="text-lg font-bold text-white mb-3">Use claudemem for</h4>
                                <ul className="space-y-2 text-sm text-gray-300">
                                    <li>• "Where is authentication handled?"</li>
                                    <li>• "What calls this function?"</li>
                                    <li>• "Find dead code in this project"</li>
                                    <li>• "Show untested high-importance code"</li>
                                    <li>• Navigating unfamiliar codebases</li>
                                </ul>
                            </div>
                            <div className="bg-purple-500/10 border border-purple-500/20 rounded-xl p-6">
                                <h4 className="text-lg font-bold text-white mb-3">Use Supermemory for</h4>
                                <ul className="space-y-2 text-sm text-gray-300">
                                    <li>• Saving API documentation pages</li>
                                    <li>• Organizing research and bookmarks</li>
                                    <li>• "What did I read about React hooks?"</li>
                                    <li>• Cross-platform memory for AI tools</li>
                                    <li>• Building a personal knowledge base</li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Self-Learning System */}
            {/* Self-Learning System */}
            {activeSection === 'self-learning' && (
                <SelfLearningDoc onNavigate={setActiveSection} />
            )}

            {/* Validation & Results */}
            {activeSection === 'validation-results' && (
                <ValidationResultsDoc />
            )}
        </div>
      </div>
    </div>
  );
};

export default DocsPage;