"""
MindSpace Storage — centralized data persistence layer.

Usage:
    from storage import StorageManager

    manager = StorageManager()
    manager.initialize()

    manager.save("notes", {"name": "My Note", "content": "Hello"})
    notes = manager.get_all("notes")
"""

from .storage_manager import StorageManager
from .config import StorageConfig, load_config

__all__ = ["StorageManager", "StorageConfig", "load_config"]
