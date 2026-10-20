"""Atomic SQLite 003 -> 004 runner. The caller supplies the engine explicitly."""

import re

from sqlalchemy import inspect

from .sqlite_v1a import (
    MigrationError, REVISION as V1A_REVISION, TASK_COLUMNS,
    _columns, _create_v1a_tables, _migrate as _migrate_v1a,
)


REVISION = '004_timer_timeentry_lifecycle_schema'
ACTIVE_INDEX = 'uq_time_entries_single_active'
TEMP_ENTRIES = 'time_entries__migration_004'
ENTRY_COLUMNS = frozenset({
    'id', 'task_id', 'project_id_snapshot', 'started_at', 'ended_at', 'created_at', 'updated_at',
})
OLD_ENTRY_COLUMNS = frozenset({
    'id', 'task_id', 'project_id_snapshot', 'start_at', 'end_at', 'duration_minutes', 'created_at',
})


def _record(connection, revision):
    connection.exec_driver_sql(
        'CREATE TABLE IF NOT EXISTS schema_migrations '
        '(revision VARCHAR(100) NOT NULL PRIMARY KEY, applied_at DATETIME NOT NULL)'
    )
    connection.exec_driver_sql(
        'INSERT INTO schema_migrations (revision, applied_at) VALUES (?, CURRENT_TIMESTAMP)', (revision,)
    )


def _revisions(connection):
    if 'schema_migrations' not in inspect(connection).get_table_names():
        return set()
    return set(connection.exec_driver_sql('SELECT revision FROM schema_migrations').scalars())


def _verify_latest(connection):
    tables = set(inspect(connection).get_table_names())
    if not {'projects', 'tasks', 'schedule_blocks', 'time_entries'}.issubset(tables):
        raise MigrationError('004 schema is incomplete.')
    tasks = _columns(connection, 'tasks')
    entries = _columns(connection, 'time_entries')
    if not (TASK_COLUMNS | {'status'}).issubset(tasks) or tasks['status']['nullable']:
        raise MigrationError('004 Task.status does not match its fixed schema.')
    if not ENTRY_COLUMNS.issubset(entries) or {'start_at', 'end_at', 'duration_minutes'} & entries.keys():
        raise MigrationError('004 TimeEntry columns do not match its fixed schema.')
    for name in ENTRY_COLUMNS - {'project_id_snapshot', 'ended_at'}:
        if entries[name]['nullable']:
            raise MigrationError(f'004 TimeEntry.{name} must be NOT NULL.')
    if not entries['ended_at']['nullable'] or not entries['project_id_snapshot']['nullable']:
        raise MigrationError('004 ended_at and project_id_snapshot must allow NULL.')
    if inspect(connection).get_pk_constraint('time_entries')['constrained_columns'] != ['id']:
        raise MigrationError('Unsupported TimeEntry primary key.')
    foreign_keys = connection.exec_driver_sql('PRAGMA foreign_key_list(time_entries)').all()
    if len(foreign_keys) != 1 or not any(
        fk[3] == 'task_id' and fk[2] == 'tasks' and fk[4] == 'id' and fk[6] == 'CASCADE'
        for fk in foreign_keys
    ):
        raise MigrationError('004 requires only the Task CASCADE foreign key; Snapshot has no FK.')
    task_sql = connection.exec_driver_sql("SELECT sql FROM sqlite_master WHERE name='tasks' AND type='table'").scalar_one()
    status_check = "CONSTRAINTck_tasks_statusCHECK(statusIN('NOT_STARTED','IN_PROGRESS','COMPLETED'))"
    if status_check.lower() not in ''.join(task_sql.replace('"', '').split()).lower():
        raise MigrationError('004 Task.status CHECK constraint is missing or different.')
    if str(tasks['status']['default']).strip("'\"") != 'NOT_STARTED':
        raise MigrationError('004 Task.status default must be NOT_STARTED.')
    sql = connection.exec_driver_sql(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name=? AND tbl_name='time_entries'",
        (ACTIVE_INDEX,),
    ).scalar_one_or_none()
    expected = f'CREATEUNIQUEINDEX{ACTIVE_INDEX}ONtime_entries((1))WHEREended_atISNULL'
    if sql is None or ''.join(sql.replace('"', '').split()).lower() != expected.lower():
        raise MigrationError('004 single Active Entry index is missing or different.')
    if connection.exec_driver_sql('PRAGMA foreign_key_check').first() is not None:
        raise MigrationError('004 would leave foreign key violations.')


