import React, { useState, useCallback, useEffect, useRef } from 'react';
import { getVsCodeApi } from './vscode';
import { useVscodeMessages } from './hooks/useVscodeMessages';
import { useSearch } from './hooks/useSearch';
import { useSymbolNav } from './hooks/useSymbolNav';
import { useAnalysis } from './hooks/useAnalysis';
import { TabBar, type TabId } from './components/TabBar';
import { SearchPanel } from './components/search/SearchPanel';
import { SymbolNav } from './components/symbols/SymbolNav';
import { AnalysisPanel } from './components/analysis/AnalysisPanel';
import { StatusBar } from './components/shared/StatusBar';
import type { HostToWebviewMessage, IndexStatus } from './types/messages';

export function App(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<TabId>('search');
  const [projectPath, setProjectPath] = useState<string>('');
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);

  // Reindex state owned by App so handleMessage can route reindexLine/reindexComplete
  const [reindexing, setReindexing] = useState(false);
  const [reindexLog, setReindexLog] = useState<string[]>([]);
  const activeReindexId = useRef<string>('');

  const search = useSearch();
  const symbolNav = useSymbolNav();
  const analysis = useAnalysis();

  // Route incoming messages to the appropriate handler
  const handleMessage = useCallback(
    (message: HostToWebviewMessage) => {
      switch (message.type) {
        case 'init':
          setProjectPath(message.projectPath);
          setIndexStatus({ exists: message.indexExists });
          break;

        case 'statusResult':
          setIndexStatus(message.status);
          break;

        case 'reindexLine':
          if (message.requestId === activeReindexId.current) {
            setReindexLog((prev) => [...prev.slice(-9), message.line]);
          }
          break;

        case 'reindexComplete':
          if (message.requestId === activeReindexId.current) {
            setReindexing(false);
            setReindexLog([]);
            // Refresh status after reindex
            getVsCodeApi().postMessage({ type: 'getStatus', requestId: `post-reindex-${Date.now()}` });
          }
          break;

        case 'error':
          if (message.requestId === activeReindexId.current) {
            setReindexing(false);
            setReindexLog([]);
          }
          // Also route errors to other handlers (they filter by requestId)
          search.handleMessage(message);
          symbolNav.handleMessage(message);
          analysis.handleMessage(message);
          break;

        default:
          // Route to the appropriate hook handler
          search.handleMessage(message);
          symbolNav.handleMessage(message);
          analysis.handleMessage(message);
          break;
      }
    },
    [search, symbolNav, analysis],
  );

  const handleReindex = useCallback((requestId: string) => {
    activeReindexId.current = requestId;
    setReindexing(true);
    setReindexLog([]);
  }, []);

  useVscodeMessages(handleMessage);

  // Signal readiness to the host. The host re-sends 'init' in response to 'ready',
  // ensuring the webview always gets projectPath even if it loaded after the first send.
  useEffect(() => {
    getVsCodeApi().postMessage({ type: 'ready' });
  }, []);

  return (
    <div className="app">
      <StatusBar
        status={indexStatus}
        reindexing={reindexing}
        reindexLog={reindexLog}
        onReindex={handleReindex}
      />
      <TabBar activeTab={activeTab} onTabChange={setActiveTab} />

      <div className="tab-content">
        {activeTab === 'search' && (
          <SearchPanel
            query={search.query}
            results={search.results}
            loading={search.loading}
            error={search.error}
            onQueryChange={search.setQuery}
          />
        )}
        {activeTab === 'symbols' && (
          <SymbolNav nav={symbolNav} />
        )}
        {activeTab === 'analysis' && (
          <AnalysisPanel analysis={analysis} />
        )}
      </div>
    </div>
  );
}
