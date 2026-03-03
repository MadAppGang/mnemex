import React from 'react';
import { getVsCodeApi } from '../../vscode';
import { SymbolHeader } from './SymbolHeader';
import { SummarySection } from './SummarySection';
import { ReferenceList } from './ReferenceList';
import { CodePreview } from './CodePreview';
import type { UseCompanionReturn } from '../../hooks/useCompanion';

interface CompanionPanelProps {
  companion: UseCompanionReturn;
}

export function CompanionPanel({ companion }: CompanionPanelProps): React.JSX.Element {
  const handlePinToggle = () => {
    companion.togglePin();
    getVsCodeApi().postMessage({ type: 'companionTogglePin' });
  };

  // Empty state
  if (companion.empty && !companion.loading) {
    return (
      <div className="companion-empty">
        <div className="companion-empty-text">
          Move your cursor to a function, class, or method to see its context.
        </div>
      </div>
    );
  }

  // Loading state
  if (companion.loading) {
    return (
      <div className="companion-loading">
        <div className="spinner" />
        <span className="companion-loading-text">
          Loading {companion.symbolName}...
        </span>
      </div>
    );
  }

  return (
    <div className="companion-content">
      {/* Pin toggle */}
      <div className="companion-toolbar">
        <button
          className={`companion-pin-btn ${companion.pinned ? 'pinned' : ''}`}
          onClick={handlePinToggle}
          title={companion.pinned ? 'Unpin — resume auto-tracking' : 'Pin — stop auto-tracking'}
        >
          {companion.pinned ? '📌 Pinned' : '📌 Pin'}
        </button>
      </div>

      {/* Symbol header */}
      {companion.symbol && (
        <SymbolHeader
          symbol={companion.symbol}
          language={companion.language}
          symbolCount={companion.symbolCount}
        />
      )}

      {/* Summary */}
      <SummarySection summary={companion.summary} />

      {/* Callers */}
      {companion.callers && (
        <ReferenceList
          title="Callers"
          items={companion.callers.callers}
        />
      )}

      {/* Callees */}
      {companion.callees && (
        <ReferenceList
          title="Callees"
          items={companion.callees.callees}
        />
      )}

      {/* Source code */}
      {companion.sourceCode && companion.symbol && (
        <CodePreview
          sourceCode={companion.sourceCode}
          startLine={companion.symbol.line}
          language={companion.language}
        />
      )}
    </div>
  );
}
