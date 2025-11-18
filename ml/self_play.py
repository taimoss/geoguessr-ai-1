"""
Self-play harness that reuses stored screenshots to query the backend inference API and
evaluate predictions against folder-derived ground truth.

Usage:
    python -m ml.self_play --backend http://localhost:8000 --limit 100
"""
from __future__ import annotations

import argparse
import base64
import json
import random
from pathlib import Path
from typing import List, Tuple

import httpx

COUNTRY_CONFIG_PATH = Path("ml/configs/countries_geoguessr.json")
IMAGE_ROOT = Path("data/images")


def load_countries() -> dict[str, str]:
    with open(COUNTRY_CONFIG_PATH, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return {entry["code"]: entry["name"] for entry in data}


def list_images(limit: int | None = None) -> List[Path]:
    if not IMAGE_ROOT.exists():
        return []
    files = sorted(IMAGE_ROOT.glob("*/*.png"))
    if limit:
        return random.sample(files, min(limit, len(files)))
    return files


def encode_image(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("utf-8")


def parse_ground_truth(path: Path) -> Tuple[str, str]:
    country_name = path.parent.name
    round_name = path.stem
    return country_name, round_name


async def run_self_play(backend_url: str, limit: int | None = None) -> None:
    countries = load_countries()
    candidates = list_images(limit)
    if not candidates:
        print("Keine gespeicherten Bilder gefunden. Spiele erst einige Runden, um Daten zu erzeugen.")
        return

    stats = {
        "total": 0,
        "country_correct": 0,
        "samples": [],
    }

    async with httpx.AsyncClient(timeout=30) as client:
        for image_path in candidates:
            country_label, round_name = parse_ground_truth(image_path)
            base64_image = encode_image(image_path)
            round_id = image_path.stem

            response = await client.post(
                f"{backend_url.rstrip('/')}/v1/inference",
                json={
                    "image_base64": base64_image,
                    "session_id": f"selfplay-{country_label}",
                    "round_id": round_id,
                    "metadata": {"source": "self_play"},
                },
            )
            response.raise_for_status()
            payload = response.json()

            predicted_country = payload.get("country", {}).get("id") or payload.get("country", {}).get("name")
            is_correct = predicted_country == country_label
            stats["total"] += 1
            if is_correct:
                stats["country_correct"] += 1

            stats["samples"].append(
                {
                    "round_id": round_id,
                    "session": country_label,
                    "ground_truth_country": country_label,
                    "predicted_country": predicted_country,
                    "country_correct": is_correct,
                    "screenshot_path": payload.get("screenshot_path"),
                }
            )

    accuracy = (stats["country_correct"] / stats["total"]) * 100 if stats["total"] else 0
    print(f"Self-Play abgeschlossen ({stats['total']} Beispiele).")
    print(f"Country Accuracy: {accuracy:.2f}% ({stats['country_correct']}/{stats['total']})")

    output_path = Path("data") / "self_play_metrics.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as fh:
        json.dump(stats, fh, indent=2)
    print(f"Details gespeichert in {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="GeoGuessr GeoViT self-play harness.")
    parser.add_argument("--backend", default="http://localhost:8000", help="Base URL des FastAPI-Backends.")
    parser.add_argument("--limit", type=int, default=100, help="Maximale Anzahl an Bildern für den Durchlauf.")
    args = parser.parse_args()

    import asyncio

    asyncio.run(run_self_play(args.backend, limit=args.limit))


if __name__ == "__main__":
    main()
