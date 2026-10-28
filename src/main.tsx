import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Register Service Worker for GitHub Pages static deployments
if (typeof window !== 'undefined' && 'serviceWorker' in navigator && !window.location.hostname.includes('run.app')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

createRoot(document.getElementById('root')!).render(<App />);
