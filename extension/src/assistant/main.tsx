import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/styles.css';
import { initContextLogging } from '../lib/log.js';
import { App } from './App.js';

initContextLogging('assistant').info('opened');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
