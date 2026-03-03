import React from 'react';
import { FileLink } from '../shared/FileLink';
import type { ImpactResult } from '../../types/messages';

interface ImpactListProps {
  data: ImpactResult;
}

export function ImpactList({ data }: ImpactListProps): React.JSX.Element {
  if (data.affected.length === 0) {
    return (
      <div className="analysis-list">
        <div className="analysis-count">
          No transitive callers found for <strong>{data.symbol}</strong>.
        </div>
      </div>
    );
  }

  return (
    <div className="analysis-list">
      <div className="analysis-count">
        {data.affected.length} symbols affected by changes to{' '}
        <strong>{data.symbol}</strong>
      </div>
      <ul className="analysis-item-list">
        {data.affected.map((item, i) => (
          <li key={`affected-${i}`} className="analysis-item">
            <div className="analysis-item-header">
              <span className="analysis-item-name">{item.name}</span>
              <span className="symbol-kind-badge">{item.kind}</span>
            </div>
            <FileLink filePath={item.file} line={item.line} label={`${item.file}:${item.line}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}
