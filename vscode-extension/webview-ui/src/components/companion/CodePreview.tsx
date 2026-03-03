import React from 'react';

interface CodePreviewProps {
  sourceCode: string;
  startLine: number;
  language: string | null;
}

export function CodePreview({ sourceCode, startLine, language }: CodePreviewProps): React.JSX.Element {
  const lines = sourceCode.split('\n');

  return (
    <div className="companion-section">
      <div className="companion-section-title">
        Code{language ? ` (${language})` : ''}
      </div>
      <div className="companion-code-block">
        <table className="companion-code-table">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="companion-code-row">
                <td className="companion-line-number">{startLine + i}</td>
                <td className="companion-code-line">{line}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
