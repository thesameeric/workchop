import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './features';
import { loadAccount, reportAuthError } from './lib/account';
import './lib/theme';
import './styles.css';

reportAuthError();
void loadAccount();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
