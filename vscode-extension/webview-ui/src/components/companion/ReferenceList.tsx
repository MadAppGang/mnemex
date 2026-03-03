import React from 'react';
import { getVsCodeApi } from '../../vscode';

interface ReferenceItem {
  name: string;
  file: string;
  line: number;
  kind: string;
}

interface ReferenceListProps {
  title: string;
  items: ReferenceItem[];
}

export function ReferenceList({ title, items }: ReferenceListProps): React.JSX.Element {
  const handleClick = (filePath: string, line: number) => {
    getVsCodeApi().postMessage({ type: 'companionOpenFile', filePath, line });
  };

  return (
    <div className="companion-section">
      <div className="companion-section-title">
        {title} ({items.length})
      </div>
      {items.length === 0 ? (
        <div className="companion-empty-hint">None found.</div>
      ) : (
        <ul className="companion-ref-list">
          {items.map((item, i) => (
            <li key={`${item.name}-${item.file}-${i}`} className="companion-ref-item">
              <span className="companion-ref-name">{item.name}</span>
              <span className="companion-ref-kind">{item.kind}</span>
              <button
                className="file-link"
                onClick={() => handleClick(item.file, item.line)}
                title={`Open ${item.file} at line ${item.line}`}
              >
                {item.file}:{item.line}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
