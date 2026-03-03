import React from 'react';
import type { SymbolCommand } from '../../hooks/useSymbolNav';

interface SymbolInputProps {
  query: string;
  command: SymbolCommand;
  loading: boolean;
  onQueryChange: (query: string) => void;
  onCommandChange: (command: SymbolCommand) => void;
  onSubmit: () => void;
}

const COMMAND_OPTIONS: Array<{ value: SymbolCommand; label: string }> = [
  { value: 'symbol', label: 'Definition' },
  { value: 'callers', label: 'Callers' },
  { value: 'callees', label: 'Callees' },
  { value: 'context', label: 'Context' },
];

export function SymbolInput({
  query,
  command,
  loading,
  onQueryChange,
  onCommandChange,
  onSubmit,
}: SymbolInputProps): React.JSX.Element {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      onSubmit();
    }
  };

  return (
    <div className="symbol-input-row">
      <input
        className="search-input symbol-name-input"
        type="text"
        placeholder="Symbol name..."
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={loading}
        aria-label="Symbol name"
      />
      <select
        className="symbol-command-select"
        value={command}
        onChange={(e) => onCommandChange(e.target.value as SymbolCommand)}
        disabled={loading}
        aria-label="Command type"
      >
        {COMMAND_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <button
        className="btn symbol-go-btn"
        onClick={onSubmit}
        disabled={loading || !query.trim()}
        aria-label="Run"
      >
        Go
      </button>
    </div>
  );
}