def _rebuild_entries(connection):
    if set(_columns(connection, 'time_entries')) != OLD_ENTRY_COLUMNS:
        raise MigrationError('Unsupported TimeEntry source columns; refusing to discard unknown data.')
    inspector = inspect(connection)
    table_sql = connection.exec_driver_sql(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='time_entries'"
    ).scalar_one()
    if 'AUTOINCREMENT' in table_sql.upper() or inspector.get_check_constraints('time_entries') or inspector.get_unique_constraints('time_entries'):
        raise MigrationError('Unsupported TimeEntry constraints; refusing to discard them.')
    dependents = connection.exec_driver_sql(
        "SELECT type, sql FROM sqlite_master WHERE tbl_name='time_entries' "
        "AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name"
    ).all()
    for kind, sql in dependents:
        if kind == 'trigger' or re.search(r'\b(start_at|end_at|duration_minutes)\b', sql, re.IGNORECASE):
            raise MigrationError('TimeEntry trigger/index needs manual review before column replacement.')
    if TEMP_ENTRIES in inspector.get_table_names():
        raise MigrationError(f'{TEMP_ENTRIES} already exists; manual review required.')
    # Validate the old FK rather than silently removing a historical Snapshot FK.
    keys = connection.exec_driver_sql('PRAGMA foreign_key_list(time_entries)').all()
    if len(keys) != 1 or keys[0][3] != 'task_id' or keys[0][2] != 'tasks' or keys[0][4] != 'id' or keys[0][6] != 'CASCADE':
        raise MigrationError('Unsupported TimeEntry source foreign keys.')
    connection.exec_driver_sql(
        f'CREATE TABLE {TEMP_ENTRIES} ('
        'id INTEGER NOT NULL PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, '
        'project_id_snapshot INTEGER NULL, started_at DATETIME NOT NULL, ended_at DATETIME NULL, '
        'created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)'
    )
    connection.exec_driver_sql(
        f'INSERT INTO {TEMP_ENTRIES} '
        '(id, task_id, project_id_snapshot, started_at, ended_at, created_at, updated_at) '
        'SELECT id, task_id, project_id_snapshot, start_at, end_at, created_at, created_at FROM time_entries'
    )
    connection.exec_driver_sql('DROP TABLE time_entries')
    connection.exec_driver_sql(f'ALTER TABLE {TEMP_ENTRIES} RENAME TO time_entries')
    for _, sql in dependents:
        connection.exec_driver_sql(sql)
    connection.exec_driver_sql('CREATE INDEX IF NOT EXISTS ix_time_entries_id ON time_entries (id)')


def _migrate_004(connection):
    if REVISION in _revisions(connection):
        _verify_latest(connection)
        return
    if 'status' in _columns(connection, 'tasks'):
        # Only the empty metadata.create_all() case may arrive here with final columns already present.
        _verify_latest(connection)
        if any(connection.exec_driver_sql(f'SELECT 1 FROM {table} LIMIT 1').first() is not None
               for table in ('tasks', 'projects', 'schedule_blocks', 'time_entries')):
            raise MigrationError('Unrecorded 004 schema contains data; manual review required.')
    else:
        _rebuild_entries(connection)
        connection.exec_driver_sql(
            "ALTER TABLE tasks ADD COLUMN status VARCHAR(11) NOT NULL DEFAULT 'NOT_STARTED' "
            "CONSTRAINT ck_tasks_status CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'))"
        )
        connection.exec_driver_sql(
            "UPDATE tasks SET status = CASE WHEN completed THEN 'COMPLETED' ELSE 'NOT_STARTED' END"
        )
        connection.exec_driver_sql(
            f'CREATE UNIQUE INDEX {ACTIVE_INDEX} ON time_entries((1)) WHERE ended_at IS NULL'
        )
        _verify_latest(connection)
    _record(connection, REVISION)


def _migrate_latest(connection):
    tables = set(inspect(connection).get_table_names())
    revisions = _revisions(connection)
    if REVISION in revisions and V1A_REVISION not in revisions:
        raise MigrationError('004 migration record is missing its 003 prerequisite.')
    if 'tasks' not in tables:
        if tables - {'schema_migrations'}:
            raise MigrationError('Incomplete source database; manual review required.')
        _create_v1a_tables(connection)
    elif V1A_REVISION not in revisions and 'status' in _columns(connection, 'tasks'):
        # A final, empty schema created directly by SQLAlchemy needs history, not backfill.
        _verify_latest(connection)
        if any(connection.exec_driver_sql(f'SELECT 1 FROM {table} LIMIT 1').first() is not None
               for table in ('tasks', 'projects', 'schedule_blocks', 'time_entries')):
            raise MigrationError('Unrecorded final schema contains data; manual review required.')
        _record(connection, V1A_REVISION)
    _migrate_v1a(connection)
    _migrate_004(connection)


def migrate_sqlite_latest(engine, after_migration=None):
    """Run pending revisions in one explicit SQLite transaction, including all DDL."""
    if engine.dialect.name != 'sqlite':
        raise MigrationError('This migration supports SQLite only.')
    with engine.connect() as connection:
        foreign_keys = connection.exec_driver_sql('PRAGMA foreign_keys').scalar_one()
        connection.commit()
        connection.exec_driver_sql('PRAGMA foreign_keys=OFF')
        connection.commit()
        try:
            connection.exec_driver_sql('BEGIN IMMEDIATE')
            if connection.exec_driver_sql('PRAGMA foreign_key_check').first() is not None:
                raise MigrationError('Source contains foreign key violations.')
            _migrate_latest(connection)
            if after_migration is not None:
                after_migration(connection)
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.exec_driver_sql(f'PRAGMA foreign_keys={int(foreign_keys)}')
            connection.commit()
