const DEFAULT_CONFIG = {
  backendUrl: "http://localhost:8000",
  sessionPrefix: "chrome-session",
  autoPlayEnabled: false,
};

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaults();
});

function ensureDefaults() {
  chrome.storage.sync.get(DEFAULT_CONFIG, (config) => {
    const updates = {};
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      if (config[key] === undefined) {
        updates[key] = value;
      }
    }
    if (Object.keys(updates).length) {
      chrome.storage.sync.set(updates);
    }
  });
}

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_CONFIG, (config) => {
      resolve({
        backendUrl: config.backendUrl || DEFAULT_CONFIG.backendUrl,
        sessionPrefix: config.sessionPrefix || DEFAULT_CONFIG.sessionPrefix,
        autoPlayEnabled:
          typeof config.autoPlayEnabled === "boolean"
            ? config.autoPlayEnabled
            : DEFAULT_CONFIG.autoPlayEnabled,
      });
    });
  });
}

function saveConfig(partial) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_CONFIG, (current) => {
      const merged = { ...current, ...partial };
      chrome.storage.sync.set(merged, () => resolve(merged));
    });
  });
}

async function runInference(payload) {
  const config = await getConfig();
  const backendBase = payload.backendUrl || config.backendUrl || DEFAULT_CONFIG.backendUrl;
  const backendUrl = backendBase.replace(/\/$/, "") + "/v1/inference";

  const response = await fetch(backendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image_base64: payload.imageBase64,
      session_id: payload.sessionId || `${config.sessionPrefix}-${Date.now()}`,
      round_id: payload.roundId,
      metadata: payload.metadata ?? {},
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Inference failed: ${response.status}`);
  }
  return response.json();
}

async function logRound(payload) {
  const config = await getConfig();
  const backendBase = payload.backendUrl || config.backendUrl || DEFAULT_CONFIG.backendUrl;
  const backendUrl = backendBase.replace(/\/$/, "") + "/v1/rounds";

  const response = await fetch(backendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Round logging failed: ${response.status}`);
  }
  return response.json();
}

