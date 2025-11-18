"""SQLModel data models for sessions, rounds, and predictions."""
from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import uuid4

from sqlalchemy import Column, Text
from sqlmodel import Field, SQLModel


def _uuid() -> str:
    return str(uuid4())


class GameSession(SQLModel, table=True):
    """Represents a full GeoGuessr session (set of rounds)."""

    id: str = Field(default_factory=_uuid, primary_key=True, index=True)
    started_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    mode: Optional[str] = Field(default=None)
    player: Optional[str] = Field(default=None)


class Round(SQLModel, table=True):
    """Single GeoGuessr round with associated ground-truth metadata."""

    id: str = Field(default_factory=_uuid, primary_key=True, index=True)
    session_id: str = Field(foreign_key="gamesession.id", nullable=False, index=True)
    round_index: int = Field(default=0, nullable=False)
    gt_lat: float = Field(nullable=False)
    gt_lon: float = Field(nullable=False)
    gt_country: str = Field(nullable=False, index=True)
    gt_continent: Optional[str] = Field(default=None, index=True)
    score: int = Field(nullable=False, default=0)
    screenshot_path: Optional[str] = Field(default=None)
    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)


class Prediction(SQLModel, table=True):
    """Model prediction for a round."""

    round_id: str = Field(foreign_key="round.id", primary_key=True)
    inference_id: str = Field(default_factory=_uuid, index=True)
    model_version: str = Field(default="geovit-tinyvit-21m-v0")
    lat: float = Field(nullable=False)
    lon: float = Field(nullable=False)
    continent_id: Optional[str] = Field(default=None)
    continent_confidence: Optional[float] = Field(default=None)
    country_id: Optional[str] = Field(default=None)
    country_confidence: Optional[float] = Field(default=None)
    grid_l4: Optional[str] = Field(default=None)
    grid_l4_confidence: Optional[float] = Field(default=None)
    grid_l6: Optional[str] = Field(default=None)
    grid_l6_confidence: Optional[float] = Field(default=None)
    confidence_lat: Optional[float] = Field(default=None)
    confidence_lon: Optional[float] = Field(default=None)
    inference_time_ms: Optional[int] = Field(default=None)
    extra_json: Optional[str] = Field(default=None, sa_column=Column(Text))
    distance_km: Optional[float] = Field(default=None)
    is_correct: Optional[bool] = Field(default=None)
    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
