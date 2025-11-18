const PIN_IMG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23ffffff'%3E%3Cpath d='M12 2a7 7 0 0 0-7 7c0 4.88 6.32 12.34 6.6 12.65a.55.55 0 0 0 .8 0C12.68 21.34 19 13.88 19 9a7 7 0 0 0-7-7zm0 10a3 3 0 1 1 3-3 3 3 0 0 1-3 3z'/%3E%3C/svg%3E";
const VIEW_IMG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23ffffff'%3E%3Cpath d='M4.5 12s3.5-5.5 7.5-5.5S19.5 12 19.5 12 16 17.5 12 17.5 4.5 12 4.5 12zm7.5-3a3 3 0 1 0 3 3 3 3 0 0 0-3-3z'/%3E%3C/svg%3E";
const SAFE_IMG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23ffffff'%3E%3Cpath d='M12 2 3 5v6.14c0 5.22 3.06 10 9 12.86 5.94-2.86 9-7.64 9-12.86V5zm0 2.09 7 2.33v4.72c0 4.29-2.33 8.14-7 10.7-4.67-2.56-7-6.41-7-10.7V6.42zM11 8v5.59l4.21 2.55 1-1.73-3.21-1.92V8z'/%3E%3C/svg%3E";

let lat = 999;
let long = 999;
let cachedAddress = null;
let cachedAddressKey = null;
let lastSentCoordsSignature = null;
let debuggerBridgeInitialized = false;

