"""FastAPI entrypoint for the GeoGuessr automation backend."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from .db.session import init_db
from .routers import dataset, inference, rounds, coords, dataset_manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="GeoGuessr Automation Backend",
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(inference.router)
app.include_router(rounds.router)
app.include_router(dataset.router)
app.include_router(coords.router)
app.include_router(dataset_manager.router)


@app.get("/health", tags=["meta"])
async def health():
    return {"status": "ok"}
