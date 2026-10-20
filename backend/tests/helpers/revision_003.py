"""Deterministic historical schemas and invented data; never read a project DB.

The 003 DDL is fixed here independently of current ORM metadata and migration
execution. Every builder receives an empty, isolated SQLite engine from a test.
"""

from sqlalchemy import inspect


REVISION_003 = '003_v1a_schedule_blocks'
STAMP = '2026-09-01 01:00:00'

SCHEMA_003 = (
    'CREATE TABLE projects ('
    'id INTEGER NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, '
    'created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)',
    'CREATE TABLE tasks ('
    'id INTEGER NOT NULL PRIMARY KEY, title VARCHAR(255) NOT NULL, '
    'estimated_minutes INTEGER NULL, planned_date DATE NULL, planned_start_time TIME NULL, '
    'project_id INTEGER NULL REFERENCES projects(id) ON DELETE SET NULL, '
    'completed BOOLEAN NOT NULL DEFAULT 0, completed_at DATETIME NULL, '
    'completed_estimate_minutes INTEGER NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)',
    'CREATE TABLE time_entries ('
    'id INTEGER NOT NULL PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, '
    'project_id_snapshot INTEGER NULL, start_at DATETIME NOT NULL, end_at DATETIME NOT NULL, '
    'duration_minutes INTEGER NOT NULL, created_at DATETIME NOT NULL)',
    'CREATE TABLE schedule_blocks ('
    'id INTEGER NOT NULL PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, '
    'date DATE NOT NULL, type VARCHAR(10) NOT NULL, start_time TIME NULL, duration_minutes INTEGER NULL, '
    'created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, '
    "\nCONSTRAINT ck_schedule_blocks_type CHECK (type IN ('TIME_UNSET', 'TIMED', 'ALL_DAY')), "
    "\nCONSTRAINT ck_schedule_blocks_fields CHECK ((type = 'TIMED' AND start_time IS NOT NULL "
    'AND duration_minutes IS NOT NULL AND duration_minutes >= 1) OR '
    "(type IN ('TIME_UNSET', 'ALL_DAY') AND start_time IS NULL AND duration_minutes IS NULL))\n)",
    'CREATE TABLE schema_migrations ('
    'revision VARCHAR(100) NOT NULL PRIMARY KEY, applied_at DATETIME NOT NULL)',
    'CREATE INDEX ix_projects_id ON projects (id)',
    'CREATE INDEX ix_tasks_id ON tasks (id)',
    'CREATE INDEX ix_time_entries_id ON time_entries (id)',
    'CREATE INDEX ix_schedule_blocks_id ON schedule_blocks (id)',
    'CREATE INDEX ix_schedule_blocks_task_id ON schedule_blocks (task_id)',
)


def _require_empty(engine):
    if engine.dialect.name != 'sqlite' or inspect(engine).get_table_names():
        raise ValueError('Historical fixture requires an empty isolated SQLite database.')


