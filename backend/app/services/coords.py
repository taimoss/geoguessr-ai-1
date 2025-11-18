"""Utilities for persisting coordinate samples from the extension."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict

COORDS_LOG_PATH = Path(__file__).resolve().parents[2] / "artifacts" / "coords.jsonl"


def log_coordinate_sample(entry: Dict[str, Any]) -> datetime:
    """Append a coordinate sample to a JSONL log and return the log timestamp."""
    COORDS_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.utcnow()
    payload = {
        **entry,
        "logged_at": timestamp.isoformat(),
    }
    with COORDS_LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    return timestamp
