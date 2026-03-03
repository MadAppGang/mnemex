import React from 'react';

interface SummarySectionProps {
  summary: string | null;
}

export function SummarySection({ summary }: SummarySectionProps): React.JSX.Element | null {
  if (!summary) {
    return null;
  }

  return (
    <div className="companion-section">
      <div className="companion-section-title">Summary</div>
      <p className="companion-summary-text">{summary}</p>
    </div>
  );
}
