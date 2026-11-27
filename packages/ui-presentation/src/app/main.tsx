import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/noto-sans-lao/lao-400.css';
import '@fontsource/noto-sans-lao/lao-500.css';
import '@fontsource/noto-sans-lao/lao-600.css';
import '@fontsource/noto-sans-lao/lao-700.css';
import { App } from './App.tsx';
import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Missing #root mount element in index.html');
}

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
