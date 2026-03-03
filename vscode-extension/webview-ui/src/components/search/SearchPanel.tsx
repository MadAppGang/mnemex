import React from 'react';
import { SearchInput } from './SearchInput';
import { ResultItem } from './ResultItem';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { ErrorMessage } from '../shared/ErrorMessage';
import type { SearchResult } from '../../types/messages';

interface SearchPanelProps {
  query: string;
  results: SearchResult[];
  loading: boolean;
  error: string | null;
  onQueryChange: (query: string) => void;
}

export function SearchPanel({
  query,
  results,
  loading,
  error,
  onQueryChange,
}: SearchPanelProps): React.JSX.Element {
  return (
    <div className="panel search-panel">
      <SearchInput value={query} onChange={onQueryChange} />

      {error && <ErrorMessage message={error} />}

      {loading && (
        <div className="loading-row">
          <LoadingSpinner />
        </div>
      )}

      {!loading && !error && results.length === 0 && query.trim() && (
        <div className="empty-message">No results found.</div>
      )}

      {!loading && results.length > 0 && (
        <div className="result-list" role="list">
          {results.map((result, index) => (
            <ResultItem key={`${result.file}:${result.line}:${index}`} result={result} />
          ))}
        </div>
      )}
    </div>
  );
}
