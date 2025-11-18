const OVERLAY_ID = "geoviz-overlay";
const STATUS_IDLE = "Bereit. Lade ein neues Street-View-Bild oder klicke auf Predict.";
const STATUS_ERROR = "Fehler: ";
const ROUND_LIMIT = 5;

const SELECTORS = {
  mapToggle: [
    "button[data-qa='guess-map-button']",
    "button[aria-label*='map']",
    "button[class*='toggle-map']",
    "button[data-qa='toggle-map']",
  ],
  searchToggle: [
    "button[data-qa='guess-map-search-button']",
    "button[aria-label*='Search'][aria-label*='map']",
    "button[title*='Search'][title*='map']",
    "div[data-qa='guess-map'] button svg[aria-label*='search']",
  ],
  searchInput: [
    "input[data-qa='guess-map-search']",
    "input[placeholder*='Search']",
    "input[type='text'][class*='search']",
    "input[data-qa='guess-map-input']",
    "input[data-qa='guess-map-search-input']",
    "div[data-qa='guess-map'] input[type='text']",
  ],
  guessButtons: [
    "button[data-qa='guess-button']",
    "button[data-qa='make-guess']",
    "button[class*='guess-button']",
    "button[aria-label*='Guess']",
    "button[data-qa='perform-guess']",
  ],
  resultPanels: [
    "div[data-qa='round-result']",
    "div[class*='result-layout']",
    "div[class*='resultPanel']",
  ],
  mapCanvas: [
    "canvas[data-qa='guess-map-canvas']",
    "div[class*='guessMap'] canvas",
    ".guess-map canvas",
    '[data-qa="guess-map"] canvas',
  ],
  guessMapRoots: [
    '[data-qa="guess-map"]',
    ".guess-map",
    "div[class*='guessMap']",
    "div[data-qa='guess-map-wrapper']",
  ],
  resultMapRoots: [
    '[data-qa="result-map"]',
    '[data-qa="round-result-map"]',
    "div[class*='resultMap']",
    "div[data-qa='round-result']",
  ],
  viewResultsButtons: [
    "button[data-qa='close-round-result']",
    "button[class*='viewResults']",
  ],
  playAgainButtons: [
    "button[data-qa='play-again']",
    "button[class*='playAgain']",
    "[data-qa='play-again']",
    "[data-qa='play-next-map']",
    "[aria-label*='play again' i]",
    "[role='button'][data-qa*='play']",
  ],
};

const BUTTON_TEXT = {
  guess: ["guess", "make guess", "lock guess"],
  next: ["next", "next round", "go to next round", "continue", "proceed"],
  playAgain: ["play again", "play next map", "play another map", "new game", "play again"],
};

let currentSessionId = "";
let currentRound = 1;
let currentPrediction = null;
let lastInferencePayload = null;
let lastPreviewDataUrl = null;
let lastGuessCoordinates = null;
let canvasCache = null;
let autoPlayActive = false;
let autoPlayAbortController = null;
let extensionConfig = {
  autoPlayEnabled: false,
  sessionPrefix: "chrome-session",
};
let latestStreetViewMetadata = null;
let lastProcessedPhotoId = null;
const roundMetadata = new Map();
let screenshotApiAvailable = true;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true }
      );
    }
  });
}

function waitForCondition(checkFn, { timeout = 8000, interval = 200, signal } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const result = checkFn();
      if (result) {
        resolve(result);
        return;
      }
      if (Date.now() - start > timeout) {
        reject(new Error("Timeout waiting for condition."));
        return;
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

async function waitForElement(selectors, options) {
  return waitForCondition(() => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }, options);
}

function queryButtonByText(textList) {
  const lowerTargets = textList.map((t) => t.toLowerCase());
  const candidates = document.querySelectorAll("button, [role='button'], a[href], [data-qa]");
  for (const candidate of candidates) {
    const text = candidate.textContent?.trim().toLowerCase();
    if (!text) continue;
    if (lowerTargets.some((target) => text.includes(target))) {
      return candidate;
    }
  }
  return null;
}

let mapboxInstrumentationAttached = false;
let mapboxInstrumentationScheduled = false;

function ensureMapboxInstrumentation() {
  if (mapboxInstrumentationAttached || mapboxInstrumentationScheduled) return;
  mapboxInstrumentationScheduled = true;
  const attemptHook = () => {
    const mapLib =
      window.mapboxgl || window.maplibregl || window.maplibre || window.MapboxGeolib || window.maplibre?.default;
    if (mapLib?.Marker?.prototype) {
      patchMarkerClass(mapLib.Marker);
      mapboxInstrumentationAttached = true;
      return;
    }
    setTimeout(attemptHook, 800);
  };
  attemptHook();
}

function patchMarkerClass(MarkerClass) {
  if (MarkerClass.prototype.__geovizInstrumented) return;
  const originalSetLngLat = MarkerClass.prototype.setLngLat;
  MarkerClass.prototype.setLngLat = function patchedSetLngLat(lngLat) {
    const normalized = normalizeLngLatInput(lngLat);
    const result = originalSetLngLat.call(this, lngLat);
    if (normalized) {
      const element = typeof this.getElement === "function" ? this.getElement() : null;
      if (element instanceof HTMLElement) {
        annotateMarkerElement(element, normalized.lat, normalized.lon);
      }
    }
    return result;
  };
  MarkerClass.prototype.__geovizInstrumented = true;
}

function normalizeLngLatInput(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 2) {
    const [lon, lat] = value;
    const parsedLat = Number(lat);
    const parsedLon = Number(lon);
    if (Number.isFinite(parsedLat) && Number.isFinite(parsedLon)) {
      return { lat: parsedLat, lon: parsedLon };
    }
    return null;
  }
  if (typeof value === "object") {
    const lat = Number(value.lat ?? value.latitude ?? value[1]);
    const lon = Number(value.lng ?? value.lon ?? value.longitude ?? value[0]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { lat, lon };
    }
  }
  return null;
}

function annotateMarkerElement(element, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  element.dataset.geovizLat = String(lat);
  element.dataset.geovizLon = String(lon);
  const kind = inferMarkerKind(element);
  if (kind) {
    element.dataset.geovizMarkerKind = kind;
  }
  const scope = determineMarkerScope(element);
  if (scope) {
    element.dataset.geovizScope = scope;
  }
  element.dispatchEvent(
    new CustomEvent("geoviz-marker-update", {
      bubbles: true,
      detail: { lat, lon, kind, scope },
    })
  );
}

function inferMarkerKind(element) {
  if (!element) return null;
  const existing = element.dataset?.geovizMarkerKind;
  if (existing) return existing;
  const className = element.className?.toString().toLowerCase() ?? "";
  if (/correct|actual|target|answer|result|solution/.test(className)) return "result";
  if (/guess|player|user|your|mine|marker-guess/.test(className)) return "guess";
  const parentClass = element.parentElement?.className?.toString().toLowerCase() ?? "";
  if (/guess/.test(parentClass)) return "guess";
  if (/correct|actual|result/.test(parentClass)) return "result";
  const ariaLabel = (element.getAttribute("aria-label") || element.getAttribute("title") || "").toLowerCase();
  if (ariaLabel.includes("correct") || ariaLabel.includes("actual") || ariaLabel.includes("result")) return "result";
  if (ariaLabel.includes("guess") || ariaLabel.includes("your") || ariaLabel.includes("my guess")) return "guess";
  return null;
}

function determineMarkerScope(element) {
  if (!element) return null;
  if (belongsToGuessMap(element)) return "guess";
  if (belongsToResultMap(element)) return "result";
  return null;
}

function belongsToGuessMap(element) {
  if (!element) return false;
  return Boolean(
    element.closest("[data-qa='guess-map'], .guess-map, div[data-qa='guess-map-wrapper'], div[class*='guessMap']")
  );
}

