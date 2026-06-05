"""
SQL Server storage backend (requires pyodbc).
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from .base import StorageBackend, normalize_collection

logger = logging.getLogger("mindspace.storage.sqlserver")

SCHEMA = """
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='mindspace_records' AND xtype='U')
CREATE TABLE mindspace_records (
    id NVARCHAR(64) NOT NULL,
    collection NVARCHAR(128) NOT NULL,
    data NVARCHAR(MAX) NOT NULL,
    created_at NVARCHAR(32) NOT NULL,
    updated_at NVARCHAR(32) NOT NULL,
    PRIMARY KEY (collection, id)
);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='idx_mindspace_collection')
CREATE INDEX idx_mindspace_collection ON mindspace_records(collection);
"""


class SQLServerBackend(StorageBackend):
    name = "sqlserver"

    def __init__(self, database_config: Dict[str, Any]) -> None:
        self.config = database_config
        self._conn = None

    def _connection_string(self) -> str:
        if self.config.get("connection_string"):
            return self.config["connection_string"]
        host = self.config.get("host", "localhost")
        port = self.config.get("port", "1433")
        database = self.config.get("database", "mindspace")
        username = self.config.get("username") or self.config.get("user", "")
        password = self.config.get("password", "")
        driver = self.config.get("driver", "ODBC Driver 17 for SQL Server")
        return (
            f"DRIVER={{{driver}}};SERVER={host},{port};DATABASE={database};"
            f"UID={username};PWD={password};TrustServerCertificate=yes"
        )

    def connect(self) -> bool:
        try:
            import pyodbc
        except ImportError:
            logger.error("pyodbc not installed. Run: pip install pyodbc")
            return False

        try:
            self._conn = pyodbc.connect(self._connection_string(), timeout=5)
            with self._conn.cursor() as cur:
                cur.execute(SCHEMA)
            self._conn.commit()
            return True
        except Exception as exc:
            logger.error("SQL Server connect failed: %s", exc)
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
        doc = json.loads(row.data) if isinstance(row.data, str) else row.data
        doc.setdefault("_id", row.id)
        doc.setdefault("created_at", row.created_at)
        doc.setdefault("updated_at", row.updated_at)
        return doc

    def insert(self, collection: str, document: Dict[str, Any]) -> Dict[str, Any]:
        doc = self._prepare_insert(document)
        coll = normalize_collection(collection)
        with self._conn.cursor() as cur:
            cur.execute(
                "INSERT INTO mindspace_records (id, collection, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
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
                "UPDATE mindspace_records SET data = ?, updated_at = ? WHERE collection = ? AND id = ?",
                (json.dumps(existing), existing["updated_at"], coll, doc_id),
            )
        self._conn.commit()
        return existing

    def delete(self, collection: str, doc_id: str) -> bool:
        coll = normalize_collection(collection)
        with self._conn.cursor() as cur:
            cur.execute(
                "DELETE FROM mindspace_records WHERE collection = ? AND id = ?",
                (coll, doc_id),
            )
            deleted = cur.rowcount > 0
        self._conn.commit()
        return deleted

    def find_one(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]:
        coll = normalize_collection(collection)
        with self._conn.cursor() as cur:
            cur.execute(
                "SELECT id, collection, data, created_at, updated_at FROM mindspace_records WHERE collection = ? AND id = ?",
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
                "SELECT id, collection, data, created_at, updated_at FROM mindspace_records WHERE collection = ?",
                (coll,),
            )
            docs = [self._row_to_doc(r) for r in cur.fetchall()]
        if query:
            docs = [d for d in docs if all(d.get(k) == v for k, v in query.items())]
        if sort_field:
            docs.sort(key=lambda d: d.get(sort_field) or "", reverse=sort_desc)
        return docs
