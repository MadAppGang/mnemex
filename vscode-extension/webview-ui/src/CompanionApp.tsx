import React, { useEffect } from 'react';
import { getVsCodeApi } from './vscode';
import { useVscodeMessages } from './hooks/useVscodeMessages';
import { useCompanion } from './hooks/useCompanion';
import { CompanionPanel } from './components/companion/CompanionPanel';
import './styles/companion.css';

export function CompanionApp(): React.JSX.Element {
  const companion = useCompanion();

  useVscodeMessages(companion.handleMessage);

  useEffect(() => {
    getVsCodeApi().postMessage({ type: 'companionReady' });
  }, []);

  return (
    <div className="companion-app">
      <CompanionPanel companion={companion} />
    </div>
  );
}
