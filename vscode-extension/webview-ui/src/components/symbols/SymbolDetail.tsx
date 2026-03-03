import React from 'react';
import { FileLink } from '../shared/FileLink';
import type { SymbolInfo } from '../../types/messages';

interface SymbolDetailProps {
  symbol: SymbolInfo;
}

export function SymbolDetail({ symbol }: SymbolDetailProps): React.JSX.Element {
  return (
    <div className="symbol-detail">
      <div className="symbol-detail-header">
        <span className="symbol-name">{symbol.name}</span>
        <span className="symbol-kind-badge">{symbol.kind}</span>
        {symbol.exported && <span className="symbol-exported-badge">exported</span>}
      </div>

      <div className="symbol-detail-meta">
        <FileLink filePath={symbol.file} line={symbol.line} />
        {symbol.endLine > symbol.line && (
          <span className="symbol-lines">
            lines {symbol.line}–{symbol.endLine}
          </span>
        )}
        <span className="symbol-rank">rank {symbol.pagerank.toFixed(4)}</span>
      </div>

      {symbol.signature && (
        <pre className="symbol-signature">{symbol.signature}</pre>
      )}
    </div>
  );
}
