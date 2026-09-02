(function () {
  'use strict';

  if (window.__MTD_API_CACHE_INSTALLED__) return;
  window.__MTD_API_CACHE_INSTALLED__ = true;

  const nativeFetch = window.fetch.bind(window);
  const PREFIX = 'mtd-api-cache:v1:';
  const inflight = new Map();

  // Cache only small, read-only endpoints that are repeatedly requested.
  // Server-side authorization still runs on all real API requests.
  const RULES = [
    { test: p => p === '/api/auth/session', ttl: 60 * 1000 },
    { test: p => p === '/api/dashboard/summary', ttl: 30 * 1000 },
    { test: p => p === '/api/dashboard/today', ttl: 30 * 1000 }
  ];

  function normalizeUrl(input) {
    try {
      const raw = typeof input === 'string' ? input : input && input.url;
      return new URL(raw, window.location.origin);
    } catch (_) {
      return null;
    }
  }

  function methodOf(input, init) {
    return String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
  }

  function ruleFor(pathname) {
    return RULES.find(rule => rule.test(pathname)) || null;
  }

  function storageKey(url) {
    return PREFIX + url.pathname + url.search;
  }

  function readCache(url, ttl) {
    try {
      const raw = sessionStorage.getItem(storageKey(url));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.savedAt || Date.now() - parsed.savedAt > ttl) {
        sessionStorage.removeItem(storageKey(url));
        return null;
      }
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function writeCache(url, response, bodyText) {
    try {
      const headers = {};
      ['content-type', 'etag', 'x-mtd-cache', 'server-timing'].forEach(name => {
        const value = response.headers.get(name);
        if (value) headers[name] = value;
      });
      sessionStorage.setItem(storageKey(url), JSON.stringify({
        savedAt: Date.now(),
        status: response.status,
        statusText: response.statusText,
        headers,
        bodyText
      }));
    } catch (_) {}
  }

  function cachedResponse(entry) {
    const headers = new Headers(entry.headers || {});
    headers.set('X-MTD-Browser-Cache', 'HIT');
    return new Response(entry.bodyText || '', {
      status: entry.status || 200,
      statusText: entry.statusText || 'OK',
      headers
    });
  }

  function clearDashboardCache() {
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (!key || !key.startsWith(PREFIX)) continue;
        if (
          key.includes('/api/dashboard/summary') ||
          key.includes('/api/dashboard/today')
        ) {
          sessionStorage.removeItem(key);
        }
      }
    } catch (_) {}
  }

  function clearAllMtdCache() {
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key && key.startsWith(PREFIX)) sessionStorage.removeItem(key);
      }
    } catch (_) {}
  }

  window.mtdClearApiCache = clearAllMtdCache;

  window.fetch = async function (input, init) {
    const url = normalizeUrl(input);
    const method = methodOf(input, init);

    if (!url || url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
      return nativeFetch(input, init);
    }

    // Any successful mutation can change dashboard numbers, so expire dashboard cache.
    if (method !== 'GET' && method !== 'HEAD') {
      const response = await nativeFetch(input, init);
      if (response.ok) {
        clearDashboardCache();
        if (url.pathname.includes('/logout')) clearAllMtdCache();
      }
      return response;
    }

    const rule = ruleFor(url.pathname);
    if (!rule) return nativeFetch(input, init);

    const hit = readCache(url, rule.ttl);
    if (hit) return cachedResponse(hit);

    // If two scripts request the same URL at the same time, perform only one network request.
    const key = method + ' ' + url.href;
    if (inflight.has(key)) {
      const result = await inflight.get(key);
      return result.clone();
    }

    const requestPromise = (async () => {
      const response = await nativeFetch(input, init);
      if (!response.ok) return response;

      try {
        const copy = response.clone();
        const bodyText = await copy.text();
        writeCache(url, response, bodyText);
      } catch (_) {}

      return response;
    })();

    inflight.set(key, requestPromise);

    try {
      const response = await requestPromise;
      return response.clone();
    } finally {
      inflight.delete(key);
    }
  };
})();