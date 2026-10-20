"""Step 41A: independent estimates, half-open schedules and aggregate actuals."""

from datetime import datetime, timezone

import pytest

from app import main


def task(client, estimate=720):
    response = client.post('/tasks', json={'title': 'Lecture', 'estimatedMinutes': estimate})
    assert response.status_code == 201
    return response.json()


def block(client, task_id, day='2026-10-02', start='10:00', duration=120):
    return client.post('/schedule-blocks', json={
        'taskId': task_id, 'date': day, 'type': 'TIMED', 'startTime': start, 'durationMinutes': duration,
    })


@pytest.mark.parametrize(('start', 'duration'), [('11:00', 120), ('10:30', 30), ('09:00', 240), ('10:00', 120)])
def test_same_task_overlapping_create_rejected_without_changes(client, start, duration):
    lecture = task(client)
    first = block(client, lecture['id']).json()
    before = client.get(f"/tasks/{lecture['id']}").json()
    response = block(client, lecture['id'], start=start, duration=duration)
    assert response.status_code == 409
    assert '同じタスク' in response.json()['detail']
    assert client.get('/schedule-blocks').json() == [first]
    assert client.get(f"/tasks/{lecture['id']}").json() == before


@pytest.mark.parametrize('changes', [
    {'startTime': '11:30'},  # Drag move.
    {'durationMinutes': 181},  # Resize a 09:00 block past the existing 12:00 start.
    {'date': '2026-10-02', 'type': 'TIMED', 'startTime': '11:30', 'durationMinutes': 60},  # Edit.
])
def test_same_task_overlapping_move_resize_edit_rejected_atomically(client, changes):
    lecture = task(client)
    first = block(client, lecture['id'], start='12:00', duration=120).json()
    moving = block(client, lecture['id'], start='09:00', duration=60).json()
    before = client.get(f"/tasks/{lecture['id']}").json()
    response = client.patch(f"/schedule-blocks/{moving['id']}", json=changes)
    assert response.status_code == 409
    assert client.get('/schedule-blocks').json() == [first, moving]
    assert client.get(f"/tasks/{lecture['id']}").json() == before


def test_adjacency_and_different_task_overlap_allowed(client):
    lecture, other = task(client), task(client)
    for task_id, start in [(lecture['id'], '10:00'), (lecture['id'], '12:00'), (other['id'], '11:00')]:
        assert block(client, task_id, start=start).status_code == 201
    assert len(client.get('/schedule-blocks').json()) == 3


@pytest.mark.parametrize(('day', 'start', 'duration'), [
    ('2026-10-03', '00:30', 60),
    ('2026-10-02', '23:00', 60),
])
def test_cross_midnight_same_task_overlap_rejected(client, day, start, duration):
    lecture = task(client)
    assert block(client, lecture['id'], start='23:30').status_code == 201
    assert block(client, lecture['id'], day=day, start=start, duration=duration).status_code == 409
    assert block(client, lecture['id'], day='2026-10-03', start='01:30', duration=30).status_code == 201


def test_block_longer_than_a_day_checks_intervening_dates(client):
    lecture = task(client)
    assert block(client, lecture['id'], start='12:00', duration=3000).status_code == 201
    assert block(client, lecture['id'], day='2026-10-04', start='13:00', duration=30).status_code == 409
    assert block(client, lecture['id'], day='2026-10-04', start='14:00', duration=30).status_code == 201


def test_lecture_split_across_days_and_resize_never_changes_estimate(client):
    lecture = task(client)
    parts = [(5, 180), (6, 180), (8, 120), (10, 240)]
    blocks = [block(client, lecture['id'], day=f'2026-10-{day:02}', duration=duration).json() for day, duration in parts]
    assert [item['durationMinutes'] for item in blocks] == [180, 180, 120, 240]
    response = client.patch(f"/schedule-blocks/{blocks[0]['id']}", json={'durationMinutes': 345})
    assert response.status_code == 200
    assert response.json()['durationMinutes'] == 345
    assert client.get(f"/tasks/{lecture['id']}").json()['estimatedMinutes'] == 720


def test_task_actual_sums_multiple_entries_and_delete_refreshes_aggregates(client, monkeypatch):
    monkeypatch.setattr(main, '_utc_now', lambda: datetime(2026, 10, 10, tzinfo=timezone.utc))
    project = client.post('/projects', json={'name': 'Course'}).json()
    lecture = task(client)
    assert client.put(f"/tasks/{lecture['id']}", json={'projectId': project['id']}).status_code == 200
    ids = []
    for day, end in [(5, '12:30'), (6, '13:20'), (8, '11:40')]:
        response = client.post('/time-entries', json={
            'taskId': lecture['id'], 'startedAt': f'2026-10-{day:02}T10:00:00Z', 'endedAt': f'2026-10-{day:02}T{end}:00Z',
        })
        assert response.status_code == 201
        ids.append(response.json()['id'])
    assert client.get(f"/tasks/{lecture['id']}").json()['actualMinutes'] == 450
    assert client.get('/projects').json()[0]['actualMinutes'] == 450
    assert client.delete(f'/time-entries/{ids[1]}').status_code == 200
    assert client.get(f"/tasks/{lecture['id']}").json()['actualMinutes'] == 250
    assert client.get('/projects').json()[0]['actualMinutes'] == 250
    assert client.get('/reports/daily', params={'date': '2026-10-06', 'timezone': 'UTC'}).json()['dailyActualMinutes'] == 0
    assert client.get('/reports/weekly', params={'date': '2026-10-05', 'timezone': 'UTC'}).json()['weeklyActualMinutes'] == 250
    assert client.get('/reports/monthly', params={'month': '2026-10', 'timezone': 'UTC'}).json()['monthlyActualMinutes'] == 250
