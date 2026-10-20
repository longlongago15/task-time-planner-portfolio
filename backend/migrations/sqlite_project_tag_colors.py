"""Add nullable identification colors; a separate explicit 007 approval is required."""
from sqlalchemy import inspect

from .sqlite_task_fields import REVISION as METADATA_REVISION, _migrate_005
from .sqlite_task_tags import REVISION as TAGS_REVISION, _migrate_006
from .sqlite_timer_schema import _record, _revisions, migrate_sqlite_latest
from .sqlite_v1a import MigrationError

REVISION = '007_project_tag_colors'


def _verify_007(connection):
    inspector = inspect(connection)
    for table in ('projects', 'tags'):
        columns = {column['name']: column for column in inspector.get_columns(table)}
        color = columns.get('color')
        if color is None or not color['nullable'] or color['default'] is not None or str(color['type']) != 'VARCHAR(7)':
            raise MigrationError(f'007 {table}.color must be nullable VARCHAR(7) without a default.')


def _migrate_007(connection):
    if REVISION in _revisions(connection):
        _verify_007(connection)
        return
    inspector = inspect(connection)
    existing = [table for table in ('projects', 'tags') if 'color' in {c['name'] for c in inspector.get_columns(table)}]
    if existing:
        # An empty ORM schema may be initialized, never silently adopt user data.
        if len(existing) != 2:
            raise MigrationError('Partial unrecorded 007 schema; manual review required.')
        _verify_007(connection)
        if any(connection.exec_driver_sql(f'SELECT 1 FROM {table} LIMIT 1').first() for table in existing):
            raise MigrationError('Unrecorded 007 schema contains data; manual review required.')
    else:
        for table in ('projects', 'tags'):
            connection.exec_driver_sql(f'ALTER TABLE {table} ADD COLUMN color VARCHAR(7) NULL')
    _verify_007(connection)
    _record(connection, REVISION)


def migrate_sqlite_project_tag_colors(engine, *, allow_pending=False, allow_tags_pending=False, allow_metadata_pending=False, after_migration=None):
    # Check approval before the older runner can acquire a write transaction or migrate.
    with engine.connect() as connection:
        revisions = _revisions(connection)
        for revision, approved, flag in (
            (METADATA_REVISION, allow_metadata_pending, 'APPLY_TASK_METADATA_MIGRATION'),
            (TAGS_REVISION, allow_tags_pending, 'APPLY_TASK_TAGS_MIGRATION'),
            (REVISION, allow_pending, 'APPLY_PROJECT_TAG_COLORS_MIGRATION'),
        ):
            if revision not in revisions and not approved:
                raise MigrationError(f'Migration {revision} is pending. Obtain separate approval before starting with {flag}=1.')

    def migrate(connection):
        _migrate_005(connection)
        _migrate_006(connection)
        _migrate_007(connection)
        if after_migration is not None:
            after_migration(connection)
    migrate_sqlite_latest(engine, after_migration=migrate)
