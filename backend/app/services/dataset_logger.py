"""Dataset logging helpers for redundant JSONL exports."""
from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from .grid import compute_grid

BACKEND_ROOT = Path(__file__).resolve().parents[2]
DATASET_DIR = BACKEND_ROOT / "data" / "datasets"
DATASET_PATH = DATASET_DIR / "round_samples.jsonl"
logger = logging.getLogger(__name__)


def _safe_float(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number


def append_dataset_entry(
    *,
    sample_type: str,
    session_id: Optional[str],
    round_id: Optional[str],
    round_index: Optional[int],
    screenshot_path: Optional[str],
    ground_truth: Optional[Dict[str, Any]],
    prediction: Optional[Dict[str, Any]],
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    DATASET_DIR.mkdir(parents=True, exist_ok=True)
    gt = ground_truth or {}
    pred = prediction or {}
    sample: Dict[str, Any] = {
        "type": sample_type,
        "type": sample_type,
        "session_id": session_id,
        "round_id": round_id,
        "round_index": round_index,
        "screenshot_path": screenshot_path,
        "logged_at": datetime.utcnow().isoformat(),
        "ground_truth": {
            "lat": _safe_float(gt.get("lat")),
            "lon": _safe_float(gt.get("lon")),
            "country": gt.get("country"),
            "continent": gt.get("continent"),
        },
        "prediction": {
            "lat": _safe_float(pred.get("lat")),
            "lon": _safe_float(pred.get("lon")),
            "country_id": pred.get("country_id"),
            "country_confidence": pred.get("country_confidence"),
            "continent_id": pred.get("continent_id"),
            "continent_confidence": pred.get("continent_confidence"),
            "grid_l4": pred.get("grid_l4"),
            "grid_l4_confidence": pred.get("grid_l4_confidence"),
            "grid_l6": pred.get("grid_l6"),
            "grid_l6_confidence": pred.get("grid_l6_confidence"),
            "confidence_lat": pred.get("confidence_lat"),
            "confidence_lon": pred.get("confidence_lon"),
            "inference_id": pred.get("inference_id"),
            "model_version": pred.get("model_version"),
        },
    }

    if metadata:
        sample["metadata"] = metadata

    sample["image_exists"] = bool(screenshot_path and Path(screenshot_path).exists())

    gt_lat = sample["ground_truth"]["lat"]
    gt_lon = sample["ground_truth"]["lon"]
    if gt_lat is not None and gt_lon is not None:
        grid_l4 = compute_grid(gt_lat, gt_lon, level=4)
        grid_l6 = compute_grid(gt_lat, gt_lon, level=6)
        if grid_l4:
            sample["ground_truth"]["grid_l4"] = grid_l4[0]
            sample["ground_truth"]["grid_l4_bounds"] = grid_l4[1]
        if grid_l6:
            sample["ground_truth"]["grid_l6"] = grid_l6[0]
            sample["ground_truth"]["grid_l6_bounds"] = grid_l6[1]

    extra_json = pred.get("extra_json")
    if isinstance(extra_json, str):
        try:
            sample["prediction"]["extra"] = json.loads(extra_json)
        except json.JSONDecodeError:
            sample["prediction"]["extra_raw"] = extra_json

    with DATASET_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(sample, ensure_ascii=False) + "\n")

    logger.debug("Dataset entry appended (%s) for round %s", sample_type, round_id)
