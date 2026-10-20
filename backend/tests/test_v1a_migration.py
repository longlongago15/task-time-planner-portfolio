"""V1-A migration coverage; every SQL connection targets a pytest temporary DB."""

from datetime import date, datetime, time

import pytest
from sqlalchemy import create_engine, event, inspect, select
from sqlalchemy.engine import URL
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app import database
from app.models import Project, ScheduleBlock, Task, TimeEntry
from helpers.revision_003 import build_schema_b_fixture
from migrations.sqlite_v1a import MigrationError, REVISION
from migrations.sqlite_timer_schema import REVISION as TIMER_REVISION
from migrations.sqlite_task_fields import REVISION as TASK_METADATA_REVISION
from migrations.sqlite_task_tags import REVISION as TASK_TAGS_REVISION


@pytest.fixture
def legacy_engine(tmp_path, monkeypatch):
    engine = create_engine(URL.create('sqlite', database=str(tmp_path / 'legacy.db')))

    @event.listens_for(engine, 'connect')
    def enable_foreign_keys(connection, record):
        connection.execute('PRAGMA foreign_keys=ON')

    monkeypatch.setattr(database, 'engine', engine)
    try:
        yield engine
    finally:
        engine.dispose()


def create_schema_a(engine, nullable_estimate=False, empty=False):
    with engine.begin() as connection:
        connection.exec_driver_sql(
            'CREATE TABLE projects (id INTEGER PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, '
            'created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)'
        )
        estimate_nullability = 'NULL' if nullable_estimate else 'NOT NULL'
        connection.exec_driver_sql(
            'CREATE TABLE tasks (id INTEGER PRIMARY KEY, title VARCHAR(255) NOT NULL, '
            f'estimated_minutes INTEGER {estimate_nullability}, planned_date DATE NULL, '
            'planned_start_time TIME NULL, project_id INTEGER NULL REFERENCES projects(id) ON DELETE SET NULL, '
            'completed BOOLEAN NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)'
        )
        connection.exec_driver_sql('CREATE INDEX ix_tasks_title_custom ON tasks(title)')
        connection.exec_driver_sql(
            'CREATE TABLE time_entries (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL '
            'REFERENCES tasks(id) ON DELETE CASCADE, start_at DATETIME NOT NULL, end_at DATETIME NOT NULL, '
            'duration_minutes INTEGER NOT NULL, created_at DATETIME NOT NULL)'
        )
        if empty:
            return
        timestamp = '2026-09-01 01:00:00'
        connection.exec_driver_sql(
            'INSERT INTO projects VALUES (?, ?, ?, ?)',
            [(7, 'Project A', timestamp, timestamp), (9, 'Project B', timestamp, timestamp)],
        )
        task_values = [
            (2, 'Inbox', 30, None, None, 7, 0),
            (5, 'Completed date only', 60, '2026-09-04', None, None, 1),
            (11, 'Short timed', 45, '2026-09-04', '09:00:00', 7, 0),
            (18, 'Long timed', 120, '2026-09-05', '10:00:00', 9, 0),
            (23, 'Sixty timed', 60, '2026-09-06', '12:00:00', None, 0),
            (37, 'Date only', 30, '2026-09-07', None, 7, 0),
        ]
        if nullable_estimate:
            task_values.append((49, 'Unestimated timed', None, '2026-09-08', '13:00:00', None, 0))
        connection.exec_driver_sql(
            'INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [(*values, timestamp, timestamp) for values in task_values],
        )
        connection.exec_driver_sql(
            'INSERT INTO time_entries VALUES (?, ?, ?, ?, ?, ?)',
            [(identifier, task_id, timestamp, '2026-09-01 01:20:00', 20, timestamp)
             for identifier, task_id in [(4, 11), (19, 18), (31, 5), (45, 2)]],
        )


def rows(engine, table, columns='*'):
    with engine.connect() as connection:
        return connection.exec_driver_sql(f'SELECT {columns} FROM {table} ORDER BY id').all()


def dump(engine):
    with engine.connect() as connection:
        schema = connection.exec_driver_sql(
            "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
        ).all()
        tables = inspect(connection).get_table_names()
        data = {table: connection.exec_driver_sql(f'SELECT * FROM "{table}" ORDER BY 1').all() for table in tables}
        return schema, data