function belongsToResultMap(element) {
  if (!element) return false;
  return Boolean(
    element.closest(
      "[data-qa='round-result'], [data-qa='result-map'], [data-qa='round-result-map'], div[class*='resultMap'], div[class*='resultPanel']"
    )
  );
}

function computeRelativeMarkerPosition(element) {
  if (!(element instanceof HTMLElement)) return null;
  const mapRoot =
    element.closest(
      "[data-qa='result-map'], [data-qa='round-result-map'], div[class*='resultMap'], .mapboxgl-map, canvas[data-qa='result-map']"
    ) ||
    element.closest("[data-qa='guess-map'], .guess-map, .mapboxgl-map");
  if (!mapRoot) return null;
  const mapRect = mapRoot.getBoundingClientRect();
  if (mapRect.width <= 0 || mapRect.height <= 0) return null;
  const markerRect = element.getBoundingClientRect();
  const centerX = markerRect.left + markerRect.width / 2;
  const centerY = markerRect.top + markerRect.height / 2;
  return {
    xRatio: (centerX - mapRect.left) / mapRect.width,
    yRatio: (centerY - mapRect.top) / mapRect.height,
  };
}

function distanceKm(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every((value) => Number.isFinite(value))) {
    return Number.POSITIVE_INFINITY;
  }
  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

document.addEventListener(
  "geoviz-marker-update",
  (event) => {
    const detail = event.detail || {};
    if (detail.scope === "guess" && Number.isFinite(detail.lat) && Number.isFinite(detail.lon)) {
      lastGuessCoordinates = { lat: detail.lat, lon: detail.lon };
    }
  },
  { capture: false }
);

function buildMetadataPayload() {
  const resultKey = `round-${currentRound}`;
  const storedResult = roundMetadata.get(resultKey);
  return {
    round_index: currentRound,
    session_id: currentSessionId,
    last_guess: lastGuessCoordinates
      ? { lat: lastGuessCoordinates.lat, lon: lastGuessCoordinates.lon }
      : null,
    street_view: latestStreetViewMetadata
      ? {
          lat: latestStreetViewMetadata.lat ?? null,
          lon: latestStreetViewMetadata.lon ?? null,
          country: latestStreetViewMetadata.country_code ?? latestStreetViewMetadata.country ?? null,
          photo_id: latestStreetViewMetadata.photoId ?? null,
        }
      : null,
    result_from_map: storedResult
      ? {
          lat: storedResult.lat ?? null,
          lon: storedResult.lon ?? null,
          country: storedResult.country ?? null,
          relative: storedResult.actual_relative ?? null,
        }
      : null,
  };
}

function createOverlay() {
  if (document.getElementById(OVERLAY_ID)) return;

  const overlay = document.createElement("section");
  overlay.id = OVERLAY_ID;
  overlay.innerHTML = `
    <header>
      <div>
        <strong>GeoGuessr AI</strong>
        <p id="geoviz-status">${STATUS_IDLE}</p>
      </div>
      <button id="geoviz-close" title="Overlay ausblenden">×</button>
    </header>
    <div class="visual-panel">
      <div class="preview-card">
        <span>Status:</span>
        <div class="preview-image">
          <img id="geoviz-preview" alt="Preview" />
        </div>
      </div>
      <div class="top-countries">
        <h4>Top Countries</h4>
        <ul id="geoviz-top-countries"></ul>
      </div>
    </div>
    <div class="map-panel">
      <canvas id="geoviz-map" width="260" height="160"></canvas>
    </div>
    <div class="panel controls">
      <label>Session
        <input id="geoviz-session" type="text" />
      </label>
      <label>Round
        <input id="geoviz-round" type="number" min="1" value="1" />
      </label>
      <div class="actions">
        <button id="geoviz-predict">Predict</button>
        <button id="geoviz-next" class="ghost">Next Round</button>
        <button id="geoviz-scrape" class="ghost">Scrape</button>
      </div>
      <button id="geoviz-auto" class="auto-btn">Auto Play: OFF</button>
      <div id="geoviz-result" class="result"></div>
    </div>
  `;

  document.body.appendChild(overlay);
  updatePreview();

  overlay.querySelector("#geoviz-close").addEventListener("click", () => {
    overlay.classList.toggle("minimized");
  });

  overlay.querySelector("#geoviz-predict").addEventListener("click", () => triggerInference());
  overlay.querySelector("#geoviz-next").addEventListener("click", () => incrementRound());
  overlay.querySelector("#geoviz-scrape").addEventListener("click", () => scrapeRound());
  overlay.querySelector("#geoviz-auto").addEventListener("click", () => toggleAutoPlay());

  overlay.querySelector("#geoviz-session").addEventListener("input", (event) => {
    currentSessionId = event.target.value;
  });
  overlay.querySelector("#geoviz-round").addEventListener("input", (event) => {
    currentRound = Number(event.target.value) || 1;
  });
}

function updateStatus(message) {
  const status = document.getElementById("geoviz-status");
  if (status) status.textContent = message;
}

function updateResult(prediction) {
  const result = document.getElementById("geoviz-result");
  if (!result) return;
  if (!prediction) {
    result.innerHTML = "<em>Noch keine Prediction.</em>";
    renderTopCountries(null);
    drawGridMap(null);
    return;
  }

  result.innerHTML = `
    <div class="grid">
      <div>
        <span>Latitude</span>
        <strong>${prediction.lat.toFixed(5)}</strong>
      </div>
      <div>
        <span>Longitude</span>
        <strong>${prediction.lon.toFixed(5)}</strong>
      </div>
      <div>
        <span>Continent</span>
        <strong>${prediction.continent?.id ?? "?"}</strong>
        <small>${formatConfidence(prediction.continent?.confidence)}</small>
      </div>
      <div>
        <span>Country</span>
        <strong>${prediction.country?.id ?? "?"}</strong>
        <small>${formatConfidence(prediction.country?.confidence)}</small>
      </div>
      <div>
        <span>Grid L4</span>
        <strong>${prediction.grid_l4?.id ?? "?"}</strong>
      </div>
      <div>
        <span>Grid L6</span>
        <strong>${prediction.grid_l6?.id ?? "?"}</strong>
      </div>
    </div>
    <footer>
      <small>ID: ${prediction.inference_id}</small>
      <small>${prediction.inference_time_ms} ms</small>
    </footer>
  `;
  renderTopCountries(prediction);
  drawGridMap(prediction);
}

function updatePreview() {
  const img = document.getElementById("geoviz-preview");
  if (!img) return;
  if (lastPreviewDataUrl) {
    img.src = lastPreviewDataUrl;
    img.style.opacity = "1";
  } else {
    img.removeAttribute("src");
    img.style.opacity = "0.25";
  }
}

