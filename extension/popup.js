const statusEl = document.getElementById("status");
const backendInput = document.getElementById("backendUrl");
const sessionInput = document.getElementById("sessionPrefix");
const autoPlayInput = document.getElementById("autoPlay");

function loadConfig() {
  chrome.runtime.sendMessage({ type: "GET_CONFIG" }, (response) => {
    if (response?.success) {
      backendInput.value = response.config.backendUrl;
      sessionInput.value = response.config.sessionPrefix;
      autoPlayInput.checked = !!response.config.autoPlayEnabled;
    }
  });
}

function saveConfig() {
  statusEl.textContent = "Speichern…";
  chrome.runtime.sendMessage(
    {
      type: "SAVE_CONFIG",
      payload: {
        backendUrl: backendInput.value.trim() || "http://localhost:8000",
        sessionPrefix: sessionInput.value.trim() || "chrome-session",
        autoPlayEnabled: autoPlayInput.checked,
      },
    },
    (response) => {
      statusEl.textContent = response?.success ? "Gespeichert." : "Fehler beim Speichern";
    }
  );
}

document.getElementById("saveBtn").addEventListener("click", saveConfig);
loadConfig();