def assert_target_schema(engine):
    inspector = inspect(engine)
    for model in (Project, Task, TimeEntry, ScheduleBlock):
        actual = {column['name']: column for column in inspector.get_columns(model.__tablename__)}
        for expected in model.__table__.columns:
            assert expected.name in actual
            # SQLite reports INTEGER PRIMARY KEY nullable when NOT NULL was omitted.
            if not expected.primary_key:
                assert actual[expected.name]['nullable'] == expected.nullable
    checks = {constraint['name'] for constraint in inspector.get_check_constraints('schedule_blocks')}
    assert checks == {'ck_schedule_blocks_type', 'ck_schedule_blocks_fields'}
    start_date = next(column for column in inspector.get_columns('tasks') if column['name'] == 'start_date')
    assert str(start_date['type']) == 'DATE'
    assert start_date['nullable'] is True and start_date['default'] is None
    with engine.connect() as connection:
        assert connection.exec_driver_sql('PRAGMA foreign_key_check').all() == []
        assert connection.exec_driver_sql('PRAGMA foreign_keys').scalar_one() == 1
        # migrate_schema() upgrades the whole database, including Task periods.
        assert connection.exec_driver_sql('SELECT revision FROM schema_migrations ORDER BY revision').scalars().all() == [
            REVISION, TIMER_REVISION, TASK_METADATA_REVISION, TASK_TAGS_REVISION,
            '007_project_tag_colors', '008_task_start_date',
        ]


def test_schema_a_preserves_rows_and_converts_schedules(legacy_engine):
    create_schema_a(legacy_engine)
    task_columns = 'id, title, estimated_minutes, planned_date, planned_start_time, project_id, completed, created_at, updated_at'
    entry_columns = 'id, task_id, start_at, end_at, created_at'
    before_tasks = rows(legacy_engine, 'tasks', task_columns)
    before_entries = rows(legacy_engine, 'time_entries', entry_columns)
    before_projects = rows(legacy_engine, 'projects')
    database.migrate_schema()
    assert rows(legacy_engine, 'tasks', task_columns) == before_tasks
    assert all(start is None for start, in rows(legacy_engine, 'tasks', 'start_date'))
    assert rows(legacy_engine, 'time_entries', 'id, task_id, started_at, ended_at, created_at') == before_entries
    assert rows(legacy_engine, 'projects', 'id, name, created_at, updated_at') == before_projects
    assert rows(legacy_engine, 'schedule_blocks', 'task_id, date, type, start_time, duration_minutes') == [
        (5, '2026-09-04', 'TIME_UNSET', None, None),
        (11, '2026-09-04', 'TIMED', '09:00:00', 45),
        (18, '2026-09-05', 'TIMED', '10:00:00', 60),
        (23, '2026-09-06', 'TIMED', '12:00:00', 60),
        (37, '2026-09-07', 'TIME_UNSET', None, None),
    ]
    assert rows(legacy_engine, 'time_entries', 'id, project_id_snapshot') == [(4, 7), (19, 9), (31, None), (45, 7)]
    assert all(at is None and estimate is None for at, estimate in rows(
        legacy_engine, 'tasks', 'completed_at, completed_estimate_minutes'
    ))
    assert rows(legacy_engine, 'tasks', 'id, completed')[1] == (5, 1)
    assert 'ix_tasks_title_custom' in {index['name'] for index in inspect(legacy_engine).get_indexes('tasks')}
    assert_target_schema(legacy_engine)


def test_synthetic_schema_b_preserves_tasks_and_entries(legacy_engine):
    build_schema_b_fixture(legacy_engine)
    task_columns = 'id, title, estimated_minutes, completed, created_at, updated_at, planned_date'
    entry_columns = 'id, task_id, start_at, end_at, created_at'
    before_tasks = rows(legacy_engine, 'tasks', task_columns)
    before_entries = rows(legacy_engine, 'time_entries', entry_columns)
    assert len(before_tasks) == 3 and len(before_entries) == 4
    assert 'projects' not in inspect(legacy_engine).get_table_names()
    database.migrate_schema()
    assert rows(legacy_engine, 'tasks', task_columns) == before_tasks
    assert all(start is None for start, in rows(legacy_engine, 'tasks', 'start_date'))
    assert rows(legacy_engine, 'time_entries', 'id, task_id, started_at, ended_at, created_at') == before_entries
    assert rows(legacy_engine, 'projects') == []
    assert rows(legacy_engine, 'schedule_blocks', 'task_id, date, type, start_time, duration_minutes') == [
        (task[0], task[-1], 'TIME_UNSET', None, None) for task in before_tasks if task[-1] is not None
    ]
    assert all(project is None and start is None for project, start in rows(
        legacy_engine, 'tasks', 'project_id, planned_start_time'
    ))
    assert all(snapshot is None for snapshot, in rows(legacy_engine, 'time_entries', 'project_id_snapshot'))
    assert_target_schema(legacy_engine)
    once = dump(legacy_engine)
    database.migrate_schema()
    assert dump(legacy_engine) == once


