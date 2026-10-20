"""Persistent Timer lifecycle, concurrency and failure checks on isolated SQLite only."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
from threading import Barrier
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import event, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from app import main
from app.models import Task, TimeEntry
from helpers.current_schema import migrate_current_test_schema as migrate_sqlite_latest


START = datetime(2026, 10, 2, 10, tzinfo=timezone.utc)


@pytest.fixture
def clock(monkeypatch):
    value = SimpleNamespace(now=START)
    monkeypatch.setattr(main, '_utc_now', lambda: value.now)
    return value


def create_task(client, **fields):
    response = client.post('/tasks', json={'title': 'Persistent timer', 'estimatedMinutes': 30,
                                         'plannedDate': '2026-10-02', **fields})
    assert response.status_code == 201, response.text
    return response.json()['id']


def saved_values(factory):
    with factory() as session:
        return {
            table: session.execute(text(f'SELECT * FROM "{table}" ORDER BY rowid')).all()
            for table in inspect(session.bind).get_table_names()
        }


def entries(client, task_id):
    response = client.get(f'/tasks/{task_id}/time-entries')
    assert response.status_code == 200, response.text
    return response.json()


def utc(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def test_start_pause_resume_stop_status_and_snapshots(client, SessionLocal, clock):
    a = client.post('/projects', json={'name': 'A'}).json()['id']
    b = client.post('/projects', json={'name': 'B'}).json()['id']
    task_id = create_task(client, projectId=a)
    assert entries(client, task_id) == []
    started = client.post('/tasks/time/start', json={'taskId': task_id})
    assert started.status_code == 200
    assert started.json() == {'taskId': task_id, 'running': True, 'startedAt': START.isoformat()}
    first = entries(client, task_id)[0]
    assert first['endedAt'] is first['endAt'] is first['durationMinutes'] is None
    assert first['projectIdSnapshot'] == a
    assert utc(first['startedAt']) == utc(first['createdAt']) == utc(first['updatedAt']) == START
    assert client.get(f'/tasks/{task_id}').json()['status'] == 'IN_PROGRESS'
    assert client.get('/tasks/time/active').json() == started.json()
    clock.now += timedelta(minutes=5)
    assert client.put(f'/tasks/{task_id}', json={'projectId': b}).status_code == 200
    assert entries(client, task_id) == [first]
    clock.now = START + timedelta(minutes=30)
    pause = client.post('/tasks/time/stop', json={'taskId': task_id, 'endAt': '2099-01-01T00:00:00Z'})
    assert pause.status_code == 200
    assert pause.json()['id'] == first['id']
    assert pause.json()['projectIdSnapshot'] == a
    assert utc(pause.json()['endedAt']) == utc(pause.json()['updatedAt']) == clock.now
    for field in ('startedAt', 'startAt', 'createdAt', 'taskId'):
        assert pause.json()[field] == first[field]
    assert client.get('/tasks/time/active').json() == {'taskId': None, 'running': False, 'startedAt': None}
    assert client.get(f'/tasks/{task_id}').json()['status'] == 'IN_PROGRESS'
    clock.now = START + timedelta(minutes=45)
    assert client.post('/tasks/time/start', json={'taskId': task_id}).status_code == 200
    second = entries(client, task_id)[1]
    assert second['id'] != first['id'] and second['projectIdSnapshot'] == b
    assert entries(client, task_id)[0] == pause.json()
    assert client.put(f'/tasks/{task_id}', json={'projectId': None}).status_code == 200
    clock.now = START + timedelta(minutes=70)
    stopped = client.post('/tasks/time/stop', json={'taskId': task_id})
    assert stopped.status_code == 200
    assert stopped.json()['id'] == second['id'] and stopped.json()['projectIdSnapshot'] == b
    assert stopped.json()['durationMinutes'] == 25
    assert client.get(f'/tasks/{task_id}').json()['status'] == 'IN_PROGRESS'
    with SessionLocal() as session:
        assert session.query(TimeEntry).count() == 2
        assert session.query(TimeEntry).filter(TimeEntry.ended_at.is_(None)).count() == 0
    complete = client.patch(f'/tasks/{task_id}/complete', json={'completed': True})
    assert complete.status_code == 200 and complete.json()['status'] == 'COMPLETED'
    assert complete.json()['completedEstimateMinutes'] == 30
    assert utc(complete.json()['completedAt']) == clock.now
    reset = client.patch(f'/tasks/{task_id}/complete', json={'completed': False})
    assert reset.status_code == 200 and reset.json()['status'] == 'NOT_STARTED'
    assert reset.json()['completedAt'] is reset.json()['completedEstimateMinutes'] is None
    assert entries(client, task_id) == [pause.json(), stopped.json()]


@pytest.mark.parametrize('seconds', [0, 1, 30, 59, 60])
def test_short_timer_closes_same_entry_and_ignores_client_end(client, clock, seconds):
    task_id = create_task(client)
    assert client.post('/tasks/time/start', json={'taskId': task_id}).status_code == 200
    before = entries(client, task_id)[0]
    clock.now += timedelta(seconds=seconds)
    response = client.post('/tasks/time/stop', json={'taskId': task_id, 'endAt': '1900-01-01T00:00:00Z'})
    assert response.status_code == 200
    assert response.json()['id'] == before['id']
    assert response.json()['durationMinutes'] == seconds // 60
    assert utc(response.json()['endedAt']) == utc(response.json()['updatedAt']) == clock.now
    assert response.json()['createdAt'] == before['createdAt']
    assert entries(client, task_id) == [response.json()]


def test_clock_reversal_rolls_back_and_active_can_be_stopped_later(client, SessionLocal, clock):
    task_id = create_task(client)
    client.post('/tasks/time/start', json={'taskId': task_id})
    before = saved_values(SessionLocal)
    active = client.get('/tasks/time/active').json()
    clock.now = START - timedelta(seconds=1)
    response = client.post('/tasks/time/stop', json={'taskId': task_id})
    assert response.status_code == 409
    assert saved_values(SessionLocal) == before
    assert client.get('/tasks/time/active').json() == active
    clock.now = START + timedelta(seconds=30)
    assert client.post('/tasks/time/stop', json={'taskId': task_id}).status_code == 200


def test_wrong_task_and_repeated_stop_do_not_change_entries(client, SessionLocal, clock):
    a, b = create_task(client), create_task(client)
    assert client.post('/tasks/time/stop', json={'taskId': a}).status_code == 409
    assert client.post('/tasks/time/start', json={'taskId': a}).status_code == 200
    before = saved_values(SessionLocal)
    for task_id in (b, 999999):
        assert client.post('/tasks/time/stop', json={'taskId': task_id}).status_code == 409
        assert saved_values(SessionLocal) == before
    clock.now += timedelta(minutes=2)
    assert client.post('/tasks/time/stop', json={'taskId': a}).status_code == 200
    before = saved_values(SessionLocal)
    assert client.post('/tasks/time/stop', json={'taskId': a}).status_code == 409
    assert saved_values(SessionLocal) == before


@pytest.mark.parametrize('status,completed', [('COMPLETED', True), ('COMPLETED', False),
                                             ('NOT_STARTED', True), ('IN_PROGRESS', True)])
def test_completed_status_or_legacy_flag_rejects_start(client, SessionLocal, clock, status, completed):
    task_id = create_task(client)
    with SessionLocal() as session:
        task = session.get(Task, task_id)
        task.status, task.completed = status, completed
        session.commit()
    before = saved_values(SessionLocal)
    assert client.post('/tasks/time/start', json={'taskId': task_id}).status_code == 409
    assert saved_values(SessionLocal) == before


def test_completed_task_cannot_resume_a_closed_interval(client, SessionLocal, clock):
    task_id = create_task(client)
    client.post('/tasks/time/start', json={'taskId': task_id})
    clock.now += timedelta(minutes=1)
    assert client.post('/tasks/time/stop', json={'taskId': task_id}).status_code == 200
    assert client.patch(f'/tasks/{task_id}/complete', json={'completed': True}).status_code == 200
    before = saved_values(SessionLocal)
    assert client.post('/tasks/time/start', json={'taskId': task_id}).status_code == 409
    assert saved_values(SessionLocal) == before


def test_active_completion_is_rejected_only_for_its_own_task(client, SessionLocal, clock):
    a, b = create_task(client), create_task(client)
    assert client.post('/tasks/time/start', json={'taskId': a}).status_code == 200
    before = saved_values(SessionLocal)
    response = client.patch(f'/tasks/{a}/complete', json={'completed': True})
    assert response.status_code == 409
    assert saved_values(SessionLocal) == before
    task = client.get(f'/tasks/{a}').json()
    assert task['status'] == 'IN_PROGRESS' and task['completed'] is False
    assert task['completedAt'] is task['completedEstimateMinutes'] is None
    assert client.patch(f'/tasks/{b}/complete', json={'completed': True}).status_code == 200
    assert client.get('/tasks/time/active').json()['taskId'] == a
    # Sending an unchanged completed=false is still a no-op, preserving IN_PROGRESS.
    assert client.patch(f'/tasks/{a}/complete', json={'completed': False}).json()['status'] == 'IN_PROGRESS'


def test_start_is_reflected_in_reports_and_stop_freezes_same_duration(client, SessionLocal, clock):
    project = client.post('/projects', json={'name': 'Report integration'}).json()['id']
    task_id = create_task(client, projectId=project)
    assert client.post('/tasks/time/start', json={'taskId': task_id}).status_code == 200
    active = entries(client, task_id)[0]
    assert active['endedAt'] is active['endAt'] is active['durationMinutes'] is None
    assert client.get(f'/tasks/{task_id}/actual-minutes').json()['actualMinutes'] == 0
    clock.now += timedelta(minutes=7, seconds=59)

    def assert_seven():
        assert client.get(f'/tasks/{task_id}/actual-minutes').json()['actualMinutes'] == 7
        assert client.get(f'/tasks/{task_id}/diff').json()['differenceMinutes'] == -23
        assert client.get('/projects').json()[0]['actualMinutes'] == 7
        daily = client.get('/reports/daily', params={'date': '2026-10-02', 'timezone': 'UTC'})
        assert daily.status_code == 200 and daily.json()['dailyActualMinutes'] == 7

    before = saved_values(SessionLocal)
    assert_seven()
    assert saved_values(SessionLocal) == before
    stopped = client.post('/tasks/time/stop', json={'taskId': task_id})
    assert stopped.status_code == 200 and stopped.json()['id'] == active['id']
    assert stopped.json()['durationMinutes'] == 7
    clock.now += timedelta(hours=3)
    assert_seven()


def parallel_requests(engine, requests):
    # Synchronize separate SQL connections immediately before BEGIN IMMEDIATE,
    # so both HTTP operations contend for the same SQLite writer lock.
    barrier = Barrier(2)

    def meet(connection, cursor, statement, parameters, context, executemany):
        if statement == 'BEGIN IMMEDIATE':
            barrier.wait(timeout=10)

    event.listen(engine, 'before_cursor_execute', meet)
    try:
        def request(item):
            method, path, body = item
            with TestClient(main.app) as client:
                return client.request(method, path, json=body)

        with ThreadPoolExecutor(max_workers=2) as executor:
            return list(executor.map(request, requests))
    finally:
        event.remove(engine, 'before_cursor_execute', meet)


@pytest.mark.parametrize('same_task', [False, True])
def test_concurrent_start_commits_one_and_rolls_back_loser(client, SessionLocal, clock, same_task):
    a, b = create_task(client), create_task(client)
    before = saved_values(SessionLocal)
    results = parallel_requests(SessionLocal.kw['bind'], [
        ('POST', '/tasks/time/start', {'taskId': a}),
        ('POST', '/tasks/time/start', {'taskId': a if same_task else b}),
    ])
    assert sorted(response.status_code for response in results) == [200, 409]
    winner = next(response.json()['taskId'] for response in results if response.status_code == 200)
    with SessionLocal() as session:
        assert session.query(TimeEntry).count() == 1
        assert session.query(TimeEntry).one().task_id == winner
        assert session.query(TimeEntry).one().ended_at is None
        assert session.get(Task, winner).status == 'IN_PROGRESS'
        other = b if winner == a else a
        assert session.get(Task, other).status == 'NOT_STARTED'
    assert next(row for row in saved_values(SessionLocal)['tasks'] if row[0] == other) == next(
        row for row in before['tasks'] if row[0] == other)


def test_concurrent_stop_updates_once_and_preserves_entry_id(client, SessionLocal, clock):
    task_id = create_task(client)
    client.post('/tasks/time/start', json={'taskId': task_id})
    original = entries(client, task_id)[0]
    clock.now += timedelta(seconds=30)
    engine = SessionLocal.kw['bind']
    updates = []

    def record(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith('UPDATE time_entries'):
            updates.append(statement)

    event.listen(engine, 'after_cursor_execute', record)
    try:
        results = parallel_requests(engine, [('POST', '/tasks/time/stop', {'taskId': task_id})] * 2)
    finally:
        event.remove(engine, 'after_cursor_execute', record)
    assert sorted(response.status_code for response in results) == [200, 409]
    assert len(updates) == 1
    closed = entries(client, task_id)
    assert len(closed) == 1 and closed[0]['id'] == original['id']
    assert utc(closed[0]['endedAt']) == utc(closed[0]['updatedAt']) == clock.now
    assert client.get('/tasks/time/active').json()['running'] is False


def test_concurrent_start_and_completion_never_leave_completed_active_task(client, SessionLocal, clock):
    task_id = create_task(client)
    start, complete = parallel_requests(SessionLocal.kw['bind'], [
        ('POST', '/tasks/time/start', {'taskId': task_id}),
        ('PATCH', f'/tasks/{task_id}/complete', {'completed': True}),
    ])
    assert sorted([start.status_code, complete.status_code]) == [200, 409]
    with SessionLocal() as session:
        task = session.get(Task, task_id)
        if start.status_code == 200:
            assert task.status == 'IN_PROGRESS' and not task.completed
            assert task.completed_at is task.completed_estimate_minutes is None
            assert session.query(TimeEntry).filter(TimeEntry.ended_at.is_(None)).count() == 1
        else:
            assert task.status == 'COMPLETED' and task.completed
            assert session.query(TimeEntry).count() == 0


def test_concurrent_start_and_task_delete_do_not_leave_orphan_active(client, SessionLocal, clock):
    task_id = create_task(client)
    started, deleted = parallel_requests(SessionLocal.kw['bind'], [
        ('POST', '/tasks/time/start', {'taskId': task_id}),
        ('DELETE', f'/tasks/{task_id}', None),
    ])
    assert (started.status_code, deleted.status_code) in ((200, 409), (404, 200))
    with SessionLocal() as session:
        count = 1 if started.status_code == 200 else 0
        assert session.query(Task).count() == session.query(TimeEntry).count() == count
    assert client.get('/tasks/time/active').json()['running'] is (started.status_code == 200)


def test_concurrent_start_and_project_delete_preserve_or_avoid_snapshot(client, SessionLocal, clock):
    project_id = client.post('/projects', json={'name': 'Concurrent project'}).json()['id']
    task_id = create_task(client, projectId=project_id)
    started, deleted = parallel_requests(SessionLocal.kw['bind'], [
        ('POST', '/tasks/time/start', {'taskId': task_id}),
        ('DELETE', f'/projects/{project_id}', None),
    ])
    assert started.status_code == 200
    assert deleted.status_code in (200, 409)
    with SessionLocal() as session:
        entry = session.query(TimeEntry).one()
        assert entry.task_id == task_id and entry.ended_at is None
        expected_project = project_id if deleted.status_code == 409 else None
        assert entry.project_id_snapshot == session.get(Task, task_id).project_id == expected_project
    assert any(project['id'] == project_id for project in client.get('/projects').json()) is (deleted.status_code == 409)


def test_database_unique_failure_is_409_and_does_not_change_status(client, SessionLocal, clock, monkeypatch):
    a, b = create_task(client), create_task(client)
    assert client.post('/tasks/time/start', json={'taskId': a}).status_code == 200
    before = saved_values(SessionLocal)
    # Bypass the advisory check to exercise the actual unique IntegrityError path.
    with monkeypatch.context() as patch:
        patch.setattr(main, '_active_entry', lambda db, task_id=None: None)
        assert client.post('/tasks/time/start', json={'taskId': b}).status_code == 409
    assert saved_values(SessionLocal) == before
    assert client.get('/tasks/time/active').json()['taskId'] == a


@pytest.mark.parametrize('operation', ['start', 'stop', 'complete'])
def test_sqlite_writer_contention_is_409_without_changes(client, SessionLocal, clock, operation):
    task_id = create_task(client)
    if operation == 'stop':
        assert client.post('/tasks/time/start', json={'taskId': task_id}).status_code == 200
        clock.now += timedelta(minutes=1)
    engine = SessionLocal.kw['bind']
    before = saved_values(SessionLocal)

    def short_wait(connection, record):
        connection.execute('PRAGMA busy_timeout=20')

    event.listen(engine, 'connect', short_wait)
    try:
        with engine.connect() as holder:
            holder.exec_driver_sql('BEGIN IMMEDIATE')
            try:
                if operation == 'complete':
                    response = client.patch(f'/tasks/{task_id}/complete', json={'completed': True})
                else:
                    response = client.post(f'/tasks/time/{operation}', json={'taskId': task_id})
                assert response.status_code == 409
            finally:
                holder.rollback()
    finally:
        event.remove(engine, 'connect', short_wait)
    assert saved_values(SessionLocal) == before


@pytest.mark.parametrize('operation,failure', [('start', 'status'), ('start', 'insert'), ('start', 'commit'),
                                               ('stop', 'update'), ('stop', 'commit')])
def test_write_or_commit_failure_rolls_back_every_saved_value(client, SessionLocal, clock, monkeypatch, operation, failure):
    task_id = create_task(client)
    if operation == 'stop':
        assert client.post('/tasks/time/start', json={'taskId': task_id}).status_code == 200
        clock.now += timedelta(minutes=2)
    before = saved_values(SessionLocal)
    engine = SessionLocal.kw['bind']

    def fail_after_write(connection, cursor, statement, parameters, context, executemany):
        if ((failure == 'status' and statement.startswith('UPDATE tasks'))
                or (failure == 'insert' and statement.startswith('INSERT INTO time_entries'))
                or (failure == 'update' and statement.startswith('UPDATE time_entries'))):
            raise RuntimeError('Controlled write failure after SQL ran')

    class FailingCommit(Session):
        def commit(self):
            self.flush()
            raise RuntimeError('Controlled failure before commit')

    event.listen(engine, 'after_cursor_execute', fail_after_write)
    try:
        with monkeypatch.context() as patch:
            if failure == 'commit':
                patch.setattr(main, 'SessionLocal', sessionmaker(bind=engine, class_=FailingCommit, autoflush=False))
            with TestClient(main.app, raise_server_exceptions=False) as failing:
                response = failing.post(f'/tasks/time/{operation}', json={'taskId': task_id})
            assert response.status_code == 500
    finally:
        event.remove(engine, 'after_cursor_execute', fail_after_write)
    assert saved_values(SessionLocal) == before
    assert client.get('/tasks/time/active').json()['running'] == (operation == 'stop')
    # A clean retry uses the same persisted state and succeeds.
    assert client.post(f'/tasks/time/{operation}', json={'taskId': task_id}).status_code == 200


def test_unrelated_integrity_failure_is_not_misreported_as_active_conflict(client, SessionLocal, clock):
    task_id = create_task(client)
    engine = SessionLocal.kw['bind']
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TRIGGER reject_insert BEFORE INSERT ON time_entries "
                                   "BEGIN SELECT RAISE(ABORT, 'controlled storage fault'); END")
    before = saved_values(SessionLocal)
    with TestClient(main.app, raise_server_exceptions=False) as failing:
        assert failing.post('/tasks/time/start', json={'taskId': task_id}).status_code == 500
    assert saved_values(SessionLocal) == before


def test_active_and_status_survive_fresh_python_process_and_stop(client, SessionLocal, clock):
    engine = SessionLocal.kw['bind']
    # Record 003/004 before populating this metadata-created temporary DB.
    migrate_sqlite_latest(engine)
    task_id = create_task(client)
    assert client.post('/tasks/time/start', json={'taskId': task_id}).status_code == 200
    original = entries(client, task_id)[0]
    engine.dispose()
    script = '''
import json, os, sys
from datetime import datetime
from pathlib import Path
from sqlalchemy import event
from sqlalchemy.engine import Engine, URL
expected = Path(sys.argv[1]).resolve()
def guard(dialect, record, args, kwargs):
    if dialect.name != 'sqlite' or Path(args[0]).resolve() != expected:
        raise RuntimeError('Restart test attempted a connection outside its temporary DB')
event.listen(Engine, 'do_connect', guard)
os.environ['DATABASE_URL'] = URL.create('sqlite', database=str(expected)).render_as_string(hide_password=False)
from app import main
from fastapi.testclient import TestClient
main._utc_now = lambda: datetime.fromisoformat(sys.argv[3])
task = int(sys.argv[2])
with TestClient(main.app) as client:
    active = client.get('/tasks/time/active').json()
    before = client.get(f'/tasks/{task}').json()
    stopped = client.post('/tasks/time/stop', json={'taskId': task})
    assert stopped.status_code == 200, stopped.text
    print(json.dumps({'active': active, 'status': before['status'], 'stopped': stopped.json(),
                      'after': client.get('/tasks/time/active').json()}))
'''
    child_env = os.environ.copy()
    child_env['PYTHONDONTWRITEBYTECODE'] = '1'
    result = subprocess.run([sys.executable, '-B', '-c', script, str(engine.url.database), str(task_id),
                             (START + timedelta(minutes=7, seconds=59)).isoformat()],
                            cwd=Path(__file__).resolve().parents[1], env=child_env,
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    recovered = json.loads(result.stdout)
    assert recovered['active'] == {'taskId': task_id, 'running': True, 'startedAt': START.isoformat()}
    assert recovered['status'] == 'IN_PROGRESS'
    assert recovered['stopped']['id'] == original['id']
    assert recovered['stopped']['durationMinutes'] == 7
    assert recovered['after']['running'] is False
    assert entries(client, task_id) == [recovered['stopped']]
    assert client.get(f'/tasks/{task_id}').json()['status'] == 'IN_PROGRESS'


def test_direct_database_active_is_the_only_source_and_reads_are_unchanged(client, SessionLocal, clock):
    task_id = create_task(client)
    with SessionLocal() as session:
        session.get(Task, task_id).status = 'IN_PROGRESS'
        session.add(TimeEntry(task_id=task_id, started_at=START, created_at=START, updated_at=START))
        session.commit()
    before = saved_values(SessionLocal)
    assert client.get('/tasks/time/active').json() == {'taskId': task_id, 'running': True, 'startedAt': START.isoformat()}
    assert client.get(f'/tasks/{task_id}').json()['actualStartedAt'] == START.isoformat().replace('+00:00', 'Z')
    assert saved_values(SessionLocal) == before
    assert not hasattr(main, '_active_timers') and not hasattr(main, '_ActiveTimer')
