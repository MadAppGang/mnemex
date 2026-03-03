import React from 'react';

interface PageRankBadgeProps {
  pagerank: number;
  symbolCount: number;
}

/**
 * Color-coded PageRank badge matching the TUI's heat-map scheme.
 *
 * ratio = pagerank / (1 / symbolCount)
 * ratio >= 5  → green  (#1B5E20) — "high importance"
 * ratio >= 1  → orange (#E65100) — "average"
 * ratio < 1   → red    (#B71C1C) — "low importance"
 */
export function PageRankBadge({ pagerank, symbolCount }: PageRankBadgeProps): React.JSX.Element {
  const expected = 1 / Math.max(symbolCount, 1);
  const ratio = pagerank / expected;

  let color: string;
  let label: string;
  if (ratio >= 5) {
    color = '#1B5E20';
    label = 'high';
  } else if (ratio >= 1) {
    color = '#E65100';
    label = 'avg';
  } else {
    color = '#B71C1C';
    label = 'low';
  }

  return (
    <span
      className="pagerank-badge"
      style={{ backgroundColor: color }}
      title={`PageRank ${pagerank.toFixed(6)} — ${label} importance (${ratio.toFixed(1)}x avg)`}
    >
      PR {pagerank.toFixed(4)}
    </span>
  );
}
