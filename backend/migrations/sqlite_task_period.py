"""008: nullable Task start date, guarded before any migration writes."""
from sqlalchemy import inspect

from .sqlite_project_tag_colors import migrate_sqlite_project_tag_colors
from .sqlite_timer_schema import _record, _revisions
from .sqlite_v1a import MigrationError

REVISION = '008_task_start_date'


def _verify_008(connection):
    column = next((c for c in inspect(connection).get_columns('tasks') if c['name'] == 'start_date'), None)
    if column is None or not column['nullable'] or column['default'] is not None or str(column['type']) != 'DATE':
        raise MigrationError('008 tasks.start_date must be nullable DATE without a default.')


def _migrate_008(connection):
    if REVISION in _revisions(connection):
        _verify_008(connection)
        return
    columns = {c['name'] for c in inspect(connection).get_columns('tasks')}
    if 'start_date' in columns:
        _verify_008(connection)
        if connection.exec_driver_sql('SELECT 1 FROM tasks LIMIT 1').first():
            raise MigrationError('Unrecorded 008 schema contains Tasks; manual review required.')
    else:
        connection.exec_driver_sql('ALTER TABLE tasks ADD COLUMN start_date DATE NULL')
    _verify_008(connection)
    _record(connection, REVISION)


def migrate_sqlite_task_period(engine, *, allow_pending=False, allow_colors_pending=False, allow_tags_pending=False, allow_metadata_pending=False):
    with engine.connect() as connection:
        if REVISION not in _revisions(connection) and not allow_pending:
            raise MigrationError('Migration 008_task_start_date is pending. Obtain separate approval before starting with APPLY_TASK_PERIOD_MIGRATION=1.')
    migrate_sqlite_project_tag_colors(engine, allow_pending=allow_colors_pending,
        allow_tags_pending=allow_tags_pending, allow_metadata_pending=allow_metadata_pending, after_migration=_migrate_008)
