"""Dataset manager endpoints for image overview and cleanup."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

router = APIRouter(prefix="/v1/dataset-manager", tags=["dataset-manager"])

DATA_DIR = Path("data/images")


class ImageInfo(BaseModel):
    path: str
    filename: str
    country: str
    size_kb: float
    is_black: bool
    is_duplicate: bool
    hash: str


class CountryStats(BaseModel):
    country: str
    count: int
    size_mb: float


class DatasetStats(BaseModel):
    total_images: int
    total_size_mb: float
    countries: list[CountryStats]
    black_images: int
    duplicate_images: int


class DeleteRequest(BaseModel):
    paths: list[str]


class DeleteResponse(BaseModel):
    deleted: int
    errors: list[str]


def calculate_image_hash(filepath: Path) -> str:
    """Calculate MD5 hash of image file."""
    try:
        with open(filepath, "rb") as f:
            # Read first 50KB for faster hashing
            data = f.read(50000)
            return hashlib.md5(data).hexdigest()
    except Exception:
        return ""


def is_black_image(filepath: Path) -> bool:
    """Check if image is mostly black (invalid)."""
    try:
        with open(filepath, "rb") as f:
            # Skip JPEG header and read sample
            f.seek(100)
            data = f.read(5000)
            if len(data) < 100:
                return True

            # Count low bytes (dark pixels)
            low_count = sum(1 for b in data if b < 30)
            ratio = low_count / len(data)

            return ratio > 0.7
    except Exception:
        return False


def scan_images() -> tuple[list[ImageInfo], dict[str, list[str]]]:
    """Scan all images and detect issues."""
    images = []
    hash_map: dict[str, list[str]] = {}  # hash -> list of paths

    if not DATA_DIR.exists():
        return images, hash_map

    for country_dir in DATA_DIR.iterdir():
        if not country_dir.is_dir():
            continue

        country = country_dir.name

        for img_file in country_dir.glob("*.jpg"):
            try:
                size_kb = img_file.stat().st_size / 1024
                img_hash = calculate_image_hash(img_file)
                is_black = is_black_image(img_file)

                # Track duplicates by hash
                if img_hash:
                    if img_hash not in hash_map:
                        hash_map[img_hash] = []
                    hash_map[img_hash].append(str(img_file))

                images.append(ImageInfo(
                    path=str(img_file),
                    filename=img_file.name,
                    country=country,
                    size_kb=round(size_kb, 2),
                    is_black=is_black,
                    is_duplicate=False,  # Will be updated later
                    hash=img_hash
                ))
            except Exception as e:
                print(f"Error scanning {img_file}: {e}")

    # Mark duplicates (all but first occurrence)
    for img in images:
        if img.hash and len(hash_map.get(img.hash, [])) > 1:
            paths = hash_map[img.hash]
            if img.path != paths[0]:  # Keep first, mark rest as duplicates
                img.is_duplicate = True

    return images, hash_map


@router.get("/stats", response_model=DatasetStats)
def get_dataset_stats():
    """Get overall dataset statistics."""
    images, hash_map = scan_images()

    # Count per country
    country_counts: dict[str, dict] = {}
    for img in images:
        if img.country not in country_counts:
            country_counts[img.country] = {"count": 0, "size": 0}
        country_counts[img.country]["count"] += 1
        country_counts[img.country]["size"] += img.size_kb

    countries = [
        CountryStats(
            country=c,
            count=data["count"],
            size_mb=round(data["size"] / 1024, 2)
        )
        for c, data in sorted(country_counts.items(), key=lambda x: x[1]["count"], reverse=True)
    ]

    # Count issues
    black_count = sum(1 for img in images if img.is_black)
    duplicate_count = sum(1 for img in images if img.is_duplicate)
    total_size = sum(img.size_kb for img in images) / 1024

    return DatasetStats(
        total_images=len(images),
        total_size_mb=round(total_size, 2),
        countries=countries,
        black_images=black_count,
        duplicate_images=duplicate_count
    )


@router.get("/images", response_model=list[ImageInfo])
def list_images(
    country: Optional[str] = Query(None, description="Filter by country"),
    only_black: bool = Query(False, description="Show only black images"),
    only_duplicates: bool = Query(False, description="Show only duplicates"),
    limit: int = Query(100, description="Max images to return"),
    offset: int = Query(0, description="Offset for pagination")
):
    """List images with optional filters."""
    images, _ = scan_images()

    # Apply filters
    if country:
        images = [img for img in images if img.country == country]
    if only_black:
        images = [img for img in images if img.is_black]
    if only_duplicates:
        images = [img for img in images if img.is_duplicate]

    # Sort by country, then filename
    images.sort(key=lambda x: (x.country, x.filename))

    return images[offset:offset + limit]


@router.post("/delete", response_model=DeleteResponse)
def delete_images(request: DeleteRequest):
    """Delete selected images."""
    deleted = 0
    errors = []

    for path in request.paths:
        try:
            filepath = Path(path)
            if filepath.exists() and filepath.is_file():
                # Safety check - must be under data/images
                if "data/images" in str(filepath):
                    filepath.unlink()
                    deleted += 1
                else:
                    errors.append(f"Invalid path: {path}")
            else:
                errors.append(f"File not found: {path}")
        except Exception as e:
            errors.append(f"Error deleting {path}: {str(e)}")

    return DeleteResponse(deleted=deleted, errors=errors)


@router.get("/image/{country}/{filename}")
def get_image(country: str, filename: str):
    """Serve an image file for preview."""
    filepath = DATA_DIR / country / filename
    if not filepath.exists():
        return {"error": "Image not found"}
    return FileResponse(filepath, media_type="image/jpeg")


@router.get("/", response_class=HTMLResponse)
def dataset_manager_ui():
    """Serve the dataset manager UI."""
    html = """
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GeoGuessr Dataset Manager</title>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 20px;
            background: #0a0a0a;
            color: #e0e0e0;
        }
        h1 { color: #4ade80; margin-bottom: 20px; }
        h2 { color: #60a5fa; margin: 20px 0 10px; }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        .stat-card {
            background: #1a1a1a;
            padding: 15px;
            border-radius: 8px;
            border: 1px solid #333;
        }
        .stat-card .label { color: #888; font-size: 12px; }
        .stat-card .value { font-size: 24px; font-weight: bold; color: #4ade80; }
        .stat-card.warning .value { color: #fbbf24; }
        .stat-card.danger .value { color: #f87171; }

        .controls {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }
        select, button {
            padding: 8px 16px;
            border-radius: 6px;
            border: 1px solid #333;
            background: #1a1a1a;
            color: #e0e0e0;
            cursor: pointer;
        }
        button:hover { background: #2a2a2a; }
        button.danger { background: #7f1d1d; border-color: #991b1b; }
        button.danger:hover { background: #991b1b; }
        button.primary { background: #1d4ed8; border-color: #2563eb; }
        button.primary:hover { background: #2563eb; }

        .country-list {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
            gap: 8px;
            margin-bottom: 20px;
            max-height: 200px;
            overflow-y: auto;
            padding: 10px;
            background: #1a1a1a;
            border-radius: 8px;
        }
        .country-item {
            display: flex;
            justify-content: space-between;
            padding: 5px 8px;
            background: #2a2a2a;
            border-radius: 4px;
            font-size: 12px;
        }
        .country-item .name { font-weight: bold; }
        .country-item .count { color: #4ade80; }

        .image-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 15px;
        }
        .image-card {
            background: #1a1a1a;
            border-radius: 8px;
            overflow: hidden;
            border: 2px solid #333;
            cursor: pointer;
            transition: all 0.2s;
        }
        .image-card:hover { border-color: #4ade80; }
        .image-card.selected { border-color: #f87171; background: #2a1a1a; }
        .image-card.black { border-color: #fbbf24; }
        .image-card.duplicate { border-color: #a78bfa; }
        .image-card img {
            width: 100%;
            height: 150px;
            object-fit: cover;
        }
        .image-card .info {
            padding: 8px;
            font-size: 11px;
        }
        .image-card .info .filename {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-weight: bold;
        }
        .image-card .info .meta {
            color: #888;
            display: flex;
            justify-content: space-between;
        }
        .image-card .badges {
            display: flex;
            gap: 4px;
            margin-top: 4px;
        }
        .badge {
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 9px;
            font-weight: bold;
        }
        .badge.black { background: #fbbf24; color: #000; }
        .badge.duplicate { background: #a78bfa; color: #000; }

        .loading {
            text-align: center;
            padding: 40px;
            color: #888;
        }

        .pagination {
            display: flex;
            justify-content: center;
            gap: 10px;
            margin-top: 20px;
        }

        #status {
            position: fixed;
            bottom: 20px;
            right: 20px;
            padding: 10px 20px;
            background: #1d4ed8;
            border-radius: 6px;
            display: none;
        }
    </style>
</head>
<body>
    <h1>GeoGuessr Dataset Manager</h1>

    <div class="stats-grid" id="stats">
        <div class="loading">Lade Statistiken...</div>
    </div>

    <h2>Länder-Übersicht</h2>
    <div class="country-list" id="countries">
        <div class="loading">Lade...</div>
    </div>

    <h2>Bilder</h2>
    <div class="controls">
        <select id="countryFilter">
            <option value="">Alle Länder</option>
        </select>
        <button onclick="filterBlack()" id="btnBlack">Nur Schwarze</button>
        <button onclick="filterDuplicates()" id="btnDuplicates">Nur Duplikate</button>
        <button onclick="loadImages()" class="primary">Alle anzeigen</button>
        <button onclick="deleteSelected()" class="danger" id="btnDelete" disabled>
            Ausgewählte löschen (0)
        </button>
    </div>

    <div class="image-grid" id="images">
        <div class="loading">Lade Bilder...</div>
    </div>

    <div class="pagination">
        <button onclick="prevPage()">← Zurück</button>
        <span id="pageInfo">Seite 1</span>
        <button onclick="nextPage()">Weiter →</button>
    </div>

    <div id="status"></div>

    <script>
        let allImages = [];
        let selectedPaths = new Set();
        let currentPage = 0;
        const pageSize = 50;
        let currentFilter = { country: '', black: false, duplicates: false };

        async function loadStats() {
            try {
                const res = await fetch('/v1/dataset-manager/stats');
                const stats = await res.json();

                document.getElementById('stats').innerHTML = `
                    <div class="stat-card">
                        <div class="label">Gesamt Bilder</div>
                        <div class="value">${stats.total_images}</div>
                    </div>
                    <div class="stat-card">
                        <div class="label">Gesamt Größe</div>
                        <div class="value">${stats.total_size_mb} MB</div>
                    </div>
                    <div class="stat-card">
                        <div class="label">Länder</div>
                        <div class="value">${stats.countries.length}</div>
                    </div>
                    <div class="stat-card warning">
                        <div class="label">Schwarze Bilder</div>
                        <div class="value">${stats.black_images}</div>
                    </div>
                    <div class="stat-card danger">
                        <div class="label">Duplikate</div>
                        <div class="value">${stats.duplicate_images}</div>
                    </div>
                `;

                // Country list
                const countrySelect = document.getElementById('countryFilter');
                const countryList = document.getElementById('countries');

                countryList.innerHTML = stats.countries.map(c => `
                    <div class="country-item">
                        <span class="name">${c.country}</span>
                        <span class="count">${c.count}</span>
                    </div>
                `).join('');

                stats.countries.forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c.country;
                    opt.textContent = `${c.country} (${c.count})`;
                    countrySelect.appendChild(opt);
                });

            } catch (err) {
                console.error('Error loading stats:', err);
            }
        }

        async function loadImages() {
            currentFilter = { country: '', black: false, duplicates: false };
            document.getElementById('btnBlack').style.background = '';
            document.getElementById('btnDuplicates').style.background = '';
            await fetchImages();
        }

        async function filterBlack() {
            currentFilter.black = !currentFilter.black;
            currentFilter.duplicates = false;
            document.getElementById('btnBlack').style.background = currentFilter.black ? '#854d0e' : '';
            document.getElementById('btnDuplicates').style.background = '';
            currentPage = 0;
            await fetchImages();
        }

        async function filterDuplicates() {
            currentFilter.duplicates = !currentFilter.duplicates;
            currentFilter.black = false;
            document.getElementById('btnDuplicates').style.background = currentFilter.duplicates ? '#5b21b6' : '';
            document.getElementById('btnBlack').style.background = '';
            currentPage = 0;
            await fetchImages();
        }

        async function fetchImages() {
            const country = document.getElementById('countryFilter').value;
            currentFilter.country = country;

            let url = `/v1/dataset-manager/images?limit=${pageSize}&offset=${currentPage * pageSize}`;
            if (country) url += `&country=${country}`;
            if (currentFilter.black) url += `&only_black=true`;
            if (currentFilter.duplicates) url += `&only_duplicates=true`;

            try {
                const res = await fetch(url);
                allImages = await res.json();
                renderImages();
            } catch (err) {
                console.error('Error loading images:', err);
            }
        }

        function renderImages() {
            const container = document.getElementById('images');

            if (allImages.length === 0) {
                container.innerHTML = '<div class="loading">Keine Bilder gefunden</div>';
                return;
            }

            container.innerHTML = allImages.map(img => {
                const isSelected = selectedPaths.has(img.path);
                let classes = 'image-card';
                if (isSelected) classes += ' selected';
                if (img.is_black) classes += ' black';
                if (img.is_duplicate) classes += ' duplicate';

                let badges = '';
                if (img.is_black) badges += '<span class="badge black">SCHWARZ</span>';
                if (img.is_duplicate) badges += '<span class="badge duplicate">DUPLIKAT</span>';

                return `
                    <div class="${classes}" onclick="toggleSelect('${img.path}')">
                        <img src="/v1/dataset-manager/image/${img.country}/${img.filename}"
                             loading="lazy"
                             onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>❌</text></svg>'">
                        <div class="info">
                            <div class="filename" title="${img.filename}">${img.filename}</div>
                            <div class="meta">
                                <span>${img.country}</span>
                                <span>${img.size_kb} KB</span>
                            </div>
                            <div class="badges">${badges}</div>
                        </div>
                    </div>
                `;
            }).join('');

            document.getElementById('pageInfo').textContent = `Seite ${currentPage + 1}`;
        }

        function toggleSelect(path) {
            if (selectedPaths.has(path)) {
                selectedPaths.delete(path);
            } else {
                selectedPaths.add(path);
            }
            renderImages();
            updateDeleteButton();
        }

        function updateDeleteButton() {
            const btn = document.getElementById('btnDelete');
            btn.textContent = `Ausgewählte löschen (${selectedPaths.size})`;
            btn.disabled = selectedPaths.size === 0;
        }

        async function deleteSelected() {
            if (selectedPaths.size === 0) return;

            if (!confirm(`${selectedPaths.size} Bilder wirklich löschen?`)) return;

            try {
                const res = await fetch('/v1/dataset-manager/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ paths: Array.from(selectedPaths) })
                });
                const result = await res.json();

                showStatus(`${result.deleted} Bilder gelöscht`);
                selectedPaths.clear();
                updateDeleteButton();

                // Reload
                await loadStats();
                await fetchImages();
            } catch (err) {
                console.error('Error deleting:', err);
                showStatus('Fehler beim Löschen');
            }
        }

        function prevPage() {
            if (currentPage > 0) {
                currentPage--;
                fetchImages();
            }
        }

        function nextPage() {
            if (allImages.length === pageSize) {
                currentPage++;
                fetchImages();
            }
        }

        function showStatus(msg) {
            const el = document.getElementById('status');
            el.textContent = msg;
            el.style.display = 'block';
            setTimeout(() => el.style.display = 'none', 3000);
        }

        // Event listeners
        document.getElementById('countryFilter').addEventListener('change', () => {
            currentPage = 0;
            fetchImages();
        });

        // Init
        loadStats();
        fetchImages();
    </script>
</body>
</html>
"""
    return html
