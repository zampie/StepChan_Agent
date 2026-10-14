import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SettingsView } from './ui/SettingsView';
import { installDiagnostics } from './platform/diagnostics';
import './style.css';

// 先装诊断再挂载：挂载过程本身出错也要能被看到。
installDiagnostics();

// 两个窗口共用同一份前端产物，用 hash 区分。
// 桌宠窗口是透明无边框的，设置窗口是普通有边框窗口 —— 它们的样式前提完全不同，
// 所以不能共享一个根组件。
const isSettings = window.location.hash.startsWith('#/settings');

// StrictMode 的双次挂载会让 Pixi 的 Application 和 realtime WebSocket 各建两次，
// 桌宠窗口因此只在设置窗口里开 StrictMode。
createRoot(document.getElementById('root')!).render(
  isSettings ? (
    <React.StrictMode>
      <SettingsView />
    </React.StrictMode>
  ) : (
    <App />
  ),
);
