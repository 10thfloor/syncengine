import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider } from '@syncengine/client';
import './index.css';
import App, { db } from './App.tsx';

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <StoreProvider store={db}>
            <App />
        </StoreProvider>
    </StrictMode>,
);