function injectGeoPhotoBridge() {
  if (window.__geoGuessrCoordHooked) return;
  window.__geoGuessrCoordHooked = true;

  const script = document.createElement("script");
  script.type = "text/javascript";
  script.src = chrome.runtime.getURL("geo-bridge.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

injectGeoPhotoBridge();
ensureDebuggerBridge();

function convertToMinutes(decimal) {
  return Math.floor(decimal * 60);
}

function convertToSeconds(decimal) {
  return ((decimal * 3600) % 60).toFixed(1);
}

function getLatDirection(value) {
  return value >= 0 ? "N" : "S";
}

function getLongDirection(value) {
  return value >= 0 ? "E" : "W";
}

function isDecimal(value) {
  const asString = String(value);
  return !Number.isNaN(Number(asString)) && asString.includes(".");
}

function getOverlayState() {
  const sessionInput = document.getElementById("geoviz-session");
  const roundInput = document.getElementById("geoviz-round");
  const sessionId = sessionInput?.value?.trim() || null;
  const roundValue = Number(roundInput?.value);
  const roundIndex = Number.isFinite(roundValue) ? Math.max(1, Math.round(roundValue)) : null;
  const roundId = roundIndex ? `round-${roundIndex}` : null;
  return {
    sessionId,
    roundIndex,
    roundId,
  };
}

function notifyCoordsUpdate(latValue, lonValue, context = "geo_photo") {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  if (!Number.isFinite(latValue) || !Number.isFinite(lonValue)) return;
  const signature = `${latValue.toFixed(5)}:${lonValue.toFixed(5)}:${context}`;
  if (signature === lastSentCoordsSignature) return;
  lastSentCoordsSignature = signature;
  const overlayState = getOverlayState();
  const extraMeta = {
    session_id: overlayState.sessionId,
    round_id: overlayState.roundId,
    round_index: overlayState.roundIndex,
  };
  if (window.__geovizDebuggerMetadata?.place) {
    extraMeta.place = window.__geovizDebuggerMetadata.place;
  }
  if (window.__geovizDebuggerMetadata?.language) {
    extraMeta.language = window.__geovizDebuggerMetadata.language;
  }
  chrome.runtime.sendMessage(
    {
      type: "SEND_COORDS",
      payload: {
        lat: latValue,
        lon: lonValue,
        source: context,
        captured_at: new Date().toISOString(),
        session_id: overlayState.sessionId,
        round_id: overlayState.roundId,
        round_index: overlayState.roundIndex,
        metadata: extraMeta,
      },
    },
    () => chrome.runtime?.lastError
  );
  console.debug(`[GeoViz] Koordinaten (${context}) -> lat=${latValue.toFixed(5)}, lon=${lonValue.toFixed(5)}`);
}

function applyDebuggerMetadata(payload) {
  const latValue = Number(payload?.lat);
  const lonValue = Number(payload?.lon);
  if (!Number.isFinite(latValue) || !Number.isFinite(lonValue)) return;
  lat = latValue;
  long = lonValue;
  if (typeof latestStreetViewMetadata !== "undefined") {
    if (!latestStreetViewMetadata) {
      latestStreetViewMetadata = {};
    }
    latestStreetViewMetadata.lat = latValue;
    latestStreetViewMetadata.lon = lonValue;
    if (payload?.place) {
      latestStreetViewMetadata.address = payload.place;
      const inferredCountry = inferCountryFromAddress(payload.place);
      if (inferredCountry) {
        latestStreetViewMetadata.country = inferredCountry;
        latestStreetViewMetadata.country_code = inferredCountry;
      }
    }
  }
  window.__geovizDebuggerMetadata = {
    lat: latValue,
    lon: lonValue,
    place: payload?.place ?? null,
    source: payload?.source ?? "debugger",
  };
  console.debug("[GeoViz] Debugger-Metadaten übernommen:", {
    lat: latValue,
    lon: lonValue,
    place: payload?.place ?? null,
    source: payload?.source ?? "debugger",
  });
  notifyCoordsUpdate(latValue, lonValue, payload?.source ?? "debugger");
}

function ensureDebuggerBridge() {
  if (debuggerBridgeInitialized) return;
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  debuggerBridgeInitialized = true;
  chrome.runtime.sendMessage({ type: "START_GEO_CAPTURE" }, (response) => {
    if (chrome.runtime?.lastError) {
      console.warn("[GeoViz] START_GEO_CAPTURE Fehler:", chrome.runtime.lastError.message);
      return;
    }
    if (!response?.success) {
      console.warn("[GeoViz] START_GEO_CAPTURE fehlgeschlagen:", response?.error);
    } else {
      console.debug("[GeoViz] Debugger-Capture gestartet.");
    }
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "GEO_METADATA" && message?.payload) {
      applyDebuggerMetadata(message.payload);
    }
  });
}

function convertCoords(latValue, longValue) {
  const latAbs = Math.abs(latValue);
  const longAbs = Math.abs(longValue);
  const latDms = `${Math.floor(latAbs)}°${convertToMinutes(latAbs % 1)}'${convertToSeconds(latAbs % 1)}"${getLatDirection(
    latValue
  )}`;
  const longDms = `${Math.floor(longAbs)}°${convertToMinutes(longAbs % 1)}'${convertToSeconds(longAbs % 1)}"${getLongDirection(
    longValue
  )}`;
  return `${latDms} + ${longDms}`;
}

async function getCoordInfo() {
  const cacheKey = `${lat.toFixed(5)}:${long.toFixed(5)}`;
  if (cachedAddress && cachedAddressKey === cacheKey) {
    return cachedAddress;
  }
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${long}&format=json`,
      {
        headers: {
          "User-Agent": "geoviz-extension",
        },
      }
    );
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    cachedAddress = data.address ?? null;
    cachedAddressKey = cacheKey;
    return cachedAddress;
  } catch {
    return null;
  }
}

function stringToBool(str) {
  if (str === "true") return true;
  if (str === "false") return false;
  return null;
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data?.data;
  if (!msg) return;
  try {
    const arr = JSON.parse(msg);
    let success = false;
    try {
      const candidateLat = arr?.[1]?.[0]?.[5]?.[0]?.[1]?.[0]?.[2];
      const candidateLong = arr?.[1]?.[0]?.[5]?.[0]?.[1]?.[0]?.[3];
      if (typeof candidateLat === "number" && typeof candidateLong === "number") {
        lat = candidateLat;
        long = candidateLong;
        success = true;
      }
    } catch {
      /* ignore */
    }
    if (!success) {
      try {
        const fallbackLat = arr?.[1]?.[5]?.[0]?.[1]?.[0]?.[2];
        const fallbackLong = arr?.[1]?.[5]?.[0]?.[1]?.[0]?.[3];
        if (isDecimal(fallbackLat) && isDecimal(fallbackLong)) {
          lat = Number(fallbackLat);
          long = Number(fallbackLong);
          success = true;
        }
      } catch {
        /* ignore */
      }
    }
    if (success) {
      cachedAddress = null;
      cachedAddressKey = null;
      console.debug("[GeoViz] GeoPhotoService Koordinaten erkannt:", lat, long);
      notifyCoordsUpdate(lat, long, "geo_photo");
    }
  } catch (error) {
    console.warn("[GeoViz] GeoPhoto payload konnte nicht verarbeitet werden.", error);
    }
});

window.addEventListener("load", () => {
  let safeMode = localStorage.getItem("safeMode");
  if (safeMode == null) {
    localStorage.setItem("safeMode", "true");
    safeMode = "true";
  }

  setInterval(() => {
    const controlsContainer = document.querySelector('[class^="styles_columnTwo__"]');
    if (controlsContainer && !document.getElementById("tellLocation")) {
      controlsContainer.insertAdjacentHTML(
        "beforeend",
        `<a href="#" class="styles_control__custom" id="tellLocation" style="margin-bottom:1rem;position:relative;touch-action:pan-x pan-y;background:rgba(0,0,0,.6);border:0;border-bottom:.0625rem solid rgba(0,0,0,.4);cursor:pointer;height:40px;display:flex;align-items:center;justify-content:center;width:40px;border-radius:50%">
          <img alt="Tell location" loading="lazy" width="22" height="24" style="filter:invert(1);position:absolute;" src="${PIN_IMG}">
        </a>
        <a href="#" class="styles_control__custom" id="autoPlace" style="margin-bottom:1rem;position:relative;touch-action:pan-x pan-y;background:rgba(0,0,0,.6);border:0;border-bottom:.0625rem solid rgba(0,0,0,.4);cursor:pointer;height:40px;display:flex;align-items:center;justify-content:center;width:40px;border-radius:50%">
          <img alt="Auto place" loading="lazy" width="22" height="24" style="filter:invert(1);position:absolute;" src="${VIEW_IMG}">
        </a>`
      );
      document.getElementById("tellLocation")?.addEventListener("click", (event) => {
        event.preventDefault();
        tellLocation();
      });
      document.getElementById("autoPlace")?.addEventListener("click", (event) => {
        event.preventDefault();
        autoPlace(stringToBool(safeMode));
      });
    }

    const settingsMenu = document.querySelector('[class^="game-menu_optionsContainer__"]');
    if (settingsMenu && !settingsMenu.querySelector(".geoviz-safe-mode")) {
      const checked = stringToBool(safeMode) !== false ? "checked" : "";
      settingsMenu.insertAdjacentHTML(
        "beforeend",
        `<label class="game-options_option__xQZVa game-options_editableOption__0hL4c geoviz-safe-mode" style="cursor:pointer;">
          <img alt="Safe mode icon" loading="lazy" width="24" height="24" class="game-menu_emoteIcon__t4FxY" src="${SAFE_IMG}" style="filter:invert(1);">
          <div class="game-options_optionLabel__Vk5xN">safe mode</div>
          <div class="game-options_optionInput__paPBZ">
            <input type="checkbox" class="toggle_toggle__qfXpL geoviz-safe-toggle" ${checked}>
          </div>
        </label>`
      );
      settingsMenu.querySelector(".geoviz-safe-toggle")?.addEventListener("change", (event) => {
        const toggle = event.target;
        const enabled = toggle.checked;
        localStorage.setItem("safeMode", String(enabled));
        safeMode = String(enabled);
      });
    }
  }, 100);
});

document.addEventListener("keydown", async (event) => {
  if (lat === 999 && long === 999) return;
  const safeModeValue = localStorage.getItem("safeMode");
  if (event.ctrlKey && event.code === "Space" && safeModeValue === "false") {
    autoPlace(false);
  }
  if (event.ctrlKey && event.shiftKey && safeModeValue === "false") {
    await tellLocation();
  }
});

async function tellLocation() {
  if (lat === 999 && long === 999) {
    return;
  }

  const overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.top = "0";
  overlay.style.left = "0";
  overlay.style.width = "100%";
  overlay.style.height = "100%";
  overlay.style.backgroundColor = "rgba(0, 0, 0, 0.7)";
  overlay.style.zIndex = "9998";
  overlay.style.display = "none";

  const popup = document.createElement("div");
  popup.style.position = "fixed";
  popup.style.top = "50%";
  popup.style.left = "50%";
  popup.style.transform = "translate(-50%, -50%)";
  popup.style.backgroundColor = "rgb(86, 59, 154)";
  popup.style.padding = "20px";
  popup.style.borderRadius = "20px";
  popup.style.boxShadow = "0 0 10px rgba(0, 0, 0, 0.5)";
  popup.style.zIndex = "9999";
  popup.style.display = "none";
  popup.style.color = "white";
  popup.style.textAlign = "center";
  popup.style.maxWidth = "480px";

  const title = document.createElement("h2");
  title.style.color = "#a19bd9";
  title.style.fontStyle = "italic";
  title.style.fontWeight = "700";
  title.style.fontFamily = "neo-sans, sans-serif";
  title.innerText = "LOCATION";
  popup.appendChild(title);

  const coordInfo = await getCoordInfo();
  const content = document.createElement("div");
  content.style.fontFamily = "neo-sans, sans-serif";
  content.style.padding = "20px";
  content.style.marginTop = "10px";
  content.style.maxHeight = "360px";
  content.style.overflowY = "auto";

  if (coordInfo) {
    Object.entries(coordInfo).forEach(([key, value]) => {
      const infoItem = document.createElement("p");
      infoItem.style.display = "flex";
      infoItem.style.justifyContent = "flex-start";
      infoItem.style.flexWrap = "wrap";
      infoItem.style.gap = "10px";
      infoItem.style.margin = "0 0 8px 0";

      const keySpan = document.createElement("span");
      keySpan.style.textAlign = "left";
      keySpan.style.fontWeight = "700";
      keySpan.style.textTransform = "uppercase";
      keySpan.textContent = `${key}:`;

      const valueSpan = document.createElement("span");
      valueSpan.style.textAlign = "left";
      valueSpan.textContent = String(value);

      infoItem.appendChild(keySpan);
      infoItem.appendChild(valueSpan);
      content.appendChild(infoItem);
    });
  } else {
    const fallback = document.createElement("p");
    fallback.textContent = "Keine Adresse gefunden. Aktuelle Koordinaten:";
    fallback.style.marginBottom = "12px";
    content.appendChild(fallback);
    const coordLine = document.createElement("p");
    coordLine.style.fontWeight = "700";
    coordLine.textContent = convertCoords(lat, long);
    content.appendChild(coordLine);
  }

  popup.appendChild(content);

  const closeButton = document.createElement("button");
  closeButton.innerText = "Close";
  closeButton.style.marginTop = "20px";
  closeButton.style.color = "white";
  closeButton.style.cursor = "pointer";
  closeButton.style.padding = "10px 20px";
  closeButton.style.borderRadius = "15px";
  closeButton.style.backgroundColor = "#6cb928";
  closeButton.style.fontFamily = "neo-sans, sans-serif";
  closeButton.style.fontStyle = "italic";
  closeButton.style.fontWeight = "700";
  closeButton.style.fontSize = "16px";
  closeButton.style.width = "100%";

  const hidePopup = () => {
    popup.style.display = "none";
    overlay.style.display = "none";
    overlay.remove();
    popup.remove();
  };

  closeButton.onclick = hidePopup;
  overlay.onclick = hidePopup;

  popup.appendChild(closeButton);
  document.body.appendChild(overlay);
  document.body.appendChild(popup);

  popup.style.display = "block";
  overlay.style.display = "block";
}

function getRandomOffset() {
  const offset = 0.5 + Math.random() * 2;
  return Math.random() < 0.5 ? -offset : offset;
}

async function autoPlace(safeMode) {
  const container = document.querySelector(".guess-map_canvasContainer__s7oJp");
  if (!container) return;
  const fiberKey = Object.keys(container).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) return;
  const onMarkerLocationChanged = container[fiberKey]?.return?.memoizedProps?.onMarkerLocationChanged;
  if (typeof onMarkerLocationChanged !== "function") return;

  let latToUse = lat;
  let longToUse = long;
  if (safeMode) {
    latToUse += getRandomOffset();
    longToUse += getRandomOffset();
  }
  onMarkerLocationChanged({ lat: latToUse, lng: longToUse });

  const guessButton = document.querySelector('button[data-qa="perform-guess"]');
  if (!guessButton) return;

  const simulateClick = (target) => {
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, buttons: 1 });
    const up = new MouseEvent("mouseup", { bubbles: true, cancelable: true, buttons: 1 });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, buttons: 1 });
    target.dispatchEvent(down);
    target.dispatchEvent(up);
    target.dispatchEvent(click);
  };

  const delay = Math.floor(Math.random() * 3000) + 500;
  setTimeout(() => simulateClick(guessButton), delay);
}
