"""Snapshot capture through the persisted start/stop interval lifecycle."""

from datetime import datetime, timedelta, timezone

import pytest

from app import main
from app.models import Task, TimeEntry


START = datetime(2026, 10, 2, 1, tzinfo=timezone.utc)


def create_project(client, name):
    response = client.post('/projects', json={'name': name})
    assert response.status_code == 200, response.text
    return response.json()['id']


def create_task(client, project_id=None):
    response = client.post('/tasks', json={'title': 'Snapshot task', 'projectId': project_id})
    assert response.status_code == 201, response.text
    return response.json()['id']


def start(client, monkeypatch, task_id, started_at=START, **extra):
    monkeypatch.setattr(main, '_utc_now', lambda: started_at)
    response = client.post('/tasks/time/start', json={'taskId': task_id, **extra})
    assert response.status_code == 200, response.text
    assert response.json() == {'taskId': task_id, 'running': True, 'startedAt': started_at.isoformat()}
    return response.json()


def stop(client, monkeypatch, task_id, end_at=START + timedelta(minutes=2), **extra):
    monkeypatch.setattr(main, '_utc_now', lambda: end_at)
    response = client.post('/tasks/time/stop', json={'taskId': task_id, 'endAt': end_at.isoformat(), **extra})
    assert response.status_code == 200, response.text
    return response.json()


def set_project(client, task_id, project_id):
    response = client.put(f'/tasks/{task_id}', json={'projectId': project_id})
    assert response.status_code == 200, response.text
    assert response.json()['projectId'] == project_id


def assert_saved_entry(SessionLocal, entry, project_id):
    assert entry['projectIdSnapshot'] == project_id
    with SessionLocal() as session:
        stored = session.get(TimeEntry, entry['id'])
        assert stored.project_id_snapshot == project_id
        assert stored.task_id == entry['taskId']
        assert main._as_utc(stored.started_at) == datetime.fromisoformat(entry['startAt'].replace('Z', '+00:00'))
        assert main._as_utc(stored.ended_at) == datetime.fromisoformat(entry['endAt'].replace('Z', '+00:00'))
        assert stored.duration_minutes == entry['durationMinutes']


@pytest.mark.parametrize('has_project', [True, False])
def test_start_captures_project_or_null_and_stop_returns_it(client, SessionLocal, monkeypatch, has_project):
    project_id = create_project(client, 'Project A') if has_project else None
    task_id = create_task(client, project_id)
    start(client, monkeypatch, task_id)
    # Start commits the Active interval and its Snapshot before responding.
    with SessionLocal() as session:
        assert session.query(TimeEntry).count() == 1
        assert session.query(TimeEntry).one().project_id_snapshot == project_id
        assert session.query(TimeEntry).one().ended_at is None
    active = client.get('/tasks/time/active')
    assert active.status_code == 200
    assert active.json() == {'taskId': task_id, 'running': True, 'startedAt': START.isoformat()}
    task = client.get(f'/tasks/{task_id}').json()
    assert datetime.fromisoformat(task['actualStartedAt'].replace('Z', '+00:00')) == START
    entry = stop(client, monkeypatch, task_id)
    assert entry['durationMinutes'] == 2
    assert_saved_entry(SessionLocal, entry, project_id)
    listed = client.get(f'/tasks/{task_id}/time-entries')
    assert listed.status_code == 200
    assert listed.json() == [entry]
    assert client.get('/tasks/time/active').json()['running'] is False


@pytest.mark.parametrize('change', ['other_project', 'unassigned'])
def test_stop_uses_start_membership_after_task_change(client, SessionLocal, monkeypatch, change):
    project_a = create_project(client, 'Project A')
    project_b = create_project(client, 'Project B') if change == 'other_project' else None
    task_id = create_task(client, project_a)
    start(client, monkeypatch, task_id)
    set_project(client, task_id, project_b)
    entry = stop(client, monkeypatch, task_id)
    assert_saved_entry(SessionLocal, entry, project_a)
    assert client.get(f'/tasks/{task_id}').json()['projectId'] == project_b


