"""
CLI helper for validating storage configuration and connectivity.

Usage:
    python -m storage.cli
    python -m storage.cli --config path/to/storage_config.py
    python -m storage.cli --test-save notes
"""

from __future__ import annotations

import argparse
import json
import sys

from .config import load_config
from .storage_manager import StorageManager


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="MindSpace Storage Manager CLI")
    parser.add_argument("--config", help="Path to storage_config.py")
    parser.add_argument("--user-data", help="User data directory override")
    parser.add_argument(
        "--test-save",
        metavar="COLLECTION",
        help="Insert a test document into the given collection",
    )
    args = parser.parse_args(argv)

    config = load_config(args.config, args.user_data)
    manager = StorageManager(config=config)
    manager.initialize()

    status = manager.status()
    print(json.dumps(status, indent=2))

    if not status["connected"]:
        print("\nConnection validation FAILED.", file=sys.stderr)
        return 1

    if args.test_save:
        doc = manager.save(args.test_save, {
            "name": "Storage CLI test",
            "content": "Created by storage.cli",
            "source": "cli",
        })
        print(f"\nTest document saved: {doc['_id']}")
        found = manager.get(args.test_save, doc["_id"])
        print(f"Read back: {json.dumps(found, indent=2)}")

    manager.shutdown()
    print("\nStorage configuration OK.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
