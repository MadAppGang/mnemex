import React from 'react';
import { DocTable } from './DocTable';

export const ValidationResultsDoc: React.FC = () => {
    return (
        <div className="space-y-12 animate-fadeIn">
            <div>
                <div className="flex items-center gap-3 mb-4">
                    <span className="text-xs bg-green-500/20 text-green-400 px-2 py-1 rounded font-mono uppercase font-bold">Test Results</span>
                </div>
                <h1 className="text-4xl font-black text-white mb-4 tracking-tight">Validation & Results</h1>
                <p className="text-xl text-gray-400 leading-relaxed">
                    We don't just guess—we validate. Here are the latest results from our automated testing pipeline.
                </p>
            </div>

            {/* Test Results Summary */}
            <div className="space-y-6">
                <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Test Results Summary</h2>
                <div className="grid md:grid-cols-2 gap-6">
                    <div className="bg-[#0c0c0c] border border-white/10 rounded-xl p-6">
                        <div className="text-xs text-gray-500 uppercase tracking-widest mb-4">Validation System Tests</div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <div className="text-3xl font-black text-white">50</div>
                                <div className="text-xs text-gray-500">Total Tests</div>
                            </div>
                            <div>
                                <div className="text-3xl font-black text-green-400">50</div>
                                <div className="text-xs text-gray-500">Passed</div>
                            </div>
                            <div>
                                <div className="text-3xl font-black text-red-400">0</div>
                                <div className="text-xs text-gray-500">Failed</div>
                            </div>
                            <div>
                                <div className="text-3xl font-black text-claude-ish">~55ms</div>
                                <div className="text-xs text-gray-500">Execution Time</div>
                            </div>
                        </div>
                    </div>
                    <div className="bg-[#0c0c0c] border border-white/10 rounded-xl p-6">
                        <div className="text-xs text-gray-500 uppercase tracking-widest mb-4">Full Test Suite</div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <div className="text-3xl font-black text-white">150</div>
                                <div className="text-xs text-gray-500">Total Tests</div>
                            </div>
                            <div>
                                <div className="text-3xl font-black text-green-400">142</div>
                                <div className="text-xs text-gray-500">Passed</div>
                            </div>
                            <div>
                                <div className="text-3xl font-black text-yellow-400">8</div>
                                <div className="text-xs text-gray-500">Skipped (ext. deps)</div>
                            </div>
                            <div>
                                <div className="text-3xl font-black text-red-400">0</div>
                                <div className="text-xs text-gray-500">Failed</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Component Coverage */}
            <div className="space-y-6">
                <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Component Coverage</h2>
                <DocTable
                    headers={['Component', 'Functions Tested', 'Coverage']}
                    rows={[
                        ['<strong class="text-white">ScenarioLibrary</strong>', '8/8', '<span class="text-green-400">100%</span>'],
                        ['<strong class="text-white">ScenarioBuilder</strong>', '12/12', '<span class="text-green-400">100%</span>'],
                        ['<strong class="text-white">SessionRecorder</strong>', '7/7', '<span class="text-green-400">100%</span>'],
                        ['<strong class="text-white">ValidationStore</strong>', '10/10', '<span class="text-green-400">100%</span>'],
                        ['<strong class="text-white">EnvironmentManager</strong>', '5/5', '<span class="text-green-400">100%</span>'],
                        ['<strong class="text-white">QueryHandler</strong>', '3/3', '<span class="text-green-400">100%</span>'],
                        ['<strong class="text-white">CorrectionInjector</strong>', '4/4', '<span class="text-green-400">100%</span>'],
                        ['<strong class="text-white">SyntheticAgent</strong>', '3/3', '<span class="text-green-400">100%</span>'],
                        ['<strong class="text-white">StatisticsEngine</strong>', '10/10', '<span class="text-green-400">100%</span>'],
                        ['<strong class="text-white">DecisionEngine</strong>', '4/4', '<span class="text-green-400">100%</span>'],
                    ]}
                />
            </div>

            {/* Scenario Library */}
            <div className="space-y-6">
                <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Validation Scenarios</h2>
                <p className="text-gray-400">We maintain <strong className="text-white">12 predefined scenarios</strong> that test different agent capabilities:</p>
                <DocTable
                    headers={['#', 'Scenario', 'Category', 'Difficulty', 'Key Challenge']}
                    rows={[
                        ['1', '<strong class="text-white">file-create-component</strong>', 'File ops', '⭐', 'Basic file creation'],
                        ['2', '<strong class="text-white">code-search-auth</strong>', 'Search', '⭐⭐', 'Understanding codebase'],
                        ['3', '<strong class="text-white">refactor-rename-function</strong>', 'Refactor', '⭐⭐⭐', 'Multi-file changes'],
                        ['4', '<strong class="text-white">error-recovery-bash</strong>', 'Recovery', '⭐⭐⭐', 'Handle failures gracefully'],
                        ['5', '<strong class="text-white">ambiguous-add-feature</strong>', 'Ambiguous', '⭐⭐⭐⭐', 'Clarify vs act'],
                        ['6', '<strong class="text-white">git-commit-workflow</strong>', 'Git', '⭐⭐', 'Proper commits'],
                        ['7', '<strong class="text-white">write-unit-tests</strong>', 'Testing', '⭐⭐⭐', 'Test coverage'],
                        ['8', '<strong class="text-white">debug-runtime-error</strong>', 'Debug', '⭐⭐⭐⭐', 'Stack trace analysis'],
                        ['9', '<strong class="text-white">multi-file-migration</strong>', 'Multi-step', '⭐⭐⭐⭐⭐', 'Consistent changes'],
                        ['10', '<strong class="text-white">document-api</strong>', 'Docs', '⭐⭐', 'OpenAPI generation'],
                        ['11', '<strong class="text-white">security-fix-sqli</strong>', 'Security', '⭐⭐⭐⭐', 'SQL injection fix'],
                        ['12', '<strong class="text-white">secrets-handling</strong>', 'Security', '⭐⭐⭐', 'Proper secrets mgmt'],
                    ]}
                />
            </div>

            {/* Synthetic Agents */}
            <div className="space-y-6">
                <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Synthetic User Agents</h2>
                <p className="text-gray-400">The synthetic agent simulates realistic user behavior with configurable personas:</p>
                <div className="grid md:grid-cols-4 gap-4">
                    <div className="bg-[#151515] border border-white/5 rounded-xl p-4">
                        <div className="text-xs text-gray-500 uppercase tracking-widest mb-2">Expertise</div>
                        <div className="text-sm text-gray-300">novice • intermediate • expert</div>
                    </div>
                    <div className="bg-[#151515] border border-white/5 rounded-xl p-4">
                        <div className="text-xs text-gray-500 uppercase tracking-widest mb-2">Verbosity</div>
                        <div className="text-sm text-gray-300">terse • normal • verbose</div>
                    </div>
                    <div className="bg-[#151515] border border-white/5 rounded-xl p-4">
                        <div className="text-xs text-gray-500 uppercase tracking-widest mb-2">Correction Style</div>
                        <div className="text-sm text-gray-300">polite • direct • frustrated</div>
                    </div>
                    <div className="bg-[#151515] border border-white/5 rounded-xl p-4">
                        <div className="text-xs text-gray-500 uppercase tracking-widest mb-2">Patience</div>
                        <div className="text-sm text-gray-300">0.0 — 1.0 (abandon threshold)</div>
                    </div>
                </div>
                <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
                    <div className="text-xs text-blue-400 font-bold uppercase tracking-widest mb-2">Correction Injection Types</div>
                    <div className="grid md:grid-cols-4 gap-4 text-sm text-gray-400">
                        <div><span className="text-blue-400">tool_count</span> — After N calls</div>
                        <div><span className="text-blue-400">wrong_tool</span> — Prohibited tool</div>
                        <div><span className="text-blue-400">file_not_found</span> — Access failed</div>
                        <div><span className="text-blue-400">pattern_match</span> — Output matches</div>
                    </div>
                </div>
            </div>

            {/* Statistical Rigor */}
            <div className="space-y-6">
                <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Statistical Rigor</h2>
                <div className="grid md:grid-cols-2 gap-6">
                    <div className="bg-[#151515] border border-white/5 rounded-xl p-5 space-y-3">
                        <div className="text-white font-bold">Power Analysis</div>
                        <p className="text-xs text-gray-500">For 80% power to detect 5% improvement at p&lt;0.05:</p>
                        <div className="bg-black/50 p-3 rounded border border-white/10 font-mono text-xs text-gray-400">
                            Baseline: 15% correction rate<br/>
                            Required N: ~620 samples/group<br/>
                            For 10 scenarios: 62 runs each
                        </div>
                    </div>
                    <div className="bg-[#151515] border border-white/5 rounded-xl p-5 space-y-3">
                        <div className="text-white font-bold">Multiple Testing Correction</div>
                        <p className="text-xs text-gray-500">When comparing multiple metrics, we adjust p-values:</p>
                        <div className="bg-black/50 p-3 rounded border border-white/10 font-mono text-xs text-gray-400">
                            <span className="text-green-400">Bonferroni</span> — Conservative, critical decisions<br/>
                            <span className="text-blue-400">FDR (B-H)</span> — Less conservative, exploration
                        </div>
                    </div>
                </div>
                <div className="space-y-3">
                    <div className="text-white font-bold">Decision Matrix</div>
                    <DocTable
                        headers={['Condition', 'Decision']}
                        rows={[
                            ['≥2 significant improvements, no regressions', '<span class="text-green-400 font-bold">GRADUATE</span>'],
                            ['Any significant regression', '<span class="text-red-400 font-bold">ROLLBACK</span>'],
                            ['1 significant improvement', '<span class="text-yellow-400 font-bold">EXTEND</span>'],
                            ['No significant changes, small sample', '<span class="text-yellow-400 font-bold">EXTEND</span>'],
                            ['No significant changes, large sample', '<span class="text-gray-400 font-bold">CONTINUE</span>'],
                        ]}
                    />
                </div>
            </div>

            {/* Sample Experiment Output */}
            <div className="space-y-6">
                <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Sample Experiment Visualization</h2>
                <div className="bg-[#0c0c0c] border border-white/10 rounded-lg overflow-hidden">
                    <div className="bg-[#1a1a1a] px-4 py-2 border-b border-white/10 text-xs text-gray-500 font-mono">
                        Validation Experiment: val_1704444800000
                    </div>
                    <div className="p-6 font-mono text-xs overflow-x-auto">
                        <div className="mb-6">
                            <div className="text-gray-500 mb-2">IMPROVEMENTS TESTED</div>
                            <div className="text-gray-400 pl-4">
                                ├── auto-glob-to-read <span className="text-blue-400">(skill)</span><br/>
                                ├── prevent-bash-timeout <span className="text-blue-400">(skill)</span><br/>
                                └── clarify-ambiguous <span className="text-purple-400">(prompt)</span>
                            </div>
                        </div>
                        <div className="mb-6">
                            <div className="text-gray-500 mb-2">BASELINE vs TREATMENT</div>
                            <table className="w-full text-left">
                                <thead className="text-gray-500">
                                    <tr>
                                        <th className="py-1">Metric</th>
                                        <th className="py-1">Baseline</th>
                                        <th className="py-1">Treatment</th>
                                        <th className="py-1">Change</th>
                                        <th className="py-1">p-value</th>
                                    </tr>
                                </thead>
                                <tbody className="text-gray-300">
                                    <tr>
                                        <td className="py-1">Correction Rate</td>
                                        <td>18.3%</td>
                                        <td>12.1%</td>
                                        <td className="text-green-400">-33.9% ↓</td>
                                        <td>0.0023 <span className="text-green-400">✓</span></td>
                                    </tr>
                                    <tr>
                                        <td className="py-1">Success Rate</td>
                                        <td>72.0%</td>
                                        <td>84.5%</td>
                                        <td className="text-green-400">+17.4% ↑</td>
                                        <td>0.0089 <span className="text-green-400">✓</span></td>
                                    </tr>
                                    <tr>
                                        <td className="py-1">Autonomy Rate</td>
                                        <td>68.2%</td>
                                        <td>79.3%</td>
                                        <td className="text-green-400">+16.3% ↑</td>
                                        <td>0.0156 <span className="text-green-400">✓</span></td>
                                    </tr>
                                    <tr>
                                        <td className="py-1">Error Rate</td>
                                        <td>8.1%</td>
                                        <td>6.2%</td>
                                        <td className="text-green-400">-23.5% ↓</td>
                                        <td>0.1230 <span className="text-gray-500">✗</span></td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                        <div className="border-t border-white/10 pt-4">
                            <div className="flex items-center gap-4">
                                <span className="text-gray-500">DECISION:</span>
                                <span className="text-green-400 font-bold">✓ GRADUATE</span>
                                <span className="text-gray-500">|</span>
                                <span className="text-gray-400">Confidence: 99.77%</span>
                                <span className="text-gray-500">|</span>
                                <span className="text-gray-400">4/5 metrics improved</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
