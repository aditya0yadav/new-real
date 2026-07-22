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

  const BACKEND_URL = 'http://localhost:4000';
  const pageEntryTime = Date.now();
  const pageUrl = window.location.href;
  const pageDomain = window.location.hostname;
  let currentSessionId = null; // set when SESSION_STARTED fires

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

  // ── 2. Receive console logs from inject.js & window.postMessage ──
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__MRT_SOURCE__ === 'inject') {
      sendToBackground('CONSOLE_LOG', {
        level: e.data.level,
        message: e.data.message,
        stack: e.data.stack || null,
        timestamp: e.data.timestamp,
        pageUrl,
      });
    } else if (e.data.type === 'MRT_START_SESSION') {
      sendToBackground('START_SESSION', e.data.payload || e.data);
    } else if (e.data.type === 'MRT_STOP_SESSION') {
      sendToBackground('STOP_SESSION', e.data.payload || e.data);
    }
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

  // ── 3b. Listen for SESSION_STARTED ──────────────────────────
  // If session wasn't active when page loaded, re-send everything when it starts
  try {
    if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || msg.type !== 'SESSION_STARTED') return;

        currentSessionId = msg.sessionId;

        // Re-send page visit
        sendToBackground('PAGE_VISIT', {
          url: pageUrl,
          domain: pageDomain,
          title: document.title,
          referrer: document.referrer,
          entryTime: pageEntryTime,
          timestamp: Date.now(),
          retroactive: true,
        });

        // Capture rich environment data (timezone, IP, browser, device, network)
        captureEnvironment(msg.sessionId);

        // Post HTML snapshot directly to backend
        setTimeout(() => capturePageSnapshot(msg.sessionId), 300);

        // Re-inject inject.js to ensure console is hooked
        try {
          const script = document.createElement('script');
          script.src = chrome.runtime.getURL('inject.js');
          (document.head || document.documentElement).appendChild(script);
          script.addEventListener('load', () => script.remove());
        } catch (_) {}
      });
    }
  } catch (_) {}

  // ── 3c. Capture rich environment (timezone, IP, browser, device, network) ──
  async function captureEnvironment(sessionId) {
    const env = {
      capturedAt: new Date().toISOString(),
      pageUrl,

      // ── Timezone & locale ──
      timezone:       Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezoneOffset: new Date().getTimezoneOffset(),  // minutes from UTC (negative = ahead)
      localTime:      new Date().toLocaleString(),
      language:       navigator.language,
      languages:      Array.from(navigator.languages || []),

      // ── Browser fingerprint ──
      userAgent:      navigator.userAgent,
      platform:       navigator.platform,
      vendor:         navigator.vendor,
      cookieEnabled:  navigator.cookieEnabled,
      doNotTrack:     navigator.doNotTrack,
      onLine:         navigator.onLine,
      javaEnabled:    navigator.javaEnabled?.() ?? false,

      // ── Screen & display ──
      screen: {
        width:       screen.width,
        height:      screen.height,
        availWidth:  screen.availWidth,
        availHeight: screen.availHeight,
        colorDepth:  screen.colorDepth,
        pixelDepth:  screen.pixelDepth,
        pixelRatio:  window.devicePixelRatio,
        orientation: screen.orientation?.type || null,
      },

      // ── Viewport (visible browser area) ──
      viewport: {
        width:  window.innerWidth,
        height: window.innerHeight,
      },

      // ── Hardware ──
      hardware: {
        cpuCores:     navigator.hardwareConcurrency || null,
        deviceMemory: navigator.deviceMemory || null,  // GB (rounded)
        maxTouchPoints: navigator.maxTouchPoints || 0,
      },

      // ── Network connection ──
      network: (() => {
        const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (!c) return null;
        return {
          effectiveType: c.effectiveType || null,  // '4g', '3g', '2g', 'slow-2g'
          downlink:      c.downlink || null,        // Mbps
          rtt:           c.rtt || null,             // ms round trip time
          saveData:      c.saveData || false,       // data saver mode on?
          type:          c.type || null,            // 'wifi', 'cellular', etc.
        };
      })(),

      // ── Page load performance ──
      pagePerformance: (() => {
        try {
          const entries = performance.getEntriesByType('navigation');
          if (entries.length > 0) {
            const n = entries[0];
            return {
              dnsLookup:     Math.round(n.domainLookupEnd - n.domainLookupStart),
              tcpConnect:    Math.round(n.connectEnd - n.connectStart),
              tlsHandshake:  Math.round(n.secureConnectionStart > 0 ? n.connectEnd - n.secureConnectionStart : 0),
              timeToFirstByte: Math.round(n.responseStart - n.requestStart),
              downloadTime:  Math.round(n.responseEnd - n.responseStart),
              domParsing:    Math.round(n.domInteractive - n.responseEnd),
              domReady:      Math.round(n.domContentLoadedEventEnd),
              fullPageLoad:  Math.round(n.loadEventEnd),
              transferSizeKB: Math.round((n.transferSize || 0) / 1024),
              cachedLoad:    n.transferSize === 0,
            };
          }
        } catch (_) {}
        return null;
      })(),

      // ── Storage quotas ──
      storage: null, // filled async below

      // ── IP & location (filled async below) ──
      ip: null,
      ipData: null,
    };

    // Get storage quota
    try {
      const quota = await navigator.storage?.estimate();
      if (quota) {
        env.storage = {
          usedMB:  Math.round((quota.usage || 0) / 1024 / 1024),
          quotaMB: Math.round((quota.quota || 0) / 1024 / 1024),
        };
      }
    } catch (_) {}

    // Get battery info
    try {
      const battery = await navigator.getBattery?.();
      if (battery) {
        env.battery = {
          level:    Math.round(battery.level * 100),  // percentage
          charging: battery.charging,
          chargingTime: battery.chargingTime === Infinity ? null : battery.chargingTime,
          dischargingTime: battery.dischargingTime === Infinity ? null : battery.dischargingTime,
        };
      }
    } catch (_) {}

    // Get IP address & geo from public API (no key needed)
    try {
      const ipRes = await fetch('https://ipapi.co/json/', { cache: 'no-store' });
      if (ipRes.ok) {
        const ipData = await ipRes.json();
        env.ip = ipData.ip;
        env.ipData = {
          ip:          ipData.ip,
          city:        ipData.city,
          region:      ipData.region,
          country:     ipData.country_name,
          countryCode: ipData.country_code,
          postal:      ipData.postal,
          latitude:    ipData.latitude,
          longitude:   ipData.longitude,
          timezone:    ipData.timezone,  // cross-check with browser timezone
          isp:         ipData.org,
          asn:         ipData.asn,
        };
      }
    } catch (_) {}

    // POST directly to backend
    try {
      await fetch(`${BACKEND_URL}/api/session/${sessionId}/environment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(env),
      });
    } catch (_) {}
  }

  // ── 4. Full HTML snapshot + performance timing (on load) ──
  // sessionIdOverride: used when called from SESSION_STARTED (direct fetch, no 1MB limit)
  function capturePageSnapshot(sessionIdOverride) {
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

    const payload = {
      url: pageUrl,
      domain: pageDomain,
      title: document.title,
      html,
      timing,
      timestamp: Date.now(),
      htmlLength: html.length,
    };

    const sid = sessionIdOverride || currentSessionId;
    if (sid && window.location.protocol !== 'https:') {
      // Direct fetch to backend — avoids Chrome's 1MB message size limit (only on HTTP pages)
      fetch(`${BACKEND_URL}/api/session/${sid}/html`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    } else {
      // Fallback or HTTPS: relay through background (exempt from mixed-content restrictions)
      sendToBackground('PAGE_HTML', payload);
    }
  }

  if (document.readyState === 'complete') {
    setTimeout(capturePageSnapshot, 200);
  } else {
    window.addEventListener('load', () => setTimeout(capturePageSnapshot, 200));
  }

  // ── 4b. Live Contextual DOM Traversal Helper ────────────────
  function getContextualQuestionHeading(t) {
    if (!t || typeof t.closest !== 'function') return null;
    try {
      // 1. Container lookup
      const container = t.closest('.question, .form-group, .mb-3, .card, fieldset, form, [role="group"], .survey-step, .col-sm-12');
      if (container) {
        const heading = container.querySelector('h1, h2, h3, h4, h5, h6, legend, .q-title, .question-text, label.form-label, label.control-label, label');
        if (heading && heading.innerText) {
          const txt = heading.innerText.trim();
          if (txt && txt.length > 2 && !txt.isdigit?.()) return txt.substring(0, 180);
        }
      }
      // 2. Ancestor sibling lookup
      let curr = t;
      for (let i = 0; i < 5; i++) {
        if (!curr) break;
        let prev = curr.previousElementSibling;
        while (prev) {
          if (['H1','H2','H3','H4','H5','H6','LEGEND','P','LABEL'].includes(prev.tagName)) {
            const txt = prev.innerText ? prev.innerText.trim() : '';
            if (txt && txt.length > 3) return txt.substring(0, 180);
          }
          prev = prev.previousElementSibling;
        }
        curr = curr.parentElement;
      }
    } catch (_) {}
    return null;
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
        questionHeading: getContextualQuestionHeading(t),
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

  // ── 8. Form / input changes (captures typed values & question heading live) ──
  const sendInputEvent = (t) => {
    if (!t || t.type === 'password') return;
    const val = t.value !== undefined && t.value !== null ? String(t.value) : null;
    sendToBackground('PAGE_EVENT', {
      type: 'input_change',
      target: {
        tag: t.tagName?.toLowerCase(),
        type: t.type || null,
        name: t.name || null,
        id: t.id || null,
        value: val,
        questionHeading: getContextualQuestionHeading(t),
      },
      timestamp: Date.now(),
      pageUrl,
    });
  };

  document.addEventListener('input', debounce((e) => sendInputEvent(e.target), 300), true);
  document.addEventListener('change', (e) => sendInputEvent(e.target), true);

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
    try {
      if (typeof chrome === 'undefined' || !chrome?.runtime?.id || !chrome?.runtime?.sendMessage) return;
      const p = chrome.runtime.sendMessage({ type, data });
      if (p && typeof p.catch === 'function') {
        p.catch(() => {});
      }
    } catch (_) {
      // Extension context invalidated when user reloads extension in chrome://extensions
    }
  }

  function debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }
})();