def test_unassigned_start_stays_null_after_assignment(client, SessionLocal, monkeypatch):
    project_a = create_project(client, 'Project A')
    task_id = create_task(client)
    start(client, monkeypatch, task_id)
    set_project(client, task_id, project_a)
    entry = stop(client, monkeypatch, task_id)
    assert_saved_entry(SessionLocal, entry, None)


def test_task_project_change_does_not_rewrite_existing_entry(client, SessionLocal, monkeypatch):
    project_a = create_project(client, 'Project A')
    project_b = create_project(client, 'Project B')
    task_id = create_task(client, project_a)
    start(client, monkeypatch, task_id)
    entry = stop(client, monkeypatch, task_id)
    set_project(client, task_id, project_b)
    assert_saved_entry(SessionLocal, entry, project_a)
    assert client.get(f'/tasks/{task_id}/time-entries').json() == [entry]


def test_pause_resume_uses_each_interval_start_project(client, SessionLocal, monkeypatch):
    project_a = create_project(client, 'Project A')
    project_b = create_project(client, 'Project B')
    task_id = create_task(client, project_a)
    start(client, monkeypatch, task_id)
    # The existing UI uses stop for Pause and start for Resume.
    first = stop(client, monkeypatch, task_id)
    set_project(client, task_id, project_b)
    resumed_at = START + timedelta(minutes=10)
    start(client, monkeypatch, task_id, resumed_at)
    second = stop(client, monkeypatch, task_id, resumed_at + timedelta(minutes=3))
    assert first['id'] != second['id']
    assert first['durationMinutes'] == 2
    assert second['durationMinutes'] == 3
    assert_saved_entry(SessionLocal, first, project_a)
    assert_saved_entry(SessionLocal, second, project_b)
    assert client.get(f'/tasks/{task_id}/time-entries').json() == [first, second]
    assert client.get(f'/tasks/{task_id}/actual-minutes').json()['actualMinutes'] == 5


@pytest.mark.parametrize('delete_while_active', [True, False])
def test_project_deletion_is_rejected_and_retains_historical_snapshot(client, SessionLocal, monkeypatch, delete_while_active):
    project_a = create_project(client, 'Project A')
    task_id = create_task(client, project_a)
    start(client, monkeypatch, task_id)
    if not delete_while_active:
        entry = stop(client, monkeypatch, task_id)
    assert client.delete(f'/projects/{project_a}').status_code == 409
    assert client.get(f'/tasks/{task_id}').json()['projectId'] == project_a
    if delete_while_active:
        entry = stop(client, monkeypatch, task_id)
    assert_saved_entry(SessionLocal, entry, project_a)
    assert client.get(f'/tasks/{task_id}/time-entries').json() == [entry]


@pytest.mark.parametrize('field', ['projectIdSnapshot', 'project_id_snapshot'])
def test_client_cannot_choose_snapshot_on_start_or_stop(client, SessionLocal, monkeypatch, field):
    project_a = create_project(client, 'Project A')
    project_b = create_project(client, 'Spoofed project')
    task_id = create_task(client, project_a)
    start(client, monkeypatch, task_id, **{field: project_b})
    entry = stop(client, monkeypatch, task_id, **{field: project_b})
    assert_saved_entry(SessionLocal, entry, project_a)


def test_invalid_stop_and_rejected_restart_keep_original_capture(client, SessionLocal, monkeypatch):
    project_a = create_project(client, 'Project A')
    project_b = create_project(client, 'Project B')
    task_id = create_task(client, project_a)
    start(client, monkeypatch, task_id)
    set_project(client, task_id, project_b)
    monkeypatch.setattr(main, '_utc_now', lambda: START - timedelta(seconds=1))
    response = client.post('/tasks/time/stop', json={'taskId': task_id})
    assert response.status_code == 409
    repeated = client.post('/tasks/time/start', json={'taskId': task_id})
    assert repeated.status_code == 409
    with SessionLocal() as session:
        assert session.query(TimeEntry).count() == 1
        assert session.query(TimeEntry).one().ended_at is None
    entry = stop(client, monkeypatch, task_id)
    assert_saved_entry(SessionLocal, entry, project_a)


