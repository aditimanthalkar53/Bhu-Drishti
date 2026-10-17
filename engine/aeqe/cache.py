"""Tile-keyed, model-versioned oracle result cache.

Key = (tile_id, scene_key, oracle name, model version, params hash). Because the
scene key is part of the key, a new satellite acquisition for the same window
naturally produces cache misses for the affected tiles and nothing stale is
reused. Results are shared across queries and users: a follow-up question on
the same tiles/scenes, a tighter precision target, or a different aggregate
over the same oracle output is answered from cache.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class CacheEntry:
    value: float
    detail: dict
    latency_s: float


class ResultCache:
    def __init__(self, path: str | Path = ":memory:"):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL") if self.path != ":memory:" else None
        self._db.execute(
            """CREATE TABLE IF NOT EXISTS oracle_results (
                key TEXT PRIMARY KEY,
                tile_id TEXT NOT NULL,
                scene_key TEXT NOT NULL,
                oracle TEXT NOT NULL,
                model_version TEXT NOT NULL,
                params_hash TEXT NOT NULL,
                value REAL NOT NULL,
                detail TEXT NOT NULL,
                latency_s REAL NOT NULL,
                created_at REAL NOT NULL
            )"""
        )
        self._db.execute("CREATE INDEX IF NOT EXISTS idx_scene ON oracle_results(scene_key)")
        self._db.commit()
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    @staticmethod
    def make_key(tile_id: str, scene_key: str, oracle: str, model_version: str, params: str) -> tuple[str, str]:
        params_hash = hashlib.sha1(params.encode()).hexdigest()[:12]
        raw = f"{tile_id}|{scene_key}|{oracle}|{model_version}|{params_hash}"
        return hashlib.sha1(raw.encode()).hexdigest(), params_hash

    def get(self, key: str) -> Optional[CacheEntry]:
        with self._lock:
            row = self._db.execute("SELECT value, detail, latency_s FROM oracle_results WHERE key=?", (key,)).fetchone()
            if row is None:
                self.misses += 1
                return None
            self.hits += 1
            return CacheEntry(row[0], json.loads(row[1]), row[2])

    def put(self, key: str, *, tile_id: str, scene_key: str, oracle: str, model_version: str, params_hash: str,
            value: float, detail: dict, latency_s: float) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO oracle_results VALUES (?,?,?,?,?,?,?,?,?,?)",
                (key, tile_id, scene_key, oracle, model_version, params_hash, float(value), json.dumps(detail), latency_s, time.time()),
            )
            self._db.commit()

    def invalidate_scene(self, scene_key: str) -> int:
        with self._lock:
            cur = self._db.execute("DELETE FROM oracle_results WHERE scene_key=?", (scene_key,))
            self._db.commit()
            return cur.rowcount

    def clear(self) -> int:
        with self._lock:
            cur = self._db.execute("DELETE FROM oracle_results")
            self._db.commit()
            self.hits = self.misses = 0
            return cur.rowcount

    def stats(self) -> dict:
        with self._lock:
            n, saved = self._db.execute("SELECT COUNT(*), COALESCE(SUM(latency_s),0) FROM oracle_results").fetchone()
            by_oracle = self._db.execute("SELECT oracle, COUNT(*) FROM oracle_results GROUP BY oracle").fetchall()
        total = self.hits + self.misses
        return {
            "entries": n,
            "hits": self.hits,
            "misses": self.misses,
            "hit_rate": round(self.hits / total, 4) if total else 0.0,
            "stored_compute_seconds": round(saved, 2),
            "by_oracle": dict(by_oracle),
            "path": self.path,
        }
