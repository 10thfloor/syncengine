import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider } from '@syncengine/client';
import App, { db } from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider store={db}>
      <App />
    </StoreProvider>
  </StrictMode>,
);
