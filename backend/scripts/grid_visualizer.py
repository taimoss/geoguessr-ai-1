"""Generate grid coverage visualizations from the dataset JSONL."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Dict, Optional

import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

from backend.app.services.grid import compute_grid


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Render grid probability heatmap.")
    parser.add_argument(
        "--dataset",
        default=str(Path("backend") / "data" / "datasets" / "round_samples.jsonl"),
        help="Path to the dataset JSONL file.",
    )
    parser.add_argument(
        "--level",
        type=int,
        default=4,
        help="Grid level to visualize (e.g. 4 or 6).",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Optional path to save the plot. Defaults to backend/data/visualizations/grid_heatmap_level{level}.png",
    )
    parser.add_argument(
        "--entry-type",
        default="inference",
        choices=["inference", "round", "all"],
        help="Which sample types to include.",
    )
    return parser.parse_args()


def load_samples(dataset_path: Path, entry_type: str) -> list[dict]:
    samples: list[dict] = []
    if not dataset_path.exists():
        raise FileNotFoundError(f"Dataset not found: {dataset_path}")
    with dataset_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            entry_type_value = entry.get("type", "round")
            if entry_type != "all" and entry_type_value != entry_type:
                continue
            samples.append(entry)
    return samples


def accumulate_grid_scores(samples: list[dict], level: int) -> Dict[str, dict]:
    scores: Dict[str, dict] = {}
    for entry in samples:
        prediction = entry.get("prediction") or {}
        lat = prediction.get("lat")
        lon = prediction.get("lon")
        if lat is None or lon is None:
            continue
        confidence = (
            prediction.get("country_confidence")
            or prediction.get("grid_l4_confidence")
            or prediction.get("grid_l6_confidence")
            or 0.5
        )
        grid_result = compute_grid(lat, lon, level=level)
        if not grid_result:
            continue
        grid_id, bounds = grid_result
        data = scores.setdefault(
            grid_id,
            {
                "weight": 0.0,
                "count": 0,
                "bounds": bounds,
            },
        )
        data["weight"] += float(confidence)
        data["count"] += 1
    return scores


def render_heatmap(
    scores: Dict[str, dict],
    level: int,
    output_path: Optional[Path],
) -> None:
    if not scores:
        raise RuntimeError("No grid samples found to visualize.")

    plt.figure(figsize=(14, 7))
    ax = plt.gca()
    ax.set_facecolor("#101010")
    plt.title(f"Grid Level {level} Coverage Heatmap", color="white")
    ax.set_xlim(-180, 180)
    ax.set_ylim(-90, 90)
    ax.set_xlabel("Longitude", color="white")
    ax.set_ylabel("Latitude", color="white")
    ax.tick_params(colors="white")

    max_weight = max(data["weight"] for data in scores.values())

    for data in scores.values():
        bounds = data["bounds"]
        weight_norm = data["weight"] / max_weight if max_weight else 0
        color = (1, 0, 0, 0.2 + 0.6 * weight_norm)
        rect = Rectangle(
            (bounds["lon_min"], bounds["lat_min"]),
            bounds["lon_max"] - bounds["lon_min"],
            bounds["lat_max"] - bounds["lat_min"],
            linewidth=0.2,
            edgecolor=(1, 0, 0, 0.5),
            facecolor=color,
        )
        ax.add_patch(rect)

    ax.grid(color="#303030", linestyle="--", linewidth=0.3)
    plt.tight_layout()
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        plt.savefig(output_path, dpi=180, facecolor="#101010")
        print(f"Saved heatmap to {output_path}")
    else:
        plt.show()


def main() -> None:
    args = parse_args()
    dataset_path = Path(args.dataset)
    samples = load_samples(dataset_path, args.entry_type)
    scores = accumulate_grid_scores(samples, args.level)
    output = Path(args.output) if args.output else Path("backend/data/visualizations") / f"grid_heatmap_level{args.level}.png"
    render_heatmap(scores, args.level, output)


if __name__ == "__main__":
    main()
