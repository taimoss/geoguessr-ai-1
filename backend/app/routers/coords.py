"""Endpoints for ingesting coordinate samples."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services.coords import log_coordinate_sample
from ..services.country_info import country_from_coords
from ..services.grid import compute_grid
from ..services.coords_cache import store_coords

router = APIRouter(prefix="/v1", tags=["coords"])


class CoordinateSample(BaseModel):
    lat: float = Field(..., description="Latitude of the detected point")
    lon: float = Field(..., description="Longitude of the detected point")
    source: Optional[str] = Field(default="extension", description="Origin of the coordinate")
    captured_at: Optional[datetime] = Field(
        default=None, description="Capture timestamp sent by the client (UTC ISO-8601)"
    )
    session_id: Optional[str] = Field(default=None)
    round_id: Optional[str] = Field(default=None)
    round_index: Optional[int] = Field(default=None)
    metadata: Optional[Dict[str, Any]] = Field(
        default=None, description="Arbitrary metadata captured alongside the coordinate"
    )


class CoordinateResponse(BaseModel):
    status: str
    lat: float
    lon: float
    logged_at: datetime
    country: Optional[str]
    grid_l4: Optional[str]
    grid_l6: Optional[str]
    session_id: Optional[str]
    round_id: Optional[str]


@router.post("/coords", response_model=CoordinateResponse, status_code=202)
async def ingest_coordinate(payload: CoordinateSample) -> CoordinateResponse:
    """Accept a coordinate sample and append it to the artifacts log."""
    country_code = country_from_coords(payload.lat, payload.lon)
    grid_l4 = compute_grid(payload.lat, payload.lon, level=4)
    grid_l6 = compute_grid(payload.lat, payload.lon, level=6)
    entry = {
        "lat": payload.lat,
        "lon": payload.lon,
        "source": payload.source or "extension",
        "captured_at": (payload.captured_at or datetime.utcnow()).isoformat(),
        "metadata": payload.metadata or {},
        "session_id": payload.session_id,
        "round_id": payload.round_id,
        "round_index": payload.round_index,
        "country": country_code,
        "grid_l4": grid_l4[0] if grid_l4 else None,
        "grid_l4_bounds": grid_l4[1] if grid_l4 else None,
        "grid_l6": grid_l6[0] if grid_l6 else None,
        "grid_l6_bounds": grid_l6[1] if grid_l6 else None,
    }
    try:
        timestamp = log_coordinate_sample(entry)
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Failed to store coordinate sample") from exc

    store_coords(
        payload.session_id,
        payload.round_id,
        {
            "lat": payload.lat,
            "lon": payload.lon,
            "country": country_code,
            "grid_l4": entry["grid_l4"],
            "grid_l6": entry["grid_l6"],
            "round_index": payload.round_index,
            "captured_at": entry["captured_at"],
            "metadata": payload.metadata or {},
        },
    )

    return CoordinateResponse(
        status="accepted",
        lat=payload.lat,
        lon=payload.lon,
        logged_at=timestamp,
        country=country_code,
        grid_l4=entry["grid_l4"],
        grid_l6=entry["grid_l6"],
        session_id=payload.session_id,
        round_id=payload.round_id,
    )
