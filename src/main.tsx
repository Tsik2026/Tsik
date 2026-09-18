import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'
import { applyPrefs, loadPrefs } from './lib/prefs'

applyPrefs(loadPrefs())

// PWA-автообновление: когда новый сервис-воркер берёт управление страницей,
// перезагружаем её, чтобы пользователь сразу получил свежую версию.
// Первую активацию (на чистом устройстве) не перезагружаем.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    window.location.reload();
  });
  // периодическая проверка обновлений: при возврате во вкладку и раз в 30 минут
  navigator.serviceWorker.ready
    .then((reg) => {
      const check = () => reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      window.setInterval(check, 30 * 60 * 1000);
    })
    .catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
