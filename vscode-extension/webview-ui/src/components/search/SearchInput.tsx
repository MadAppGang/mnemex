import React from 'react';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function SearchInput({ value, onChange, disabled }: SearchInputProps): React.JSX.Element {
  return (
    <input
      type="text"
      className="search-input"
      placeholder="Search code semantically..."
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      autoFocus
      aria-label="Search query"
    />
  );
}
