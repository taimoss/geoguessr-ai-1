"""Convenience launcher that starts the mock model server and FastAPI backend."""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


def run():
    parser = argparse.ArgumentParser(description="Start mock GeoViT model and backend API.")
    parser.add_argument("--backend-port", type=int, default=8000)
    parser.add_argument("--model-port", type=int, default=8080)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument(
        "--use-mock-model",
        action="store_true",
        help="Launch ml.mock_model_server automatically.",
    )
    args = parser.parse_args()

    processes: list[subprocess.Popen] = []

    try:
        if args.use_mock_model:
            model_cmd = [
                sys.executable,
                "-m",
                "ml.mock_model_server",
                "--host",
                args.host,
                "--port",
                str(args.model_port),
            ]
            print(f"[mock-model] {' '.join(model_cmd)}")
            processes.append(subprocess.Popen(model_cmd))
            os.environ["MODEL_ENDPOINT"] = f"http://{args.host}:{args.model_port}/predictions/geovit"
            print(f"[mock-model] MODEL_ENDPOINT set to {os.environ['MODEL_ENDPOINT']}")

        backend_cmd = [
            "uvicorn",
            "backend.app.main:app",
            "--host",
            args.host,
            "--port",
            str(args.backend_port),
        ]
        print(f"[backend] {' '.join(backend_cmd)}")
        processes.append(subprocess.Popen(backend_cmd))
        print("[launcher] Press Ctrl+C to stop services.")

        for proc in processes:
            proc.wait()
    except KeyboardInterrupt:
        print("\n[launcher] Stopping services...")
    finally:
        for proc in processes:
            if proc.poll() is None:
                proc.terminate()
        for proc in processes:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    run()
