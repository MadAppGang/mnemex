import React from 'react';

export type TabId = 'search' | 'symbols' | 'analysis';

interface TabBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'search', label: 'Search' },
  { id: 'symbols', label: 'Symbols' },
  { id: 'analysis', label: 'Analysis' },
];

export function TabBar({ activeTab, onTabChange }: TabBarProps): React.JSX.Element {
  return (
    <div className="tab-bar" role="tablist">
      {TABS.map(({ id, label }) => (
        <button
          key={id}
          role="tab"
          aria-selected={activeTab === id}
          className={`tab${activeTab === id ? ' active' : ''}`}
          onClick={() => onTabChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
