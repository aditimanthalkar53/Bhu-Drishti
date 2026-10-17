"""Small SQLite cache for source responses with per-entry expiry.

Used for things that are cheap to store and expensive or rate-limited to
fetch: FIRMS CSV pages, CMR granule lists, Earth Engine embedding samples,
IMERG area means. Each entry has its own TTL, so near-real-time fire data can
expire in minutes while stable land-cover-derived values live for weeks.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Optional


class TTLCache:
    def __init__(self, path: str | Path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.execute("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, expires REAL, created REAL)")
        self._db.commit()

    @staticmethod
    def key(*parts: Any) -> str:
        return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            row = self._db.execute("SELECT v, expires FROM kv WHERE k=?", (key,)).fetchone()
        if row is None or row[1] < time.time():
            return None
        return json.loads(row[0])

    def get_with_age(self, key: str) -> tuple[Optional[Any], Optional[float]]:
        with self._lock:
            row = self._db.execute("SELECT v, expires, created FROM kv WHERE k=?", (key,)).fetchone()
        if row is None or row[1] < time.time():
            return None, None
        return json.loads(row[0]), time.time() - row[2]

    def put(self, key: str, value: Any, ttl_s: float) -> None:
        now = time.time()
        with self._lock:
            self._db.execute("INSERT OR REPLACE INTO kv VALUES (?,?,?,?)", (key, json.dumps(value, default=str), now + ttl_s, now))
            self._db.commit()

    def purge(self) -> int:
        with self._lock:
            n = self._db.execute("DELETE FROM kv WHERE expires < ?", (time.time(),)).rowcount
            self._db.commit()
        return n
