import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App, { pageLoaded } from './App';
import { loadStatus } from './features/billing/state';
import './features/styles';
import { loadAccount, reportAuthError } from './lib/account';
import { route } from './lib/router';
import './lib/theme';
import './styles.css';
// The legal pages, registered before the first route().
import './ui/legal';

reportAuthError();
void loadAccount();
// The home page's prices. (The features, billing among them, load only when something needs them.)
void loadStatus();
route();

// The page for this address first, so the first paint shows it (the home page needs nothing more). If
// it can't load, the page says so.
void pageLoaded()
  .catch(() => {})
  .then(() =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  );
