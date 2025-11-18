"""Inference endpoints for the GeoGuessr automation backend."""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..services.inference import GeoModelClient, get_model_client
from ..services.storage import save_base64_image
from ..services.coords_cache import get_coords
from ..services.dataset_logger import append_dataset_entry
from ..services.country_info import find_country_code, country_from_coords

router = APIRouter(prefix="/v1", tags=["inference"])


class InferenceRequest(BaseModel):
    image_base64: str = Field(..., description="Base64-encoded screenshot extracted from Geoguessr")
    session_id: Optional[str] = Field(default=None)
    round_id: Optional[str] = Field(default=None)
    metadata: Dict[str, Any] | None = Field(default=None)


class ClassificationResult(BaseModel):
    id: Optional[str]
    name: Optional[str] = None
    confidence: Optional[float]


class InferenceResponse(BaseModel):
    inference_id: str
    lat: float
    lon: float
    continent: ClassificationResult
    country: ClassificationResult
    grid_l4: ClassificationResult
    grid_l6: ClassificationResult
    confidence_lat: Optional[float] = None
    confidence_lon: Optional[float] = None
    model_version: str
    inference_time_ms: int
    screenshot_path: Optional[str] = None
    top_countries: list[ClassificationResult] = Field(default_factory=list)
    grid_polygon: Optional[list[list[float]]] = None
    metadata: Optional[dict[str, Any]] = None


InferenceResponse.model_rebuild()


class ScreenshotRequest(BaseModel):
    image_base64: str = Field(..., description="Base64-encoded Street View frame")
    session_id: Optional[str] = None
    round_id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class ScreenshotResponse(BaseModel):
    screenshot_path: str
    session_id: Optional[str] = None
    round_id: Optional[str] = None


def normalize_country_label(label: Optional[str]) -> Optional[str]:
    if not label:
        return None
    label = label.strip()
    if not label:
        return None
    lookup = find_country_code(label)
    if lookup:
        return lookup
    if len(label) == 2 and label.isalpha():
        return label.upper()
    return None


def extract_country_hint(metadata: Optional[Dict[str, Any]]) -> Optional[str]:
    if not isinstance(metadata, dict):
        return None
    street_view = metadata.get("street_view")
    if isinstance(street_view, dict):
        country = street_view.get("country")
        code = normalize_country_label(country)
        if code:
            return code
        lat = street_view.get("lat")
        lon = street_view.get("lon")
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            return country_from_coords(lat, lon)
    result_map = metadata.get("result_from_map")
    if isinstance(result_map, dict):
        country = result_map.get("country")
        code = normalize_country_label(country)
        if code:
            return code
        lat = result_map.get("lat")
        lon = result_map.get("lon")
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            return country_from_coords(lat, lon)
    return None


