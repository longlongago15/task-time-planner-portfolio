"""Revision 005, using the existing atomic SQLite migration runner."""
from .sqlite_timer_schema import _columns, _record, _revisions, migrate_sqlite_latest
from .sqlite_v1a import MigrationError

REVISION = '005_task_priority_deadline'


def _migrate_005(connection):
    columns = _columns(connection, 'tasks')
    if REVISION in _revisions(connection):
        if not {'priority', 'deadline'}.issubset(columns):
            raise MigrationError('005 Task fields are missing.')
    else:
        if 'priority' not in columns:
            connection.exec_driver_sql(
                "ALTER TABLE tasks ADD COLUMN priority VARCHAR(6) NULL "
                "CONSTRAINT ck_tasks_priority CHECK (priority IS NULL OR priority IN ('HIGH', 'MEDIUM', 'LOW'))"
            )
        if 'deadline' not in columns:
            connection.exec_driver_sql('ALTER TABLE tasks ADD COLUMN deadline DATE NULL')
        _record(connection, REVISION)
    columns = _columns(connection, 'tasks')
    if any(not columns[name]['nullable'] for name in ('priority', 'deadline')):
        raise MigrationError('005 Task priority and deadline must allow NULL.')


def migrate_sqlite_task_fields(engine, *, allow_pending=True):
    def migrate(connection):
        if not allow_pending and REVISION not in _revisions(connection):
            raise MigrationError(
                'Task metadata migration 005 is pending. Back up the database and obtain approval '
                'before starting with APPLY_TASK_METADATA_MIGRATION=1.'
            )
        _migrate_005(connection)
    migrate_sqlite_latest(engine, after_migration=migrate)
