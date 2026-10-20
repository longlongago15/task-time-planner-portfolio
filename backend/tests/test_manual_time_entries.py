"""Manual history correction must preserve Active, snapshots and unrelated rows."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Barrier

import pytest
from sqlalchemy import inspect, text

from app import main

NOW = datetime(2026, 10, 4, 12, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def fixed_now(monkeypatch):
    monkeypatch.setattr(main, '_utc_now', lambda: NOW)


def task(client, **fields):
    response = client.post('/tasks', json={'title': 'Manual history', **fields})
    assert response.status_code == 201
    return response.json()['id']


def history(client, task_id):
    return client.get(f'/tasks/{task_id}/time-entries').json()


def payload(task_id, start='2026-10-02T10:00:00Z', end='2026-10-02T11:00:00Z'):
    return {'taskId': task_id, 'startedAt': start, 'endedAt': end}


def create(client, task_id, **fields):
    response = client.post('/time-entries', json={**payload(task_id), **fields})
    assert response.status_code == 201, response.text
    return response.json()


def rows(factory):
    with factory() as session:
        return {name: session.execute(text(f'SELECT * FROM "{name}" ORDER BY rowid')).all()
                for name in inspect(session.bind).get_table_names()}


def test_create_closed_snapshot_status_and_protection(client, SessionLocal):
    project = client.post('/projects', json={'name': 'Original'}).json()['id']
    tid = task(client, projectId=project)
    entry = create(client, tid)
    assert entry['projectIdSnapshot'] == project
    assert entry['durationMinutes'] == 60
    assert entry['startedAt'] == entry['startAt'] and entry['endedAt'] == entry['endAt']
    assert datetime.fromisoformat(entry['createdAt'].replace('Z', '+00:00')) == NOW
    assert client.get(f'/tasks/{tid}').json()['status'] == 'IN_PROGRESS'
    assert client.get('/tasks/time/active').json()['running'] is False
    assert client.delete(f'/tasks/{tid}').status_code == 409
    assert client.delete(f'/projects/{project}').status_code == 409
    assert rows(SessionLocal)['schedule_blocks'] == []


def test_unassigned_short_entry_and_completed_history_preserved(client):
    tid = task(client, estimatedMinutes=30)
    complete = client.patch(f'/tasks/{tid}/complete', json={'completed': True}).json()
    entry = create(client, tid, endedAt='2026-10-02T10:00:30Z')
    assert entry['durationMinutes'] == 0 and entry['projectIdSnapshot'] is None
    response = client.patch(f"/time-entries/{entry['id']}", json={'endedAt': '2026-10-02T10:01:00Z'})
    assert response.status_code == 200
    current = client.get(f'/tasks/{tid}').json()
    for field in ('status', 'completed', 'completedAt', 'completedEstimateMinutes'):
        assert current[field] == complete[field]
    assert client.delete(f"/time-entries/{entry['id']}").status_code == 200
    assert client.get(f'/tasks/{tid}').json()['status'] == 'COMPLETED'


def test_time_correction_and_task_correction_preserve_snapshot_after_task_moves(client):
    a = client.post('/projects', json={'name': 'A'}).json()['id']
    b = client.post('/projects', json={'name': 'B'}).json()['id']
    old, new = task(client, projectId=a), task(client, projectId=b)
    entry = create(client, old)
    client.put(f'/tasks/{old}', json={'projectId': b})
    edited = client.patch(f"/time-entries/{entry['id']}", json={
        'startedAt': '2026-10-02T10:10:00Z', 'endedAt': '2026-10-02T11:30:00Z',
    })
    assert edited.status_code == 200
    assert edited.json()['projectIdSnapshot'] == a and edited.json()['durationMinutes'] == 80
    for field in ('id', 'taskId', 'projectIdSnapshot', 'createdAt'):
        assert edited.json()[field] == entry[field]
    correction = client.patch(f"/time-entries/{entry['id']}", json={'taskId': new})
    assert correction.status_code == 200
    assert correction.json()['taskId'] == new and correction.json()['projectIdSnapshot'] == a
    assert correction.json()['startedAt'] == edited.json()['startedAt']
    assert correction.json()['endedAt'] == edited.json()['endedAt']
    assert history(client, old) == [] and history(client, new) == [correction.json()]
    assert client.get(f'/tasks/{new}').json()['status'] == 'NOT_STARTED'


def test_task_correction_validates_target_and_interval_atomically(client, SessionLocal):
    old, new = task(client), task(client)
    entry = create(client, old)
    create(client, new, startedAt='2026-10-02T11:00:00Z', endedAt='2026-10-02T12:00:00Z')
    before = rows(SessionLocal)
    missing = client.patch(f"/time-entries/{entry['id']}", json={'taskId': 999999})
    assert missing.status_code == 404 and rows(SessionLocal) == before
    overlapping = client.patch(f"/time-entries/{entry['id']}", json={'taskId': new, 'endedAt': '2026-10-02T11:01:00Z'})
    assert overlapping.status_code == 409 and rows(SessionLocal) == before
    for task_id in [None, 0, '1']:
        invalid = client.patch(f"/time-entries/{entry['id']}", json={'taskId': task_id})
        assert invalid.status_code == 422 and rows(SessionLocal) == before


def test_delete_only_target_retains_task_status_plans_projects_and_other_entries(client, SessionLocal):
    p = client.post('/projects', json={'name': 'History'}).json()['id']
    tid = task(client, projectId=p)
    client.post('/schedule-blocks', json={'taskId': tid, 'date': '2026-10-02', 'type': 'ALL_DAY'})
    first = create(client, tid)
    second = create(client, tid, startedAt='2026-10-02T11:00:00Z', endedAt='2026-10-02T11:30:00Z')
    before = rows(SessionLocal)
    assert client.delete(f"/time-entries/{first['id']}").status_code == 200
    after = rows(SessionLocal)
    for table in ('projects', 'tasks', 'schedule_blocks'):
        assert before[table] == after[table]
    assert history(client, tid) == [second]
    client.delete(f"/time-entries/{second['id']}")
    assert client.get(f'/tasks/{tid}').json()['status'] == 'IN_PROGRESS'


@pytest.mark.parametrize('method', ['PATCH', 'DELETE'])
def test_active_cannot_be_edited_or_deleted_and_all_rows_unchanged(client, SessionLocal, method):
    tid = task(client)
    client.post('/tasks/time/start', json={'taskId': tid})
    entry = history(client, tid)[0]
    active = client.get('/tasks/time/active').json()
    before = rows(SessionLocal)
    response = client.request(method, f"/time-entries/{entry['id']}", json={'startedAt': '2026-10-02T10:00:00Z', 'endedAt': '2026-10-02T11:00:00Z'} if method == 'PATCH' else None)
    assert response.status_code == 409 and '計測中' in response.json()['detail']
    assert rows(SessionLocal) == before and client.get('/tasks/time/active').json() == active


@pytest.mark.parametrize('changes', [
    {'endedAt': None}, {'startedAt': None}, {'taskId': None}, {'startedAt': '2026-10-02T10:00:00'},
    {'endedAt': '2026-10-02T10:00:00Z'}, {'endedAt': '2026-10-02T09:00:00Z'},
    {'endedAt': '2026-10-05T00:00:00Z'}, {'projectIdSnapshot': 123}, {'taskId': 0},
])
@pytest.mark.parametrize('method', ['POST', 'PATCH'])
def test_invalid_manual_request_rolls_back_every_row(client, SessionLocal, changes, method):
    tid = task(client)
    existing = create(client, tid)
    before = rows(SessionLocal)
    response = client.request(method, '/time-entries' if method == 'POST' else f"/time-entries/{existing['id']}", json={**({k: v for k, v in payload(tid).items() if k != 'taskId'} if method == 'PATCH' else payload(tid)), **changes})
    assert response.status_code == (404 if method == 'PATCH' and 'projectIdSnapshot' in changes else 422)
    assert rows(SessionLocal) == before


@pytest.mark.parametrize('start,end', [
    ('09:30', '10:01'), ('10:30', '11:30'), ('10:10', '10:20'), ('09:00', '12:00'), ('10:00', '11:00'),
])
def test_global_overlap_rejected_for_different_task(client, SessionLocal, start, end):
    a, b = task(client), task(client)
    create(client, a)
    before = rows(SessionLocal)
    result = client.post('/time-entries', json=payload(b, f'2026-10-02T{start}:00Z', f'2026-10-02T{end}:00Z'))
    assert result.status_code == 409 and '別の実績' in result.json()['detail']
    assert rows(SessionLocal) == before


def test_adjacent_edit_self_exclusion_and_edit_overlap(client, SessionLocal):
    tid = task(client)
    entry = create(client, tid)
    adjacent = create(client, tid, startedAt='2026-10-02T11:00:00Z', endedAt='2026-10-02T12:00:00Z')
    assert client.patch(f"/time-entries/{entry['id']}", json={'startedAt': '2026-10-02T10:00:00Z', 'endedAt': '2026-10-02T11:00:00Z'}).status_code == 200
    before = rows(SessionLocal)
    assert client.patch(f"/time-entries/{entry['id']}", json={'endedAt': '2026-10-02T11:01:00Z'}).status_code == 409
    assert rows(SessionLocal) == before
    assert adjacent['durationMinutes'] == 60


def test_active_overlap_and_past_adjacency_allow_other_task_without_touching_active(client, SessionLocal, monkeypatch):
    a, b = task(client), task(client)
    monkeypatch.setattr(main, '_utc_now', lambda: NOW - timedelta(hours=1))
    client.post('/tasks/time/start', json={'taskId': a})
    monkeypatch.setattr(main, '_utc_now', lambda: NOW)
    active = client.get('/tasks/time/active').json()
    before = rows(SessionLocal)
    overlap = client.post('/time-entries', json=payload(b, '2026-10-04T10:30:00Z', '2026-10-04T11:30:00Z'))
    assert overlap.status_code == 409 and rows(SessionLocal) == before
    past = create(client, b, startedAt='2026-10-04T10:30:00Z', endedAt='2026-10-04T11:00:00Z')
    assert past['durationMinutes'] == 30 and client.get('/tasks/time/active').json() == active


def test_missing_task_entry_and_partial_patch_validation(client, SessionLocal):
    tid = task(client)
    entry = create(client, tid)
    before = rows(SessionLocal)
    assert client.post('/time-entries', json=payload(999999, '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z')).status_code == 404
    assert client.patch(f"/time-entries/{entry['id']}", json={'taskId': 999999}).status_code == 404
    assert client.patch('/time-entries/999999', json={'endedAt': '2026-10-02T12:00:00Z'}).status_code == 404
    assert client.delete('/time-entries/999999').status_code == 404
    assert rows(SessionLocal) == before
    assert client.patch(f"/time-entries/{entry['id']}", json={}).json() == entry
    assert client.post('/time-entries', json={'taskId': tid, 'startedAt': '2026-10-02T10:00:00Z'}).status_code == 422


def test_cross_midnight_and_all_reports_aggregates_follow_crud(client):
    p = client.post('/projects', json={'name': 'Cross midnight'}).json()['id']
    tid = task(client, projectId=p)
    entry = create(client, tid, startedAt='2026-10-02T23:30:00+09:00', endedAt='2026-10-03T00:30:00+09:00')
    def totals():
        return [client.get(f'/reports/daily?date={day}&timezone=Asia/Tokyo').json()['dailyActualMinutes'] for day in ('2026-10-02', '2026-10-03')]
    assert totals() == [30, 30] and len(history(client, tid)) == 1
    assert client.get('/reports/weekly?date=2026-10-02&timezone=Asia/Tokyo').json()['weeklyActualMinutes'] == 60
    assert client.get('/reports/monthly?month=2026-10&timezone=Asia/Tokyo').json()['monthlyActualMinutes'] == 60
    assert client.get('/projects').json()[0]['actualMinutes'] == 60
    assert client.get(f'/tasks/{tid}').json()['actualMinutes'] == 60
    client.patch(f"/time-entries/{entry['id']}", json={'endedAt': '2026-10-03T01:00:00+09:00'})
    assert totals() == [30, 60]
    assert client.get('/reports/weekly?date=2026-10-02&timezone=UTC').json()['weeklyActualMinutes'] == 90
    assert client.get('/reports/monthly?month=2026-10&timezone=UTC').json()['monthlyActualMinutes'] == 90
    client.delete(f"/time-entries/{entry['id']}")
    assert totals() == [0, 0]
    assert client.get('/projects').json()[0]['actualMinutes'] == 0
    assert client.get(f'/tasks/{tid}').json()['actualMinutes'] == 0


def test_dst_offset_aware_interval_uses_elapsed_time_and_local_report(client, monkeypatch):
    monkeypatch.setattr(main, '_utc_now', lambda: datetime(2026, 11, 2, tzinfo=timezone.utc))
    tid = task(client)
    entry = create(client, tid, startedAt='2026-11-01T01:30:00-04:00', endedAt='2026-11-01T01:30:00-05:00')
    assert entry['durationMinutes'] == 60
    assert client.get('/reports/daily?date=2026-11-01&timezone=America/New_York').json()['dailyActualMinutes'] == 60


def test_concurrent_manual_creates_cannot_both_pass_overlap(client):
    a, b = task(client), task(client)
    gate = Barrier(2)
    def submit(tid):
        gate.wait(timeout=10)
        return client.post('/time-entries', json=payload(tid)).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(submit, [a, b])) == [201, 409]
    assert len(history(client, a)) + len(history(client, b)) == 1


def test_explicit_snapshot_correction_and_null_preserve_task(client, SessionLocal):
    original = client.post('/projects', json={'name': 'Original'}).json()['id']
    corrected = client.post('/projects', json={'name': 'Corrected'}).json()['id']
    tid = task(client, projectId=original)
    entry = create(client, tid)
    url = f"/time-entries/{entry['id']}"
    response = client.patch(url, json={'projectIdSnapshot': corrected})
    assert response.status_code == 200
    assert response.json()['projectIdSnapshot'] == corrected
    assert client.get(f'/tasks/{tid}').json()['projectId'] == original
    assert response.json()['startedAt'] == entry['startedAt']
    response = client.patch(url, json={'projectIdSnapshot': None})
    assert response.status_code == 200 and response.json()['projectIdSnapshot'] is None
    before = rows(SessionLocal)
    assert client.patch(url, json={'projectIdSnapshot': 99999}).status_code == 404
    assert client.patch(url, json={'tagIds': [1]}).status_code == 422
    assert rows(SessionLocal) == before
