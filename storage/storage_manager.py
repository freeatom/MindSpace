"""
Central storage manager for MindSpace.

All application components should interact with StorageManager instead of
writing data directly to disk or databases.

Flow:
    Application Save Request
            ↓
    Storage Manager
            ↓
    Check Configuration
            ↓
    Database Configured?
          /      \\
        Yes       No
         ↓         ↓
    Save to DB   Save Locally

If the configured database is unavailable, automatically falls back to local
storage and logs a warning.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Type

from .config import DATA_COLLECTIONS, StorageConfig, load_config
from .backends.base import StorageBackend
from .backends.local_backend import LocalStorageBackend
from .backends.sqlite_backend import SQLiteBackend
from .backends.mongodb_backend import MongoDBBackend
from .backends.mysql_backend import MySQLBackend
from .backends.postgresql_backend import PostgreSQLBackend
from .backends.sqlserver_backend import SQLServerBackend

logger = logging.getLogger("mindspace.storage")

BACKEND_REGISTRY: Dict[str, Type[StorageBackend]] = {
    "local": LocalStorageBackend,
    "sqlite": SQLiteBackend,
    "mongodb": MongoDBBackend,
    "mysql": MySQLBackend,
    "postgresql": PostgreSQLBackend,
    "sqlserver": SQLServerBackend,
}

# Default search fields per collection
SEARCH_FIELDS: Dict[str, List[str]] = {
    "notes": ["name", "title", "content", "tags"],
    "calendar_events": ["title", "description", "location"],
    "chat_history": ["role", "content"],
    "thoughts": ["content", "tags"],
    "search_history": ["query"],
    "documents": ["name", "title", "content"],
    "file_metadata": ["filename", "path", "mime_type"],
}


class StorageManager:
    """
    Central data persistence layer with pluggable backends.

    Usage:
        manager = StorageManager()
        manager.initialize()

        doc = manager.save("notes", {"name": "Meeting", "content": "..."})
        all_notes = manager.get_all("notes")
    """

    def __init__(
        self,
        config: Optional[StorageConfig] = None,
        config_path: Optional[str] = None,
        user_data_path: Optional[str] = None,
    ) -> None:
        self._config = config or load_config(config_path, user_data_path)
        self._backend: Optional[StorageBackend] = None
        self._fallback_backend: Optional[LocalStorageBackend] = None
        self._active_type: str = "local"
        self._initialized = False
        self._using_fallback = False

    @property
    def config(self) -> StorageConfig:
        return self._config

    @property
    def active_backend(self) -> str:
        return self._active_type

    @property
    def is_using_fallback(self) -> bool:
        return self._using_fallback

    def initialize(self) -> bool:
        """
        Select and connect the active storage backend.
        Falls back to local storage when the configured database is unavailable.
        """
        if self._initialized:
            return True

        local_path = self._config.local_path or "~/.mindspace/mindspace-data"
        self._fallback_backend = LocalStorageBackend(local_path)
        self._fallback_backend.connect()

        requested = self._config.storage_type

        if requested == "local":
            self._backend = self._fallback_backend
            self._active_type = "local"
            self._using_fallback = False
            self._initialized = True
            logger.info("Storage manager using local backend at %s", local_path)
            return True

        backend = self._create_backend(requested)
        if backend is None:
            self._warn_and_fallback(requested, "unsupported backend type")
            return True

        if not backend.connect():
            self._warn_and_fallback(requested, "connection failed during connect()")
            return True

        if not backend.validate_connection():
            backend.disconnect()
            self._warn_and_fallback(requested, "connection validation failed")
            return True

        self._backend = backend
        self._active_type = requested
        self._using_fallback = False
        self._initialized = True
        logger.info("Storage manager using %s backend", requested)
        return True

    def _create_backend(self, storage_type: str) -> Optional[StorageBackend]:
        cls = BACKEND_REGISTRY.get(storage_type)
        if not cls:
            return None
        local_path = self._config.local_path or "~/.mindspace/mindspace-data"
        if storage_type == "local":
            return LocalStorageBackend(local_path)
        if storage_type == "sqlite":
            return SQLiteBackend(self._config.database_config, local_path)
        return cls(self._config.database_config)

    def _warn_and_fallback(self, requested: str, reason: str) -> None:
        if self._config.log_warnings:
            logger.warning(
                "Database '%s' unavailable (%s). Automatically switching to local storage.",
                requested,
                reason,
            )
        self._backend = self._fallback_backend
        self._active_type = "local"
        self._using_fallback = True
        self._initialized = True

    def shutdown(self) -> None:
        if self._backend and self._backend is not self._fallback_backend:
            self._backend.disconnect()
        if self._fallback_backend and self._backend is not self._fallback_backend:
            self._fallback_backend.disconnect()
        self._initialized = False

    def validate_connection(self) -> bool:
        """Re-check connectivity; switch to local fallback if the active DB fails."""
        self._ensure_initialized()
        if self._active_type == "local":
            return self._backend.validate_connection() if self._backend else False
        if not self._backend.validate_connection():
            if self._config.fallback_to_local and self._fallback_backend:
                self._warn_and_fallback(self._active_type, "connection lost")
                return self._fallback_backend.validate_connection()
            return False
        return True

    def _ensure_initialized(self) -> None:
        if not self._initialized:
            self.initialize()

    def _ensure_collection(self, collection: str) -> str:
        name = collection.strip().lower().replace("-", "_")
        if name not in DATA_COLLECTIONS:
            logger.debug("Using non-standard collection: %s", name)
        return name

    # ── Public CRUD API ──────────────────────────────────────────────

    def save(self, collection: str, document: Dict[str, Any]) -> Dict[str, Any]:
        """Insert a new document into the given collection."""
        self._ensure_initialized()
        coll = self._ensure_collection(collection)
        return self._backend.insert(coll, document)

    def update(self, collection: str, doc_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update an existing document by _id."""
        self._ensure_initialized()
        coll = self._ensure_collection(collection)
        return self._backend.update(coll, doc_id, updates)

    def delete(self, collection: str, doc_id: str) -> bool:
        """Delete a document by _id."""
        self._ensure_initialized()
        coll = self._ensure_collection(collection)
        return self._backend.delete(coll, doc_id)

    def get(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]:
        """Retrieve a single document by _id."""
        self._ensure_initialized()
        coll = self._ensure_collection(collection)
        return self._backend.find_one(coll, doc_id)

    def get_all(
        self,
        collection: str,
        query: Optional[Dict[str, Any]] = None,
        sort_field: Optional[str] = None,
        sort_desc: bool = True,
    ) -> List[Dict[str, Any]]:
        """Retrieve all documents in a collection, optionally filtered."""
        self._ensure_initialized()
        coll = self._ensure_collection(collection)
        return self._backend.find_all(coll, query, sort_field, sort_desc)

    def search(
        self,
        collection: str,
        query_text: str,
        fields: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Text search within a collection."""
        self._ensure_initialized()
        coll = self._ensure_collection(collection)
        search_fields = fields or SEARCH_FIELDS.get(coll)
        return self._backend.search(coll, query_text, search_fields)

    def upsert(self, collection: str, document: Dict[str, Any]) -> Dict[str, Any]:
        """Insert or update based on presence of _id."""
        doc_id = document.get("_id")
        if doc_id and self.get(collection, doc_id):
            updated = self.update(collection, doc_id, document)
            return updated or self.save(collection, document)
        return self.save(collection, document)

    def count(self, collection: str, query: Optional[Dict[str, Any]] = None) -> int:
        return len(self.get_all(collection, query))

    def status(self) -> Dict[str, Any]:
        """Return current storage status for diagnostics."""
        self._ensure_initialized()
        connected = self._backend.validate_connection() if self._backend else False
        return {
            "initialized": self._initialized,
            "configured_type": self._config.storage_type,
            "active_backend": self._active_type,
            "using_fallback": self._using_fallback,
            "connected": connected,
            "local_path": self._config.local_path,
            "collections": list(DATA_COLLECTIONS),
        }


# Module-level singleton (optional convenience)
_default_manager: Optional[StorageManager] = None


def get_storage_manager(
    config_path: Optional[str] = None,
    user_data_path: Optional[str] = None,
    force_new: bool = False,
) -> StorageManager:
    """Return the shared StorageManager instance, creating it if needed."""
    global _default_manager
    if force_new or _default_manager is None:
        _default_manager = StorageManager(config_path=config_path, user_data_path=user_data_path)
        _default_manager.initialize()
    return _default_manager
