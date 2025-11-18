import { useCallback, useState } from "react";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

export interface ClassificationResult {
  id?: string | null;
  confidence?: number | null;
}

export interface InferenceResponse {
  inference_id: string;
  lat: number;
  lon: number;
  continent: ClassificationResult;
  country: ClassificationResult;
  grid_l4: ClassificationResult;
  grid_l6: ClassificationResult;
  confidence_lat?: number;
  confidence_lon?: number;
  model_version: string;
  inference_time_ms: number;
}

export interface InferenceRequest {
  image_base64: string;
  session_id?: string;
  round_id?: string;
  metadata?: Record<string, string>;
}

export function useInference() {
  const [data, setData] = useState<InferenceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runInference = useCallback(async (payload: InferenceRequest) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE_URL}/v1/inference`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Request failed (${response.status})`);
      }
      const json = (await response.json()) as InferenceResponse;
      setData(json);
      return json;
    } catch (err) {
      console.error("Inference failed", err);
      setError(err instanceof Error ? err.message : "Unknown error");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { data, loading, error, runInference };
}