function renderTopCountries(prediction) {
  const list = document.getElementById("geoviz-top-countries");
  if (!list) return;
  list.innerHTML = "";
  const entries =
    prediction?.top_countries?.length > 0
      ? prediction.top_countries
      : prediction
        ? [prediction.country]
        : [];
  if (!entries.length) {
    list.innerHTML = "<li class=\"placeholder\">Keine Daten</li>";
    return;
  }

  entries.slice(0, 3).forEach((entry, index) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span>${index === 0 ? `<strong>${entry?.name ?? entry?.id}</strong>` : entry?.name ?? entry?.id ?? "?"}</span>
      <span>${entry?.confidence !== undefined ? entry.confidence.toFixed(3) : "—"}</span>
    `;
    list.appendChild(li);
  });
}

function drawGridMap(prediction) {
  const canvas = document.getElementById("geoviz-map");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#032013";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  for (let lon = -180; lon <= 180; lon += 60) {
    const x = ((lon + 180) / 360) * canvas.width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let lat = -90; lat <= 90; lat += 30) {
    const y = ((90 - lat) / 180) * canvas.height;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  if (!prediction) return;

  const polygon =
    prediction.grid_polygon && prediction.grid_polygon.length >= 3
      ? prediction.grid_polygon
      : buildFallbackPolygon(prediction.lat, prediction.lon);

  const projected = polygon.map(([lat, lon]) => ({
    x: ((lon + 180) / 360) * canvas.width,
    y: ((90 - lat) / 180) * canvas.height,
  }));

  ctx.beginPath();
  projected.forEach((point, idx) => {
    if (idx === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.closePath();
  ctx.fillStyle = "rgba(255, 76, 76, 0.25)";
  ctx.strokeStyle = "#ff4d4f";
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();

  const markerX = ((prediction.lon + 180) / 360) * canvas.width;
  const markerY = ((90 - prediction.lat) / 180) * canvas.height;
  ctx.fillStyle = "#3b82f6";
  ctx.beginPath();
  ctx.arc(markerX, markerY, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "white";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function buildFallbackPolygon(lat, lon) {
  const delta = 2;
  return [
    [lat - delta, lon - delta],
    [lat - delta, lon + delta],
    [lat + delta, lon + delta],
    [lat + delta, lon - delta],
  ];
}

function captureRoundMetadataFromPanel(panel, roundIndex) {
  if (!panel || typeof roundIndex !== "number") return;
  const markerEntries = parseResultMarkers(panel);
  if (!markerEntries.length) return;
  const serverMeta = extractRoundMetadata(roundIndex);
  const reference = serverMeta ?? latestStreetViewMetadata;
  const { actual, guess } = classifyResultMarkers(markerEntries, reference);
  if (!actual) return;
  const key = `round-${roundIndex + 1}`;
  roundMetadata.set(key, {
    lat: actual.lat,
    lon: actual.lon,
    country: serverMeta?.country ?? latestStreetViewMetadata?.country ?? null,
    actual_relative: actual.relative ?? null,
    guess_lat: guess?.lat ?? null,
    guess_lon: guess?.lon ?? null,
    guess_relative: guess?.relative ?? null,
  });
  if (panel instanceof HTMLElement) {
    panel.dataset.geovizResultCaptured = "true";
  }
}

function parseResultMarkers(panel) {
  const markerElements = panel.querySelectorAll("[data-geoviz-lat][data-geoviz-lon]");
  const entries = [];
  markerElements.forEach((element) => {
    if (!belongsToResultMap(element)) return;
    const lat = Number(element.dataset.geovizLat);
    const lon = Number(element.dataset.geovizLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    entries.push({
      element,
      lat,
      lon,
      kind: element.dataset.geovizMarkerKind || inferMarkerKind(element) || null,
      relative: computeRelativeMarkerPosition(element),
    });
  });
  return entries;
}

function classifyResultMarkers(entries, referenceMeta) {
  const result = { actual: null, guess: null };
  if (!entries?.length) return result;
  let actual = entries.find((entry) => entry.kind === "result") ?? null;
  if (
    !actual &&
    referenceMeta &&
    Number.isFinite(referenceMeta.lat) &&
    Number.isFinite(referenceMeta.lon)
  ) {
    let bestMatch = null;
    entries.forEach((entry) => {
      const dist = distanceKm(entry.lat, entry.lon, referenceMeta.lat, referenceMeta.lon);
      if (!bestMatch || dist < bestMatch.dist) {
        bestMatch = { entry, dist };
      }
    });
    actual = bestMatch?.entry ?? null;
  }
  if (!actual) {
    actual = entries[0];
  }
  let guess = entries.find((entry) => entry !== actual && entry.kind === "guess") ?? null;
  if (!guess && entries.length > 1) {
    guess = entries.find((entry) => entry !== actual) ?? null;
  }
  result.actual = actual ?? null;
  result.guess = guess ?? null;
  return result;
}

function readGuessMarkerFromMap() {
  const elements = Array.from(document.querySelectorAll("[data-geoviz-lat][data-geoviz-lon]")).filter((el) =>
    belongsToGuessMap(el)
  );
  if (!elements.length) return null;
  const latest = elements[elements.length - 1];
  const lat = Number(latest.dataset.geovizLat);
  const lon = Number(latest.dataset.geovizLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat,
    lon,
    relative: computeRelativeMarkerPosition(latest),
  };
}

function displayRoundFeedback(logResponse) {
  if (!logResponse) return;
  const result = logResponse.is_correct === true ? "✅ Correct" : "⚠️ Miss";
  const distText =
    logResponse.distance_km !== undefined && logResponse.distance_km !== null
      ? `${logResponse.distance_km.toFixed(1)} km`
      : "n/a";
  updateStatus(`Round stored. ${result} (${distText}) – Score ${logResponse.score}`);
}

function updateRoundInput() {
  const roundInput = document.getElementById("geoviz-round");
  if (roundInput) roundInput.value = String(currentRound);
}

function updateAutoButton() {
  const button = document.getElementById("geoviz-auto");
  if (!button) return;
  button.textContent = autoPlayActive ? "Auto Play: ON" : "Auto Play: OFF";
  button.classList.toggle("active", autoPlayActive);
}

function formatConfidence(value) {
  if (typeof value !== "number") return "—";
  return `${Math.round(value * 100)}%`;
}

function incrementRound() {
  currentRound += 1;
  lastGuessCoordinates = null;
  updateRoundInput();
}

function findStreetViewCanvas() {
  if (canvasCache && document.body.contains(canvasCache)) {
    return canvasCache;
  }
  const selectors = [
    "canvas[data-qa='panorama']",
    "div[class*='panorama'] canvas",
    "canvas[aria-label='Street View']",
    "canvas[aria-label*='Street View']",
    "canvas[class*='scene']",
    "canvas",
  ];
  for (const selector of selectors) {
    const canvas = document.querySelector(selector);
    if (
      canvas instanceof HTMLCanvasElement &&
      canvas.width > 1024 &&
      canvas.height > 512 &&
      canvas.dataset.geoviz !== "overlay" &&
      !canvas.closest("[data-qa='guess-map']") &&
      !canvas.closest(".guess-map")
    ) {
      canvasCache = canvas;
      return canvas;
    }
  }
  return null;
}

function captureImageBase64() {
  const canvas = findStreetViewCanvas();
  if (!canvas) {
    console.error("[GeoViz] Street-View Canvas nicht gefunden – Screenshot übersprungen.");
    throw new Error("Street-View Canvas nicht gefunden.");
  }
  try {
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    if (!dataUrl.startsWith("data:image/jpeg")) {
      console.warn("[GeoViz] Unerwarteter Canvas Data URL Prefix:", dataUrl.slice(0, 24));
    }
    return dataUrl.split(",")[1];
  } catch (error) {
    console.error("[GeoViz] toDataURL fehlgeschlagen:", error);
    throw new Error("Screenshot konnte nicht erstellt werden.");
  }
}

async function saveCurrentScreenshot({ silent = false } = {}) {
  if (!screenshotApiAvailable) {
    return null;
  }
  let imageBase64;
  try {
    imageBase64 = captureImageBase64();
  } catch (error) {
    if (!silent) {
      updateStatus(`${STATUS_ERROR}${error.message}`);
    }
    throw error;
  }
  lastPreviewDataUrl = `data:image/jpeg;base64,${imageBase64}`;
  updatePreview();
  let response;
  try {
    response = await sendMessageAsync({
      type: "SAVE_SCREENSHOT",
      payload: {
        imageBase64,
        sessionId: currentSessionId,
        roundId: `round-${currentRound}`,
        metadata: buildMetadataPayload(),
      },
    });
  } catch (error) {
    if (!silent) {
      updateStatus(`${STATUS_ERROR}${error.message}`);
    }
    throw error;
  }
  if (!response?.success) {
    const message = response?.error || "Screenshot speichern fehlgeschlagen.";
    const normalizedMessage = typeof message === "string" ? message.toLowerCase() : "";
    if (response?.status === 404 || normalizedMessage.includes("not found")) {
      screenshotApiAvailable = false;
      console.warn("[GeoViz] Screenshot endpoint unavailable, skipping future saves.");
      if (!silent) {
        updateStatus("Screenshot-API nicht verfuegbar.");
      }
      return null;
    }
    throw new Error(message);
  }
  return response.data;
}

function sendMessageAsync(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function getConfig() {
  const response = await sendMessageAsync({ type: "GET_CONFIG" });
  if (!response?.success) throw new Error(response?.error || "Konnte Config nicht laden.");
  extensionConfig = response.config;
  if (!currentSessionId) {
    currentSessionId = `${extensionConfig.sessionPrefix || "chrome-session"}-${Date.now()}`;
    const sessionInput = document.getElementById("geoviz-session");
    if (sessionInput) sessionInput.value = currentSessionId;
  }
  if (extensionConfig.autoPlayEnabled) {
    startAutoPlay();
  }
}

async function requestPrediction({ silent = false } = {}) {
  await ensureSessionDefaults();
  if (!silent) updateStatus("Extrahiere Bild...");
  let imageBase64;
  try {
    imageBase64 = captureImageBase64();
  } catch (error) {
    console.error("[GeoViz] captureImageBase64 fehlgeschlagen:", error);
    throw error;
  }
  lastPreviewDataUrl = `data:image/jpeg;base64,${imageBase64}`;
  updatePreview();
  if (!silent) updateStatus("Sende an Modell...");

  const response = await sendMessageAsync({
    type: "RUN_INFERENCE",
    payload: {
      imageBase64,
      sessionId: currentSessionId,
      roundId: `round-${currentRound}`,
      metadata: buildMetadataPayload(),
    },
  });

  if (!response?.success) {
    throw new Error(response?.error || "Inference fehlgeschlagen.");
  }
  lastInferencePayload = response.data;
  if (!response?.data?.screenshot_path) {
    console.warn("[GeoViz] Inference-Resultat ohne screenshot_path erhalten.", response?.data);
  } else {
    console.debug("[GeoViz] Screenshot gespeichert unter:", response.data.screenshot_path);
  }
  return response.data;
}

function findReactGuessHandler() {
  const containers = [
    ...document.querySelectorAll("[class*='guess-map_canvasContainer'], .guess-map_canvasContainer__s7oJp"),
  ];
  containers.push(document.querySelector("[data-qa='guess-map'] canvas")?.parentElement);
  for (const container of containers) {
    if (!container) continue;
    const fiberKey = Object.keys(container).find((key) => key.startsWith("__reactFiber$"));
    if (!fiberKey) continue;
    const fiberNode = container[fiberKey];
    const handler = fiberNode?.return?.memoizedProps?.onMarkerLocationChanged;
    if (typeof handler === "function") {
      return handler;
    }
  }
  return null;
}

async function triggerInference() {
  try {
    const data = await requestPrediction();
    currentPrediction = data;
    updateResult(data);
    updateStatus("Prediction erfolgreich. Optional Score loggen.");
  } catch (error) {
    updateStatus(`${STATUS_ERROR}${error.message}`);
  }
}

async function ensureSessionDefaults() {
  if (currentSessionId) return;
  if (!extensionConfig.sessionPrefix) {
    extensionConfig.sessionPrefix = "chrome-session";
  }
  currentSessionId = `${extensionConfig.sessionPrefix}-${Date.now()}`;
  const sessionInput = document.getElementById("geoviz-session");
  if (sessionInput) sessionInput.value = currentSessionId;
}

async function ensureGuessMapOpen(signal) {
  const toggleButton = await waitForElement(SELECTORS.mapToggle, { timeout: 2000, signal }).catch(
    () => null
  );
  if (toggleButton) {
    toggleButton.click();
    await sleep(100, signal);
  }
}

async function ensureSearchInputVisible(signal) {
  const existing = document.querySelector(SELECTORS.searchInput.join(", "));
  if (existing) return existing;
  const toggle = await waitForElement(SELECTORS.searchToggle, { timeout: 1500, signal }).catch(
    () => null
  );
  if (toggle) {
    toggle.click();
    await sleep(300, signal);
  }
  return waitForElement(SELECTORS.searchInput, { timeout: 4000, signal });
}

function setNativeValue(element, value) {
  const valueSetter = Object.getOwnPropertyDescriptor(element, "value")?.set;
  const prototype = Object.getPrototypeOf(element);
  const prototypeSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (prototypeSetter) {
    prototypeSetter.call(element, value);
  } else if (valueSetter) {
    valueSetter.call(element, value);
  } else {
    element.value = value;
  }
}

async function placeGuessOnMap(lat, lon, signal) {
  await ensureGuessMapOpen(signal);
  await sleep(50, signal).catch(() => {});
  const reactHandler = findReactGuessHandler();
  if (reactHandler) {
    try {
      reactHandler({ lat, lng: lon });
      await sleep(50, signal).catch(() => {});
      const marker = readGuessMarkerFromMap();
      if (marker) {
        lastGuessCoordinates = marker;
        return;
      }
    } catch (error) {
      console.debug("[GeoViz] React placement failed, fallback to DOM interaction.", error);
    }
  }

  let placementSucceeded = false;
  let searchInput = null;
  try {
    searchInput = await ensureSearchInputVisible(signal);
  } catch {
    searchInput = null;
  }
  if (searchInput) {
    placementSucceeded = await placeMarkerViaSearch(lat, lon, signal, searchInput);
  }
  if (!placementSucceeded) {
    await placeMarkerViaClick(lat, lon, signal);
  }
  await sleep(50, signal).catch(() => {});
  let currentMarker = readGuessMarkerFromMap();
  lastGuessCoordinates = currentMarker ?? { lat, lon };
}

async function placeMarkerAtMapCenter(signal) {
  await ensureGuessMapOpen(signal);
  await sleep(30, signal).catch(() => {});
  const surface = await getGuessMapSurface(signal);
  const rect = surface.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  simulateCanvasClick(surface, clientX, clientY);
  await sleep(50, signal).catch(() => {});
  const marker = readGuessMarkerFromMap();
  lastGuessCoordinates = marker ?? null;
}

async function submitGuess(signal) {
  const button = await waitForGuessButtonEnabled(signal);
  button.click();
  await sleep(100, signal);
}

async function waitForRoundResult(signal, roundIndex = currentRound - 1) {
  const panel = await waitForElement(SELECTORS.resultPanels, { timeout: 12000, signal }).catch(() => null);
  if (panel && typeof roundIndex === "number") {
    captureRoundMetadataFromPanel(panel, roundIndex);
  }
}

async function handleResultTransition(isFinalRound, signal) {
  await clickViewResultsButton(signal);
  await sleep(150, signal);
  if (!isFinalRound) {
    const advanced = await goToNextRound(signal);
    if (advanced) {
      currentRound += 1;
      updateRoundInput();
      await sleep(100, signal);
      return;
    }
  }
  await startNextGame(signal);
}

async function placeMarkerViaSearch(lat, lon, signal, inputOverride) {
  try {
    const searchInput = inputOverride ?? (await ensureSearchInputVisible(signal));
    const coords = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    setNativeValue(searchInput, coords);
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    searchInput.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    const markerBefore = readGuessMarkerFromMap();
    await sleep(150, signal);
    const markerAfter = readGuessMarkerFromMap();
    if (
      markerAfter &&
      (!markerBefore ||
        distanceKm(markerBefore.lat, markerBefore.lon, markerAfter.lat, markerAfter.lon) > 1)
    ) {
      return true;
    }
    return true;
  } catch (error) {
    console.warn("Search placement failed", error);
    return false;
  }
}

async function placeMarkerViaClick(lat, lon, signal) {
  const surface = await getGuessMapSurface(signal);
  const rect = surface.getBoundingClientRect();
  const { x, y } = projectLatLonToCanvas(lat, lon, rect);
  simulateCanvasClick(surface, x, y);
  await sleep(100, signal);
}

async function getGuessMapSurface(signal) {
  const allSelectors = [
    ...SELECTORS.mapCanvas,
    '[data-qa="guess-map"] div[style*="z-index: 104"]',
    '[data-qa="guess-map"] div[style*="z-index: 105"]',
    '[data-qa="guess-map"] div[style*="z-index: 106"]',
    "[data-qa='guess-map'] slot",
  ];
  for (const selector of allSelectors) {
    const element = document.querySelector(selector);
    if (element) return element;
  }
  return waitForElement(SELECTORS.mapCanvas, { timeout: 6000, signal });
}

function projectLatLonToCanvas(lat, lon, rect) {
  const width = rect.width;
  const height = rect.height;
  const x = ((lon + 180) / 360) * width;
  const clampedLat = Math.max(Math.min(lat, 85.05112878), -85.05112878);
  const latRad = (clampedLat * Math.PI) / 180;
  const mercY = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  const y = height / 2 - (height * mercY) / (2 * Math.PI);
  return {
    x: rect.left + Math.min(Math.max(x, 0), width),
    y: rect.top + Math.min(Math.max(y, 0), height),
  };
}

function simulateCanvasClick(target, clientX, clientY) {
  const down = new PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: "mouse",
    clientX,
    clientY,
    buttons: 1,
  });
  const up = new PointerEvent("pointerup", {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: "mouse",
    clientX,
    clientY,
    buttons: 0,
  });
  const click = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  });
  target.dispatchEvent(down);
  target.dispatchEvent(up);
  target.dispatchEvent(click);
}

function getTargetCoordinates(prediction) {
  if (prediction?.lat != null && prediction?.lon != null) {
    return { lat: prediction.lat, lon: prediction.lon };
  }
  if (latestStreetViewMetadata?.lat != null && latestStreetViewMetadata?.lon != null) {
    return { lat: latestStreetViewMetadata.lat, lon: latestStreetViewMetadata.lon };
  }
  return { lat: 0, lon: 0 };
}

async function clickViewResultsButton(signal) {
  const btn = await waitForElement(SELECTORS.viewResultsButtons, { timeout: 6000, signal }).catch(
    () => null
  );
  if (btn) {
    btn.click();
    return;
  }
  const fallback = queryButtonByText(["view results"]);
  if (fallback) fallback.click();
}

function findPlayAgainButton() {
  for (const selector of SELECTORS.playAgainButtons) {
    const element = document.querySelector(selector);
    if (element) return element;
  }
  return queryButtonByText(BUTTON_TEXT.playAgain);
}

async function waitForPlayAgainButton(signal, timeout = 15000) {
  return waitForCondition(() => findPlayAgainButton(), { timeout, signal }).catch(() => null);
}

async function waitForGuessButtonEnabled(signal) {
  const selectorList = [...SELECTORS.guessButtons, "[data-qa='perform-guess']"];
  const button = await waitForElement(selectorList, { timeout: 6000, signal }).catch(() => null);
  const fallback = button ?? queryButtonByText(BUTTON_TEXT.guess);
  if (!fallback) {
    throw new Error("Guess-Button nicht gefunden.");
  }
  if (!fallback.disabled) return fallback;
  await waitForCondition(() => !fallback.disabled, { timeout: 6000, signal }).catch(() => {});
  return fallback;
}

function parseNextData() {
  const container = document.getElementById("__NEXT_DATA__");
  if (!container?.textContent) return null;
  try {
    return JSON.parse(container.textContent);
  } catch (error) {
    console.warn("Failed to parse __NEXT_DATA__", error);
    return null;
  }
}

function extractRoundMetadata(roundIndex) {
  const data = parseNextData();
  if (!data) return null;
  const rounds = data?.props?.pageProps?.game?.rounds;
  if (!Array.isArray(rounds)) return null;
  const round = rounds[roundIndex];
  if (!round) return null;
  return {
    lat: round.lat ?? round.latitude ?? null,
    lon: round.lng ?? round.lon ?? round.longitude ?? null,
    country: round.countryCode ?? round.country?.code ?? null,
    continent: round.continentCode ?? round.country?.continentCode ?? null,
    score: round.roundScore ?? round.score ?? 0,
  };
}

function normalizePredictionForLog(prediction) {
  return {
    inference_id: prediction.inference_id,
    lat: prediction.lat,
    lon: prediction.lon,
    continent: {
      id: prediction.continent?.id ?? null,
      confidence: prediction.continent?.confidence ?? null,
    },
    country: {
      id: prediction.country?.id ?? null,
      confidence: prediction.country?.confidence ?? null,
    },
    grid_l4: {
      id: prediction.grid_l4?.id ?? null,
      confidence: prediction.grid_l4?.confidence ?? null,
    },
    grid_l6: {
      id: prediction.grid_l6?.id ?? null,
      confidence: prediction.grid_l6?.confidence ?? null,
    },
    confidence_lat: prediction.confidence_lat ?? null,
    confidence_lon: prediction.confidence_lon ?? null,
    model_version: prediction.model_version,
    inference_time_ms: prediction.inference_time_ms,
    extra_json: JSON.stringify({
      screenshot_path: prediction.screenshot_path,
    }),
  };
}

async function logRoundResult(roundIndex, prediction) {
  const meta = extractRoundMetadata(roundIndex);
  const metaKey = `round-${roundIndex + 1}`;
  const storedMetadata = roundMetadata.get(metaKey);
  if (!meta && !storedMetadata && !latestStreetViewMetadata) {
    console.warn("Keine Metadaten fǬr Runde gefunden.");
  }
  if (!prediction) {
    console.warn("Keine Prediction für Round-Log vorhanden.");
    return;
  }
  const payload = {
    session_id: currentSessionId,
    round_id: `round-${roundIndex + 1}`,
    round_index: roundIndex + 1,
    ground_truth: {
      lat: meta?.lat ?? storedMetadata?.lat ?? latestStreetViewMetadata?.lat ?? 0,
      lon: meta?.lon ?? storedMetadata?.lon ?? latestStreetViewMetadata?.lon ?? 0,
      country: meta?.country ?? storedMetadata?.country ?? latestStreetViewMetadata?.country ?? "ZZ",
      continent: meta?.continent ?? storedMetadata?.continent ?? latestStreetViewMetadata?.continent ?? null,
    },
    prediction: normalizePredictionForLog(prediction),
    score: meta?.score ?? storedMetadata?.score ?? 0,
    screenshot_path: prediction.screenshot_path ?? lastInferencePayload?.screenshot_path ?? null,
  };
  try {
    const response = await sendMessageAsync({ type: "LOG_ROUND", payload });
    if (response?.success && response.data) {
      displayRoundFeedback(response.data);
    } else if (response?.error) {
      updateStatus(`${STATUS_ERROR}${response.error}`);
    }
  } catch (error) {
    console.warn("Round logging failed", error);
  }
  roundMetadata.delete(metaKey);
}

async function goToNextRound(signal) {
  const explicitButton = queryButtonByText(BUTTON_TEXT.next);
  if (explicitButton) {
    explicitButton.click();
    await sleep(150, signal);
    return true;
  }
  const fallbackSelectors = [
    "button[data-qa='next-round']",
    "button[class*='next']",
  ];
  for (const selector of fallbackSelectors) {
    const btn = document.querySelector(selector);
    if (btn) {
      btn.click();
      await sleep(150, signal);
      return true;
    }
  }
  return false;
}

async function startNextGame(signal) {
  let nextRoundReady = false;
  for (let attempt = 0; attempt < 3 && !nextRoundReady && !signal?.aborted; attempt += 1) {
    const playAgainButton = await waitForPlayAgainButton(signal, 8000);
    if (!playAgainButton) {
      await sleep(200, signal).catch(() => {});
      continue;
    }
    playAgainButton.click();
    await sleep(300, signal).catch(() => {});
    nextRoundReady = await waitForStreetViewReady(signal, 8000)
      .then(() => true)
      .catch(() => false);
  }
  if (!nextRoundReady) {
    console.warn("[GeoViz] Play Again button interaction failed - Street View not detected.");
  }
  currentRound = 1;
  updateRoundInput();
  lastGuessCoordinates = null;
  currentSessionId = `${extensionConfig.sessionPrefix || "chrome-session"}-${Date.now()}`;
  const sessionInput = document.getElementById("geoviz-session");
  if (sessionInput) sessionInput.value = currentSessionId;
}

async function waitForStreetViewReady(signal, timeout = 15000) {
  await waitForCondition(() => findStreetViewCanvas(), { timeout, signal });
}

let scrapeActive = false;
let scrapeAbortController = null;

async function scrapeRound() {
  if (autoPlayActive) {
    updateStatus("Stop Auto Play, bevor du Scrape nutzt.");
    return;
  }
  if (scrapeActive) {
    stopScrape();
    return;
  }
  scrapeActive = true;
  scrapeAbortController = new AbortController();
  const { signal } = scrapeAbortController;
  updateStatus("Scrape gestartet - laeuft endlos.");
  const buttons = document.querySelectorAll("#geoviz-scrape");
  buttons.forEach((btn) => (btn.textContent = "Stop Scrape"));
  (async () => {
    while (scrapeActive && !signal.aborted) {
      try {
        lastInferencePayload = null;
        currentPrediction = null;
        updateResult(null);

        // IMPORTANT: Reset metadata for fresh capture
        latestStreetViewMetadata = null;
        lastProcessedPhotoId = null;

        // Wait for Street View to be ready
        await waitForStreetViewReady(signal, 6000);

        // Wait for GeoPhotoService to capture NEW coordinates
        await sleep(800, signal);

        // Check if we got new coordinates
        if (!latestStreetViewMetadata || latestStreetViewMetadata.lat == null) {
          console.warn("[GeoViz] No new coordinates captured, waiting longer...");
          await sleep(500, signal);
        }

        const roundId = `round-${currentRound}`;

        // Send coordinates to backend FIRST so they're cached
        if (latestStreetViewMetadata?.lat != null && latestStreetViewMetadata?.lon != null) {
          try {
            console.log("[GeoViz] Sending coords to backend:", {
              lat: latestStreetViewMetadata.lat,
              lon: latestStreetViewMetadata.lon,
              country: latestStreetViewMetadata.country,
              session_id: currentSessionId,
              round_id: roundId,
            });
            await sendMessageAsync({
              type: "SEND_COORDS",
              payload: {
                lat: latestStreetViewMetadata.lat,
                lon: latestStreetViewMetadata.lon,
                source: "scrape",
                captured_at: new Date().toISOString(),
                session_id: currentSessionId,
                round_id: roundId,
                round_index: currentRound,
                metadata: {
                  country: latestStreetViewMetadata.country,
                  address: latestStreetViewMetadata.address,
                  photoId: latestStreetViewMetadata.photoId,
                },
              },
            });
            // Small delay to ensure backend has cached the coords
            await sleep(50, signal);
          } catch (coordError) {
            console.warn("[GeoViz] Failed to send coords:", coordError);
          }
        } else {
          console.warn("[GeoViz] No coordinates available from GeoPhotoService");
        }

        // Save screenshot - backend will use cached coords
        await saveCurrentScreenshot({ silent: true });

        // Quick marker placement at map center
        await placeMarkerAtMapCenter(signal);

        // Submit guess quickly
        await submitGuess(signal);

        // Wait for result
        await waitForRoundResult(signal, currentRound - 1);

        // Transition to next round/game
        try {
          await handleResultTransition(currentRound >= ROUND_LIMIT, signal);
        } catch (error) {
          console.warn("[GeoViz] Scrape transition failed", error);
        }

        updateStatus(`Scrape: Runde ${currentRound} abgeschlossen.`);
      } catch (error) {
        if (signal.aborted) break;
        console.warn("[GeoViz] Scrape failed", error);
        const message = error?.message || "";
        if (message.includes("Extension context invalidated")) {
          stopScrape();
          return;
        }
        updateStatus(`${STATUS_ERROR}${message}`);
        await sleep(200, signal).catch(() => {});
      }
    }
    stopScrape(false);
  })();
}

function stopScrape(updateStatusText = true) {
  if (!scrapeActive) return;
  scrapeActive = false;
  scrapeAbortController?.abort();
  scrapeAbortController = null;
  const buttons = document.querySelectorAll("#geoviz-scrape");
  buttons.forEach((btn) => (btn.textContent = "Scrape"));
  if (updateStatusText) {
    updateStatus("Scrape gestoppt.");
  }
}

async function playAutomaticMatch(signal) {
  currentRound = 1;
  updateRoundInput();

  for (let roundIndex = 0; roundIndex < ROUND_LIMIT; roundIndex += 1) {
    if (!autoPlayActive || signal.aborted) return;

    lastGuessCoordinates = null;
    updateStatus(`Auto Play: Runde ${roundIndex + 1} von ${ROUND_LIMIT}…`);
    await waitForStreetViewReady(signal);

    // Short wait for GeoPhotoService to capture coordinates
    await sleep(100, signal);

    // Send coordinates to backend if available
    if (latestStreetViewMetadata?.lat != null && latestStreetViewMetadata?.lon != null) {
      try {
        await sendMessageAsync({
          type: "SEND_COORDS",
          payload: {
            lat: latestStreetViewMetadata.lat,
            lon: latestStreetViewMetadata.lon,
            source: "auto_play",
            captured_at: new Date().toISOString(),
            session_id: currentSessionId,
            round_id: `round-${roundIndex + 1}`,
            round_index: roundIndex + 1,
            metadata: {
              country: latestStreetViewMetadata.country,
              address: latestStreetViewMetadata.address,
              photoId: latestStreetViewMetadata.photoId,
            },
          },
        });
      } catch (coordError) {
        console.warn("[GeoViz] Failed to send coords:", coordError);
      }
    }

    try {
      const prediction = await requestPrediction({ silent: true });
      currentPrediction = prediction;
      updateResult(prediction);
      const target = getTargetCoordinates(prediction);
      await placeGuessOnMap(target.lat, target.lon, signal);
      await submitGuess(signal);
      await waitForRoundResult(signal, roundIndex);
      if (lastInferencePayload) {
        await logRoundResult(roundIndex, lastInferencePayload);
      }
      await sleep(100, signal);
    } catch (error) {
      console.warn("[GeoViz] Auto play round failed:", error);
      updateStatus(`${STATUS_ERROR}${error.message}`);
    }

    try {
      await handleResultTransition(roundIndex >= ROUND_LIMIT - 1, signal);
    } catch (error) {
      console.warn("[GeoViz] handleResultTransition failed:", error);
      await sleep(200, signal);
    }
  }
}

async function autoPlayLoop(signal) {
  while (autoPlayActive && !signal.aborted) {
    try {
      await playAutomaticMatch(signal);
    } catch (error) {
      if (signal.aborted) return;
      updateStatus(`${STATUS_ERROR}${error.message}`);
      stopAutoPlay(false);
      return;
    }
  }
}

function startAutoPlay() {
  if (autoPlayActive) return;
  autoPlayActive = true;
  updateAutoButton();
  updateStatus("Auto Play aktiviert – Spiel startet automatisch.");
  autoPlayAbortController = new AbortController();
  autoPlayLoop(autoPlayAbortController.signal);
  sendMessageAsync({
    type: "SAVE_CONFIG",
    payload: { autoPlayEnabled: true },
  }).catch(() => {});
}

function stopAutoPlay(persist = true) {
  if (!autoPlayActive) return;
  autoPlayActive = false;
  updateAutoButton();
  updateStatus("Auto Play gestoppt.");
  autoPlayAbortController?.abort();
  autoPlayAbortController = null;
  if (persist) {
    sendMessageAsync({
      type: "SAVE_CONFIG",
      payload: { autoPlayEnabled: false },
    }).catch(() => {});
  }
}

function toggleAutoPlay() {
  if (autoPlayActive) {
    stopAutoPlay();
  } else {
    startAutoPlay();
  }
}

function monitorCanvasChanges() {
  const observer = new MutationObserver(() => {
    const canvas = findStreetViewCanvas();
    if (canvas && canvas !== canvasCache) {
      canvasCache = canvas;
      if (!autoPlayActive) {
        updateStatus("Neues Bild erkannt. Predict erneut auslösen.");
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function monitorResultPanels() {
  const selector = SELECTORS.resultPanels.join(", ");
  const observer = new MutationObserver(() => {
    document.querySelectorAll(selector).forEach((panel) => {
      if (!(panel instanceof HTMLElement)) return;
      if (panel.dataset.geovizResultCaptured === "true") return;
      captureRoundMetadataFromPanel(panel, currentRound - 1);
      panel.dataset.geovizResultCaptured = "true";
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// Continuous monitor for "View Results" and "Play Again" buttons to enable endless loop
let newGameMonitorInterval = null;

function startNewGameMonitor() {
  if (newGameMonitorInterval) return;

  newGameMonitorInterval = setInterval(() => {
    // Only act if auto-play or scrape is active
    if (!autoPlayActive && !scrapeActive) return;

    // First check for "View Results" / "Close" button and click it
    const viewResultsSelectors = [
      ...SELECTORS.viewResultsButtons,
      "button[data-qa='close-round-result']",
      "[data-qa='close-round-result']",
      "button[class*='close']",
      "[aria-label*='close' i]",
      "[aria-label*='View' i]",
    ];
    for (const selector of viewResultsSelectors) {
      const viewResultsBtn = document.querySelector(selector);
      if (viewResultsBtn && viewResultsBtn.offsetParent !== null) {
        console.log("[GeoViz] View Results button detected:", selector);
        viewResultsBtn.click();
        return;
      }
    }
    // Also check by text
    const viewResultsText = queryButtonByText(["view results", "close", "continue"]);
    if (viewResultsText && viewResultsText.offsetParent !== null) {
      console.log("[GeoViz] View Results button (by text) detected");
      viewResultsText.click();
      return;
    }

    // Then check for "Play Again" button with extended selectors
    const playAgainSelectors = [
      ...SELECTORS.playAgainButtons,
      "button[data-qa='play-again-button']",
      "a[data-qa='play-again']",
      "a[href*='play-again']",
      "[data-qa*='again']",
      "[data-qa*='next']",
      "button[class*='again']",
      "button[class*='playAgain']",
    ];

    for (const selector of playAgainSelectors) {
      const btn = document.querySelector(selector);
      if (btn && btn.offsetParent !== null) {
        console.log("[GeoViz] Play Again button detected:", selector);
        btn.click();
        // Reset for new game
        currentRound = 1;
        updateRoundInput();
        lastGuessCoordinates = null;
        latestStreetViewMetadata = null;
        currentSessionId = `${extensionConfig.sessionPrefix || "chrome-session"}-${Date.now()}`;
        const sessionInput = document.getElementById("geoviz-session");
        if (sessionInput) sessionInput.value = currentSessionId;
        return;
      }
    }

    // Also check by text for play again
    const playAgainText = queryButtonByText(["play again", "play next", "new game", "another game"]);
    if (playAgainText && playAgainText.offsetParent !== null) {
      console.log("[GeoViz] Play Again button (by text) detected");
      playAgainText.click();
      // Reset for new game
      currentRound = 1;
      updateRoundInput();
      lastGuessCoordinates = null;
      latestStreetViewMetadata = null;
      currentSessionId = `${extensionConfig.sessionPrefix || "chrome-session"}-${Date.now()}`;
      const sessionInput = document.getElementById("geoviz-session");
      if (sessionInput) sessionInput.value = currentSessionId;
    }
  }, 200);
}

function stopNewGameMonitor() {
  if (newGameMonitorInterval) {
    clearInterval(newGameMonitorInterval);
    newGameMonitorInterval = null;
  }
}

async function init() {
  createOverlay();
  updateResult(null);
  ensureMapboxInstrumentation();
  monitorCanvasChanges();
  monitorResultPanels();
  interceptGeoPhotoService();
  startNewGameMonitor();
  await getConfig();
}

if (window.top === window) {
  init().catch((error) => {
    console.error("GeoGuessr helper init failed", error);
    updateStatus(`${STATUS_ERROR}${error.message}`);
  });
}
function interceptGeoPhotoService() {
  if (window.__geovizFetchHooked) return;
  window.__geovizFetchHooked = true;

  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
    if (url && url.includes("GeoPhotoService") && response.clone) {
      const clone = response.clone();
      clone
        .text()
        .then((body) => {
          parseGeoPhotoResponse(body);
        })
        .catch(() => {});
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
    this.__geovizUrl = typeof url === "string" ? url : url?.toString();
    return originalOpen.apply(this, [method, url, ...rest]);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function send(body) {
    this.addEventListener(
      "load",
      () => {
        const url = this.__geovizUrl;
        if (!url || !String(url).includes("GeoPhotoService")) return;
        try {
          parseGeoPhotoResponse(this.responseText);
        } catch {
          /* ignore */
        }
      },
      { once: true }
    );
    return originalSend.call(this, body);
  };
}

function parseGeoPhotoResponse(body) {
  const callbackPrefix = "/**/_callbacks____";
  if (!body || !body.startsWith(callbackPrefix)) return;
  const start = body.indexOf("(");
  const end = body.lastIndexOf(")");
  if (start === -1 || end === -1) return;
  const payload = body.slice(start + 1, end);
  let data;
  try {
    data = JSON.parse(payload);
  } catch (error) {
    return;
  }
  const meta = extractMetadataFromArray(data);
  if (meta) {
    latestStreetViewMetadata = meta;
  }
}

function extractMetadataFromArray(data) {
  try {
    // Try multiple extraction strategies
    let lat = null;
    let lon = null;
    let address = null;
    let photoId = null;

    // Strategy 1: Standard GeoPhotoService structure
    const root = data?.[1]?.[0];
    if (root) {
      const locationSets = root?.[5]?.[0]?.[1];
      const primaryLocation = locationSets?.[0];
      if (primaryLocation) {
        lat = primaryLocation?.[2];
        lon = primaryLocation?.[3];
      }
      const addressBlock = root?.[3]?.[2];
      if (Array.isArray(addressBlock)) {
        address = addressBlock.map((entry) => entry?.[0]).filter(Boolean).join(", ");
      }
      photoId = root?.[1]?.[1];
    }

    // Strategy 2: Deep search for coordinates if not found
    if (typeof lat !== "number" || typeof lon !== "number") {
      const coords = findCoordinatesDeep(data);
      if (coords) {
        lat = coords.lat;
        lon = coords.lon;
      }
    }

    // Strategy 3: Look for address in alternate locations
    if (!address) {
      address = findAddressDeep(data);
    }

    if (typeof lat !== "number" || typeof lon !== "number") {
      console.warn("[GeoViz] Could not extract coordinates from GeoPhotoService response");
      return null;
    }

    const countryFromAddress = inferCountryFromAddress(address) ?? null;
    console.log("[GeoViz] Extracted metadata:", { lat, lon, country: countryFromAddress, address });

    return {
      lat,
      lon,
      country: countryFromAddress,
      address: address || null,
      country_code: countryFromAddress,
      photoId,
    };
  } catch (error) {
    console.error("[GeoViz] extractMetadataFromArray error:", error);
    return null;
  }
}

// Deep search for coordinates in nested structure
function findCoordinatesDeep(node) {
  let lat = null;
  let lon = null;

  function scan(value) {
    if (lat !== null && lon !== null) return;
    if (Array.isArray(value)) {
      // Look for arrays with coordinates pattern [something, something, lat, lon, ...]
      if (value.length >= 4 && typeof value[2] === "number" && typeof value[3] === "number") {
        const possibleLat = value[2];
        const possibleLon = value[3];
        // Validate as coordinates
        if (possibleLat >= -90 && possibleLat <= 90 && possibleLon >= -180 && possibleLon <= 180) {
          lat = possibleLat;
          lon = possibleLon;
          return;
        }
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

// Deep search for address strings
function findAddressDeep(node) {
  let bestAddress = null;

  function scan(value) {
    if (Array.isArray(value)) {
      // Look for string arrays that might be addresses
      if (value.length >= 2 && typeof value[0] === "string" && typeof value[1] === "string") {
        const text = value[0].trim();
        const lang = value[1].toLowerCase();
        // Address-like strings contain commas and are reasonable length
        if (text.includes(",") && text.length >= 5 && text.length <= 200) {
          if (!bestAddress || text.length > bestAddress.length) {
            bestAddress = text;
          }
        }
      }
      for (const entry of value) scan(entry);
    } else if (typeof value === "object" && value !== null) {
      for (const key of Object.keys(value)) scan(value[key]);
    }
  }

  scan(node);
  return bestAddress;
}

function inferCountryFromAddress(address) {
  if (!address) return null;
  const parts = address.split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;

  // Country is typically the last part of the address
  const lastPart = parts[parts.length - 1];

  // Common country name mappings to ISO codes
  const countryMappings = {
    'united states': 'US', 'usa': 'US', 'u.s.a.': 'US', 'u.s.': 'US', 'america': 'US',
    'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB', 'england': 'GB', 'scotland': 'GB', 'wales': 'GB',
    'germany': 'DE', 'deutschland': 'DE',
    'france': 'FR', 'francia': 'FR', 'frankreich': 'FR',
    'spain': 'ES', 'españa': 'ES', 'espana': 'ES', 'spanien': 'ES',
    'italy': 'IT', 'italia': 'IT', 'italien': 'IT',
    'netherlands': 'NL', 'nederland': 'NL', 'holland': 'NL',
    'belgium': 'BE', 'belgique': 'BE', 'belgie': 'BE', 'belgien': 'BE',
    'portugal': 'PT',
    'austria': 'AT', 'österreich': 'AT', 'osterreich': 'AT',
    'switzerland': 'CH', 'schweiz': 'CH', 'suisse': 'CH', 'svizzera': 'CH',
    'poland': 'PL', 'polska': 'PL', 'polen': 'PL',
    'czech republic': 'CZ', 'czechia': 'CZ', 'česko': 'CZ', 'cesko': 'CZ',
    'sweden': 'SE', 'sverige': 'SE', 'schweden': 'SE',
    'norway': 'NO', 'norge': 'NO', 'norwegen': 'NO',
    'denmark': 'DK', 'danmark': 'DK', 'dänemark': 'DK', 'danemark': 'DK',
    'finland': 'FI', 'suomi': 'FI', 'finnland': 'FI',
    'russia': 'RU', 'россия': 'RU', 'russland': 'RU', 'russian federation': 'RU',
    'japan': 'JP', '日本': 'JP', 'nippon': 'JP',
    'south korea': 'KR', 'korea': 'KR', '대한민국': 'KR', 'republic of korea': 'KR',
    'china': 'CN', '中国': 'CN', 'peoples republic of china': 'CN',
    'taiwan': 'TW', '台灣': 'TW', '台湾': 'TW',
    'australia': 'AU', 'australien': 'AU',
    'new zealand': 'NZ', 'neuseeland': 'NZ',
    'canada': 'CA', 'kanada': 'CA',
    'mexico': 'MX', 'méxico': 'MX', 'mexiko': 'MX',
    'brazil': 'BR', 'brasil': 'BR', 'brasilien': 'BR',
    'argentina': 'AR', 'argentinien': 'AR',
    'chile': 'CL',
    'colombia': 'CO', 'kolumbien': 'CO',
    'peru': 'PE',
    'south africa': 'ZA', 'südafrika': 'ZA', 'sudafrika': 'ZA',
    'india': 'IN', 'indien': 'IN', 'भारत': 'IN',
    'thailand': 'TH', 'ประเทศไทย': 'TH',
    'indonesia': 'ID', 'indonesien': 'ID',
    'malaysia': 'MY',
    'singapore': 'SG', 'singapur': 'SG',
    'philippines': 'PH', 'philippinen': 'PH', 'pilipinas': 'PH',
    'vietnam': 'VN', 'việt nam': 'VN',
    'turkey': 'TR', 'türkiye': 'TR', 'turkiye': 'TR', 'türkei': 'TR', 'turkei': 'TR',
    'greece': 'GR', 'ελλάδα': 'GR', 'ellada': 'GR', 'griechenland': 'GR',
    'ireland': 'IE', 'éire': 'IE', 'eire': 'IE', 'irland': 'IE',
    'iceland': 'IS', 'ísland': 'IS', 'island': 'IS',
    'hungary': 'HU', 'magyarország': 'HU', 'magyarorszag': 'HU', 'ungarn': 'HU',
    'romania': 'RO', 'românia': 'RO', 'rumänien': 'RO', 'rumanien': 'RO',
    'bulgaria': 'BG', 'българия': 'BG', 'bulgarien': 'BG',
    'croatia': 'HR', 'hrvatska': 'HR', 'kroatien': 'HR',
    'serbia': 'RS', 'србија': 'RS', 'srbija': 'RS', 'serbien': 'RS',
    'ukraine': 'UA', 'україна': 'UA', 'ukraina': 'UA',
    'israel': 'IL', 'ישראל': 'IL',
    'egypt': 'EG', 'مصر': 'EG', 'ägypten': 'EG', 'agypten': 'EG',
    'morocco': 'MA', 'المغرب': 'MA', 'marokko': 'MA',
    'united arab emirates': 'AE', 'uae': 'AE',
    'saudi arabia': 'SA', 'السعودية': 'SA',
    'mongolia': 'MN', 'монгол': 'MN', 'mongolei': 'MN',
    'estonia': 'EE', 'eesti': 'EE', 'estland': 'EE',
    'latvia': 'LV', 'latvija': 'LV', 'lettland': 'LV',
    'lithuania': 'LT', 'lietuva': 'LT', 'litauen': 'LT',
    'slovakia': 'SK', 'slovensko': 'SK', 'slowakei': 'SK',
    'slovenia': 'SI', 'slovenija': 'SI', 'slowenien': 'SI',
    'luxembourg': 'LU', 'luxemburg': 'LU',
    'malta': 'MT',
    'cyprus': 'CY', 'κύπρος': 'CY', 'kypros': 'CY', 'zypern': 'CY',
  };

  const normalized = lastPart.toLowerCase().trim();

  // Check if it's already a 2-letter code
  if (lastPart.length === 2 && /^[A-Za-z]{2}$/.test(lastPart)) {
    return lastPart.toUpperCase();
  }

  // Look up in mappings
  if (countryMappings[normalized]) {
    return countryMappings[normalized];
  }

  // Return the original last part for backend to resolve
  return lastPart;
}
