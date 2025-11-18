"""In-memory store for latest coordinate samples keyed by session/round."""
from __future__ import annotations

from threading import Lock
from typing import Any, Dict, Optional, Tuple

_store: Dict[Tuple[str, str], Dict[str, Any]] = {}
_lock = Lock()


def store_coords(session_id: Optional[str], round_id: Optional[str], data: Dict[str, Any]) -> None:
    if not session_id or not round_id:
        return
    key = (session_id, round_id)
    with _lock:
        _store[key] = data


def get_coords(session_id: Optional[str], round_id: Optional[str]) -> Optional[Dict[str, Any]]:
    if not session_id or not round_id:
        return None
    key = (session_id, round_id)
    with _lock:
        return _store.get(key)


def pop_coords(session_id: Optional[str], round_id: Optional[str]) -> Optional[Dict[str, Any]]:
    if not session_id or not round_id:
        return None
    key = (session_id, round_id)
    with _lock:
        return _store.pop(key, None)