def build_revision_003_fixture(engine):
    """Create 003 with four tasks, four blocks, six closed entries and two projects."""
    _require_empty(engine)
    with engine.begin() as connection:
        for statement in SCHEMA_003:
            connection.exec_driver_sql(statement)
        connection.exec_driver_sql(
            'INSERT INTO projects VALUES (?, ?, ?, ?)',
            [(7, 'Synthetic historical project', STAMP, STAMP),
             (9, 'Synthetic current project', STAMP, STAMP)],
        )
        connection.exec_driver_sql(
            'INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                # Membership moved to 9; historical entries still use 7 or NULL.
                (2, 'Synthetic estimated task', 30, '2026-10-01', '09:00:00', 9, 0, None, None, STAMP, STAMP),
                (5, 'Synthetic unknown estimate', None, '2026-10-02', None, None, 0, None, None, STAMP, STAMP),
                (11, 'Synthetic completed task', 45, '2026-10-01', '09:00:00', 7, 1,
                 '2026-10-01 09:21:00', 40, STAMP, '2026-10-01 09:21:00'),
                (18, 'Synthetic inbox task', 60, None, None, 9, 0, None, None, STAMP, STAMP),
            ],
        )
        connection.exec_driver_sql(
            'INSERT INTO schedule_blocks VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [(3, 2, '2026-10-01', 'TIMED', '09:00:00', 30, STAMP, STAMP),
             (8, 2, '2026-10-02', 'ALL_DAY', None, None, STAMP, STAMP),
             (12, 5, '2026-10-02', 'TIME_UNSET', None, None, STAMP, STAMP),
             (21, 11, '2026-10-01', 'TIMED', '09:00:00', 60, STAMP, STAMP)],
        )
        connection.exec_driver_sql(
            'INSERT INTO time_entries VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                # UTC midnight and 7m59s: daily clipping must precede flooring.
                (4, 2, 7, '2026-10-01 23:58:30', '2026-10-02 00:06:29', 7, STAMP),
                (19, 2, None, '2026-10-02 01:00:00', '2026-10-02 01:00:59', 0, STAMP),
                # Tokyo midnight; unknown estimate and unassigned snapshot.
                (31, 5, None, '2026-10-01 14:59:30', '2026-10-01 15:02:29', 2, STAMP),
                (45, 11, 7, '2026-10-01 09:00:00', '2026-10-01 09:20:45', 20, STAMP),
                (62, 18, 9, '2026-10-02 03:00:00', '2026-10-02 03:10:00', 10, STAMP),
                # Snapshot must not be inferred from the task's NULL membership.
                (77, 5, 9, '2026-10-02 05:00:00', '2026-10-02 05:01:01', 1, STAMP),
            ],
        )
        connection.exec_driver_sql('INSERT INTO schema_migrations VALUES (?, ?)', (REVISION_003, STAMP))


def build_schema_b_fixture(engine):
    """Create the earlier minimal Schema B without projects, blocks or history."""
    _require_empty(engine)
    with engine.begin() as connection:
        connection.exec_driver_sql(
            'CREATE TABLE tasks (id INTEGER NOT NULL PRIMARY KEY, title VARCHAR(255) NOT NULL, '
            'estimated_minutes INTEGER NOT NULL, completed BOOLEAN NOT NULL, '
            'created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, planned_date DATE NOT NULL)'
        )
        connection.exec_driver_sql(
            'CREATE TABLE time_entries (id INTEGER NOT NULL PRIMARY KEY, '
            'task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, '
            'start_at DATETIME NOT NULL, end_at DATETIME NOT NULL, '
            'duration_minutes INTEGER NOT NULL, created_at DATETIME NOT NULL)'
        )
        connection.exec_driver_sql('CREATE INDEX ix_tasks_id ON tasks (id)')
        connection.exec_driver_sql('CREATE INDEX ix_time_entries_id ON time_entries (id)')
        connection.exec_driver_sql(
            'INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)',
            [(2, 'Synthetic legacy pending', 30, 0, STAMP, STAMP, '2026-10-01'),
             (5, 'Synthetic legacy complete', 60, 1, STAMP, STAMP, '2026-10-02'),
             (11, 'Synthetic legacy scheduled', 45, 0, STAMP, STAMP, '2026-10-02')],
        )
        connection.exec_driver_sql(
            'INSERT INTO time_entries VALUES (?, ?, ?, ?, ?, ?)',
            [(4, 2, '2026-10-01 23:58:30', '2026-10-02 00:06:29', 7, STAMP),
             (19, 2, '2026-10-02 01:00:00', '2026-10-02 01:00:59', 0, STAMP),
             (31, 5, '2026-10-02 02:00:00', '2026-10-02 02:20:45', 20, STAMP),
             (45, 11, '2026-10-02 03:00:00', '2026-10-02 03:10:00', 10, STAMP)],
        )
