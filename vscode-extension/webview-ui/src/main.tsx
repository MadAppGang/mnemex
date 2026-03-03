import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { CompanionApp } from './CompanionApp';
import './styles/index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

const mode = rootElement.getAttribute('data-mode');

createRoot(rootElement).render(
  <React.StrictMode>
    {mode === 'companion' ? <CompanionApp /> : <App />}
  </React.StrictMode>,
);
