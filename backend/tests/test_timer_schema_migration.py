"""004 schema and compatibility checks; all writes use the Step 1 temporary DB guard."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Barrier
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, event, inspect
from sqlalchemy.engine import URL
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app import database, main, models
from app.models import Task, TimeEntry
from helpers.revision_003 import build_revision_003_fixture, build_schema_b_fixture
from migrations.sqlite_timer_schema import ACTIVE_INDEX, ENTRY_COLUMNS, OLD_ENTRY_COLUMNS, REVISION
from migrations.sqlite_task_fields import REVISION as TASK_FIELDS_REVISION
from migrations.sqlite_task_tags import REVISION as TASK_TAGS_REVISION
from helpers.current_schema import migrate_current_test_schema as migrate_sqlite_latest
from migrations.sqlite_v1a import (
    MigrationError, REVISION as V1A_REVISION, TASK_COLUMNS,
    _create_v1a_tables, migrate_sqlite_v1a,
)


NOW = datetime(2026, 10, 2, 1, tzinfo=timezone.utc)


@pytest.fixture
def migration_engine(tmp_path):
    engine = create_engine(URL.create('sqlite', database=str(tmp_path / 'migration.db')),
                           connect_args={'check_same_thread': False})

    @event.listens_for(engine, 'connect')
    def enable_foreign_keys(connection, record):
        connection.execute('PRAGMA foreign_keys=ON')

    try:
        yield engine
    finally:
        engine.dispose()


def build_source(engine, source='revision_003'):
    if source == 'revision_003':
        build_revision_003_fixture(engine)
    else:
        assert source == 'schema_b'
        build_schema_b_fixture(engine)


def snapshot(engine):
    with engine.connect() as connection:
        schema = connection.exec_driver_sql('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()
        data = {}
        for table in inspect(connection).get_table_names():
            columns = [row[1] for row in connection.exec_driver_sql(f'PRAGMA table_info("{table}")')]
            data[table] = [dict(zip(columns, row)) for row in connection.exec_driver_sql(f'SELECT * FROM "{table}" ORDER BY rowid')]
        return schema, data


def test_revision_003_fixture_is_deterministic_and_matches_frozen_schema(migration_engine, tmp_path):
    build_revision_003_fixture(migration_engine)
    initial = snapshot(migration_engine)
    duplicate = create_engine(URL.create('sqlite', database=str(tmp_path / 'duplicate.db')))
    reference = create_engine(URL.create('sqlite', database=str(tmp_path / 'fixed_003.db')))
    try:
        build_revision_003_fixture(duplicate)
        assert snapshot(duplicate) == initial
        with reference.begin() as connection:
            _create_v1a_tables(connection)
        actual, fixed = inspect(migration_engine), inspect(reference)
        for table in ('projects', 'tasks', 'schedule_blocks', 'time_entries'):
            def columns(inspector):
                return [{**column, 'type': str(column['type'])} for column in inspector.get_columns(table)]
            assert columns(actual) == columns(fixed)
            assert actual.get_pk_constraint(table) == fixed.get_pk_constraint(table)
            assert actual.get_foreign_keys(table) == fixed.get_foreign_keys(table)
            assert actual.get_check_constraints(table) == fixed.get_check_constraints(table)
            assert actual.get_unique_constraints(table) == fixed.get_unique_constraints(table)
            assert actual.get_indexes(table) == fixed.get_indexes(table)
        assert {column['name'] for column in actual.get_columns('tasks')} == TASK_COLUMNS
        assert {column['name'] for column in actual.get_columns('time_entries')} == OLD_ENTRY_COLUMNS
        _, rows = initial
        assert [row['revision'] for row in rows['schema_migrations']] == [V1A_REVISION]
        assert {row['type'] for row in rows['schedule_blocks']} == {'TIME_UNSET', 'TIMED', 'ALL_DAY'}
        assert len([row for row in rows['schedule_blocks'] if row['task_id'] == 2]) == 2
        assert (len(rows['tasks']), len(rows['time_entries']), len(rows['projects'])) == (4, 6, 2)
        # Completed 003 must be a no-op, including timestamps, snapshots and blocks.
        migrate_sqlite_v1a(migration_engine)
        assert snapshot(migration_engine) == initial
    finally:
        duplicate.dispose()
        reference.dispose()


def test_revision_003_builder_refuses_to_overwrite_existing_data(migration_engine):
    build_revision_003_fixture(migration_engine)
    initial = snapshot(migration_engine)
    with pytest.raises(ValueError, match='empty isolated SQLite'):
        build_revision_003_fixture(migration_engine)
    assert snapshot(migration_engine) == initial


def assert_latest(engine):
    with engine.connect() as connection:
        columns = {row[1]: row for row in connection.exec_driver_sql('PRAGMA table_info(time_entries)')}
        assert set(columns) == ENTRY_COLUMNS
        assert columns['ended_at'][3] == columns['project_id_snapshot'][3] == 0
        assert all(columns[name][3] == 1 for name in ENTRY_COLUMNS - {'ended_at', 'project_id_snapshot'})
        assert columns['id'][5] == 1
        keys = connection.exec_driver_sql('PRAGMA foreign_key_list(time_entries)').all()
        assert len(keys) == 1 and keys[0][2:5] == ('tasks', 'task_id', 'id') and keys[0][6] == 'CASCADE'
        indexes = {row[1]: row for row in connection.exec_driver_sql('PRAGMA index_list(time_entries)')}
        assert indexes[ACTIVE_INDEX][2] == indexes[ACTIVE_INDEX][4] == 1
        assert connection.exec_driver_sql('PRAGMA foreign_keys').scalar_one() == 1
        assert connection.exec_driver_sql('PRAGMA foreign_key_check').all() == []
        # The TimeEntry contract is 004; the full-schema helper also applies 005-008.
        assert connection.exec_driver_sql('SELECT revision FROM schema_migrations ORDER BY revision').scalars().all() == [
            V1A_REVISION, REVISION, TASK_FIELDS_REVISION, TASK_TAGS_REVISION,
            '007_project_tag_colors', '008_task_start_date',
        ]
        task_columns = {row[1]: row for row in connection.exec_driver_sql('PRAGMA table_info(tasks)')}
        start_date = task_columns['start_date']
        assert start_date[2] == 'DATE' and start_date[3] == 0 and start_date[4] is None
        status = task_columns['status']
        assert status[3] == 1 and status[4] == "'NOT_STARTED'"


@pytest.mark.parametrize('source', ['revision_003', 'schema_b'])
def test_historical_fixture_rows_are_preserved(migration_engine, source):
    build_source(migration_engine, source)
    _, before = snapshot(migration_engine)
    migrate_sqlite_latest(migration_engine)
    assert_latest(migration_engine)
    _, after = snapshot(migration_engine)
    assert len(before['tasks']) == len(after['tasks']) > 0
    assert len(before['time_entries']) == len(after['time_entries']) > 0
    for old, new in zip(before['tasks'], after['tasks']):
        assert {key: new[key] for key in old} == old
        assert new['status'] == ('COMPLETED' if old['completed'] else 'NOT_STARTED')
        assert new['start_date'] is None
    for old, new in zip(before['time_entries'], after['time_entries']):
        assert new == {
            'id': old['id'], 'task_id': old['task_id'],
            'project_id_snapshot': old.get('project_id_snapshot'),
            'started_at': old['start_at'], 'ended_at': old['end_at'],
            'created_at': old['created_at'], 'updated_at': old['created_at'],
        }
        start = datetime.fromisoformat(new['started_at'])
        end = datetime.fromisoformat(new['ended_at'])
        assert int((end - start).total_seconds() // 60) == old['duration_minutes']
    assert after['schedule_blocks']
    if 'schedule_blocks' in before:
        assert after['schedule_blocks'] == before['schedule_blocks']
        assert [{key: row[key] for key in old} for old, row in zip(before['projects'], after['projects'])] == before['projects']
        assert all(row['color'] is None for row in after['projects'])
        assert before['schema_migrations'][0] == after['schema_migrations'][0]
    with migration_engine.connect() as connection:
        assert connection.exec_driver_sql('SELECT count(*) FROM time_entries WHERE ended_at IS NULL').scalar_one() == 0
    migrated = snapshot(migration_engine)
    migrate_sqlite_latest(migration_engine)
    assert snapshot(migration_engine) == migrated


@pytest.mark.parametrize('metadata_first', [False, True])
def test_fresh_db_and_create_all_then_runner(migration_engine, metadata_first):
    if metadata_first:
        database.Base.metadata.create_all(migration_engine)
    migrate_sqlite_latest(migration_engine)
    assert_latest(migration_engine)
    initial = snapshot(migration_engine)
    database.Base.metadata.create_all(migration_engine)
    migrate_sqlite_latest(migration_engine)
    assert snapshot(migration_engine) == initial
    with Session(migration_engine) as session:
        task = Task(title='Fresh task')
        session.add(task)
        session.commit()
        assert task.status == 'NOT_STARTED'
    with migration_engine.begin() as connection:
        connection.exec_driver_sql(
            'INSERT INTO tasks (title,completed,created_at,updated_at) VALUES (?,0,?,?)',
            ('SQL default', NOW.isoformat(), NOW.isoformat()),
        )
        assert connection.exec_driver_sql('SELECT status FROM tasks ORDER BY id DESC LIMIT 1').scalar_one() == 'NOT_STARTED'
        for status in ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'):
            connection.exec_driver_sql('UPDATE tasks SET status=?', (status,))
    for invalid in (None, 'PAUSED'):
        with pytest.raises(IntegrityError):
            with migration_engine.begin() as connection:
                connection.exec_driver_sql('UPDATE tasks SET status=?', (invalid,))


def test_rerun_preserves_edits_active_entry_and_deleted_schedule(migration_engine):
    build_source(migration_engine)
    migrate_sqlite_latest(migration_engine)
    with migration_engine.begin() as connection:
        task = connection.exec_driver_sql('SELECT id FROM tasks ORDER BY id LIMIT 1').scalar_one()
        connection.exec_driver_sql("UPDATE tasks SET status='IN_PROGRESS', estimated_minutes=NULL WHERE id=?", (task,))
        connection.exec_driver_sql('UPDATE time_entries SET project_id_snapshot=NULL,updated_at=?', ('2030-01-02 03:04:05',))
        connection.exec_driver_sql('DELETE FROM schedule_blocks WHERE id=(SELECT min(id) FROM schedule_blocks)')
        connection.exec_driver_sql(
            'INSERT INTO time_entries(task_id,project_id_snapshot,started_at,ended_at,created_at,updated_at) VALUES (?,999,?,NULL,?,?)',
            (task, NOW.isoformat(), NOW.isoformat(), NOW.isoformat()),
        )
    before = snapshot(migration_engine)
    migrate_sqlite_latest(migration_engine)
    migrate_sqlite_v1a(migration_engine)
    assert snapshot(migration_engine) == before


@pytest.mark.parametrize('source', ['revision_003', 'fresh', 'metadata'])
@pytest.mark.parametrize('same_task', [False, True])
def test_single_active_constraint_uses_constant_not_task_id(migration_engine, source, same_task):
    if source == 'revision_003':
        build_source(migration_engine)
    elif source == 'metadata':
        database.Base.metadata.create_all(migration_engine)
    migrate_sqlite_latest(migration_engine)
    assert_latest(migration_engine)
    with Session(migration_engine) as session:
        first, second = Task(title='First'), Task(title='Second')
        session.add_all([first, second]); session.commit()
        first_id, second_id = first.id, second.id
        active = TimeEntry(task_id=first_id, started_at=NOW, ended_at=None)
        session.add(active); session.commit(); active_id = active.id
    with Session(migration_engine) as session:
        session.add(TimeEntry(task_id=first_id if same_task else second_id, started_at=NOW, ended_at=None))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()
    with Session(migration_engine) as session:
        assert session.query(TimeEntry).filter(TimeEntry.ended_at.is_(None)).count() == 1
        session.get(TimeEntry, active_id).ended_at = NOW + timedelta(seconds=20)
        session.commit()
        session.add(TimeEntry(task_id=second_id, started_at=NOW + timedelta(minutes=1), ended_at=None))
        session.commit()
        assert session.query(TimeEntry).filter(TimeEntry.ended_at.is_(None)).count() == 1


def test_two_connections_racing_cannot_commit_two_active_entries(migration_engine):
    migrate_sqlite_latest(migration_engine)
    with Session(migration_engine) as session:
        tasks = [Task(title=str(i)) for i in range(2)]
        session.add_all(tasks); session.commit(); identifiers = [task.id for task in tasks]
    barrier = Barrier(2)

    def insert(identifier):
        with Session(migration_engine) as session:
            session.add(TimeEntry(task_id=identifier, started_at=NOW))
            barrier.wait(timeout=5)
            try:
                session.commit()
                return 'committed'
            except IntegrityError:
                session.rollback()
                return 'constraint'

    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(insert, identifiers)) == ['committed', 'constraint']


@pytest.mark.parametrize('source', ['revision_003', 'schema_b', 'fresh'])
@pytest.mark.parametrize('failure', ['copy', 'drop', 'rename', 'status', 'revision'])
def test_failure_rolls_back_every_pending_revision_and_ddl(migration_engine, source, failure):
    if source != 'fresh':
        build_source(migration_engine, source)
    before = snapshot(migration_engine)

    def fail_after_statement(connection, cursor, statement, parameters, context, executemany):
        should_fail = (
            failure == 'copy' and statement.startswith('INSERT INTO time_entries__migration_004')
            or failure == 'drop' and statement == 'DROP TABLE time_entries'
            or failure == 'rename' and statement.startswith('ALTER TABLE time_entries__migration_004 RENAME')
            or failure == 'status' and statement.startswith('UPDATE tasks SET status')
            or failure == 'revision' and statement.startswith('INSERT INTO schema_migrations') and parameters[0] == REVISION
        )
        if should_fail:
            raise RuntimeError('Controlled 004 failure')

    event.listen(migration_engine, 'after_cursor_execute', fail_after_statement)
    try:
        with pytest.raises(RuntimeError, match='Controlled 004 failure'):
            migrate_sqlite_latest(migration_engine)
    finally:
        event.remove(migration_engine, 'after_cursor_execute', fail_after_statement)
    assert snapshot(migration_engine) == before
    with migration_engine.connect() as connection:
        assert connection.exec_driver_sql('PRAGMA foreign_keys').scalar_one() == 1


@pytest.mark.parametrize('source', ['revision_003', 'schema_b'])
def test_003_is_frozen_against_future_orm_columns(migration_engine, monkeypatch, source):
    build_source(migration_engine, source)
    # The old implementation read these live ORM objects even for a completed revision.
    monkeypatch.setattr(models, 'Task', SimpleNamespace(__table__=SimpleNamespace(columns={'future_column': None})))
    monkeypatch.setattr(models, 'TimeEntry', None)
    before = snapshot(migration_engine)
    migrate_sqlite_v1a(migration_engine)
    if source == 'revision_003':
        assert snapshot(migration_engine) == before
    else:
        with migration_engine.connect() as connection:
            assert 'status' not in [row[1] for row in connection.exec_driver_sql('PRAGMA table_info(tasks)')]
            assert 'start_at' in [row[1] for row in connection.exec_driver_sql('PRAGMA table_info(time_entries)')]


@pytest.mark.parametrize('extra', ['column', 'trigger', 'index'])
def test_unknown_source_metadata_is_not_discarded(migration_engine, extra):
    build_source(migration_engine)
    with migration_engine.begin() as connection:
        if extra == 'column':
            connection.exec_driver_sql('ALTER TABLE time_entries ADD COLUMN custom_note TEXT')
        elif extra == 'trigger':
            connection.exec_driver_sql('CREATE TRIGGER entry_trigger AFTER INSERT ON time_entries BEGIN SELECT 1; END')
        else:
            connection.exec_driver_sql('CREATE INDEX entry_old_start ON time_entries(start_at)')
    before = snapshot(migration_engine)
    with pytest.raises(MigrationError):
        migrate_sqlite_latest(migration_engine)
    assert snapshot(migration_engine) == before


def test_completed_revision_with_missing_active_index_fails_without_repair(migration_engine):
    migrate_sqlite_latest(migration_engine)
    with migration_engine.begin() as connection:
        connection.exec_driver_sql(f'DROP INDEX {ACTIVE_INDEX}')
    before = snapshot(migration_engine)
    with pytest.raises(MigrationError, match='index is missing'):
        migrate_sqlite_latest(migration_engine)
    assert snapshot(migration_engine) == before


def test_migrated_history_get_returns_new_and_legacy_fields(migration_engine, client, monkeypatch):
    build_source(migration_engine)
    migrate_sqlite_latest(migration_engine)
    monkeypatch.setattr(main, 'SessionLocal', sessionmaker(bind=migration_engine))
    with migration_engine.connect() as connection:
        task_id = connection.exec_driver_sql('SELECT task_id FROM time_entries ORDER BY id LIMIT 1').scalar_one()
    response = client.get(f'/tasks/{task_id}/time-entries')
    assert response.status_code == 200
    for entry in response.json():
        assert entry['startedAt'] == entry['startAt']
        assert entry['endedAt'] == entry['endAt']
        assert entry['updatedAt'] == entry['createdAt']
        start = datetime.fromisoformat(entry['startedAt'].replace('Z', '+00:00'))
        end = datetime.fromisoformat(entry['endedAt'].replace('Z', '+00:00'))
        assert entry['durationMinutes'] == int((end - start).total_seconds() // 60)


def test_active_get_and_aggregates_include_elapsed_time(client, SessionLocal, monkeypatch):
    monkeypatch.setattr(main, '_utc_now', lambda: NOW + timedelta(minutes=18, seconds=59))
    project = client.post('/projects', json={'name': 'Read compatibility'}).json()
    task = client.post('/tasks', json={'title': 'Read task', 'estimatedMinutes': 30,
                                     'projectId': project['id'], 'plannedDate': '2026-10-02'}).json()
    with SessionLocal() as session:
        session.add_all([
            TimeEntry(task_id=task['id'], project_id_snapshot=project['id'], started_at=NOW,
                      ended_at=NOW + timedelta(minutes=10, seconds=59)),
            TimeEntry(task_id=task['id'], project_id_snapshot=None, started_at=NOW + timedelta(minutes=11)),
        ])
        session.commit()
    response = client.get(f"/tasks/{task['id']}/time-entries")
    assert response.status_code == 200
    closed, active = response.json()
    assert closed['startedAt'] == closed['startAt'] and closed['endedAt'] == closed['endAt']
    assert closed['durationMinutes'] == 10
    assert active['endedAt'] is active['endAt'] is active['durationMinutes'] is None
    assert active['startedAt'] == active['startAt'] and active['projectIdSnapshot'] is None
    assert active['createdAt'] and active['updatedAt']
    assert client.get(f"/tasks/{task['id']}/actual-minutes").json()['actualMinutes'] == 17
    assert client.get(f"/tasks/{task['id']}/diff").json()['differenceMinutes'] == -13
    assert client.get(f"/tasks/{task['id']}").json()['actualMinutes'] == 17
    assert client.get('/tasks').json()[0]['actualMinutes'] == 17
    assert client.get('/projects').json()[0]['actualMinutes'] == 10  # Active Snapshot is NULL.
    report = client.get('/reports/daily', params={'date': '2026-10-02', 'timezone': 'UTC'})
    assert report.status_code == 200 and report.json()['dailyActualMinutes'] == 17


def test_completion_status_sync_keeps_snapshot_semantics(client, monkeypatch):
    monkeypatch.setattr(main, '_utc_now', lambda: NOW)
    task = client.post('/tasks', json={'title': 'Status compatibility', 'estimatedMinutes': 45}).json()
    assert task['status'] == 'NOT_STARTED'
    complete = client.patch(f"/tasks/{task['id']}/complete", json={'completed': True}).json()
    assert complete['status'] == 'COMPLETED'
    assert complete['completedEstimateMinutes'] == 45
    assert datetime.fromisoformat(complete['completedAt'].replace('Z', '+00:00')) == NOW
    assert client.patch(f"/tasks/{task['id']}/complete", json={'completed': True}).json() == complete
    reset = client.patch(f"/tasks/{task['id']}/complete", json={'completed': False}).json()
    assert reset['status'] == 'NOT_STARTED' and reset['completedAt'] is reset['completedEstimateMinutes'] is None


def test_timer_lifecycle_inserts_active_then_updates_same_entry(client, SessionLocal, monkeypatch):
    task_id = client.post('/tasks', json={'title': 'DB lifecycle'}).json()['id']
    monkeypatch.setattr(main, '_utc_now', lambda: NOW)
    assert client.post('/tasks/time/start', json={'taskId': task_id}).status_code == 200
    with SessionLocal() as session:
        assert session.query(TimeEntry).count() == 1
        entry_id = session.query(TimeEntry).one().id
        assert session.query(TimeEntry).one().ended_at is None
        assert session.get(Task, task_id).status == 'IN_PROGRESS'
    monkeypatch.setattr(main, '_utc_now', lambda: NOW + timedelta(minutes=2))
    stopped = client.post('/tasks/time/stop', json={'taskId': task_id, 'endAt': (NOW + timedelta(minutes=2)).isoformat()})
    assert stopped.status_code == 200
    assert stopped.json()['id'] == entry_id
    assert stopped.json()['startedAt'] == stopped.json()['startAt']
    assert stopped.json()['endedAt'] == stopped.json()['endAt']
    assert stopped.json()['durationMinutes'] == 2
    with SessionLocal() as session:
        assert session.query(TimeEntry).count() == 1
        assert session.query(TimeEntry).one().ended_at is not None
        assert session.get(Task, task_id).status == 'IN_PROGRESS'
    assert client.get('/tasks/time/active').json()['running'] is False


def test_entry_updated_at_on_update_and_duration_is_not_a_column(SessionLocal, monkeypatch):
    clock = NOW

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock if tz else clock.replace(tzinfo=None)

    monkeypatch.setattr(models, 'datetime', Clock)
    with SessionLocal() as session:
        task = Task(title='Update timestamp'); session.add(task); session.flush()
        entry = TimeEntry(task_id=task.id, started_at=NOW)
        session.add(entry); session.commit()
        assert main._as_utc(entry.created_at) == main._as_utc(entry.updated_at) == NOW
        assert entry.duration_minutes is None
        clock = NOW + timedelta(seconds=30)
        entry.ended_at = clock
        session.commit()
        assert main._as_utc(entry.created_at) == NOW and main._as_utc(entry.updated_at) == clock
        assert entry.duration_minutes == 0
        assert 'duration_minutes' not in TimeEntry.__table__.columns
        with pytest.raises(AttributeError):
            entry.duration_minutes = 1
