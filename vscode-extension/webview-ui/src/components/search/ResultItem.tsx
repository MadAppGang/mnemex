import React from 'react';
import { getVsCodeApi } from '../../vscode';
import type { SearchResult } from '../../types/messages';

interface ResultItemProps {
  result: SearchResult;
}

export function ResultItem({ result }: ResultItemProps): React.JSX.Element {
  const scorePercent = Math.round(result.score * 100);
  const shortFile = result.file.replace(/^.*[/\\]/, '');

  const handleClick = () => {
    getVsCodeApi().postMessage({ type: 'openFile', filePath: result.file, line: result.line });
  };

  return (
    <div className="result-item" onClick={handleClick} role="button" tabIndex={0}>
      <div className="result-header">
        <span className="result-name">{result.name}</span>
        <span className="result-score" title={`Score: ${result.score.toFixed(4)}`}>
          {scorePercent}%
        </span>
        <span className="result-type">{result.type}</span>
      </div>
      <div className="result-path">
        <span className="file-link">{shortFile}:{result.line}</span>
      </div>
      {result.summary && (
        <div className="result-snippet">{result.summary}</div>
      )}
    </div>
  );
}
