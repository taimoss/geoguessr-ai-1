import { FormEvent, useMemo, useState } from "react";
import PredictionCard from "./components/PredictionCard";
import { useInference } from "./hooks/useInference";

const DEFAULT_SESSION = import.meta.env.VITE_DEFAULT_SESSION ?? "session-local";

type FileEvent = FormEvent<HTMLInputElement> & {
  target: HTMLInputElement & EventTarget & { files: FileList | null };
};

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        const [, base64] = result.split(",");
        resolve(base64 ?? result);
      } else {
        reject(new Error("Unable to parse file."));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("Unknown file error"));
    reader.readAsDataURL(file);
  });
}

function App() {
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState(DEFAULT_SESSION);
  const [roundId, setRoundId] = useState(() => `round-${crypto.randomUUID()}`);
  const { data, loading, error, runInference } = useInference();

  const disableSubmit = useMemo(() => loading || !imageBase64, [imageBase64, loading]);

  const handleFileChange = async (event: FileEvent) => {
    const file = event.target.files?.[0];
    if (!file) {
      setImageBase64(null);
      setImagePreview(null);
      return;
    }
    setImagePreview(URL.createObjectURL(file));
    const base64 = await fileToBase64(file);
    setImageBase64(base64);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!imageBase64) return;
    await runInference({
      image_base64: imageBase64,
      session_id: sessionId,
      round_id: roundId
    });
  };

  const resetRound = () => {
    setRoundId(`round-${crypto.randomUUID()}`);
    setImageBase64(null);
    setImagePreview(null);
  };

  return (
    <div className="app-shell">
      <header>
        <div>
          <h1>GeoGuessr Helper UI</h1>
          <p>Test die TinyViT-Inferenz über das lokale FastAPI-Backend.</p>
        </div>
        <span className="app-version">v{__APP_VERSION__}</span>
      </header>

      <main>
        <section className="panel">
          <h2>1. Bild hochladen</h2>
          <p>Nutze einen Screenshot aus Geoguessr oder ein Beispielbild. Die Datei wird in Base64 konvertiert.</p>
          <input type="file" accept="image/png,image/jpeg,image/webp" onInput={handleFileChange} />
          {imagePreview && (
            <div className="preview">
              <img src={imagePreview} alt="Preview" />
            </div>
          )}
        </section>

        <section className="panel">
          <h2>2. Runde konfigurieren</h2>
          <form className="round-form" onSubmit={handleSubmit}>
            <label>
              Session ID
              <input value={sessionId} onChange={(e) => setSessionId(e.target.value)} />
            </label>

            <label>
              Round ID
              <input value={roundId} onChange={(e) => setRoundId(e.target.value)} />
            </label>

            <button type="submit" disabled={disableSubmit}>
              {loading ? "Predicting…" : "Prediction auslösen"}
            </button>
            <button type="button" className="ghost" onClick={resetRound}>
              Reset Round
            </button>
          </form>
        </section>

        <section className="panel">
          <h2>3. Ergebnis</h2>
          {!data && <p>Noch keine Prediction. Lade ein Bild hoch und starte die Inferenz.</p>}
          {error && <p className="error">{error}</p>}
          {data && <PredictionCard prediction={data} />}
        </section>
      </main>
    </div>
  );
}

export default App;
