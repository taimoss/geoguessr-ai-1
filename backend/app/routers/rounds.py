"""Round logging and listing endpoints."""
from __future__ import annotations

import logging
from datetime import datetime
from math import asin, cos, radians, sin, sqrt
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from ..db.models import GameSession, Prediction, Round
from ..db.session import get_session
from ..services.country_info import country_from_coords, find_country_code
from ..services.storage import move_image_to_country
from ..services.dataset_logger import append_dataset_entry

logger = logging.getLogger(__name__)


def resolve_country_code(label: Optional[str], lat: Optional[float], lon: Optional[float]) -> Optional[str]:
    if label:
        normalized = find_country_code(label)
        if normalized:
            return normalized
        if len(label) == 2 and label.isalpha():
            return label.upper()
    if lat is not None and lon is not None:
        return country_from_coords(lat, lon)
    return None

router = APIRouter(prefix="/v1", tags=["rounds"])


class GroundTruth(BaseModel):
    lat: float
    lon: float
    country: str
    continent: Optional[str] = None
    captured_at: Optional[datetime] = None


class ClassificationPayload(BaseModel):
    id: Optional[str] = None
    confidence: Optional[float] = None


class PredictionPayload(BaseModel):
    inference_id: str
    lat: float
    lon: float
    continent: ClassificationPayload
    country: ClassificationPayload
    grid_l4: ClassificationPayload
    grid_l6: ClassificationPayload
    confidence_lat: Optional[float] = None
    confidence_lon: Optional[float] = None
    model_version: str
    inference_time_ms: Optional[int] = None
    extra_json: Optional[str] = None


class RoundLogRequest(BaseModel):
    session_id: str = Field(..., description="Identifier of the Geoguessr session")
    round_id: str = Field(..., description="Unique identifier for the round within the session")
    round_index: int
    ground_truth: GroundTruth
    prediction: PredictionPayload
    score: int
    screenshot_path: Optional[str] = None
    mode: Optional[str] = None
    player: Optional[str] = None


class RoundLogResponse(BaseModel):
    round_id: str
    session_id: str
    stored_prediction: bool
    stored_round: bool
    distance_km: Optional[float] = None
    is_correct: Optional[bool] = None
    score: int


class RoundSummary(BaseModel):
    round_id: str
    session_id: str
    round_index: int
    score: int
    gt_country: str
    gt_continent: Optional[str]
    gt_lat: float
    gt_lon: float
    prediction_country: Optional[str]
    prediction_lat: Optional[float]
    prediction_lon: Optional[float]
    inference_id: Optional[str]
    created_at: datetime


