"""Transactional V1-A migration for SQLite Schema A/B; no CLI or default DB."""

from sqlalchemy import inspect


REVISION = '003_v1a_schedule_blocks'
TEMP_TASKS = 'tasks__migration_new'
# This revision describes its own schema, independent of future ORM models.
TASK_COLUMNS = frozenset({
    'id', 'title', 'estimated_minutes', 'planned_date', 'planned_start_time', 'project_id',
    'completed', 'completed_at', 'completed_estimate_minutes', 'created_at', 'updated_at',
})


def _create_v1a_tables(connection):
    connection.exec_driver_sql(
        'CREATE TABLE IF NOT EXISTS projects ('
        'id INTEGER NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, '
        'created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)'
    )
    connection.exec_driver_sql('CREATE INDEX IF NOT EXISTS ix_projects_id ON projects (id)')
    connection.exec_driver_sql(
        'CREATE TABLE IF NOT EXISTS tasks ('
        'id INTEGER NOT NULL PRIMARY KEY, title VARCHAR(255) NOT NULL, '
        'estimated_minutes INTEGER NULL, planned_date DATE NULL, planned_start_time TIME NULL, '
        'project_id INTEGER NULL REFERENCES projects(id) ON DELETE SET NULL, '
        'completed BOOLEAN NOT NULL DEFAULT 0, completed_at DATETIME NULL, '
        'completed_estimate_minutes INTEGER NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)'
    )
    connection.exec_driver_sql('CREATE INDEX IF NOT EXISTS ix_tasks_id ON tasks (id)')
    connection.exec_driver_sql(
        'CREATE TABLE IF NOT EXISTS time_entries ('
        'id INTEGER NOT NULL PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, '
        'project_id_snapshot INTEGER NULL, start_at DATETIME NOT NULL, end_at DATETIME NOT NULL, '
        'duration_minutes INTEGER NOT NULL, created_at DATETIME NOT NULL)'
    )
    connection.exec_driver_sql('CREATE INDEX IF NOT EXISTS ix_time_entries_id ON time_entries (id)')
    connection.exec_driver_sql(
        'CREATE TABLE IF NOT EXISTS schedule_blocks ('
        'id INTEGER NOT NULL PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, '
        'date DATE NOT NULL, type VARCHAR(10) NOT NULL, start_time TIME NULL, duration_minutes INTEGER NULL, '
        'created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, '
        "\nCONSTRAINT ck_schedule_blocks_type CHECK (type IN ('TIME_UNSET', 'TIMED', 'ALL_DAY')), "
        "\nCONSTRAINT ck_schedule_blocks_fields CHECK ((type = 'TIMED' AND start_time IS NOT NULL "
        'AND duration_minutes IS NOT NULL AND duration_minutes >= 1) OR '
        "(type IN ('TIME_UNSET', 'ALL_DAY') AND start_time IS NULL AND duration_minutes IS NULL))\n)"
    )
    connection.exec_driver_sql('CREATE INDEX IF NOT EXISTS ix_schedule_blocks_id ON schedule_blocks (id)')
    connection.exec_driver_sql('CREATE INDEX IF NOT EXISTS ix_schedule_blocks_task_id ON schedule_blocks (task_id)')


class MigrationError(RuntimeError):
    """Source data/schema cannot be migrated without guessing or data loss."""


def _columns(connection, table):
    return {column['name']: column for column in inspect(connection).get_columns(table)}


