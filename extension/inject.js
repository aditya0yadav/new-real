// =============================================================
//  inject.js — runs in PAGE context (not extension context)
//  Intercepts console.log/warn/error/info/debug
//  Posts captured logs to content_script via window.postMessage
// =============================================================
(function () {
  'use strict';

  // Prevent double-injection
  if (window.__MRT_CONSOLE_HOOKED__) return;
  window.__MRT_CONSOLE_HOOKED__ = true;

  const LEVELS = ['log', 'warn', 'error', 'info', 'debug', 'trace', 'group', 'groupEnd'];

  LEVELS.forEach((level) => {
    const originalFn = console[level]?.bind(console);
    if (!originalFn) return;

    console[level] = function (...args) {
      // Always call original first
      originalFn(...args);

      // Safely serialize arguments
      let message;
      try {
        message = args
          .map((a) => {
            if (a === null) return 'null';
            if (a === undefined) return 'undefined';
            if (typeof a === 'object') {
              try { return JSON.stringify(a, null, 0); }
              catch { return String(a); }
            }
            return String(a);
          })
          .join(' ');
      } catch (_) {
        message = '[MRT: could not serialize log]';
      }

      // Capture stack trace for errors/warnings
      let stack = null;
      if (level === 'error' || level === 'warn') {
        try {
          const err = new Error();
          // Remove the first 2 lines (Error + this function frame)
          const lines = (err.stack || '').split('\n').slice(2);
          stack = lines.join('\n').trim();
        } catch (_) {}
      }

      // Post to content_script
      try {
        window.postMessage(
          {
            __MRT_SOURCE__: 'inject',
            level,
            message,
            stack,
            timestamp: Date.now(),
          },
          '*'
        );
      } catch (_) {}
    };
  });
})();
