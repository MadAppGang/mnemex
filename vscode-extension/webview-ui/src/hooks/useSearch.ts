import { useState, useCallback, useRef, useEffect } from 'react';
import { getVsCodeApi } from '../vscode';
import type { SearchResult, HostToWebviewMessage } from '../types/messages';

interface SearchState {
  query: string;
  results: SearchResult[];
  loading: boolean;
  error: string | null;
}

interface UseSearchReturn extends SearchState {
  setQuery: (query: string) => void;
  handleMessage: (message: HostToWebviewMessage) => void;
}

function makeRequestId(): string {
  return `search-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Search state hook with 300ms debounce.
 * Sends search messages to the host and handles searchResults/error responses.
 * Ignores responses with mismatched requestId to avoid stale results.
 */
export function useSearch(): UseSearchReturn {
  const [state, setState] = useState<SearchState>({
    query: '',
    results: [],
    loading: false,
    error: null,
  });

  const activeRequestId = useRef<string>('');
  const prevRequestId = useRef<string>('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setQuery = useCallback((query: string) => {
    setState((prev) => ({ ...prev, query }));

    // Clear previous debounce
    if (debounceTimer.current !== null) {
      clearTimeout(debounceTimer.current);
    }

    const trimmed = query.trim();
    if (!trimmed) {
      setState((prev) => ({ ...prev, results: [], loading: false, error: null }));
      return;
    }

    // Require at least 3 characters to avoid expensive short-query API calls
    if (trimmed.length < 3) {
      return;
    }

    debounceTimer.current = setTimeout(() => {
      const requestId = makeRequestId();
      prevRequestId.current = activeRequestId.current;
      activeRequestId.current = requestId;

      setState((prev) => ({ ...prev, loading: true, error: null }));

      // Cancel the previous request if any
      if (prevRequestId.current) {
        getVsCodeApi().postMessage({ type: 'cancel', requestId: prevRequestId.current });
      }

      getVsCodeApi().postMessage({ type: 'search', query: query.trim(), requestId });
    }, 600);
  }, []);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);

  const handleMessage = useCallback((message: HostToWebviewMessage) => {
    if (message.type === 'searchResults') {
      if (message.requestId !== activeRequestId.current) {
        return; // Stale response — ignore
      }
      setState((prev) => ({
        ...prev,
        results: message.results,
        loading: false,
        error: null,
      }));
    } else if (message.type === 'loading' && message.requestId === activeRequestId.current) {
      setState((prev) => ({ ...prev, loading: true }));
    } else if (message.type === 'error' && message.requestId === activeRequestId.current) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: message.message,
      }));
    }
  }, []);

  return { ...state, setQuery, handleMessage };
}