def test_switching_tasks_preserves_rejection_and_captures_next_task(client, SessionLocal, monkeypatch):
    project_a = create_project(client, 'Project A')
    project_b = create_project(client, 'Project B')
    task_a = create_task(client, project_a)
    task_b = create_task(client, project_b)
    start(client, monkeypatch, task_a)
    assert client.post('/tasks/time/start', json={'taskId': task_b}).status_code == 409
    first = stop(client, monkeypatch, task_a)
    second_start = START + timedelta(minutes=5)
    start(client, monkeypatch, task_b, second_start)
    second = stop(client, monkeypatch, task_b, second_start + timedelta(minutes=2))
    assert_saved_entry(SessionLocal, first, project_a)
    assert_saved_entry(SessionLocal, second, project_b)


def test_completion_rejection_keeps_timer_and_start_snapshot(client, SessionLocal, monkeypatch):
    project_a = create_project(client, 'Project A')
    project_b = create_project(client, 'Project B')
    task_id = create_task(client, project_a)
    start(client, monkeypatch, task_id)
    active = client.get('/tasks/time/active').json()
    complete = client.patch(f'/tasks/{task_id}/complete', json={'completed': True})
    assert complete.status_code == 409
    assert client.get('/tasks/time/active').json() == active
    set_project(client, task_id, project_b)
    entry = stop(client, monkeypatch, task_id)
    assert_saved_entry(SessionLocal, entry, project_a)
    assert client.get(f'/tasks/{task_id}').json()['completed'] is False
    assert client.patch(f'/tasks/{task_id}/complete', json={'completed': True}).status_code == 200


def test_task_deletion_preserves_active_entry_and_timer_lifecycle(client, monkeypatch, SessionLocal):
    project_a = create_project(client, 'Project A')
    task_id = create_task(client, project_a)
    start(client, monkeypatch, task_id)
    active = client.get('/tasks/time/active').json()
    assert client.delete(f'/tasks/{task_id}').status_code == 409
    assert client.get('/tasks/time/active').json() == active
    with SessionLocal() as session:
        assert session.query(TimeEntry).count() == 1
        assert session.get(Task, task_id) is not None
    new_task = create_task(client)
    assert client.post('/tasks/time/start', json={'taskId': new_task}).status_code == 409
    assert stop(client, monkeypatch, task_id)['projectIdSnapshot'] == project_a
    start(client, monkeypatch, new_task, started_at=START + timedelta(minutes=2))
    assert stop(client, monkeypatch, new_task, end_at=START + timedelta(minutes=4))['projectIdSnapshot'] is None


def test_existing_snapshot_response_does_not_use_current_task_project(client, SessionLocal):
    project_a = create_project(client, 'Current project')
    project_b = create_project(client, 'Historical project')
    task_id = create_task(client, project_a)
    with SessionLocal() as session:
        session.add_all([
            TimeEntry(task_id=task_id, project_id_snapshot=project_b, started_at=START,
                      ended_at=START + timedelta(minutes=2)),
            TimeEntry(task_id=task_id, project_id_snapshot=None, started_at=START + timedelta(minutes=3),
                      ended_at=START + timedelta(minutes=5)),
        ])
        session.commit()
    listed = client.get(f'/tasks/{task_id}/time-entries')
    assert listed.status_code == 200
    assert [entry['projectIdSnapshot'] for entry in listed.json()] == [project_b, None]
    with SessionLocal() as session:
        assert session.get(Task, task_id).project_id == project_a
