"""
Local file-based storage backend (default).

Stores each collection as a JSON array in:
  {local_path}/collections/{collection}.json
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from .base import StorageBackend, normalize_collection, new_id, utc_now_iso

logger = logging.getLogger("mindspace.storage.local")


class LocalStorageBackend(StorageBackend):
    name = "local"

    def __init__(self, base_path: str) -> None:
        self.base_path = Path(base_path)
        self.collections_dir = self.base_path / "collections"
        self._lock = threading.RLock()
        self._connected = False

    def connect(self) -> bool:
        try:
            self.collections_dir.mkdir(parents=True, exist_ok=True)
            self._connected = True
            logger.info("Local storage ready at %s", self.collections_dir)
            return True
        except OSError as exc:
            logger.error("Failed to initialize local storage: %s", exc)
            return False

    def disconnect(self) -> None:
        self._connected = False

    def validate_connection(self) -> bool:
        try:
            self.collections_dir.mkdir(parents=True, exist_ok=True)
            test_file = self.collections_dir / ".connectivity_test"
            test_file.write_text("ok", encoding="utf-8")
            test_file.unlink(missing_ok=True)
            return True
        except OSError:
            return False

    def _collection_path(self, collection: str) -> Path:
        return self.collections_dir / f"{normalize_collection(collection)}.json"

    def _read_collection(self, collection: str) -> List[Dict[str, Any]]:
        path = self._collection_path(collection)
        if not path.exists():
            return []
        try:
            with path.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, list) else []
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Corrupt collection %s: %s", collection, exc)
            return []

    def _write_collection(self, collection: str, records: List[Dict[str, Any]]) -> None:
        path = self._collection_path(collection)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(records, fh, indent=2, ensure_ascii=False)
        tmp.replace(path)

    def insert(self, collection: str, document: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            doc = self._prepare_insert(document)
            records = self._read_collection(collection)
            records.append(doc)
            self._write_collection(collection, records)
            return doc

    def update(self, collection: str, doc_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        with self._lock:
            patch = self._prepare_update(updates)
            records = self._read_collection(collection)
            for i, rec in enumerate(records):
                if rec.get("_id") == doc_id:
                    records[i] = {**rec, **patch}
                    self._write_collection(collection, records)
                    return records[i]
            return None

    def delete(self, collection: str, doc_id: str) -> bool:
        with self._lock:
            records = self._read_collection(collection)
            new_records = [r for r in records if r.get("_id") != doc_id]
            if len(new_records) == len(records):
                return False
            self._write_collection(collection, new_records)
            return True

    def find_one(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]:
        for rec in self._read_collection(collection):
            if rec.get("_id") == doc_id:
                return rec
        return None

    def find_all(
        self,
        collection: str,
        query: Optional[Dict[str, Any]] = None,
        sort_field: Optional[str] = None,
        sort_desc: bool = True,
    ) -> List[Dict[str, Any]]:
        records = self._read_collection(collection)
        if query:
            records = [
                r for r in records
                if all(r.get(k) == v for k, v in query.items())
            ]
        if sort_field:
            records.sort(
                key=lambda r: r.get(sort_field) or "",
                reverse=sort_desc,
            )
        return records
