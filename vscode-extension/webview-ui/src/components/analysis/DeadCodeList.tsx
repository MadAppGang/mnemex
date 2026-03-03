import React from 'react';
import { FileLink } from '../shared/FileLink';
import type { DeadCodeResult } from '../../types/messages';

interface DeadCodeListProps {
  items: DeadCodeResult[];
}

export function DeadCodeList({ items }: DeadCodeListProps): React.JSX.Element {
  if (items.length === 0) {
    return <div className="empty-message">No dead code found.</div>;
  }

  return (
    <div className="analysis-list">
      <div className="analysis-count">{items.length} potentially unused symbols</div>
      <ul className="analysis-item-list">
        {items.map((item, i) => (
          <li key={`dead-${i}`} className="analysis-item">
            <div className="analysis-item-header">
              <span className="analysis-item-name">{item.name}</span>
              <span className="symbol-kind-badge">{item.kind}</span>
              <span className="analysis-item-rank">rank {item.pagerank.toFixed(5)}</span>
            </div>
            <FileLink filePath={item.file} line={item.line} label={`${item.file}:${item.line}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}
