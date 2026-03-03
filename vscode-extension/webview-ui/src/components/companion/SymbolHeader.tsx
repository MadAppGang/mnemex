import React from 'react';
import { getVsCodeApi } from '../../vscode';
import { PageRankBadge } from './PageRankBadge';
import type { SymbolInfo } from '../../types/messages';

interface SymbolHeaderProps {
  symbol: SymbolInfo;
  language: string | null;
  symbolCount: number;
}

export function SymbolHeader({ symbol, language, symbolCount }: SymbolHeaderProps): React.JSX.Element {
  const handleFileClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    getVsCodeApi().postMessage({ type: 'companionOpenFile', filePath: symbol.file, line: symbol.line });
  };

  return (
    <div className="companion-header">
      <div className="companion-header-row">
        <span className="companion-symbol-name">{symbol.name}</span>
        <span className="companion-kind-badge">{symbol.kind}</span>
        {symbol.exported && <span className="companion-exported-badge">exported</span>}
        <PageRankBadge pagerank={symbol.pagerank} symbolCount={symbolCount} />
      </div>
      <div className="companion-meta-row">
        {language && <span className="companion-language">{language}</span>}
        <span className="companion-lines">
          lines {symbol.line}–{symbol.endLine}
        </span>
        <button
          className="file-link"
          onClick={handleFileClick}
          title={`Open ${symbol.file} at line ${symbol.line}`}
        >
          {symbol.file}:{symbol.line}
        </button>
      </div>
      {symbol.signature && (
        <pre className="companion-signature">{symbol.signature}</pre>
      )}
    </div>
  );
}
