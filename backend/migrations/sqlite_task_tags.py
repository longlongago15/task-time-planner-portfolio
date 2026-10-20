"""Additive revision 006, sharing the existing atomic SQLite runner."""

from sqlalchemy import inspect

from .sqlite_task_fields import REVISION as METADATA_REVISION, _migrate_005
from .sqlite_timer_schema import _record, _revisions, migrate_sqlite_latest
from .sqlite_v1a import MigrationError

REVISION = '006_task_tags'


def _verify_006(connection):
    inspector = inspect(connection)
    if not {'tags', 'task_tags'}.issubset(inspector.get_table_names()):
        raise MigrationError('006 Tag tables are missing.')
    tags = {column['name']: column for column in inspector.get_columns('tags')}
    links = {column['name']: column for column in inspector.get_columns('task_tags')}
    if not {'id', 'name', 'created_at', 'updated_at'}.issubset(tags) or set(tags) - {'id', 'name', 'created_at', 'updated_at', 'color'} or set(links) != {'task_id', 'tag_id'}:
        raise MigrationError('006 Tag columns do not match the fixed schema.')
    if 'color' in tags and not tags['color']['nullable']:
        raise MigrationError('007 Tag color must allow NULL.')
    if any(tags[name]['nullable'] for name in ('name', 'created_at', 'updated_at')) or any(column['nullable'] for column in links.values()):
        raise MigrationError('006 Tag fields must be NOT NULL.')
    if inspector.get_pk_constraint('tags')['constrained_columns'] != ['id']:
        raise MigrationError('006 Tag primary key is invalid.')
    if inspector.get_pk_constraint('task_tags')['constrained_columns'] != ['task_id', 'tag_id']:
        raise MigrationError('006 TaskTag composite primary key is invalid.')
    if not any(item['column_names'] == ['name'] for item in inspector.get_unique_constraints('tags')):
        raise MigrationError('006 Tag name must be unique.')
    tag_sql = connection.exec_driver_sql("SELECT sql FROM sqlite_master WHERE type='table' AND name='tags'").scalar_one()
    length_check = 'CONSTRAINTck_tags_name_lengthCHECK(length(name)BETWEEN1AND255)'
    if length_check.lower() not in ''.join(tag_sql.replace('"', '').split()).lower():
        raise MigrationError('006 Tag name length constraint is missing.')
    expected = {('task_id', 'tasks', 'id', 'CASCADE'), ('tag_id', 'tags', 'id', 'CASCADE')}
    foreign_keys = connection.exec_driver_sql('PRAGMA foreign_key_list(task_tags)').all()
    if {(fk[3], fk[2], fk[4], fk[6]) for fk in foreign_keys} != expected or len(foreign_keys) != 2:
        raise MigrationError('006 TaskTag CASCADE foreign keys are invalid.')
    if connection.exec_driver_sql('PRAGMA foreign_key_check').first() is not None:
        raise MigrationError('006 would leave foreign key violations.')


def _migrate_006(connection):
    recorded = REVISION in _revisions(connection)
    tables = set(inspect(connection).get_table_names())
    existing = tables & {'tags', 'task_tags'}
    if recorded:
        _verify_006(connection)
        return
    if existing:
        # Only an empty, complete ORM-created schema may acquire its initial history.
        _verify_006(connection)
        if any(connection.exec_driver_sql(f'SELECT 1 FROM {table} LIMIT 1').first() is not None for table in existing):
            raise MigrationError('Unrecorded 006 Tag schema contains data; manual review required.')
    else:
        connection.exec_driver_sql(
            'CREATE TABLE tags (id INTEGER NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL, '
            'created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, '
            '\nCONSTRAINT uq_tags_name UNIQUE (name), '
            '\nCONSTRAINT ck_tags_name_length CHECK (length(name) BETWEEN 1 AND 255)\n)'
        )
        connection.exec_driver_sql(
            'CREATE TABLE task_tags (task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, '
            'tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE, '
            'PRIMARY KEY (task_id, tag_id))'
        )
        connection.exec_driver_sql('CREATE INDEX ix_task_tags_tag_id ON task_tags (tag_id)')
    _verify_006(connection)
    _record(connection, REVISION)


def migrate_sqlite_task_tags(engine, *, allow_pending=False, allow_metadata_pending=False):
    """A separate explicit approval is required for 006, including auto reload."""
    def migrate(connection):
        revisions = _revisions(connection)
        if METADATA_REVISION not in revisions and not allow_metadata_pending:
            raise MigrationError('Task metadata migration 005 is pending. Obtain approval before starting with APPLY_TASK_METADATA_MIGRATION=1.')
        if REVISION not in revisions and not allow_pending:
            raise MigrationError('Task Tag migration 006 is pending. Back up the database and obtain approval before starting with APPLY_TASK_TAGS_MIGRATION=1.')
        _migrate_005(connection)
        _migrate_006(connection)
    migrate_sqlite_latest(engine, after_migration=migrate)