def test_empty_synthetic_schema_a_migrates(legacy_engine):
    create_schema_a(legacy_engine, empty=True)
    database.migrate_schema()
    for table in ('projects', 'tasks', 'time_entries', 'schedule_blocks'):
        assert rows(legacy_engine, table) == []
    assert_target_schema(legacy_engine)
    once = dump(legacy_engine)
    database.migrate_schema()
    assert dump(legacy_engine) == once


def test_rerun_preserves_snapshots_ids_and_later_edits(legacy_engine):
    create_schema_a(legacy_engine)
    database.migrate_schema()
    once = dump(legacy_engine)
    database.migrate_schema()
    assert dump(legacy_engine) == once
    with legacy_engine.begin() as connection:
        connection.exec_driver_sql('UPDATE tasks SET project_id=9 WHERE id=11')
        connection.exec_driver_sql('UPDATE tasks SET project_id=7 WHERE id=5')
        connection.exec_driver_sql("UPDATE tasks SET planned_start_time='11:00:00', estimated_minutes=20 WHERE id=18")
        connection.exec_driver_sql('DELETE FROM schedule_blocks WHERE task_id=5')
        connection.exec_driver_sql(
            "UPDATE tasks SET completed_at='2026-10-02 01:00:00', completed_estimate_minutes=25 WHERE id=5"
        )
    edited = dump(legacy_engine)
    database.migrate_schema()
    assert dump(legacy_engine) == edited
    assert rows(legacy_engine, 'time_entries', 'id, project_id_snapshot') == [(4, 7), (19, 9), (31, None), (45, 7)]


def test_null_estimate_and_new_null_task_are_supported(legacy_engine):
    create_schema_a(legacy_engine, nullable_estimate=True)
    database.migrate_schema()
    with Session(legacy_engine) as session:
        task = session.get(Task, 49)
        assert task.estimated_minutes is None
        assert task.schedule_blocks[0].duration_minutes == 60
        new_task = Task(title='Not estimated', estimated_minutes=None)
        session.add(new_task)
        session.commit()
        assert new_task.id > 49
        assert new_task.estimated_minutes is None


@pytest.mark.parametrize(('update', 'message'), [
    ("UPDATE tasks SET planned_start_time='09:00:00' WHERE id=2", 'without planned_date'),
    ('UPDATE tasks SET estimated_minutes=0 WHERE id=11', 'Non-positive'),
    ('UPDATE tasks SET estimated_minutes=-10 WHERE id=18', 'Non-positive'),
])
def test_inconsistent_data_stops_without_changes(legacy_engine, update, message):
    create_schema_a(legacy_engine)
    with legacy_engine.begin() as connection:
        connection.exec_driver_sql(update)
    before = dump(legacy_engine)
    with pytest.raises(MigrationError, match=message):
        database.migrate_schema()
    assert dump(legacy_engine) == before
    with legacy_engine.connect() as connection:
        assert connection.exec_driver_sql('PRAGMA foreign_keys').scalar_one() == 1


