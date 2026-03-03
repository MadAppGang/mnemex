import React from 'react';
import { FileLink } from '../shared/FileLink';
import type { CallersResult, CalleesResult, ContextResult } from '../../types/messages';

interface CallersListProps {
  data: CallersResult | CalleesResult | ContextResult;
  mode: 'callers' | 'callees' | 'context';
}

export function CallersList({ data, mode }: CallersListProps): React.JSX.Element {
  if (mode === 'context') {
    const ctx = data as ContextResult;
    return (
      <div className="callers-list">
        <div className="symbol-detail-header">
          <span className="symbol-name">{ctx.symbol}</span>
          <span className="symbol-kind-badge">{ctx.kind}</span>
        </div>
        <div className="symbol-detail-meta">
          <FileLink filePath={ctx.file} line={ctx.line} />
        </div>

        <div className="callers-section">
          <div className="callers-section-title">Callers ({ctx.callers.length})</div>
          {ctx.callers.length === 0 ? (
            <div className="empty-message">No callers found.</div>
          ) : (
            <ul className="callers-item-list">
              {ctx.callers.map((c, i) => (
                <li key={`caller-${i}`} className="callers-item">
                  <span className="callers-item-name">{c.name}</span>
                  <FileLink filePath={c.file} line={c.line} label={`${c.file}:${c.line}`} />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="callers-section">
          <div className="callers-section-title">Callees ({ctx.callees.length})</div>
          {ctx.callees.length === 0 ? (
            <div className="empty-message">No callees found.</div>
          ) : (
            <ul className="callers-item-list">
              {ctx.callees.map((c, i) => (
                <li key={`callee-${i}`} className="callers-item">
                  <span className="callers-item-name">{c.name}</span>
                  <FileLink filePath={c.file} line={c.line} label={`${c.file}:${c.line}`} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  const isCallers = mode === 'callers';
  const result = data as CallersResult | CalleesResult;
  const items = isCallers
    ? (result as CallersResult).callers
    : (result as CalleesResult).callees;
  const label = isCallers ? 'Callers' : 'Callees';

  return (
    <div className="callers-list">
      <div className="callers-section-title">
        {label} of <strong>{result.symbol}</strong> ({items.length})
      </div>
      {items.length === 0 ? (
        <div className="empty-message">No {label.toLowerCase()} found.</div>
      ) : (
        <ul className="callers-item-list">
          {items.map((item, i) => (
            <li key={`item-${i}`} className="callers-item">
              <span className="callers-item-name">{item.name}</span>
              <span className="callers-item-kind">{item.kind}</span>
              <FileLink filePath={item.file} line={item.line} label={`${item.file}:${item.line}`} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
