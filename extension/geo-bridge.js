(function geovizGeoPhotoBridge() {
  if (window.__geovizGeoPhotoBridge) return;
  window.__geovizGeoPhotoBridge = true;

  const CALLBACK_PREFIX = "/**/_callbacks____";

  function parseBody(body) {
    if (!body || typeof body !== "string" || !body.startsWith(CALLBACK_PREFIX)) {
      return null;
    }
    const start = body.indexOf("(");
    const end = body.lastIndexOf(")");
    if (start === -1 || end === -1) return null;
    const json = body.slice(start + 1, end);
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  function forwardPayload(data) {
    if (!data) return;
    try {
      window.postMessage(
        {
          source: "geoviz-geo-photo",
          data: JSON.stringify(data),
        },
        "*"
      );
    } catch {
      /* ignore postMessage errors */
    }
  }

  function handleBody(body) {
    const parsed = parseBody(body);
    if (parsed) {
      forwardPayload(parsed);
    }
  }

  const originalFetch = window.fetch;
  window.fetch = async function geovizFetch(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      if (url && url.includes("GeoPhotoService") && response?.clone) {
        response
          .clone()
          .text()
          .then(handleBody)
          .catch(() => {});
      }
    } catch {
      /* ignore fetch hook errors */
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function geovizOpen(method, url, ...rest) {
    this.__geovizUrl = typeof url === "string" ? url : url?.toString();
    return originalOpen.call(this, method, url, ...rest);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function geovizSend(body) {
    this.addEventListener(
      "load",
      () => {
        try {
          if (this.__geovizUrl && String(this.__geovizUrl).includes("GeoPhotoService")) {
            handleBody(this.responseText);
          }
        } catch {
          /* ignore response parsing */
        }
      },
      { once: true }
    );
    return originalSend.call(this, body);
  };
})();