def test_failure_after_rebuild_rolls_back_ddl_and_data(legacy_engine):
    create_schema_a(legacy_engine)
    before = dump(legacy_engine)

    def fail_at_revision(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith('INSERT INTO schema_migrations'):
            raise RuntimeError('Simulated interruption before completion')

    event.listen(legacy_engine, 'before_cursor_execute', fail_at_revision)
    try:
        with pytest.raises(RuntimeError, match='Simulated interruption'):
            database.migrate_schema()
    finally:
        event.remove(legacy_engine, 'before_cursor_execute', fail_at_revision)
    assert dump(legacy_engine) == before
    database.migrate_schema()
    assert_target_schema(legacy_engine)


def test_unknown_task_column_is_not_discarded(legacy_engine):
    create_schema_a(legacy_engine)
    with legacy_engine.begin() as connection:
        connection.exec_driver_sql('ALTER TABLE tasks ADD COLUMN custom_data TEXT')
        connection.exec_driver_sql("UPDATE tasks SET custom_data='retain me' WHERE id=11")
    before = dump(legacy_engine)
    with pytest.raises(MigrationError, match='Unsupported Task columns'):
        database.migrate_schema()
    assert dump(legacy_engine) == before


@pytest.mark.parametrize(('block_type', 'start', 'duration'), [
    ('TIME_UNSET', time(9), None), ('TIME_UNSET', None, 30),
    ('ALL_DAY', time(9), None), ('ALL_DAY', None, 30),
    ('TIMED', None, 30), ('TIMED', time(9), None),
    ('TIMED', time(9), 0), ('TIMED', time(9), -1),
    ('UNKNOWN', None, None), (None, None, None),
])
def test_schedule_block_constraints_reject_invalid_shapes(SessionLocal, block_type, start, duration):
    with SessionLocal() as session:
        task = Task(title='Constraints', estimated_minutes=30)
        session.add(task)
        session.commit()
        session.add(ScheduleBlock(
            task_id=task.id, date=date(2026, 10, 2), type=block_type,
            start_time=start, duration_minutes=duration,
        ))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()
        assert session.query(ScheduleBlock).count() == 0


@pytest.mark.parametrize(('block_type', 'start', 'duration'), [
    ('TIME_UNSET', None, None), ('ALL_DAY', None, None), ('TIMED', time(9), 1),
])
def test_schedule_block_valid_shapes(SessionLocal, block_type, start, duration):
    with SessionLocal() as session:
        task = Task(title='Valid block', estimated_minutes=None)
        session.add(task)
        session.flush()
        block = ScheduleBlock(task_id=task.id, date=date(2026, 10, 2), type=block_type,
                              start_time=start, duration_minutes=duration)
        session.add(block)
        session.commit()
        assert block.type == block_type


def test_schedule_block_date_is_required(SessionLocal):
    with SessionLocal() as session:
        task = Task(title='Required date', estimated_minutes=30)
        session.add(task)
        session.commit()
        session.add(ScheduleBlock(task_id=task.id, date=None, type='TIME_UNSET'))
        with pytest.raises(IntegrityError):
            session.commit()


def test_deleting_block_retains_task_and_task_delete_keeps_existing_cascade(SessionLocal):
    with SessionLocal() as session:
        task = Task(title='Deletion', estimated_minutes=30)
        task.schedule_blocks = [ScheduleBlock(date=date(2026, 10, 2), type='TIME_UNSET')]
        task.time_entries = [TimeEntry(started_at=datetime(2026, 10, 2, 9),
                                       ended_at=datetime(2026, 10, 2, 9, 30))]
        session.add(task)
        session.commit()
        task_id = task.id
        session.delete(task.schedule_blocks[0])
        session.commit()
        assert session.get(Task, task_id) is not None
        assert session.query(TimeEntry).count() == 1
        session.expire(task, ['schedule_blocks'])
        task.schedule_blocks.append(ScheduleBlock(date=date(2026, 10, 3), type='ALL_DAY'))
        session.commit()
        session.delete(task)
        session.commit()
        assert session.get(Task, task_id) is None
        assert session.scalars(select(TimeEntry)).all() == []
        assert session.scalars(select(ScheduleBlock)).all() == []


def test_schedule_api_reads_migration_created_blocks(legacy_engine, client, monkeypatch):
    from app import main

    create_schema_a(legacy_engine)
    database.migrate_schema()
    monkeypatch.setattr(main, 'SessionLocal', sessionmaker(bind=legacy_engine))
    response = client.get('/schedule-blocks', params={'startDate': '2026-09-04', 'endDate': '2026-09-07'})
    assert response.status_code == 200, response.text
    blocks = response.json()
    assert [(block['taskId'], block['date'], block['type'], block['startTime'], block['durationMinutes'])
            for block in blocks] == [
        (5, '2026-09-04', 'TIME_UNSET', None, None),
        (11, '2026-09-04', 'TIMED', '09:00:00', 45),
        (18, '2026-09-05', 'TIMED', '10:00:00', 60),
        (23, '2026-09-06', 'TIMED', '12:00:00', 60),
        (37, '2026-09-07', 'TIME_UNSET', None, None),
    ]
    assert all(block['createdAt'] and block['updatedAt'] for block in blocks)


def test_inbox_filter_on_migrated_synthetic_schema_b(legacy_engine, client, monkeypatch):
    from app import main

    build_schema_b_fixture(legacy_engine)
    database.migrate_schema()
    monkeypatch.setattr(main, 'SessionLocal', sessionmaker(bind=legacy_engine))
    assert len(rows(legacy_engine, 'tasks')) == 3
    assert len(rows(legacy_engine, 'time_entries')) == 4
    blocks = rows(legacy_engine, 'schedule_blocks', 'type')
    assert blocks == [('TIME_UNSET',)] * 3
    inbox = client.get('/tasks', params={'inbox': 'true'})
    assert inbox.status_code == 200, inbox.text
    assert inbox.json() == []
    all_tasks = client.get('/tasks')
    scheduled = client.get('/tasks', params={'inbox': 'false'})
    assert all_tasks.status_code == scheduled.status_code == 200
    assert len(all_tasks.json()) == 3
    assert scheduled.json() == all_tasks.json()
