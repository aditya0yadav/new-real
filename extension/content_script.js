// =============================================================
//  Content Script — injected into every page
//  Captures: URL, domain, HTML, console logs, clicks,
//            scroll, JS errors, page timing, input events
// =============================================================
(function () {
  'use strict';

  // Prevent double-injection
  if (window.__MRT_INJECTED__) return;
  window.__MRT_INJECTED__ = true;

  const pageEntryTime = Date.now();
  const pageUrl = window.location.href;
  const pageDomain = window.location.hostname;

  // ── 1. Inject page-context console interceptor ────────────
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    script.dataset.mrtInjected = '1';
    (document.head || document.documentElement).appendChild(script);
    script.addEventListener('load', () => script.remove());
  } catch (e) {
    console.warn('[MRT] Could not inject inject.js:', e);
  }

  // ── 2. Receive console logs from inject.js ────────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__MRT_SOURCE__ !== 'inject') return;
    sendToBackground('CONSOLE_LOG', {
      level: e.data.level,
      message: e.data.message,
      stack: e.data.stack || null,
      timestamp: e.data.timestamp,
      pageUrl,
    });
  });

  // ── 3. Page visit info (immediately) ─────────────────────
  sendToBackground('PAGE_VISIT', {
    url: pageUrl,
    domain: pageDomain,
    title: document.title,
    referrer: document.referrer,
    entryTime: pageEntryTime,
    timestamp: pageEntryTime,
  });

  // ── 4. Full HTML snapshot + performance timing (on load) ──
  function capturePageSnapshot() {
    const html = document.documentElement.outerHTML;
    let timing = null;

    try {
      const pt = performance.timing;
      const nav = pt.navigationStart;
      timing = {
        domReady:        pt.domContentLoadedEventEnd - nav,
        fullLoad:        pt.loadEventEnd - nav,
        domInteractive:  pt.domInteractive - nav,
        responseEnd:     pt.responseEnd - nav,
        firstByte:       pt.responseStart - nav,
      };
    } catch (_) {}

    const navEntries = performance.getEntriesByType?.('navigation') || [];
    if (navEntries.length > 0) {
      const n = navEntries[0];
      timing = {
        domReady:       Math.round(n.domContentLoadedEventEnd),
        fullLoad:       Math.round(n.loadEventEnd),
        domInteractive: Math.round(n.domInteractive),
        responseEnd:    Math.round(n.responseEnd),
        firstByte:      Math.round(n.responseStart),
        transferSize:   n.transferSize || 0,
      };
    }

    sendToBackground('PAGE_HTML', {
      url: pageUrl,
      domain: pageDomain,
      title: document.title,
      html,
      timing,
      timestamp: Date.now(),
      htmlLength: html.length,
    });
  }

  if (document.readyState === 'complete') {
    setTimeout(capturePageSnapshot, 200);
  } else {
    window.addEventListener('load', () => setTimeout(capturePageSnapshot, 200));
  }

  // ── 5. Click events ───────────────────────────────────────
  document.addEventListener('click', (e) => {
    const t = e.target;
    sendToBackground('PAGE_EVENT', {
      type: 'click',
      x: e.clientX,
      y: e.clientY,
      target: {
        tag: t.tagName?.toLowerCase(),
        id: t.id || null,
        classes: typeof t.className === 'string' ? t.className.split(' ').filter(Boolean) : [],
        text: t.innerText?.substring(0, 120) || null,
        href: t.href || t.closest('a')?.href || null,
      },
      timestamp: Date.now(),
      pageUrl,
    });
  }, true);

  // ── 6. Scroll depth (debounced) ───────────────────────────
  let lastScrollDepth = 0;
  window.addEventListener('scroll', debounce(() => {
    const scrollTop = window.scrollY;
    const docHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    ) - window.innerHeight;
    const depth = docHeight > 0 ? Math.round((scrollTop / docHeight) * 100) : 100;

    if (Math.abs(depth - lastScrollDepth) >= 5) {
      lastScrollDepth = depth;
      sendToBackground('PAGE_EVENT', {
        type: 'scroll',
        scrollY: Math.round(scrollTop),
        scrollDepthPercent: depth,
        timestamp: Date.now(),
        pageUrl,
      });
    }
  }, 500));

  // ── 7. JS errors ──────────────────────────────────────────
  window.addEventListener('error', (e) => {
    sendToBackground('CONSOLE_LOG', {
      level: 'error',
      message: e.message || 'JS Error',
      stack: e.error?.stack || null,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      timestamp: Date.now(),
      pageUrl,
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    sendToBackground('CONSOLE_LOG', {
      level: 'error',
      message: `Unhandled Rejection: ${e.reason?.toString?.() || 'Unknown'}`,
      stack: e.reason?.stack || null,
      timestamp: Date.now(),
      pageUrl,
    });
  });

  // ── 8. Form / input changes (no password values) ──────────
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || t.type === 'password') return;
    sendToBackground('PAGE_EVENT', {
      type: 'input_change',
      target: {
        tag: t.tagName?.toLowerCase(),
        type: t.type || null,
        name: t.name || null,
        id: t.id || null,
      },
      timestamp: Date.now(),
      pageUrl,
    });
  }, true);

  // ── 9. Page visibility (tab switching) ────────────────────
  document.addEventListener('visibilitychange', () => {
    sendToBackground('PAGE_EVENT', {
      type: 'visibility',
      visible: !document.hidden,
      timestamp: Date.now(),
      pageUrl,
    });
  });

  // ── Helpers ───────────────────────────────────────────────
  function sendToBackground(type, data) {
    chrome.runtime.sendMessage({ type, data }).catch(() => {
      // Silently fail — session may not be active
    });
  }

  function debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }
})();
