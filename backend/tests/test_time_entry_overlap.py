"""All writes use one half-open overlap rule, on conftest's guarded temp DB."""
from datetime import datetime, timedelta, timezone

import pytest

from app import main
from app.models import TimeEntry

BASE = datetime(2026, 10, 12, 10, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    value = {'now': BASE + timedelta(days=2)}
    monkeypatch.setattr(main, '_utc_now', lambda: value['now'])
    return value


def task(client, project=None):
    return client.post('/tasks', json={'title': 'Overlap', 'projectId': project}).json()['id']


def create(client, tid, start, end):
    return client.post('/time-entries', json={
        'taskId': tid, 'startedAt': start.isoformat(), 'endedAt': end.isoformat(),
    })


def seed(factory, tid, start, end):
    # Legacy/future records can only be introduced directly into the isolated DB.
    with factory() as db:
        entry = TimeEntry(task_id=tid, started_at=start, ended_at=end, created_at=start, updated_at=start)
        db.add(entry)
        db.commit()
        return entry.id


@pytest.mark.parametrize('start,end,expected', [
    (-60, 0, 201), (-60, 30, 409), (0, 60, 409), (30, 90, 409), (60, 120, 201),
])
def test_closed_half_open_across_tasks_and_projects(client, SessionLocal, start, end, expected):
    pa = client.post('/projects', json={'name': 'A'}).json()['id']
    pb = client.post('/projects', json={'name': 'B'}).json()['id']
    a, b = task(client, pa), task(client, pb)
    assert create(client, a, BASE, BASE + timedelta(hours=1)).status_code == 201
    result = create(client, b, BASE + timedelta(minutes=start), BASE + timedelta(minutes=end))
    assert result.status_code == expected
    with SessionLocal() as db:
        assert db.query(TimeEntry).count() == (2 if expected == 201 else 1)
    if expected == 409:
        assert result.json()['detail'] == main.TIME_ENTRY_OVERLAP_DETAIL
        assert client.get(f'/tasks/{b}').json()['status'] == 'NOT_STARTED'


def test_edit_self_exclusion_and_failed_edit_keeps_original(client):
    a, b = task(client), task(client)
    first = create(client, a, BASE, BASE + timedelta(hours=1)).json()
    assert create(client, b, BASE + timedelta(hours=2), BASE + timedelta(hours=3)).status_code == 201
    url = f"/time-entries/{first['id']}"
    assert client.patch(url, json={'endedAt': (BASE + timedelta(minutes=90)).isoformat()}).status_code == 200
    before = client.get(f'/tasks/{a}/time-entries').json()
    assert client.patch(url, json={'endedAt': (BASE + timedelta(minutes=121)).isoformat()}).status_code == 409
    assert client.get(f'/tasks/{a}/time-entries').json() == before
    assert client.patch(url, json={'endedAt': (BASE + timedelta(hours=2)).isoformat()}).status_code == 200


@pytest.mark.parametrize('start,expected', [(30, 409), (60, 201)])
def test_cross_midnight_and_timezone_offsets(client, start, expected):
    a, b = task(client), task(client)
    midnight = datetime.fromisoformat('2026-10-13T00:00:00+09:00')
    assert create(client, a, midnight - timedelta(minutes=30), midnight + timedelta(hours=1)).status_code == 201
    # Express the proposed interval in UTC, not the original +09:00 offset.
    result = create(client, b, (midnight + timedelta(minutes=start)).astimezone(timezone.utc),
                    (midnight + timedelta(hours=2)).astimezone(timezone.utc))
    assert result.status_code == expected


def test_active_open_interval_past_adjacency_pause_gap_resume_stop(client, clock):
    a, b = task(client), task(client)
    clock['now'] = BASE
    assert client.post('/tasks/time/start', json={'taskId': a}).status_code == 200
    clock['now'] = BASE + timedelta(minutes=30)
    assert create(client, b, BASE - timedelta(hours=1), BASE).status_code == 201
    assert create(client, b, BASE, BASE + timedelta(minutes=10)).status_code == 409
    assert client.post('/tasks/time/start', json={'taskId': b}).status_code == 409
    assert client.post('/tasks/time/stop', json={'taskId': a}).status_code == 200
    clock['now'] = BASE + timedelta(minutes=45)
    assert create(client, b, BASE + timedelta(minutes=30), BASE + timedelta(minutes=45)).status_code == 201
    assert client.post('/tasks/time/start', json={'taskId': a}).status_code == 200
    clock['now'] = BASE + timedelta(minutes=75)
    assert client.post('/tasks/time/stop', json={'taskId': a}).status_code == 200
    rows = client.get(f'/tasks/{a}/time-entries').json()
    assert [row['durationMinutes'] for row in rows] == [30, 30]
    assert client.get('/tasks/time/active').json()['running'] is False


@pytest.mark.parametrize('offset', [-30, 60])
def test_start_rejects_legacy_covering_now_or_future_entry(client, SessionLocal, clock, offset):
    a, b = task(client), task(client)
    clock['now'] = BASE
    seed(SessionLocal, a, BASE + timedelta(minutes=offset), BASE + timedelta(minutes=offset + 60))
    result = client.post('/tasks/time/start', json={'taskId': b})
    assert result.status_code == 409 and result.json()['detail'] == main.TIME_ENTRY_OVERLAP_DETAIL
    assert client.get('/tasks/time/active').json()['running'] is False
    assert client.get(f'/tasks/{b}').json()['status'] == 'NOT_STARTED'


def test_start_at_closed_end_and_immediate_zero_stop_are_allowed(client, clock):
    a, b = task(client), task(client)
    clock['now'] = BASE
    assert create(client, a, BASE - timedelta(hours=1), BASE).status_code == 201
    assert client.post('/tasks/time/start', json={'taskId': b}).status_code == 200
    assert client.post('/tasks/time/stop', json={'taskId': b}).status_code == 200
    assert client.post('/tasks/time/start', json={'taskId': a}).status_code == 200
    clock['now'] += timedelta(minutes=1)
    assert client.post('/tasks/time/stop', json={'taskId': a}).status_code == 200


def test_stop_excludes_self_and_rejects_legacy_overlap_without_closing_active(client, SessionLocal, clock):
    a, b = task(client), task(client)
    clock['now'] = BASE
    assert client.post('/tasks/time/start', json={'taskId': a}).status_code == 200
    seed(SessionLocal, b, BASE + timedelta(minutes=10), BASE + timedelta(minutes=20))
    clock['now'] = BASE + timedelta(minutes=30)
    result = client.post('/tasks/time/stop', json={'taskId': a})
    assert result.status_code == 409 and result.json()['detail'] == main.TIME_ENTRY_OVERLAP_DETAIL
    assert client.get('/tasks/time/active').json()['taskId'] == a
    assert client.get(f'/tasks/{a}/time-entries').json()[0]['endedAt'] is None


def test_future_manual_entry_remains_invalid(client, clock):
    tid = task(client)
    clock['now'] = BASE
    assert create(client, tid, BASE + timedelta(hours=1), BASE + timedelta(hours=2)).status_code == 422
