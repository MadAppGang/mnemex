import React from 'react';
import { DeadCodeList } from './DeadCodeList';
import { TestGapsList } from './TestGapsList';
import { ImpactList } from './ImpactList';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { ErrorMessage } from '../shared/ErrorMessage';
import type { UseAnalysisReturn, AnalysisTab } from '../../hooks/useAnalysis';

interface AnalysisPanelProps {
  analysis: Omit<UseAnalysisReturn, 'handleMessage'>;
}

const TABS: Array<{ id: AnalysisTab; label: string }> = [
  { id: 'dead-code', label: 'Dead Code' },
  { id: 'test-gaps', label: 'Test Gaps' },
  { id: 'impact', label: 'Impact' },
];

export function AnalysisPanel({ analysis }: AnalysisPanelProps): React.JSX.Element {
  const {
    activeTab,
    impactQuery,
    loading,
    error,
    deadCodeItems,
    testGapItems,
    impactResult,
    setActiveTab,
    setImpactQuery,
    runAnalysis,
  } = analysis;

  const handleTabClick = (tab: AnalysisTab) => {
    setActiveTab(tab);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      runAnalysis();
    }
  };

  return (
    <div className="panel analysis-panel">
      <div className="sub-tab-bar">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`sub-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => handleTabClick(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'impact' && (
        <div className="symbol-input-row">
          <input
            className="search-input symbol-name-input"
            type="text"
            placeholder="Symbol name..."
            value={impactQuery}
            onChange={(e) => setImpactQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
            aria-label="Symbol name for impact analysis"
          />
          <button
            className="btn symbol-go-btn"
            onClick={runAnalysis}
            disabled={loading || !impactQuery.trim()}
          >
            Analyze
          </button>
        </div>
      )}

      {activeTab !== 'impact' && (
        <div className="analysis-run-row">
          <button
            className="btn"
            onClick={runAnalysis}
            disabled={loading}
          >
            {loading ? 'Running...' : 'Run'}
          </button>
        </div>
      )}

      {error && <ErrorMessage message={error} />}

      {loading && (
        <div className="loading-row">
          <LoadingSpinner />
        </div>
      )}

      {!loading && !error && activeTab === 'dead-code' && deadCodeItems !== null && (
        <DeadCodeList items={deadCodeItems} />
      )}

      {!loading && !error && activeTab === 'test-gaps' && testGapItems !== null && (
        <TestGapsList items={testGapItems} />
      )}

      {!loading && !error && activeTab === 'impact' && impactResult !== null && (
        <ImpactList data={impactResult} />
      )}

      {!loading && !error &&
        ((activeTab === 'dead-code' && deadCodeItems === null) ||
          (activeTab === 'test-gaps' && testGapItems === null) ||
          (activeTab === 'impact' && impactResult === null && !impactQuery.trim())) && (
          <div className="empty-message">
            {activeTab === 'impact' ? 'Enter a symbol name and press Analyze.' : 'Press Run to analyze.'}
          </div>
        )}
    </div>
  );
}
