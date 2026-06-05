"""
PostgreSQL storage backend (requires psycopg2-binary).
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from .base import StorageBackend, normalize_collection

logger = logging.getLogger("mindspace.storage.postgresql")

SCHEMA = """
CREATE TABLE IF NOT EXISTS mindspace_records (
    id VARCHAR(64) NOT NULL,
    collection VARCHAR(128) NOT NULL,
    data JSONB NOT NULL,
    created_at VARCHAR(32) NOT NULL,
    updated_at VARCHAR(32) NOT NULL,
    PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS idx_mindspace_collection ON mindspace_records(collection);
"""


class PostgreSQLBackend(StorageBackend):
    name = "postgresql"

    def __init__(self, database_config: Dict[str, Any]) -> None:
        self.config = database_config
        self._conn = None

    def connect(self) -> bool:
        try:
            import psycopg2
        except ImportError:
            logger.error("psycopg2 not installed. Run: pip install psycopg2-binary")
            return False

        try:
            self._conn = psycopg2.connect(
                host=self.config.get("host", "localhost"),
                port=int(self.config.get("port", 5432)),
                user=self.config.get("username") or self.config.get("user", "postgres"),
                password=self.config.get("password", ""),
                dbname=self.config.get("database", "mindspace"),
                connect_timeout=5,
            )
            with self._conn.cursor() as cur:
                cur.execute(SCHEMA)
            self._conn.commit()
            return True
        except Exception as exc:
            logger.error("PostgreSQL connect failed: %s", exc)
            return False

    def disconnect(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    def validate_connection(self) -> bool:
        if not self._conn:
            return False
        try:
            with self._conn.cursor() as cur:
                cur.execute("SELECT 1")
            return True
        except Exception:
            return False

    def _row_to_doc(self, row) -> Dict[str, Any]:
        doc = row[2] if isinstance(row[2], dict) else json.loads(row[2])
        doc.setdefault("_id", row[0])
        doc.setdefault("created_at", row[3])
        doc.setdefault("updated_at", row[4])
        return doc

    def insert(self, collection: str, document: Dict[str, Any]) -> Dict[str, Any]:
        doc = self._prepare_insert(document)
        coll = normalize_collection(collection)
        with self._conn.cursor() as cur:
            cur.execute(
                "INSERT INTO mindspace_records (id, collection, data, created_at, updated_at) VALUES (%s, %s, %s, %s, %s)",
                (doc["_id"], coll, json.dumps(doc), doc["created_at"], doc["updated_at"]),
            )
        self._conn.commit()
        return doc

    def update(self, collection: str, doc_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        existing = self.find_one(collection, doc_id)
        if not existing:
            return None
        existing.update(self._prepare_update(updates))
        coll = normalize_collection(collection)
        with self._conn.cursor() as cur:
            cur.execute(
                "UPDATE mindspace_records SET data = %s, updated_at = %s WHERE collection = %s AND id = %s",
                (json.dumps(existing), existing["updated_at"], coll, doc_id),
            )
        self._conn.commit()
        return existing

    def delete(self, collection: str, doc_id: str) -> bool:
        coll = normalize_collection(collection)
        with self._conn.cursor() as cur:
            cur.execute(
                "DELETE FROM mindspace_records WHERE collection = %s AND id = %s",
                (coll, doc_id),
            )
            deleted = cur.rowcount > 0
        self._conn.commit()
        return deleted

    def find_one(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]:
        coll = normalize_collection(collection)
        with self._conn.cursor() as cur:
            cur.execute(
                "SELECT id, collection, data, created_at, updated_at FROM mindspace_records WHERE collection = %s AND id = %s",
                (coll, doc_id),
            )
            row = cur.fetchone()
        return self._row_to_doc(row) if row else None

    def find_all(
        self,
        collection: str,
        query: Optional[Dict[str, Any]] = None,
        sort_field: Optional[str] = None,
        sort_desc: bool = True,
    ) -> List[Dict[str, Any]]:
        coll = normalize_collection(collection)
        with self._conn.cursor() as cur:
            cur.execute(
                "SELECT id, collection, data, created_at, updated_at FROM mindspace_records WHERE collection = %s",
                (coll,),
            )
            docs = [self._row_to_doc(r) for r in cur.fetchall()]
        if query:
            docs = [d for d in docs if all(d.get(k) == v for k, v in query.items())]
        if sort_field:
            docs.sort(key=lambda d: d.get(sort_field) or "", reverse=sort_desc)
        return docs
