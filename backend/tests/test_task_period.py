import pytest
from sqlalchemy import create_engine, inspect
from migrations.sqlite_project_tag_colors import migrate_sqlite_project_tag_colors
from migrations.sqlite_task_period import REVISION, migrate_sqlite_task_period
from migrations import sqlite_task_period
from migrations.sqlite_v1a import MigrationError


@pytest.mark.parametrize('period', [
    {'startDate': None, 'deadline': '2026-10-15'},
    {'startDate': '2026-12-04', 'deadline': '2026-12-08'},
    {'startDate': '2026-12-04', 'deadline': '2027-01-08'},
])
def test_period_update_and_fresh_list_and_single_reads(client, period):
    created = client.post('/tasks', json={'title': 'Reload period', 'deadline': '2026-10-15'})
    assert created.status_code == 201
    task_id = created.json()['id']
    updated = client.put(f'/tasks/{task_id}', json=period)
    assert updated.status_code == 200
    for key, value in period.items():
        assert updated.json()[key] == value
    # Every HTTP request opens a fresh Session, including the reload-equivalent reads.
    for _ in range(2):
        single = client.get(f'/tasks/{task_id}')
        listed = client.get('/tasks')
        assert single.status_code == 200
        assert listed.status_code == 200
        assert single.json() == updated.json()
        assert next(task for task in listed.json() if task['id'] == task_id) == updated.json()


@pytest.mark.parametrize('period', [{}, {'deadline': '2026-10-20'}, {'startDate': '2026-10-12', 'deadline': '2026-10-20'}, {'startDate': '2026-10-20', 'deadline': '2026-10-20'}])
def test_create_read_period_without_schedule(client, period):
    response = client.post('/tasks', json={'title': 'Period task', **period})
    assert response.status_code == 201
    task = response.json()
    assert task['startDate'] == period.get('startDate')
    assert task['deadline'] == period.get('deadline')
    assert client.get(f"/tasks/{task['id']}").json() == task
    assert client.get('/schedule-blocks').json() == []


def test_partial_update_checks_stored_other_date_and_preserves_metadata(client):
    task = client.post('/tasks', json={'title': 'Keep', 'startDate': '2026-10-12', 'deadline': '2026-10-20', 'estimatedMinutes': 60}).json()
    url = f"/tasks/{task['id']}"
    for invalid in [{'startDate': '2026-10-21'}, {'deadline': '2026-10-11'}]:
        assert client.put(url, json=invalid).status_code == 422
        assert client.get(url).json() == task
    updated = client.put(url, json={'title': 'Renamed'}).json()
    assert (updated['startDate'], updated['deadline'], updated['estimatedMinutes']) == ('2026-10-12', '2026-10-20', 60)
    cleared = client.put(url, json={'startDate': None, 'deadline': None}).json()
    assert cleared['startDate'] is None and cleared['deadline'] is None
    assert client.delete(url).status_code == 200


@pytest.mark.parametrize('value', ['20260230', '2026-02-30', '2026-1-01', '2026/10/12', '1999-12-31', '2101-01-01', 'abc', 1, True])
def test_invalid_start_date_never_writes(client, value):
    task = client.post('/tasks', json={'title': 'Unchanged'}).json()
    assert client.post('/tasks', json={'title': 'Invalid', 'startDate': value}).status_code == 422
    assert client.put(f"/tasks/{task['id']}", json={'startDate': value}).status_code == 422
    assert client.get(f"/tasks/{task['id']}").json() == task


def old_database(tmp_path):
    engine = create_engine(f'sqlite:///{(tmp_path / "period-migration.db").as_posix()}')
    migrate_sqlite_project_tag_colors(engine, allow_pending=True, allow_tags_pending=True, allow_metadata_pending=True)
    with engine.begin() as c:
        c.exec_driver_sql("INSERT INTO tasks (title,completed,status,created_at,updated_at) VALUES ('Existing',0,'NOT_STARTED','2026-10-01','2026-10-01')")
    return engine


def test_pending_008_guard_makes_no_changes(tmp_path):
    engine = old_database(tmp_path)
    try:
        with pytest.raises(MigrationError, match='008_task_start_date'):
            migrate_sqlite_task_period(engine)
        assert 'start_date' not in {c['name'] for c in inspect(engine).get_columns('tasks')}
        with engine.connect() as c:
            assert REVISION not in c.exec_driver_sql('SELECT revision FROM schema_migrations').scalars().all()
    finally:
        engine.dispose()


def test_008_nullable_existing_rows_and_idempotence(tmp_path):
    engine = old_database(tmp_path)
    try:
        migrate_sqlite_task_period(engine, allow_pending=True)
        column = next(c for c in inspect(engine).get_columns('tasks') if c['name'] == 'start_date')
        assert column['nullable'] and column['default'] is None
        with engine.begin() as c:
            assert c.exec_driver_sql('SELECT start_date FROM tasks').scalar() is None
            c.exec_driver_sql("UPDATE tasks SET start_date='2026-10-12' WHERE id=1")
        migrate_sqlite_task_period(engine)
        with engine.connect() as c:
            assert c.exec_driver_sql('SELECT start_date FROM tasks').scalar() == '2026-10-12'
            assert c.exec_driver_sql('PRAGMA foreign_key_check').all() == []
    finally:
        engine.dispose()


def test_008_failure_rolls_back_column_and_revision(tmp_path, monkeypatch):
    engine = old_database(tmp_path)
    try:
        def fail(*args):
            raise RuntimeError('Injected recording failure')
        monkeypatch.setattr(sqlite_task_period, '_record', fail)
        with pytest.raises(RuntimeError, match='Injected'):
            migrate_sqlite_task_period(engine, allow_pending=True)
        assert 'start_date' not in {c['name'] for c in inspect(engine).get_columns('tasks')}
        with engine.connect() as c:
            assert c.exec_driver_sql('SELECT title FROM tasks').scalar() == 'Existing'
    finally:
        engine.dispose()
