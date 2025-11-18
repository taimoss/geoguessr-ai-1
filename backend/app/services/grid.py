"""Utility helpers for assigning adaptive grid IDs to coordinates."""
from __future__ import annotations

from typing import Optional, Tuple


def _clamp(value: float, min_value: float, max_value: float) -> float:
    return max(min(value, max_value), min_value)


# Default steps (degrees) for low coverage areas.
GRID_DEFAULT = {
    4: {"lat_step": 12.0, "lon_step": 12.0},
    6: {"lat_step": 6.0, "lon_step": 6.0},
}

# Regional overrides – denser grids in high coverage regions.
# Based on popular GeoGuessr areas (Europe, NA, JP, etc.).
GRID_OVERRIDES = [
    {
        "name": "north_america_core",
        "lat_min": 10,
        "lat_max": 75,
        "lon_min": -170,
        "lon_max": -50,
        "steps": {4: {"lat_step": 6, "lon_step": 6}, 6: {"lat_step": 3, "lon_step": 3}},
    },
    {
        "name": "europe_core",
        "lat_min": 30,
        "lat_max": 72,
        "lon_min": -15,
        "lon_max": 60,
        "steps": {4: {"lat_step": 3, "lon_step": 3}, 6: {"lat_step": 1.5, "lon_step": 1.5}},
    },
    {
        "name": "russia_steppe",
        "lat_min": 45,
        "lat_max": 75,
        "lon_min": 30,
        "lon_max": 150,
        "steps": {4: {"lat_step": 5, "lon_step": 5}, 6: {"lat_step": 2.5, "lon_step": 2.5}},
    },
    {
        "name": "east_asia",
        "lat_min": 10,
        "lat_max": 50,
        "lon_min": 90,
        "lon_max": 150,
        "steps": {4: {"lat_step": 4, "lon_step": 4}, 6: {"lat_step": 2, "lon_step": 2}},
    },
    {
        "name": "oceania",
        "lat_min": -50,
        "lat_max": -5,
        "lon_min": 105,
        "lon_max": 180,
        "steps": {4: {"lat_step": 5, "lon_step": 5}, 6: {"lat_step": 2.5, "lon_step": 2.5}},
    },
    {
        "name": "south_america_band",
        "lat_min": -55,
        "lat_max": 15,
        "lon_min": -85,
        "lon_max": -35,
        "steps": {4: {"lat_step": 8, "lon_step": 8}, 6: {"lat_step": 4, "lon_step": 4}},
    },
    {
        "name": "africa_mediterranean",
        "lat_min": -5,
        "lat_max": 35,
        "lon_min": -20,
        "lon_max": 50,
        "steps": {4: {"lat_step": 7, "lon_step": 7}, 6: {"lat_step": 3.5, "lon_step": 3.5}},
    },
]


def _select_steps(lat: float, lon: float, level: int) -> Tuple[str, float, float]:
    for zone in GRID_OVERRIDES:
        if (
            zone["lat_min"] <= lat <= zone["lat_max"]
            and zone["lon_min"] <= lon <= zone["lon_max"]
            and level in zone["steps"]
        ):
            steps = zone["steps"][level]
            return zone["name"], steps["lat_step"], steps["lon_step"]
    default = GRID_DEFAULT.get(level, GRID_DEFAULT[4])
    return "global", default["lat_step"], default["lon_step"]


def compute_grid(lat: Optional[float], lon: Optional[float], level: int = 4) -> Optional[Tuple[str, dict]]:
    """Return adaptive grid id + bounds for the given coordinate."""
    if lat is None or lon is None:
        return None
    lat = _clamp(lat, -90.0, 90.0)
    lon = (_clamp(lon, -180.0, 180.0) + 360.0) % 360.0 - 180.0

    zone_tag, lat_step, lon_step = _select_steps(lat, lon, level)

    row = int((lat + 90) / lat_step)
    col = int((lon + 180) / lon_step)

    lat_min = -90 + row * lat_step
    lon_min = -180 + col * lon_step
    lat_max = min(90.0, lat_min + lat_step)
    lon_max = min(180.0, lon_min + lon_step)

    grid_id = f"grid_l{level}_{zone_tag}_{row:03d}_{col:03d}"
    bounds = {
        "lat_min": lat_min,
        "lat_max": lat_max,
        "lon_min": lon_min,
        "lon_max": lon_max,
        "row": row,
        "col": col,
        "zone": zone_tag,
        "lat_step": lat_step,
        "lon_step": lon_step,
    }
    return grid_id, bounds
