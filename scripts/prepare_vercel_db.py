"""Initialize the Vercel workspace database, optionally restoring a SQLite backup."""
from __future__ import annotations

import argparse
from contextlib import closing
import os
from pathlib import Path
import sqlite3

from app.auth import (
    WorkspaceUnavailable, _QUOTA_SCHEMA, _WORKSPACE_SCHEMA, _WORKSPACE_TABLES,
    _remote_database,
)


def prepare(snapshot: Path | None = None) -> None:
    url = os.environ.get("GITCITY_TURSO_DATABASE_URL", "").strip()
    token = os.environ.get("GITCITY_TURSO_AUTH_TOKEN", "").strip()
    with _remote_database(url, token) as destination:
        destination.executescript(_WORKSPACE_SCHEMA + _QUOTA_SCHEMA)
    if snapshot is None:
        return

    with (closing(sqlite3.connect(snapshot.resolve().as_uri() + "?mode=ro", uri=True)) as source,
          _remote_database(url, token, write=True) as destination):
        source.execute("BEGIN")
        if any(destination.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone()
               for table in _WORKSPACE_TABLES):
            raise ValueError("Restore requires an empty destination database.")
        present = {row[0] for row in source.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
        if not set(_WORKSPACE_TABLES[:4]) <= present:
            raise ValueError("Backup is missing GitCity workspace tables.")
        for table in _WORKSPACE_TABLES:
            if table not in present:
                continue
            rows = source.execute(f"SELECT * FROM {table}")
            placeholders = ",".join("?" for _ in rows.description)
            while batch := rows.fetchmany(100):
                destination.executemany(f"INSERT INTO {table} VALUES ({placeholders})", batch)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path, nargs="?", help="Private SQLite backup to restore")
    try:
        prepare(parser.parse_args().snapshot)
    except (WorkspaceUnavailable, ValueError, sqlite3.Error) as error:
        parser.exit(1, f"Database preparation failed: {error}\n")
    print("GitCity workspace database ready.")
