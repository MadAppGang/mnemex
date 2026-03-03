import React from 'react';
import { FileLink } from '../shared/FileLink';
import type { TestGapResult } from '../../types/messages';

interface TestGapsListProps {
  items: TestGapResult[];
}

export function TestGapsList({ items }: TestGapsListProps): React.JSX.Element {
  if (items.length === 0) {
    return <div className="empty-message">No test gaps found.</div>;
  }

  return (
    <div className="analysis-list">
      <div className="analysis-count">{items.length} symbols needing test coverage</div>
      <ul className="analysis-item-list">
        {items.map((item, i) => (
          <li key={`gap-${i}`} className="analysis-item">
            <div className="analysis-item-header">
              <span className="analysis-item-name">{item.name}</span>
              <span className="symbol-kind-badge">{item.kind}</span>
              <span className="analysis-item-rank">rank {item.pagerank.toFixed(4)}</span>
            </div>
            <div className="analysis-item-meta">
              <FileLink filePath={item.file} line={item.line} label={`${item.file}:${item.line}`} />
              <span className="analysis-item-callers">{item.callers} callers</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
