import type { InferenceResponse } from "../hooks/useInference";

interface Props {
  prediction: InferenceResponse;
}

const formatConfidence = (value?: number | null) => {
  if (value === undefined || value === null) return "—";
  return `${Math.round(value * 100)}%`;
};

function PredictionRow({
  label,
  value,
  confidence
}: {
  label: string;
  value?: string | null;
  confidence?: number | null;
}) {
  return (
    <div className="prediction-row">
      <span>{label}</span>
      <strong>{value ?? "—"}</strong>
      <small>{formatConfidence(confidence)}</small>
    </div>
  );
}

export default function PredictionCard({ prediction }: Props) {
  return (
    <div className="prediction-card">
      <div className="prediction-header">
        <div>
          <h3>GeoViT Vorhersage</h3>
          <p>Version {prediction.model_version}</p>
        </div>
        <span>{prediction.inference_time_ms} ms</span>
      </div>

      <div className="coordinates">
        <div>
          <label>Latitude</label>
          <strong>{prediction.lat.toFixed(5)}</strong>
          <small>Sigma: {prediction.confidence_lat ?? "—"}</small>
        </div>
        <div>
          <label>Longitude</label>
          <strong>{prediction.lon.toFixed(5)}</strong>
          <small>Sigma: {prediction.confidence_lon ?? "—"}</small>
        </div>
      </div>

      <PredictionRow label="Kontinent" value={prediction.continent.id} confidence={prediction.continent.confidence} />
      <PredictionRow label="Land" value={prediction.country.id} confidence={prediction.country.confidence} />
      <PredictionRow label="Grid L4" value={prediction.grid_l4.id} confidence={prediction.grid_l4.confidence} />
      <PredictionRow label="Grid L6" value={prediction.grid_l6.id} confidence={prediction.grid_l6.confidence} />

      <footer>
        <small>Inference ID: {prediction.inference_id}</small>
      </footer>
    </div>
  );
}
