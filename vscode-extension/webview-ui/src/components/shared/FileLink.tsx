import React from 'react';
import { getVsCodeApi } from '../../vscode';

interface FileLinkProps {
  filePath: string;
  line: number;
  label?: string;
}

/**
 * A button styled as a link that navigates to a file:line in the editor.
 * Sends an openFile message to the extension host.
 *
 * NOTE: line numbers from claudemem are 1-based. The extension host performs
 * the 1-based -> 0-based conversion before calling vscode.Position.
 */
export function FileLink({ filePath, line, label }: FileLinkProps): React.JSX.Element {
  const handleClick = () => {
    getVsCodeApi().postMessage({ type: 'openFile', filePath, line });
  };

  const display = label ?? `${filePath}:${line}`;

  return (
    <button
      className="file-link"
      onClick={handleClick}
      title={`Open ${filePath} at line ${line}`}
    >
      {display}
    </button>
  );
}
