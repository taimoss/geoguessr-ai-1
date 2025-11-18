"""Database session and initialization helpers for the GeoGuessr automation backend."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Generator

from sqlmodel import Session, SQLModel, create_engine

BACKEND_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = Path(os.getenv("LITESQL_PATH", str(BACKEND_ROOT / "data" / "litesql.db")))
DEFAULT_DB_URL = os.getenv("DATABASE_URL", f"sqlite:///{DEFAULT_DB_PATH}")

engine = create_engine(
    DEFAULT_DB_URL,
    echo=False,
    connect_args={"check_same_thread": False} if DEFAULT_DB_URL.startswith("sqlite") else {},
)


def init_db() -> None:
    """Create database directory and tables if they do not exist."""
    if DEFAULT_DB_URL.startswith("sqlite"):
        DEFAULT_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    SQLModel.metadata.create_all(engine)


def get_session() -> Generator[Session, None, None]:
    """FastAPI dependency that yields a SQLModel session."""
    with Session(engine) as session:
        yield session
