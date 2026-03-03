import { useState, useCallback, useRef } from 'react';
import { getVsCodeApi } from '../vscode';
import type {
  HostToWebviewMessage,
  SymbolInfo,
  CallersResult,
  CalleesResult,
  ContextResult,
} from '../types/messages';

export type SymbolCommand = 'symbol' | 'callers' | 'callees' | 'context';

export interface SymbolNavState {
  query: string;
  command: SymbolCommand;
  loading: boolean;
  error: string | null;
  symbolResult: SymbolInfo | null;
  callersResult: CallersResult | null;
  calleesResult: CalleesResult | null;
  contextResult: ContextResult | null;
}

export interface UseSymbolNavReturn extends SymbolNavState {
  setQuery: (query: string) => void;
  setCommand: (command: SymbolCommand) => void;
  submit: () => void;
  handleMessage: (message: HostToWebviewMessage) => void;
}

function makeRequestId(): string {
  return `symbol-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useSymbolNav(): UseSymbolNavReturn {
  const [state, setState] = useState<SymbolNavState>({
    query: '',
    command: 'symbol',
    loading: false,
    error: null,
    symbolResult: null,
    callersResult: null,
    calleesResult: null,
    contextResult: null,
  });

  const activeRequestId = useRef<string>('');

  const setQuery = useCallback((query: string) => {
    setState((prev) => ({ ...prev, query }));
  }, []);

  const setCommand = useCallback((command: SymbolCommand) => {
    setState((prev) => ({
      ...prev,
      command,
      symbolResult: null,
      callersResult: null,
      calleesResult: null,
      contextResult: null,
      error: null,
    }));
  }, []);

  const submit = useCallback(() => {
    setState((prev) => {
      if (!prev.query.trim()) {
        return prev;
      }

      const requestId = makeRequestId();
      activeRequestId.current = requestId;

      const name = prev.query.trim();
      const messageMap: Record<SymbolCommand, () => void> = {
        symbol: () => getVsCodeApi().postMessage({ type: 'getSymbol', name, requestId }),
        callers: () => getVsCodeApi().postMessage({ type: 'getCallers', name, requestId }),
        callees: () => getVsCodeApi().postMessage({ type: 'getCallees', name, requestId }),
        context: () => getVsCodeApi().postMessage({ type: 'getContext', name, requestId }),
      };
      messageMap[prev.command]();

      return {
        ...prev,
        loading: true,
        error: null,
        symbolResult: null,
        callersResult: null,
        calleesResult: null,
        contextResult: null,
      };
    });
  }, []);

  const handleMessage = useCallback((message: HostToWebviewMessage) => {
    const isActive = (id: string) => id === activeRequestId.current;

    if (message.type === 'loading' && isActive(message.requestId)) {
      setState((prev) => ({ ...prev, loading: true }));
    } else if (message.type === 'error' && isActive(message.requestId)) {
      setState((prev) => ({ ...prev, loading: false, error: message.message }));
    } else if (message.type === 'symbolResult' && isActive(message.requestId)) {
      setState((prev) => ({ ...prev, loading: false, error: null, symbolResult: message.symbol }));
    } else if (message.type === 'callersResult' && isActive(message.requestId)) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: null,
        callersResult: message.data,
      }));
    } else if (message.type === 'calleesResult' && isActive(message.requestId)) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: null,
        calleesResult: message.data,
      }));
    } else if (message.type === 'contextResult' && isActive(message.requestId)) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: null,
        contextResult: message.data,
      }));
    }
  }, []);

  return { ...state, setQuery, setCommand, submit, handleMessage };
}
