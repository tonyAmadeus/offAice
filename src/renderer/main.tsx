import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary, reportRenderError } from './ErrorBoundary';
import './styles.css';
import './team.css';
import './project-room.css';

// Errors outside rendering (event handlers, timers, promises) never reach a boundary; record them too.
window.addEventListener('error', event => reportRenderError('窗口脚本', event.error ?? event.message));
window.addEventListener('unhandledrejection', event => reportRenderError('后台请求', event.reason));

createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary area="AIROOM 界面" fullPage><App /></ErrorBoundary></React.StrictMode>);