@router.post("/inference", response_model=InferenceResponse)
async def run_inference(
    payload: InferenceRequest,
    model_client: GeoModelClient = Depends(get_model_client),
) -> InferenceResponse:
    """Proxy request to the GeoViT inference service and return the result."""
    result = await model_client.predict(
        image_base64=payload.image_base64,
        session_id=payload.session_id,
        round_id=payload.round_id,
    )
    coords_hint = get_coords(payload.session_id, payload.round_id)
    country_hint = coords_hint.get("country") if coords_hint else None
    if not country_hint:
        country_hint = extract_country_hint(payload.metadata)
    try:
        screenshot_path = save_base64_image(
            payload.image_base64,
            payload.round_id,
            country_name=country_hint,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    merged_metadata: Dict[str, Any] = {}
    if isinstance(payload.metadata, dict):
        merged_metadata.update(payload.metadata)
    if coords_hint:
        street_meta = merged_metadata.setdefault("street_view", {})
        if coords_hint.get("lat") is not None:
            street_meta["lat"] = coords_hint["lat"]
            result["lat"] = coords_hint["lat"]
        if coords_hint.get("lon") is not None:
            street_meta["lon"] = coords_hint["lon"]
            result["lon"] = coords_hint["lon"]
        if coords_hint.get("country"):
            street_meta["country"] = coords_hint["country"]
        if coords_hint.get("grid_l4"):
            street_meta["grid_l4"] = coords_hint["grid_l4"]
        if coords_hint.get("grid_l6"):
            street_meta["grid_l6"] = coords_hint["grid_l6"]
        street_meta["round_index"] = coords_hint.get("round_index")
    elif payload.metadata:
        merged_metadata.update(payload.metadata)
        if payload.metadata.get("lat") is not None:
            result["lat"] = payload.metadata["lat"]
        if payload.metadata.get("lon") is not None:
            result["lon"] = payload.metadata["lon"]
    if merged_metadata:
        result["metadata"] = merged_metadata
    result["screenshot_path"] = screenshot_path

    try:
        append_dataset_entry(
            sample_type="inference",
            session_id=payload.session_id,
            round_id=payload.round_id,
            round_index=coords_hint.get("round_index") if coords_hint else None,
            screenshot_path=screenshot_path,
            ground_truth={
                "lat": coords_hint.get("lat") if coords_hint else None,
                "lon": coords_hint.get("lon") if coords_hint else None,
                "country": coords_hint.get("country") if coords_hint else None,
                "grid_l4": coords_hint.get("grid_l4") if coords_hint else None,
                "grid_l6": coords_hint.get("grid_l6") if coords_hint else None,
            }
            if coords_hint
            else merged_metadata.get("street_view") if isinstance(merged_metadata.get("street_view"), dict) else None,
            prediction={
                "lat": result.get("lat"),
                "lon": result.get("lon"),
                "country_id": result.get("country", {}).get("id") if result.get("country") else None,
                "country_confidence": result.get("country", {}).get("confidence") if result.get("country") else None,
                "continent_id": result.get("continent", {}).get("id") if result.get("continent") else None,
                "continent_confidence": result.get("continent", {}).get("confidence")
                if result.get("continent")
                else None,
                "grid_l4": result.get("grid_l4", {}).get("id") if result.get("grid_l4") else None,
                "grid_l4_confidence": result.get("grid_l4", {}).get("confidence") if result.get("grid_l4") else None,
                "grid_l6": result.get("grid_l6", {}).get("id") if result.get("grid_l6") else None,
                "grid_l6_confidence": result.get("grid_l6", {}).get("confidence") if result.get("grid_l6") else None,
                "confidence_lat": result.get("confidence_lat"),
                "confidence_lon": result.get("confidence_lon"),
                "inference_id": result.get("inference_id"),
                "model_version": result.get("model_version"),
            },
            metadata={
                "source": "inference",
                "street_view": merged_metadata.get("street_view") if isinstance(merged_metadata.get("street_view"), dict) else None,
            },
        )
    except Exception as dataset_error:  # noqa: BLE001
        logger = logging.getLogger(__name__)
        logger.warning("Failed to append inference dataset entry: %s", dataset_error)

    return InferenceResponse(**result)


@router.post("/screenshot", response_model=ScreenshotResponse, status_code=201)
async def store_screenshot(payload: ScreenshotRequest) -> ScreenshotResponse:
    """Persist a screenshot without triggering inference."""
    country_hint = extract_country_hint(payload.metadata)
    try:
        screenshot_path = save_base64_image(
            payload.image_base64,
            payload.round_id,
            country_name=country_hint,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    round_index = None
    ground_truth = None
    metadata_payload: Dict[str, Any] | None = None
    if isinstance(payload.metadata, dict):
        metadata_payload = payload.metadata
        round_index = payload.metadata.get("round_index")
        street_view_meta = payload.metadata.get("street_view")
        if isinstance(street_view_meta, dict):
            ground_truth = {
                "lat": street_view_meta.get("lat"),
                "lon": street_view_meta.get("lon"),
                "country": street_view_meta.get("country"),
                "continent": street_view_meta.get("continent"),
            }

    try:
        append_dataset_entry(
            sample_type="screenshot",
            session_id=payload.session_id,
            round_id=payload.round_id,
            round_index=round_index,
            screenshot_path=screenshot_path,
            ground_truth=ground_truth,
            prediction=None,
            metadata=metadata_payload,
        )
    except Exception as dataset_error:  # noqa: BLE001
        logger = logging.getLogger(__name__)
        logger.warning("Failed to append screenshot dataset entry: %s", dataset_error)

    return ScreenshotResponse(
        screenshot_path=screenshot_path,
        session_id=payload.session_id,
        round_id=payload.round_id,
    )
