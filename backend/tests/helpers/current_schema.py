"""Explicit approvals for the current schema on conftest-guarded temporary DBs."""

from migrations.sqlite_task_period import migrate_sqlite_task_period


def migrate_current_test_schema(engine):
    migrate_sqlite_task_period(engine, allow_pending=True, allow_colors_pending=True, allow_tags_pending=True, allow_metadata_pending=True)