@router.post("/rounds", response_model=RoundLogResponse, status_code=201)
def log_round(payload: RoundLogRequest, db: Session = Depends(get_session)) -> RoundLogResponse:
    """Persist a round entry and associated prediction."""
    session = db.get(GameSession, payload.session_id)
    if session is None:
        session = GameSession(
            id=payload.session_id,
            started_at=payload.ground_truth.captured_at or datetime.utcnow(),
            mode=payload.mode,
            player=payload.player,
        )
        db.add(session)

    normalized_country = resolve_country_code(
        payload.ground_truth.country,
        payload.ground_truth.lat,
        payload.ground_truth.lon,
    )
    if normalized_country:
        payload.ground_truth.country = normalized_country
    else:
        payload.ground_truth.country = payload.ground_truth.country or "ZZ"

    round_obj = db.get(Round, payload.round_id)
    stored_round = False
    if round_obj is None:
        round_obj = Round(
            id=payload.round_id,
            session_id=payload.session_id,
            round_index=payload.round_index,
            gt_lat=payload.ground_truth.lat,
            gt_lon=payload.ground_truth.lon,
            gt_country=payload.ground_truth.country,
            gt_continent=payload.ground_truth.continent,
            score=payload.score,
            screenshot_path=payload.screenshot_path,
        )
        db.add(round_obj)
        stored_round = True
    else:
        round_obj.score = payload.score
        round_obj.gt_lat = payload.ground_truth.lat
        round_obj.gt_lon = payload.ground_truth.lon
        round_obj.gt_country = payload.ground_truth.country
        round_obj.gt_continent = payload.ground_truth.continent
        round_obj.round_index = payload.round_index

    prediction = db.get(Prediction, payload.round_id)
    stored_prediction = False
    if prediction is None:
        prediction = Prediction(
            round_id=payload.round_id,
            inference_id=payload.prediction.inference_id,
            model_version=payload.prediction.model_version,
            lat=payload.prediction.lat,
            lon=payload.prediction.lon,
            continent_id=payload.prediction.continent.id,
            continent_confidence=payload.prediction.continent.confidence,
            country_id=payload.prediction.country.id,
            country_confidence=payload.prediction.country.confidence,
            grid_l4=payload.prediction.grid_l4.id,
            grid_l4_confidence=payload.prediction.grid_l4.confidence,
            grid_l6=payload.prediction.grid_l6.id,
            grid_l6_confidence=payload.prediction.grid_l6.confidence,
            confidence_lat=payload.prediction.confidence_lat,
            confidence_lon=payload.prediction.confidence_lon,
            inference_time_ms=payload.prediction.inference_time_ms,
            extra_json=payload.prediction.extra_json,
        )
        db.add(prediction)
        stored_prediction = True
    else:
        prediction.lat = payload.prediction.lat
        prediction.lon = payload.prediction.lon
        prediction.country_id = payload.prediction.country.id
        prediction.country_confidence = payload.prediction.country.confidence
        prediction.continent_id = payload.prediction.continent.id
        prediction.continent_confidence = payload.prediction.continent.confidence
        prediction.grid_l4 = payload.prediction.grid_l4.id
        prediction.grid_l4_confidence = payload.prediction.grid_l4.confidence
        prediction.grid_l6 = payload.prediction.grid_l6.id
        prediction.grid_l6_confidence = payload.prediction.grid_l6.confidence
        prediction.confidence_lat = payload.prediction.confidence_lat
        prediction.confidence_lon = payload.prediction.confidence_lon
        prediction.model_version = payload.prediction.model_version
        prediction.extra_json = payload.prediction.extra_json
    distance_km = None
    is_correct = None
    if payload.prediction.lat is not None and payload.prediction.lon is not None:
        distance_km = haversine_km(
            payload.prediction.lat,
            payload.prediction.lon,
            payload.ground_truth.lat,
            payload.ground_truth.lon,
        )
        is_correct = distance_km <= 200 if distance_km is not None else None
        prediction.distance_km = distance_km
        prediction.is_correct = is_correct

    db.commit()

    final_screenshot_path = payload.screenshot_path
    if payload.screenshot_path:
        country_code = payload.ground_truth.country or (
            country_from_coords(payload.ground_truth.lat, payload.ground_truth.lon)
            if payload.ground_truth.lat is not None and payload.ground_truth.lon is not None
            else None
        )
        country_label = country_code or "unknown"
        new_path = move_image_to_country(payload.screenshot_path, country_label)
        round_obj.screenshot_path = new_path
        final_screenshot_path = new_path
        round_obj.gt_lat = payload.ground_truth.lat
        round_obj.gt_lon = payload.ground_truth.lon
        round_obj.gt_country = country_code
        db.commit()

    try:
        append_dataset_entry(
            sample_type="round",
            session_id=payload.session_id,
            round_id=payload.round_id,
            round_index=payload.round_index,
            screenshot_path=round_obj.screenshot_path or final_screenshot_path,
            ground_truth={
                "lat": payload.ground_truth.lat,
                "lon": payload.ground_truth.lon,
                "country": payload.ground_truth.country,
                "continent": payload.ground_truth.continent,
                "score": payload.score,
            },
            prediction={
                "lat": payload.prediction.lat,
                "lon": payload.prediction.lon,
                "country_id": payload.prediction.country.id,
                "country_confidence": payload.prediction.country.confidence,
                "continent_id": payload.prediction.continent.id,
                "continent_confidence": payload.prediction.continent.confidence,
                "grid_l4": payload.prediction.grid_l4.id,
                "grid_l4_confidence": payload.prediction.grid_l4.confidence,
                "grid_l6": payload.prediction.grid_l6.id,
                "grid_l6_confidence": payload.prediction.grid_l6.confidence,
                "confidence_lat": payload.prediction.confidence_lat,
                "confidence_lon": payload.prediction.confidence_lon,
                "inference_id": payload.prediction.inference_id,
                "model_version": payload.prediction.model_version,
                "extra_json": payload.prediction.extra_json,
            },
            metadata={
                "source": "round_log",
                "distance_km": distance_km,
                "is_correct": is_correct,
            },
        )
    except Exception as dataset_error:  # noqa: BLE001
        logger.warning("Failed to append dataset entry: %s", dataset_error)

    return RoundLogResponse(
        round_id=payload.round_id,
        session_id=payload.session_id,
        stored_prediction=stored_prediction,
        stored_round=stored_round,
        distance_km=distance_km,
        is_correct=is_correct,
        score=payload.score,
    )


@router.get("/rounds", response_model=list[RoundSummary])
def list_rounds(
    session_id: Optional[str] = Query(default=None),
    limit: int = Query(default=25, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_session),
) -> list[RoundSummary]:
    """Return a paginated list of rounds along with prediction metadata."""
    statement = select(Round, Prediction).join(Prediction, Prediction.round_id == Round.id, isouter=True)
    if session_id:
        statement = statement.where(Round.session_id == session_id)
    statement = statement.order_by(Round.created_at.desc()).offset(offset).limit(limit)

    rows = db.exec(statement).all()
    summaries: list[RoundSummary] = []
    for round_obj, prediction in rows:
        summaries.append(
            RoundSummary(
                round_id=round_obj.id,
                session_id=round_obj.session_id,
                round_index=round_obj.round_index,
                score=round_obj.score,
                gt_country=round_obj.gt_country,
                gt_continent=round_obj.gt_continent,
                gt_lat=round_obj.gt_lat,
                gt_lon=round_obj.gt_lon,
                prediction_country=prediction.country_id if prediction else None,
                prediction_lat=prediction.lat if prediction else None,
                prediction_lon=prediction.lon if prediction else None,
                inference_id=prediction.inference_id if prediction else None,
                created_at=round_obj.created_at,
            )
        )
    return summaries


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Approx distance between two lat/lon pairs in kilometers."""
    R = 6371.0
    phi1 = radians(lat1)
    phi2 = radians(lat2)
    dphi = radians(lat2 - lat1)
    dlambda = radians(lon2 - lon1)
    a = sin(dphi / 2) ** 2 + cos(phi1) * cos(phi2) * sin(dlambda / 2) ** 2
    c = 2 * asin(sqrt(a))
    return R * c