def _validate_source(connection, tables, task_columns):
    required = {'id', 'title', 'estimated_minutes', 'completed', 'created_at', 'updated_at'}
    if not required.issubset(task_columns):
        raise MigrationError(f'Missing Task columns: {sorted(required - task_columns.keys())}')
    invalid_estimates = connection.exec_driver_sql(
        'SELECT id FROM tasks WHERE estimated_minutes IS NOT NULL AND estimated_minutes <= 0 LIMIT 10'
    ).scalars().all()
    if invalid_estimates:
        raise MigrationError(f'Non-positive estimated_minutes; Task IDs: {invalid_estimates}')
    if 'planned_start_time' in task_columns:
        date_expr = 'planned_date' if 'planned_date' in task_columns else 'NULL'
        invalid_dates = connection.exec_driver_sql(
            f'SELECT id FROM tasks WHERE {date_expr} IS NULL AND planned_start_time IS NOT NULL LIMIT 10'
        ).scalars().all()
        if invalid_dates:
            raise MigrationError(f'planned_start_time without planned_date; Task IDs: {invalid_dates}')
    if 'project_id' in task_columns:
        if 'projects' not in tables:
            bad_projects = connection.exec_driver_sql(
                'SELECT id FROM tasks WHERE project_id IS NOT NULL LIMIT 10'
            ).scalars().all()
        else:
            bad_projects = connection.exec_driver_sql(
                'SELECT t.id FROM tasks t LEFT JOIN projects p ON p.id=t.project_id '
                'WHERE t.project_id IS NOT NULL AND p.id IS NULL LIMIT 10'
            ).scalars().all()
        if bad_projects:
            raise MigrationError(f'Missing Project references; Task IDs: {bad_projects}')
    if 'projects' in tables:
        project_columns = set(_columns(connection, 'projects'))
        if not {'id', 'name', 'created_at', 'updated_at'}.issubset(project_columns):
            raise MigrationError('Unsupported projects schema; Project values will not be invented.')
    if 'time_entries' in tables:
        entry_columns = set(_columns(connection, 'time_entries'))
        required_entries = {'id', 'task_id', 'start_at', 'end_at', 'duration_minutes', 'created_at'}
        if not required_entries.issubset(entry_columns):
            raise MigrationError('Unsupported time_entries schema.')
        orphans = connection.exec_driver_sql(
            'SELECT e.id FROM time_entries e LEFT JOIN tasks t ON t.id=e.task_id '
            'WHERE t.id IS NULL LIMIT 10'
        ).scalars().all()
        if orphans:
            raise MigrationError(f'Orphan TimeEntry IDs: {orphans}')
    if connection.exec_driver_sql('PRAGMA foreign_key_check').first() is not None:
        raise MigrationError('Source contains foreign key violations.')
    if 'schedule_blocks' in tables and connection.exec_driver_sql(
        'SELECT 1 FROM schedule_blocks LIMIT 1'
    ).first() is not None:
        raise MigrationError('ScheduleBlocks exist without a completed migration record; manual review required.')


def _rebuild_tasks(connection, columns, target_columns):
    # Reject extra columns/constraints instead of silently dropping unknown data.
    extra = columns.keys() - target_columns
    if extra:
        raise MigrationError(f'Unsupported Task columns: {sorted(extra)}')
    table_sql = connection.exec_driver_sql(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
    ).scalar_one()
    if 'AUTOINCREMENT' in table_sql.upper() or inspect(connection).get_check_constraints('tasks'):
        raise MigrationError('Unsupported Task constraints; refusing to discard them.')
    if inspect(connection).get_unique_constraints('tasks'):
        raise MigrationError('Unsupported Task UNIQUE constraints; refusing to discard them.')
    dependent_sql = connection.exec_driver_sql(
        "SELECT sql FROM sqlite_master WHERE tbl_name='tasks' "
        "AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name"
    ).scalars().all()
    if TEMP_TASKS in inspect(connection).get_table_names():
        raise MigrationError(f'{TEMP_TASKS} already exists; manual review required.')
    connection.exec_driver_sql(
        f'CREATE TABLE {TEMP_TASKS} ('
        'id INTEGER NOT NULL PRIMARY KEY, title VARCHAR(255) NOT NULL, '
        'estimated_minutes INTEGER NULL, planned_date DATE NULL, planned_start_time TIME NULL, '
        'project_id INTEGER NULL REFERENCES projects(id) ON DELETE SET NULL, '
        'completed BOOLEAN NOT NULL DEFAULT 0, completed_at DATETIME NULL, '
        'completed_estimate_minutes INTEGER NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)'
    )
    names = [
        'id', 'title', 'estimated_minutes', 'planned_date', 'planned_start_time', 'project_id',
        'completed', 'completed_at', 'completed_estimate_minutes', 'created_at', 'updated_at',
    ]
    expressions = [name if name in columns else 'NULL' for name in names]
    connection.exec_driver_sql(
        f'INSERT INTO {TEMP_TASKS} ({", ".join(names)}) SELECT {", ".join(expressions)} FROM tasks'
    )
    connection.exec_driver_sql('DROP TABLE tasks')
    connection.exec_driver_sql(f'ALTER TABLE {TEMP_TASKS} RENAME TO tasks')
    for sql in dependent_sql:
        connection.exec_driver_sql(sql)
    connection.exec_driver_sql('CREATE INDEX IF NOT EXISTS ix_tasks_id ON tasks (id)')


