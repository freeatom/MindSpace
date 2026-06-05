"""
Storage configuration loader.

Reads from (in priority order):
  1. Explicit path passed to load_config()
  2. MINDSPACE_STORAGE_CONFIG environment variable
  3. storage_config.py in the user data directory
  4. storage_config.py next to this package
  5. Built-in defaults (local storage)
"""

from __future__ import annotations

import importlib.util
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger("mindspace.storage")

SUPPORTED_STORAGE_TYPES = (
    "local",
    "sqlite",
    "mongodb",
    "mysql",
    "postgresql",
    "sqlserver",
)

# Collections routed through the storage manager
DATA_COLLECTIONS = (
    "notes",
    "calendar_events",
    "chat_history",
    "thoughts",
    "tags",
    "archives",
    "tools",
    "clipboard",
    "workflows",
    "user_preferences",
    "search_history",
    "file_metadata",
    "documents",
)


@dataclass
class StorageConfig:
    storage_type: str = "local"
    local_path: Optional[str] = None
    database_config: Dict[str, Any] = field(default_factory=dict)
    fallback_to_local: bool = True
    log_warnings: bool = True

    def __post_init__(self) -> None:
        self.storage_type = (self.storage_type or "local").lower().strip()
        if self.storage_type not in SUPPORTED_STORAGE_TYPES:
            logger.warning(
                "Unknown STORAGE_TYPE '%s'; falling back to local.",
                self.storage_type,
            )
            self.storage_type = "local"


def _load_python_config_file(path: Path) -> Dict[str, Any]:
    spec = importlib.util.spec_from_file_location("mindspace_storage_config", path)
    if not spec or not spec.loader:
        return {}
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return {
        "STORAGE_TYPE": getattr(module, "STORAGE_TYPE", None),
        "LOCAL_PATH": getattr(module, "LOCAL_PATH", None),
        "DATABASE_CONFIG": getattr(module, "DATABASE_CONFIG", None),
        "FALLBACK_TO_LOCAL": getattr(module, "FALLBACK_TO_LOCAL", None),
        "LOG_WARNINGS": getattr(module, "LOG_WARNINGS", None),
    }


def _config_from_dict(raw: Dict[str, Any], default_local_path: Path) -> StorageConfig:
    db_cfg = raw.get("DATABASE_CONFIG") or raw.get("database_config") or {}
    if not isinstance(db_cfg, dict):
        db_cfg = {}

    local_path = raw.get("LOCAL_PATH") or raw.get("local_path") or str(default_local_path)

    return StorageConfig(
        storage_type=raw.get("STORAGE_TYPE") or raw.get("storage_type") or "local",
        local_path=local_path,
        database_config=db_cfg,
        fallback_to_local=raw.get("FALLBACK_TO_LOCAL", raw.get("fallback_to_local", True)),
        log_warnings=raw.get("LOG_WARNINGS", raw.get("log_warnings", True)),
    )


def load_config(
    config_path: Optional[str] = None,
    user_data_path: Optional[str] = None,
) -> StorageConfig:
    """
    Load storage configuration. Defaults to local storage when nothing is configured.
    """
    package_dir = Path(__file__).resolve().parent
    default_local = Path(user_data_path or os.path.expanduser("~/.mindspace")) / "mindspace-data"

    candidates = []
    if config_path:
        candidates.append(Path(config_path))
    env_path = os.environ.get("MINDSPACE_STORAGE_CONFIG")
    if env_path:
        candidates.append(Path(env_path))
    if user_data_path:
        candidates.append(Path(user_data_path) / "storage_config.py")
    candidates.append(package_dir / "storage_config.py")
    candidates.append(package_dir.parent / "storage_config.py")

    for candidate in candidates:
        if candidate.is_file():
            logger.info("Loading storage config from %s", candidate)
            raw = _load_python_config_file(candidate)
            return _config_from_dict(raw, default_local)

    # Environment variable overrides without a config file
    env_type = os.environ.get("MINDSPACE_STORAGE_TYPE")
    if env_type:
        return StorageConfig(
            storage_type=env_type,
            local_path=str(default_local),
            database_config={
                "host": os.environ.get("MINDSPACE_DB_HOST", ""),
                "port": os.environ.get("MINDSPACE_DB_PORT", ""),
                "database": os.environ.get("MINDSPACE_DB_NAME", ""),
                "username": os.environ.get("MINDSPACE_DB_USER", ""),
                "password": os.environ.get("MINDSPACE_DB_PASSWORD", ""),
            },
        )

    logger.debug("No storage config found; using local storage at %s", default_local)
    return StorageConfig(storage_type="local", local_path=str(default_local))
