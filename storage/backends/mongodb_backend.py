"""
MongoDB storage backend (requires pymongo).
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from .base import StorageBackend, normalize_collection

logger = logging.getLogger("mindspace.storage.mongodb")


class MongoDBBackend(StorageBackend):
    name = "mongodb"

    def __init__(self, database_config: Dict[str, Any]) -> None:
        self.config = database_config
        self._client = None
        self._db = None

    def connect(self) -> bool:
        try:
            import pymongo  # noqa: F401
            from pymongo import MongoClient
        except ImportError:
            logger.error("pymongo not installed. Run: pip install pymongo")
            return False

        host = self.config.get("host", "localhost")
        port = int(self.config.get("port", 27017))
        username = self.config.get("username") or self.config.get("user")
        password = self.config.get("password") or ""
        database = self.config.get("database", "mindspace")
        uri = self.config.get("uri")
        if not uri:
            if username and password:
                uri = f"mongodb://{username}:{password}@{host}:{port}/{database}"
            else:
                uri = f"mongodb://{host}:{port}/{database}"

        try:
            self._client = MongoClient(uri, serverSelectionTimeoutMS=5000)
            self._client.admin.command("ping")
            self._db = self._client[database]
            return True
        except Exception as exc:
            logger.error("MongoDB connect failed: %s", exc)
            return False

    def disconnect(self) -> None:
        if self._client:
            self._client.close()
            self._client = None
            self._db = None

    def validate_connection(self) -> bool:
        if not self._client:
            return False
        try:
            self._client.admin.command("ping")
            return True
        except Exception:
            return False

    def _col(self, collection: str):
        return self._db[normalize_collection(collection)]

    def insert(self, collection: str, document: Dict[str, Any]) -> Dict[str, Any]:
        doc = self._prepare_insert(document)
        self._col(collection).insert_one(doc)
        return doc

    def update(self, collection: str, doc_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        patch = self._prepare_update(updates)
        result = self._col(collection).find_one_and_update(
            {"_id": doc_id},
            {"$set": patch},
            return_document=True,
        )
        return result

    def delete(self, collection: str, doc_id: str) -> bool:
        result = self._col(collection).delete_one({"_id": doc_id})
        return result.deleted_count > 0

    def find_one(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]:
        return self._col(collection).find_one({"_id": doc_id})

    def find_all(
        self,
        collection: str,
        query: Optional[Dict[str, Any]] = None,
        sort_field: Optional[str] = None,
        sort_desc: bool = True,
    ) -> List[Dict[str, Any]]:
        cursor = self._col(collection).find(query or {})
        if sort_field:
            cursor = cursor.sort(sort_field, -1 if sort_desc else 1)
        return list(cursor)
