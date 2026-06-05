"""
MindSpace Storage Configuration — copy to storage_config.py and customize.

Search order (first match wins):
  1. Path passed to StorageManager(config_path=...)
  2. MINDSPACE_STORAGE_CONFIG environment variable
  3. {user_data}/storage_config.py
  4. MindSpace/storage/storage_config.py
  5. MindSpace/storage_config.py

If no config file exists, local storage is used automatically.
"""

# ── Storage type ─────────────────────────────────────────────────────
# Options: "local", "sqlite", "mongodb", "mysql", "postgresql", "sqlserver"
STORAGE_TYPE = "local"

# ── Local storage path (always used as fallback) ─────────────────────
LOCAL_PATH = None  # defaults to ~/.mindspace/mindspace-data

# ── External database settings (only when STORAGE_TYPE != "local") ───
DATABASE_CONFIG = {
    "host": "localhost",
    "port": 27017,          # 27017 MongoDB, 3306 MySQL, 5432 PostgreSQL, 1433 SQL Server
    "database": "mindspace",
    "username": "",
    "password": "",
    # Optional overrides:
    # "uri": "mongodb://user:pass@host:27017/mindspace",
    # "path": "C:/path/to/mindspace.db",          # sqlite file path
    # "driver": "ODBC Driver 17 for SQL Server",  # sqlserver
    # "connection_string": "DRIVER={...};SERVER=...",
}

# ── Behaviour ────────────────────────────────────────────────────────
FALLBACK_TO_LOCAL = True   # switch to local storage if DB is unavailable
LOG_WARNINGS = True        # log warnings when falling back
