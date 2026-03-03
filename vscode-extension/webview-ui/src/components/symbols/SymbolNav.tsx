import React from 'react';
import { SymbolInput } from './SymbolInput';
import { SymbolDetail } from './SymbolDetail';
import { CallersList } from './CallersList';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { ErrorMessage } from '../shared/ErrorMessage';
import type { UseSymbolNavReturn } from '../../hooks/useSymbolNav';

interface SymbolNavProps {
  nav: Omit<UseSymbolNavReturn, 'handleMessage'>;
}

export function SymbolNav({ nav }: SymbolNavProps): React.JSX.Element {
  const {
    query,
    command,
    loading,
    error,
    symbolResult,
    callersResult,
    calleesResult,
    contextResult,
    setQuery,
    setCommand,
    submit,
  } = nav;

  const hasResult = symbolResult || callersResult || calleesResult || contextResult;

  return (
    <div className="panel symbol-nav-panel">
      <SymbolInput
        query={query}
        command={command}
        loading={loading}
        onQueryChange={setQuery}
        onCommandChange={setCommand}
        onSubmit={submit}
      />

      {error && <ErrorMessage message={error} />}

      {loading && (
        <div className="loading-row">
          <LoadingSpinner />
        </div>
      )}

      {!loading && !error && !hasResult && (
        <div className="empty-message">
          Enter a symbol name and press Go.
        </div>
      )}

      {!loading && symbolResult && (
        <SymbolDetail symbol={symbolResult} />
      )}

      {!loading && callersResult && (
        <CallersList data={callersResult} mode="callers" />
      )}

      {!loading && calleesResult && (
        <CallersList data={calleesResult} mode="callees" />
      )}

      {!loading && contextResult && (
        <CallersList data={contextResult} mode="context" />
      )}
    </div>
  );
}
