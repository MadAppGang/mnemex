import React from 'react';
import { getVsCodeApi } from '../../vscode';
import { LoadingSpinner } from './LoadingSpinner';
import type { IndexStatus } from '../../types/messages';

interface StatusBarProps {
  status: IndexStatus | null;
  reindexing: boolean;
  reindexLog: string[];
  onReindex: (requestId: string) => void;
}

function makeRequestId(): string {
  return `reindex-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function StatusBar({ status, reindexing, reindexLog, onReindex }: StatusBarProps): React.JSX.Element {
  const handleReindex = () => {
    const requestId = makeRequestId();
    onReindex(requestId);
    getVsCodeApi().postMessage({ type: 'reindex', requestId });
  };

  const dotClass = status?.exists ? 'status-dot ok' : 'status-dot missing';

  return (
    <div className="status-bar">
      <span className={dotClass} title={status?.exists ? 'Index exists' : 'No index'} />
      {status?.exists ? (
        <span className="status-text">
          {status.files != null ? `${status.files} files` : ''}
          {status.chunks != null ? ` · ${status.chunks} chunks` : ''}
        </span>
      ) : (
        <span className="status-text">Not indexed</span>
      )}

      {reindexing ? (
        <LoadingSpinner />
      ) : (
        <button className="btn btn-secondary" onClick={handleReindex} style={{ marginLeft: 'auto' }}>
          Re-index
        </button>
      )}

      {reindexLog.length > 0 && (
        <div className="reindex-log">
          {reindexLog.map((line, i) => (
            <div key={i} className="reindex-log-line">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
