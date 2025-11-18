"""Utility helpers for country metadata (names, centroids)."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Optional, Tuple

import reverse_geocoder as rg

COUNTRY_INFO_PATH = Path(__file__).resolve().parent.parent / "data" / "country_info.json"


@lru_cache()
def _load_info() -> dict[str, dict]:
    with open(COUNTRY_INFO_PATH, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return {entry["code"]: entry for entry in data}


def get_country_name(code: Optional[str]) -> Optional[str]:
    if not code:
        return None
    info = _load_info().get(code.upper())
    return info["name"] if info else None


def get_country_centroid(code: Optional[str]) -> Optional[Tuple[float, float]]:
    if not code:
        return None
    info = _load_info().get(code.upper())
    if not info:
        return None
    return info["lat"], info["lon"]


def find_country_code(identifier: Optional[str]) -> Optional[str]:
    if not identifier:
        return None
    upper = identifier.upper()
    info = _load_info()
    if upper in info:
        return upper
    for code, entry in info.items():
        if entry["name"].lower() == identifier.lower():
            return code
    return None


def country_from_coords(lat: Optional[float], lon: Optional[float]) -> Optional[str]:
    if lat is None or lon is None:
        return None
    try:
        result = rg.search((lat, lon), mode=1)
        if not result:
            return None
        return result[0]["cc"].upper()
    except Exception:
        return None
