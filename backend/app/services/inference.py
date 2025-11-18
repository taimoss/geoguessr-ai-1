"""Inference service abstraction for communicating with the GeoViT model."""
from __future__ import annotations

import base64
import json
import os
import random
import time
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, Optional
from uuid import uuid4

import httpx
import timm
import torch
from PIL import Image
from torchvision import transforms

from .country_info import find_country_code, get_country_centroid, get_country_name

COUNTRY_CHOICES = [
    ("Czechia", "CZ"),
    ("Romania", "RO"),
    ("Hungary", "HU"),
    ("Germany", "DE"),
    ("France", "FR"),
    ("Brazil", "BR"),
    ("Japan", "JP"),
    ("Canada", "CA"),
    ("Australia", "AU"),
    ("South Africa", "ZA"),
]


class GeoModelClient:
    """Client that can call a remote ML endpoint or fall back to dummy predictions."""

    def __init__(
        self,
        endpoint: Optional[str] = None,
        api_key: Optional[str] = None,
        model_version: str = "geovit-tinyvit-21m-v0",
        timeout_seconds: float | None = None,
        checkpoint_path: Optional[str] = None,
        classes_path: Optional[str] = None,
    ) -> None:
        self.endpoint = endpoint or os.getenv("MODEL_ENDPOINT")
        self.api_key = api_key or os.getenv("MODEL_API_KEY")
        self.model_version = model_version
        self.timeout_seconds = timeout_seconds or float(os.getenv("MODEL_TIMEOUT", "10"))
        self.checkpoint_path = checkpoint_path or os.getenv("MODEL_CHECKPOINT")
        self.classes_path = classes_path or os.getenv("MODEL_CLASSES_PATH")
        self._local_model = None
        self._local_transform = None
        self._local_class_names: list[str] = []
        self._local_device = "cuda" if torch.cuda.is_available() else "cpu"

    async def predict(
        self,
        image_base64: str,
        session_id: Optional[str] = None,
        round_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Call the configured ML endpoint or fall back to dummy predictions."""
        if self.endpoint:
            return await self._call_remote(image_base64, session_id, round_id)
        if self.checkpoint_path and Path(self.checkpoint_path).exists():
            return await self._local_model_predict(image_base64)
        return self._dummy_prediction(image_base64)

    async def _call_remote(
        self,
        image_base64: str,
        session_id: Optional[str],
        round_id: Optional[str],
    ) -> Dict[str, Any]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        payload = {
            "image_base64": image_base64,
            "session_id": session_id,
            "round_id": round_id,
        }
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            response = await client.post(self.endpoint, json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
            data.setdefault("model_version", self.model_version)
            return data

    async def _local_model_predict(self, image_base64: str) -> Dict[str, Any]:
        self._ensure_local_model()
        image = self._decode_image(image_base64)
        tensor = self._local_transform(image).unsqueeze(0).to(self._local_device)
        start_time = time.perf_counter()
        with torch.no_grad():
            logits = self._local_model(tensor)
            probs = torch.softmax(logits, dim=1).squeeze().cpu()
        elapsed_ms = int((time.perf_counter() - start_time) * 1000)
        topk = torch.topk(probs, k=min(3, probs.shape[0]))
        top_countries = []
        for prob, idx in zip(topk.values.tolist(), topk.indices.tolist()):
            raw_label = self._local_class_names[idx] if idx < len(self._local_class_names) else f"class-{idx}"
            code = find_country_code(raw_label) or raw_label
            name = get_country_name(code) or raw_label
            top_countries.append({"id": code, "name": name, "confidence": round(prob, 3)})

        country = top_countries[0] if top_countries else {"id": "unknown", "name": "unknown", "confidence": 0.0}
        centroid = get_country_centroid(country["id"])
        if centroid:
            lat, lon = centroid
        else:
            lat = random.uniform(-70, 70)
            lon = random.uniform(-170, 170)
        return {
            "inference_id": str(uuid4()),
            "lat": lat,
            "lon": lon,
            "continent": {"id": "UNK", "name": "Unknown", "confidence": 0.0},
            "country": country,
            "grid_l4": {"id": "S2-L4", "confidence": 0.0},
            "grid_l6": {"id": "S2-L6", "confidence": 0.0},
            "confidence_lat": None,
            "confidence_lon": None,
            "model_version": self.model_version,
            "inference_time_ms": elapsed_ms,
            "top_countries": top_countries,
            "grid_polygon": self._make_polygon(lat, lon),
        }

    def _ensure_local_model(self) -> None:
        if self._local_model is not None:
            return
        if not self.checkpoint_path:
            raise RuntimeError("MODEL_CHECKPOINT not configured.")
        print(f"[GeoModelClient] Loading local model from {self.checkpoint_path}")
        self._local_model = timm.create_model(
            "tiny_vit_21m_224",
            pretrained=False,
            num_classes=self._load_class_count(),
        )
        state = torch.load(self.checkpoint_path, map_location="cpu")
        self._local_model.load_state_dict(state)
        self._local_model.to(self._local_device).eval()
        self._local_transform = transforms.Compose(
            [
                transforms.Resize((224, 224)),
                transforms.ToTensor(),
            ]
        )

    def _load_class_count(self) -> int:
        if self.classes_path and Path(self.classes_path).exists():
            with open(self.classes_path, "r", encoding="utf-8") as fh:
                self._local_class_names = json.load(fh)
                return len(self._local_class_names)
        raise RuntimeError("MODEL_CLASSES_PATH missing or invalid.")

    def _decode_image(self, base64_str: str) -> Image.Image:
        try:
            data = base64.b64decode(base64_str)
        except Exception as exc:  # noqa: BLE001
            raise ValueError("Invalid base64 image.") from exc
        return Image.open(BytesIO(data)).convert("RGB")

    def _dummy_prediction(self, image_base64: str) -> Dict[str, Any]:
        start_time = time.perf_counter()
        random.seed(image_base64[:16])
        lat = random.uniform(-85.0, 85.0)
        lon = random.uniform(-180.0, 180.0)
        inference_id = str(uuid4())

        elapsed_ms = int((time.perf_counter() - start_time) * 1000)
        top_countries = self._sample_top_countries()
        country_name, country_code, country_conf = top_countries[0]
        centroid = get_country_centroid(country_code)
        if centroid:
            lat, lon = centroid
        grid_polygon = self._make_polygon(lat, lon)
        return {
            "inference_id": inference_id,
            "lat": lat,
            "lon": lon,
            "continent": {"id": "EU", "name": "Europe", "confidence": round(random.random(), 3)},
            "country": {"id": country_code, "name": country_name, "confidence": country_conf},
            "grid_l4": {"id": "N0-1234", "confidence": round(random.random(), 3)},
            "grid_l6": {"id": "N0-123456", "confidence": round(random.random(), 3)},
            "confidence_lat": round(random.random(), 3),
            "confidence_lon": round(random.random(), 3),
            "model_version": self.model_version,
            "inference_time_ms": elapsed_ms,
            "top_countries": [
                {"id": code, "name": name, "confidence": conf} for name, code, conf in top_countries
            ],
            "grid_polygon": grid_polygon,
        }

    def _sample_top_countries(self) -> list[tuple[str, str, float]]:
        samples = random.sample(COUNTRY_CHOICES, k=3)
        confidences = sorted([random.random() for _ in range(3)], reverse=True)
        enriched = []
        for idx, (name, code) in enumerate(samples):
            resolved_name = get_country_name(code) or name
            enriched.append((resolved_name, code, round(confidences[idx], 3)))
        return enriched

    def _make_polygon(self, lat: float, lon: float) -> list[list[float]]:
        delta = 1.5
        return [
            [lat - delta, lon - delta],
            [lat - delta, lon + delta],
            [lat + delta, lon + delta],
            [lat + delta, lon - delta],
        ]


_MODEL_CLIENT = GeoModelClient()


def get_model_client() -> GeoModelClient:
    """FastAPI dependency hook."""
    return _MODEL_CLIENT