def _migrate(connection):
    tables = set(inspect(connection).get_table_names())
    if 'tasks' not in tables:
        return
    task_columns = _columns(connection, 'tasks')
    target_columns = TASK_COLUMNS
    if 'schema_migrations' in tables and connection.exec_driver_sql(
        'SELECT 1 FROM schema_migrations WHERE revision=?', (REVISION,)
    ).first() is not None:
        if not {'projects', 'time_entries', 'schedule_blocks'}.issubset(tables) or not target_columns.issubset(task_columns):
            raise MigrationError('Completed migration record does not match the schema.')
        if not task_columns['estimated_minutes']['nullable'] or 'project_id_snapshot' not in _columns(connection, 'time_entries'):
            raise MigrationError('Completed migration record does not match the schema.')
        return

    _validate_source(connection, tables, task_columns)
    # Create Project before rebuilding Task references. Keep every 003 DDL fixed.
    connection.exec_driver_sql(
        'CREATE TABLE IF NOT EXISTS projects ('
        'id INTEGER NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, '
        'created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)'
    )
    needs_rebuild = (
        not target_columns.issubset(task_columns) or
        not task_columns['estimated_minutes']['nullable'] or
        not task_columns['planned_date']['nullable']
    )
    if needs_rebuild:
        _rebuild_tasks(connection, task_columns, target_columns)
    _create_v1a_tables(connection)
    entry_columns = _columns(connection, 'time_entries')
    if 'project_id_snapshot' not in entry_columns:
        connection.exec_driver_sql('ALTER TABLE time_entries ADD COLUMN project_id_snapshot INTEGER NULL')
        connection.exec_driver_sql(
            'UPDATE time_entries SET project_id_snapshot = '
            '(SELECT project_id FROM tasks WHERE tasks.id=time_entries.task_id)'
        )
    # An already-existing snapshot column is never reclassified, even when NULL.
    connection.exec_driver_sql(
        'INSERT INTO schedule_blocks '
        '(task_id, date, type, start_time, duration_minutes, created_at, updated_at) '
        'SELECT id, planned_date, '
        "CASE WHEN planned_start_time IS NULL THEN 'TIME_UNSET' ELSE 'TIMED' END, "
        'planned_start_time, '
        'CASE WHEN planned_start_time IS NULL THEN NULL '
        'WHEN estimated_minutes IS NULL THEN 60 ELSE min(estimated_minutes, 60) END, '
        'CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM tasks WHERE planned_date IS NOT NULL'
    )
    if connection.exec_driver_sql('PRAGMA foreign_key_check').first() is not None:
        raise MigrationError('Migration would leave foreign key violations.')
    connection.exec_driver_sql(
        'CREATE TABLE IF NOT EXISTS schema_migrations '
        '(revision VARCHAR(100) NOT NULL PRIMARY KEY, applied_at DATETIME NOT NULL)'
    )
    connection.exec_driver_sql(
        'INSERT INTO schema_migrations (revision, applied_at) VALUES (?, CURRENT_TIMESTAMP)', (REVISION,)
    )


def migrate_sqlite_v1a(engine):
    """Migrate the supplied engine atomically, preserving its FK setting."""
    if engine.dialect.name != 'sqlite':
        raise MigrationError('This migration supports SQLite only.')
    with engine.connect() as connection:
        foreign_keys = connection.exec_driver_sql('PRAGMA foreign_keys').scalar_one()
        connection.commit()
        connection.exec_driver_sql('PRAGMA foreign_keys=OFF')
        connection.commit()
        try:
            # sqlite3 legacy transaction mode does not BEGIN for DDL. Start
            # explicitly so table rebuild, backfill and revision roll back together.
            connection.exec_driver_sql('BEGIN IMMEDIATE')
            _migrate(connection)
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.exec_driver_sql(f'PRAGMA foreign_keys={int(foreign_keys)}')
            connection.commit()
