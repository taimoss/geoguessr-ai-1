"""Dataset export endpoints."""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select

from ..db.models import Prediction, Round
from ..db.session import engine

router = APIRouter(prefix="/v1", tags=["dataset"])


def _row_iter():
    header = ",".join(
        [
            "round_id",
            "session_id",
            "round_index",
            "gt_lat",
            "gt_lon",
            "gt_country",
            "gt_continent",
            "score",
            "prediction_lat",
            "prediction_lon",
            "prediction_country",
            "prediction_continent",
            "model_version",
            "inference_id",
        ]
    )
    yield header + "\n"

    with Session(engine) as session:
        statement = select(Round, Prediction).join(Prediction, Prediction.round_id == Round.id, isouter=True)
        for round_obj, prediction in session.exec(statement):
            fields = [
                round_obj.id,
                round_obj.session_id,
                str(round_obj.round_index),
                f"{round_obj.gt_lat}",
                f"{round_obj.gt_lon}",
                round_obj.gt_country,
                round_obj.gt_continent or "",
                str(round_obj.score),
                f"{prediction.lat:.6f}" if prediction else "",
                f"{prediction.lon:.6f}" if prediction else "",
                prediction.country_id if prediction else "",
                prediction.continent_id if prediction else "",
                prediction.model_version if prediction else "",
                prediction.inference_id if prediction else "",
            ]
            yield ",".join(fields) + "\n"


@router.get("/dataset/export")
def export_dataset() -> StreamingResponse:
    """Stream a CSV dump of rounds and predictions."""
    generator = _row_iter()
    return StreamingResponse(
        generator,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="geoguessr_dataset.csv"'},
    )
