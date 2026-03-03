import { useState, useCallback, useRef } from 'react';
import { getVsCodeApi } from '../vscode';
import type {
  HostToWebviewMessage,
  DeadCodeResult,
  TestGapResult,
  ImpactResult,
} from '../types/messages';

export type AnalysisTab = 'dead-code' | 'test-gaps' | 'impact';

export interface AnalysisState {
  activeTab: AnalysisTab;
  impactQuery: string;
  loading: boolean;
  error: string | null;
  deadCodeItems: DeadCodeResult[] | null;
  testGapItems: TestGapResult[] | null;
  impactResult: ImpactResult | null;
}

export interface UseAnalysisReturn extends AnalysisState {
  setActiveTab: (tab: AnalysisTab) => void;
  setImpactQuery: (query: string) => void;
  runAnalysis: () => void;
  handleMessage: (message: HostToWebviewMessage) => void;
}

function makeRequestId(): string {
  return `analysis-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useAnalysis(): UseAnalysisReturn {
  const [state, setState] = useState<AnalysisState>({
    activeTab: 'dead-code',
    impactQuery: '',
    loading: false,
    error: null,
    deadCodeItems: null,
    testGapItems: null,
    impactResult: null,
  });

  const activeRequestId = useRef<string>('');

  const setActiveTab = useCallback((tab: AnalysisTab) => {
    setState((prev) => ({ ...prev, activeTab: tab, error: null }));
  }, []);

  const setImpactQuery = useCallback((query: string) => {
    setState((prev) => ({ ...prev, impactQuery: query }));
  }, []);

  const runAnalysis = useCallback(() => {
    setState((prev) => {
      const requestId = makeRequestId();
      activeRequestId.current = requestId;

      if (prev.activeTab === 'dead-code') {
        getVsCodeApi().postMessage({ type: 'getDeadCode', requestId });
        return { ...prev, loading: true, error: null, deadCodeItems: null };
      } else if (prev.activeTab === 'test-gaps') {
        getVsCodeApi().postMessage({ type: 'getTestGaps', requestId });
        return { ...prev, loading: true, error: null, testGapItems: null };
      } else if (prev.activeTab === 'impact') {
        const name = prev.impactQuery.trim();
        if (!name) {
          return prev;
        }
        getVsCodeApi().postMessage({ type: 'getImpact', name, requestId });
        return { ...prev, loading: true, error: null, impactResult: null };
      }
      return prev;
    });
  }, []);

  const handleMessage = useCallback((message: HostToWebviewMessage) => {
    const isActive = (id: string) => id === activeRequestId.current;

    if (message.type === 'loading' && isActive(message.requestId)) {
      setState((prev) => ({ ...prev, loading: true }));
    } else if (message.type === 'error' && isActive(message.requestId)) {
      setState((prev) => ({ ...prev, loading: false, error: message.message }));
    } else if (message.type === 'deadCodeResult' && isActive(message.requestId)) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: null,
        deadCodeItems: message.items,
      }));
    } else if (message.type === 'testGapsResult' && isActive(message.requestId)) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: null,
        testGapItems: message.items,
      }));
    } else if (message.type === 'impactResult' && isActive(message.requestId)) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: null,
        impactResult: message.data,
      }));
    }
  }, []);

  return { ...state, setActiveTab, setImpactQuery, runAnalysis, handleMessage };
}
