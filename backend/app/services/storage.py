"""Utility helpers for storing screenshots and assets on disk."""
from __future__ import annotations

import base64
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Optional
from uuid import uuid4

from .country_info import find_country_code


DEFAULT_IMAGE_DIR = Path(__file__).resolve().parents[2] / "data" / "images"
IMAGE_STORAGE_DIR = Path(os.getenv("IMAGE_STORAGE_DIR", str(DEFAULT_IMAGE_DIR)))
logger = logging.getLogger(__name__)


def _safe_segment(value: Optional[str]) -> str:
    if not value:
        return "default"
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip())
    return cleaned or "default"


def _country_segment(country_name: Optional[str]) -> str:
    if not country_name:
        return "unknown"
    normalized = find_country_code(country_name)
    if normalized:
        return normalized
    cleaned = country_name.strip()
    if len(cleaned) == 2 and cleaned.isalpha():
        return cleaned.upper()
    return _safe_segment(cleaned)


def save_base64_image(
    image_base64: str,
    round_id: Optional[str],
    country_name: Optional[str] = None,
) -> str:
    """Decode a base64 string and store it under data/images/<country>/."""
    IMAGE_STORAGE_DIR.mkdir(parents=True, exist_ok=True)

    country_segment = _country_segment(country_name)
    round_segment = _safe_segment(round_id) if round_id else uuid4().hex
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S_%f")

    folder_path = IMAGE_STORAGE_DIR / country_segment
    folder_path.mkdir(parents=True, exist_ok=True)

    file_path = folder_path / f"{round_segment}_{timestamp}.png"
    try:
        binary = base64.b64decode(image_base64, validate=True)
    except Exception as exc:  # noqa: BLE001
        logger.error("Screenshot konnte nicht dekodiert werden (round_id=%s): %s", round_id, exc)
        raise ValueError("Screenshot konnte nicht dekodiert werden.") from exc

    with open(file_path, "wb") as fh:
        fh.write(binary)
    logger.info("Screenshot gespeichert: %s", file_path)

    return str(file_path)


def move_image_to_country(existing_path: Optional[str], country_name: Optional[str]) -> Optional[str]:
    """Move existing screenshot into the correct country folder."""
    if not existing_path or not country_name:
        return existing_path

    src = Path(existing_path)
    if not src.exists():
        return existing_path

    dst_dir = IMAGE_STORAGE_DIR / _country_segment(country_name)
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / src.name
    if dst.resolve() == src.resolve():
        return str(dst)

    try:
        src.replace(dst)
    except OSError:
        return existing_path
    return str(dst)
