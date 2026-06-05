"""
Abstract storage backend interface.
"""

from __future__ import annotations

import uuid
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return uuid.uuid4().hex


def normalize_collection(name: str) -> str:
    return name.strip().lower().replace("-", "_")


class StorageBackend(ABC):
    """Pluggable storage backend — all backends implement this interface."""

    name: str = "base"

    @abstractmethod
    def connect(self) -> bool:
        """Establish connection. Return True on success."""

    @abstractmethod
    def disconnect(self) -> None:
        """Close connection and release resources."""

    @abstractmethod
    def validate_connection(self) -> bool:
        """Verify connectivity and credentials."""

    @abstractmethod
    def insert(self, collection: str, document: Dict[str, Any]) -> Dict[str, Any]:
        pass

    @abstractmethod
    def update(self, collection: str, doc_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        pass

    @abstractmethod
    def delete(self, collection: str, doc_id: str) -> bool:
        pass

    @abstractmethod
    def find_one(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]:
        pass

    @abstractmethod
    def find_all(
        self,
        collection: str,
        query: Optional[Dict[str, Any]] = None,
        sort_field: Optional[str] = None,
        sort_desc: bool = True,
    ) -> List[Dict[str, Any]]:
        pass

    def search(
        self,
        collection: str,
        query_text: str,
        fields: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Default text search — backends may override for efficiency."""
        if not query_text or not query_text.strip():
            return self.find_all(collection)
        needle = query_text.strip().lower()
        fields = fields or []
        results = []
        for doc in self.find_all(collection):
            haystack = " ".join(
                str(doc.get(f, "")) for f in fields
            ) if fields else str(doc)
            if needle in haystack.lower():
                results.append(doc)
        return results

    def _prepare_insert(self, document: Dict[str, Any]) -> Dict[str, Any]:
        doc = dict(document)
        now = utc_now_iso()
        doc.setdefault("_id", new_id())
        doc.setdefault("created_at", now)
        doc.setdefault("updated_at", now)
        return doc

    def _prepare_update(self, updates: Dict[str, Any]) -> Dict[str, Any]:
        patch = dict(updates)
        patch["updated_at"] = utc_now_iso()
        patch.pop("_id", None)
        patch.pop("created_at", None)
        return patch
