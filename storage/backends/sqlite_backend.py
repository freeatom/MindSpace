"""
SQLite storage backend.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

from .base import StorageBackend, normalize_collection

logger = logging.getLogger("mindspace.storage.sqlite")

SCHEMA = """
CREATE TABLE IF NOT EXISTS mindspace_records (
    id TEXT NOT NULL,
    collection TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS idx_collection ON mindspace_records(collection);
"""


class SQLiteBackend(StorageBackend):
    name = "sqlite"

    def __init__(self, database_config: Dict[str, Any], local_path: str) -> None:
        db_file = database_config.get("database") or database_config.get("path")
        if not db_file:
            db_file = str(Path(local_path) / "mindspace.db")
        self.db_path = db_file
        self._conn: Optional[sqlite3.Connection] = None

    def connect(self) -> bool:
        try:
            Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
            self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
            self._conn.row_factory = sqlite3.Row
            self._conn.executescript(SCHEMA)
            self._conn.commit()
            return True
        except sqlite3.Error as exc:
            logger.error("SQLite connect failed: %s", exc)
            return False

    def disconnect(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    def validate_connection(self) -> bool:
        if not self._conn:
            return False
        try:
            self._conn.execute("SELECT 1")
            return True
        except sqlite3.Error:
            return False

    def _row_to_doc(self, row: sqlite3.Row) -> Dict[str, Any]:
        doc = json.loads(row["data"])
        doc.setdefault("_id", row["id"])
        doc.setdefault("created_at", row["created_at"])
        doc.setdefault("updated_at", row["updated_at"])
        return doc

    def insert(self, collection: str, document: Dict[str, Any]) -> Dict[str, Any]:
        doc = self._prepare_insert(document)
        coll = normalize_collection(collection)
        self._conn.execute(
            "INSERT INTO mindspace_records (id, collection, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (doc["_id"], coll, json.dumps(doc), doc["created_at"], doc["updated_at"]),
        )
        self._conn.commit()
        return doc

    def update(self, collection: str, doc_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        coll = normalize_collection(collection)
        row = self._conn.execute(
            "SELECT * FROM mindspace_records WHERE collection = ? AND id = ?",
            (coll, doc_id),
        ).fetchone()
        if not row:
            return None
        doc = self._row_to_doc(row)
        doc.update(self._prepare_update(updates))
        self._conn.execute(
            "UPDATE mindspace_records SET data = ?, updated_at = ? WHERE collection = ? AND id = ?",
            (json.dumps(doc), doc["updated_at"], coll, doc_id),
        )
        self._conn.commit()
        return doc

    def delete(self, collection: str, doc_id: str) -> bool:
        coll = normalize_collection(collection)
        cur = self._conn.execute(
            "DELETE FROM mindspace_records WHERE collection = ? AND id = ?",
            (coll, doc_id),
        )
        self._conn.commit()
        return cur.rowcount > 0

    def find_one(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]:
        coll = normalize_collection(collection)
        row = self._conn.execute(
            "SELECT * FROM mindspace_records WHERE collection = ? AND id = ?",
            (coll, doc_id),
        ).fetchone()
        return self._row_to_doc(row) if row else None

    def find_all(
        self,
        collection: str,
        query: Optional[Dict[str, Any]] = None,
        sort_field: Optional[str] = None,
        sort_desc: bool = True,
    ) -> List[Dict[str, Any]]:
        coll = normalize_collection(collection)
        rows = self._conn.execute(
            "SELECT * FROM mindspace_records WHERE collection = ?",
            (coll,),
        ).fetchall()
        docs = [self._row_to_doc(r) for r in rows]
        if query:
            docs = [d for d in docs if all(d.get(k) == v for k, v in query.items())]
        if sort_field:
            docs.sort(key=lambda d: d.get(sort_field) or "", reverse=sort_desc)
        return docs