async function sendCoords(payload) {
  const config = await getConfig();
  const backendBase = payload.backendUrl || config.backendUrl || DEFAULT_CONFIG.backendUrl;
  const backendUrl = backendBase.replace(/\/$/, "") + "/v1/coords";

  const response = await fetch(backendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Coordinate export failed: ${response.status}`);
  }
  return response.json();
}

async function saveScreenshot(payload) {
  const config = await getConfig();
  const backendBase = payload.backendUrl || config.backendUrl || DEFAULT_CONFIG.backendUrl;
  const backendUrl = backendBase.replace(/\/$/, "") + "/v1/screenshot";

  const response = await fetch(backendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image_base64: payload.imageBase64,
      session_id: payload.sessionId || `${config.sessionPrefix}-${Date.now()}`,
      round_id: payload.roundId,
      metadata: payload.metadata ?? {},
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    const error = new Error(message || `Screenshot save failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

const GEO_CAPTURE_VERSION = "1.3";
const GEO_SERVICE_REGEX = /GeoPhotoService/i;
let geoCaptureTabId = null;
const geoRequestUrlById = new Map();
const utf8Decoder = new TextDecoder("utf-8");
let lastCoordinateSignature = null;

function decodeBase64ToUtf8(body) {
  try {
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return utf8Decoder.decode(bytes);
  } catch {
    try {
      return atob(body);
    } catch {
      return "";
    }
  }
}

function stripJSONPWrapper(text) {
  const first = text.indexOf("(");
  const last = text.lastIndexOf(")");
  if (first !== -1 && last !== -1 && last > first) {
    return text.slice(first + 1, last);
  }
  return text;
}

function parseGeoPayload(text) {
  if (!text) return null;
  const trimmed = stripJSONPWrapper(text.trim());
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBracket = trimmed.indexOf("[");
    const lastBracket = trimmed.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      try {
        return JSON.parse(trimmed.slice(firstBracket, lastBracket + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function findPlaceCandidate(node, preferredLanguages = ["en", "da", "es", "de"]) {
  let best = null;
  function scan(value) {
    if (value == null || best?._terminal) return;
    if (Array.isArray(value)) {
      if (
        value.length >= 2 &&
        typeof value[0] === "string" &&
        typeof value[1] === "string" &&
        value[1].length <= 5
      ) {
        const text = value[0].trim();
        const lang = value[1].toLowerCase();
        const looksLikePlace = /,|\s/.test(text) && text.length >= 3 && !/^©|\(c\)/i.test(text);
        if (looksLikePlace) {
          const languageScore = (preferredLanguages.indexOf(lang) + 1) || preferredLanguages.length + 1;
          const lengthPenalty = Math.abs(30 - text.length) / 30;
          const score = languageScore + lengthPenalty;
          if (!best || score < best.score) {
            best = { place: text, lang, score };
          }
        }
      }
      for (const entry of value) scan(entry);
    } else if (typeof value === "object") {
      for (const key of Object.keys(value)) {
        scan(value[key]);
      }
    }
  }
  scan(node);
  if (!best) return null;
  return { place: best.place, lang: best.lang };
}

function findCoordinates(node) {
  let lat = null;
  let lon = null;
  function scan(value) {
    if (lat !== null && lon !== null) return;
    if (Array.isArray(value)) {
      if (
        value.length >= 4 &&
        typeof value[2] === "number" &&
        typeof value[3] === "number"
      ) {
        lat = value[2];
        lon = value[3];
      }
      for (const entry of value) {
        scan(entry);
        if (lat !== null && lon !== null) return;
      }
    } else if (typeof value === "object" && value !== null) {
      for (const key of Object.keys(value)) {
        scan(value[key]);
        if (lat !== null && lon !== null) return;
      }
    }
  }
  scan(node);
  if (lat === null || lon === null) return null;
  return { lat, lon };
}

function sendGeoMetadataToTab(tabId, payload) {
  if (!tabId) return;
  chrome.tabs.sendMessage(
    tabId,
    { type: "GEO_METADATA", payload },
    () => chrome.runtime.lastError
  );
}

function persistGeoMetadata(payload) {
  chrome.storage.local.set({ geovizLastMetadata: payload }, () => chrome.runtime?.lastError);
}

async function emitGeoMetadata(tabId, metadata) {
  const signature = `${metadata.lat?.toFixed?.(5)}:${metadata.lon?.toFixed?.(5)}`;
  if (signature && signature === lastCoordinateSignature) {
    return;
  }
  lastCoordinateSignature = signature;
  persistGeoMetadata(metadata);
  sendGeoMetadataToTab(tabId, metadata);
  try {
    await sendCoords({
      lat: metadata.lat,
      lon: metadata.lon,
      source: metadata.source ?? "debugger",
      captured_at: new Date(metadata.timestamp || Date.now()).toISOString(),
      metadata: {
        place: metadata.place ?? null,
        language: metadata.language ?? null,
        url: metadata.url ?? null,
      },
    });
  } catch (error) {
    console.warn("[GeoViz] SEND_COORDS failed:", error);
  }
}

async function startGeoCapture(tabId) {
  if (!tabId) {
    throw new Error("Kein Tab für GeoCapture verfügbar.");
  }
  if (geoCaptureTabId === tabId) return;
  if (geoCaptureTabId !== null && geoCaptureTabId !== tabId) {
    await stopGeoCapture();
  }
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, GEO_CAPTURE_VERSION, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      chrome.debugger.sendCommand({ tabId }, "Network.enable", {}, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        geoCaptureTabId = tabId;
        geoRequestUrlById.clear();
        resolve();
      });
    });
  });
}

function stopGeoCapture() {
  return new Promise((resolve) => {
    if (geoCaptureTabId === null) {
      resolve();
      return;
    }
    const targetTab = geoCaptureTabId;
    chrome.debugger.detach({ tabId: targetTab }, () => {
      geoCaptureTabId = null;
      geoRequestUrlById.clear();
      lastCoordinateSignature = null;
      resolve();
    });
  });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== geoCaptureTabId) return;
  if (method !== "Network.responseReceived") return;
  const url = params?.response?.url || "";
  if (!GEO_SERVICE_REGEX.test(url)) return;
  geoRequestUrlById.set(params.requestId, url);
  chrome.debugger.sendCommand(
    { tabId: source.tabId },
    "Network.getResponseBody",
    { requestId: params.requestId },
    (body) => {
      if (chrome.runtime.lastError || !body) {
        return;
      }
      const text = body.base64Encoded ? decodeBase64ToUtf8(body.body) : body.body;
      const data = parseGeoPayload(text);
      if (!data) return;
      const coords = findCoordinates(data);
      if (!coords) return;
      const place = findPlaceCandidate(data);
      emitGeoMetadata(source.tabId, {
        lat: coords.lat,
        lon: coords.lon,
        place: place?.place ?? null,
        language: place?.lang ?? null,
        source: "debugger",
        url,
        timestamp: Date.now(),
        hookType: "debugger",
      });
    }
  );
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === geoCaptureTabId) {
    stopGeoCapture();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_CONFIG") {
    getConfig()
      .then((config) => sendResponse({ success: true, config }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.type === "RUN_INFERENCE") {
    runInference(message.payload)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.type === "LOG_ROUND") {
    logRound(message.payload)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.type === "SAVE_CONFIG") {
    saveConfig(message.payload || {})
      .then((config) => sendResponse({ success: true, config }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.type === "SEND_COORDS") {
    sendCoords(message.payload)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.type === "SAVE_SCREENSHOT") {
    saveScreenshot(message.payload)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error.message,
          status: typeof error.status === "number" ? error.status : null,
        })
      );
    return true;
  }

  if (message?.type === "START_GEO_CAPTURE") {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: "Kein Tab-Kontext verfügbar." });
      return true;
    }
    startGeoCapture(tabId)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.type === "STOP_GEO_CAPTURE") {
    stopGeoCapture()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  return false;
});
