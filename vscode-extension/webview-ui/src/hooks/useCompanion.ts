import { useState, useCallback } from 'react';
import type {
  HostToWebviewMessage,
  SymbolInfo,
  CallersResult,
  CalleesResult,
} from '../types/messages';

export interface CompanionState {
  symbolName: string | null;
  symbol: SymbolInfo | null;
  callers: CallersResult | null;
  callees: CalleesResult | null;
  summary: string | null;
  sourceCode: string | null;
  language: string | null;
  symbolCount: number;
  loading: boolean;
  empty: boolean;
  pinned: boolean;
}

export interface UseCompanionReturn extends CompanionState {
  handleMessage: (message: HostToWebviewMessage) => void;
  togglePin: () => void;
}

export function useCompanion(): UseCompanionReturn {
  const [state, setState] = useState<CompanionState>({
    symbolName: null,
    symbol: null,
    callers: null,
    callees: null,
    summary: null,
    sourceCode: null,
    language: null,
    symbolCount: 100,
    loading: false,
    empty: true,
    pinned: false,
  });

  const handleMessage = useCallback((message: HostToWebviewMessage) => {
    switch (message.type) {
      case 'companionLoading':
        setState((prev) => ({
          ...prev,
          loading: true,
          empty: false,
          symbolName: message.symbolName,
        }));
        break;

      case 'companionUpdate':
        setState((prev) => ({
          ...prev,
          loading: false,
          empty: false,
          symbolName: message.symbolName,
          symbol: message.symbol,
          callers: message.callers,
          callees: message.callees,
          summary: message.summary,
          sourceCode: message.sourceCode,
          language: message.language,
          symbolCount: message.symbolCount,
        }));
        break;

      case 'companionEmpty':
        setState((prev) => ({
          ...prev,
          loading: false,
          empty: true,
          symbolName: null,
          symbol: null,
          callers: null,
          callees: null,
          summary: null,
          sourceCode: null,
          language: null,
        }));
        break;

      default:
        break;
    }
  }, []);

  const togglePin = useCallback(() => {
    setState((prev) => ({ ...prev, pinned: !prev.pinned }));
  }, []);

  return { ...state, handleMessage, togglePin };
}
