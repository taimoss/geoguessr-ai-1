"""FastAPI mock inference server for local development.

Usage:
    python -m ml.mock_model_server --port 8080
"""
from __future__ import annotations

import argparse
import base64
import random
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

COUNTRY_CHOICES = [
    ("Romania", "RO"),
    ("Czechia", "CZ"),
    ("Japan", "JP"),
    ("Brazil", "BR"),
    ("Canada", "CA"),
    ("Australia", "AU"),
]

app = FastAPI(title="Mock GeoViT Server")


class InferencePayload(BaseModel):
    image_base64: str
    session_id: str | None = None
    round_id: str | None = None


def _top_countries() -> list[dict]:
    samples = random.sample(COUNTRY_CHOICES, k=3)
    probs = sorted([random.random() for _ in range(3)], reverse=True)
    return [
        {"id": code, "name": name, "confidence": round(probs[idx], 3)}
        for idx, (name, code) in enumerate(samples)
    ]


def _grid_polygon(lat: float, lon: float):
    delta = 2
    return [
        [lat - delta, lon - delta],
        [lat - delta, lon + delta],
        [lat + delta, lon + delta],
        [lat + delta, lon - delta],
    ]


@app.post("/predictions/geovit")
async def predict(payload: InferencePayload):
    try:
        base64.b64decode(payload.image_base64, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Invalid base64 image.") from exc

    start = time.perf_counter()
    lat = random.uniform(-70, 70)
    lon = random.uniform(-170, 170)
    top = _top_countries()
    elapsed = int((time.perf_counter() - start) * 1000)
    return {
        "inference_id": f"mock-{int(time.time()*1000)}",
        "lat": lat,
        "lon": lon,
        "continent": {"id": "EU", "name": "Europe", "confidence": round(random.random(), 3)},
        "country": top[0],
        "grid_l4": {"id": "N0-1234", "confidence": round(random.random(), 3)},
        "grid_l6": {"id": "N0-123456", "confidence": round(random.random(), 3)},
        "confidence_lat": round(random.random(), 3),
        "confidence_lon": round(random.random(), 3),
        "model_version": "mock-1.0",
        "inference_time_ms": elapsed,
        "top_countries": top,
        "grid_polygon": _grid_polygon(lat, lon),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
