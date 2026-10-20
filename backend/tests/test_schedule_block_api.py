"""ScheduleBlock CRUD and transitions in the Step 1 isolated database."""

from datetime import date, datetime, time, timezone

import pytest

from app import main
from app.models import Project, ScheduleBlock, Task, TimeEntry


def create_task(client, estimate=30, **fields):
    response = client.post('/tasks', json={'title': 'Scheduled task', 'estimatedMinutes': estimate, **fields})
    assert response.status_code == 201, response.text
    return response.json()


def create_block(client, task_id, **fields):
    if fields.get('type') == 'TIMED' and 'durationMinutes' not in fields:
        fields['durationMinutes'] = 30
    response = client.post('/schedule-blocks', json={
        'taskId': task_id, 'date': '2026-10-02', 'type': 'TIME_UNSET', **fields,
    })
    assert response.status_code == 201, response.text
    return response.json()


def get_blocks(client, **params):
    response = client.get('/schedule-blocks', params=params)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize(('block_type', 'fields', 'expected_start', 'expected_duration'), [
    ('TIME_UNSET', {}, None, None),
    ('ALL_DAY', {'startTime': None, 'durationMinutes': None}, None, None),
    ('TIMED', {'startTime': '13:30', 'durationMinutes': 1}, '13:30:00', 1),
    ('TIMED', {'startTime': '23:30', 'durationMinutes': 90}, '23:30:00', 90),
])
def test_create_types_and_local_times(client, SessionLocal, block_type, fields, expected_start, expected_duration):
    task = create_task(client)
    block = create_block(client, task['id'], type=block_type, **fields)
    assert set(block) == {'id', 'taskId', 'date', 'type', 'startTime', 'durationMinutes', 'createdAt', 'updatedAt'}
    assert block['taskId'] == task['id']
    assert block['date'] == '2026-10-02'
    assert block['type'] == block_type
    assert block['startTime'] == expected_start
    assert block['durationMinutes'] == expected_duration
    for key in ('createdAt', 'updatedAt'):
        assert datetime.fromisoformat(block[key].replace('Z', '+00:00')).utcoffset().total_seconds() == 0
    assert get_blocks(client) == [block]
    with SessionLocal() as session:
        stored = session.get(ScheduleBlock, block['id'])
        assert stored.date == date(2026, 10, 2)
        assert stored.start_time == (time.fromisoformat(expected_start) if expected_start else None)
        if stored.start_time is not None:
            assert stored.start_time.tzinfo is None


@pytest.mark.parametrize('estimate', [30, 60, 120, None])
def test_timed_creation_requires_duration_independently_of_estimate(client, estimate):
    task = create_task(client, estimate)
    response = client.post('/schedule-blocks', json={
        'taskId': task['id'], 'date': '2026-10-02', 'type': 'TIMED', 'startTime': '13:00',
    })
    assert response.status_code == 422
    assert get_blocks(client) == []


@pytest.mark.parametrize('fields', [
    {'type': 'TIMED'},
    {'type': 'TIMED', 'startTime': None, 'durationMinutes': 30},
    {'type': 'TIMED', 'startTime': '13:00', 'durationMinutes': 0},
    {'type': 'TIMED', 'startTime': '13:00', 'durationMinutes': -1},
    {'type': 'TIMED', 'startTime': '13:00', 'durationMinutes': None},
    {'type': 'TIME_UNSET', 'startTime': '13:00'},
    {'type': 'TIME_UNSET', 'durationMinutes': 30},
    {'type': 'ALL_DAY', 'startTime': '13:00'},
    {'type': 'ALL_DAY', 'durationMinutes': 30},
    {'type': 'UNKNOWN'},
    {'type': None},
    {'date': None},
    {'date': '2026-02-30'},
    {'date': '20261002'},
    {'date': '2026-10-02T00:00:00Z'},
    {'type': 'TIMED', 'startTime': '25:00'},
    {'type': 'TIMED', 'startTime': '13:00+09:00'},
    {'type': 'TIMED', 'startTime': '13:00Z'},
])
def test_invalid_create_does_not_store_block(client, SessionLocal, fields):
    task = create_task(client)
    response = client.post('/schedule-blocks', json={
        'taskId': task['id'], 'date': '2026-10-02', 'type': 'TIME_UNSET', **fields,
    })
    assert response.status_code == 422
    assert get_blocks(client) == []
    with SessionLocal() as session:
        assert session.query(Task).count() == 1
        assert session.query(ScheduleBlock).count() == 0


def test_create_requires_date_and_existing_task(client, SessionLocal):
    task = create_task(client)
    missing_date = client.post('/schedule-blocks', json={'taskId': task['id'], 'type': 'TIME_UNSET'})
    assert missing_date.status_code == 422
    missing_task = client.post('/schedule-blocks', json={
        'taskId': 99999, 'date': '2026-10-02', 'type': 'TIME_UNSET',
    })
    assert missing_task.status_code == 404
    with SessionLocal() as session:
        assert session.query(Task).count() == 1
        assert session.query(ScheduleBlock).count() == 0


def test_multiple_blocks_and_different_task_overlaps_are_allowed(client, SessionLocal):
    task = create_task(client)
    another = create_task(client)
    blocks = [
        create_block(client, task['id'], type='TIMED', startTime='10:00', durationMinutes=60),
        create_block(client, task['id'], type='TIMED', startTime='11:00', durationMinutes=60),
        create_block(client, another['id'], type='TIMED', startTime='10:30', durationMinutes=60),
        create_block(client, task['id'], date='2026-10-03'),
    ]
    assert len({block['id'] for block in blocks}) == 4
    assert get_blocks(client) == blocks
    with SessionLocal() as session:
        assert session.query(ScheduleBlock).count() == 4
        assert session.query(ScheduleBlock).filter_by(task_id=task['id']).count() == 3


def test_get_filters_inclusive_dates_task_and_deterministic_order(client):
    first_task = create_task(client)
    second_task = create_task(client)
    late = create_block(client, first_task['id'], date='2026-10-08')
    middle_first = create_block(client, first_task['id'], date='2026-10-02')
    early = create_block(client, first_task['id'], date='2026-09-30')
    boundary_start = create_block(client, second_task['id'], date='2026-10-01')
    middle_second = create_block(client, second_task['id'], date='2026-10-02')
    boundary_end = create_block(client, first_task['id'], date='2026-10-07')
    ordered = [early, boundary_start, middle_first, middle_second, boundary_end, late]
    assert get_blocks(client) == ordered
    assert get_blocks(client) == ordered
    assert get_blocks(client, startDate='2026-10-01', endDate='2026-10-07') == ordered[1:-1]
    assert get_blocks(client, taskId=first_task['id']) == [early, middle_first, boundary_end, late]
    assert get_blocks(client, startDate='2026-10-01', endDate='2026-10-07', taskId=first_task['id']) == [middle_first, boundary_end]
    assert get_blocks(client, startDate='2026-10-07') == [boundary_end, late]
    assert get_blocks(client, endDate='2026-10-01') == [early, boundary_start]
    assert get_blocks(client, startDate='2026-10-02', endDate='2026-10-02') == [middle_first, middle_second]
    assert get_blocks(client, taskId=99999) == []


@pytest.mark.parametrize('params', [
    {'startDate': '2026-10-07', 'endDate': '2026-10-01'},
    {'startDate': 'not-a-date'},
    {'endDate': '2026-02-30'},
    {'taskId': 'invalid'},
])
def test_get_rejects_invalid_filters(client, params):
    assert client.get('/schedule-blocks', params=params).status_code == 422


def test_patch_partial_fields_preserves_others_and_task(client, monkeypatch):
    task = create_task(client, plannedDate='2026-10-01', plannedStartTime='08:00')
    block = create_block(client, task['id'], type='TIMED', startTime='13:00')
    patch_time = datetime(2026, 10, 2, 5, tzinfo=timezone.utc)
    monkeypatch.setattr(main, '_utc_now', lambda: patch_time)
    for changes in ({'date': '2026-10-04'}, {'startTime': '15:30'}, {'durationMinutes': 90}):
        response = client.patch(f"/schedule-blocks/{block['id']}", json=changes)
        assert response.status_code == 200, response.text
        expected = {**block, **changes, 'updatedAt': response.json()['updatedAt']}
        if 'startTime' in changes:
            expected['startTime'] = '15:30:00'
        assert response.json() == expected
        assert datetime.fromisoformat(response.json()['updatedAt'].replace('Z', '+00:00')) == patch_time
        block = response.json()
    assert client.get(f"/tasks/{task['id']}").json() == task
    assert client.patch(f"/schedule-blocks/{block['id']}", json={}).json() == block


@pytest.mark.parametrize('target_type', ['TIME_UNSET', 'ALL_DAY'])
def test_timed_to_non_timed_clears_old_time_fields(client, target_type):
    task = create_task(client)
    block = create_block(client, task['id'], type='TIMED', startTime='10:00', durationMinutes=60)
    response = client.patch(f"/schedule-blocks/{block['id']}", json={'type': target_type})
    assert response.status_code == 200
    changed = response.json()
    assert changed['type'] == target_type
    assert changed['startTime'] is None
    assert changed['durationMinutes'] is None
    assert changed['date'] == block['date']
    assert changed['taskId'] == task['id']


@pytest.mark.parametrize('source_type', ['TIME_UNSET', 'ALL_DAY'])
@pytest.mark.parametrize('estimate', [30, 120, None])
def test_non_timed_to_timed_requires_duration_independently_of_estimate(client, source_type, estimate):
    task = create_task(client, 1)
    block = create_block(client, task['id'], type=source_type)
    assert client.put(f"/tasks/{task['id']}", json={'estimatedMinutes': estimate}).status_code == 200
    response = client.patch(f"/schedule-blocks/{block['id']}", json={'type': 'TIMED', 'startTime': '14:00'})
    assert response.status_code == 422, response.text
    assert get_blocks(client) == [block]


@pytest.mark.parametrize('source_type', ['TIME_UNSET', 'ALL_DAY'])
def test_conversion_with_explicit_duration_and_null_non_timed_fields(client, source_type):
    task = create_task(client, 30)
    block = create_block(client, task['id'], type=source_type)
    valid_nulls = client.patch(f"/schedule-blocks/{block['id']}", json={'startTime': None, 'durationMinutes': None})
    assert valid_nulls.status_code == 200
    timed = client.patch(f"/schedule-blocks/{block['id']}", json={
        'type': 'TIMED', 'startTime': '14:00', 'durationMinutes': 90,
    })
    assert timed.status_code == 200
    assert timed.json()['durationMinutes'] == 90


@pytest.mark.parametrize('changes', [
    {'startTime': None}, {'durationMinutes': None}, {'durationMinutes': 0}, {'durationMinutes': -1},
    {'date': None}, {'type': None}, {'type': 'UNKNOWN'}, {'startTime': '14:00+09:00'},
    {'type': 'TIME_UNSET', 'startTime': '10:00'},
    {'type': 'ALL_DAY', 'durationMinutes': 60},
    {'date': '2026-10-03', 'type': 'ALL_DAY', 'startTime': '10:00'},
    {'taskId': 99999},
])
def test_invalid_timed_patch_keeps_entire_original_block(client, SessionLocal, changes):
    task = create_task(client)
    block = create_block(client, task['id'], type='TIMED', startTime='10:00')
    response = client.patch(f"/schedule-blocks/{block['id']}", json=changes)
    assert response.status_code == 422, response.text
    assert get_blocks(client) == [block]
    with SessionLocal() as session:
        stored = session.get(ScheduleBlock, block['id'])
        assert stored.date == date(2026, 10, 2)
        assert stored.type == 'TIMED'
        assert stored.start_time == time(10)
        assert stored.duration_minutes == 30
        assert stored.task_id == task['id']


@pytest.mark.parametrize('source_type', ['TIME_UNSET', 'ALL_DAY'])
@pytest.mark.parametrize('changes', [
    {'type': 'TIMED'},
    {'type': 'TIMED', 'startTime': None},
    {'type': 'TIMED', 'startTime': '14:00', 'durationMinutes': None},
    {'startTime': '14:00'},
    {'durationMinutes': 30},
])
def test_invalid_non_timed_patch_keeps_original(client, source_type, changes):
    task = create_task(client)
    block = create_block(client, task['id'], type=source_type)
    response = client.patch(f"/schedule-blocks/{block['id']}", json=changes)
    assert response.status_code == 422, response.text
    assert get_blocks(client) == [block]


def test_task_estimate_change_does_not_change_existing_duration(client):
    task = create_task(client, 30)
    block = create_block(client, task['id'], type='TIMED', startTime='10:00')
    assert client.put(f"/tasks/{task['id']}", json={'estimatedMinutes': 90}).status_code == 200
    assert get_blocks(client) == [block]
    for changes in ({'startTime': '15:30'}, {'type': 'TIMED'}, {'date': '2026-10-03'}):
        response = client.patch(f"/schedule-blocks/{block['id']}", json=changes)
        assert response.status_code == 200
        assert response.json()['durationMinutes'] == 30
    assert client.get(f"/tasks/{task['id']}").json()['estimatedMinutes'] == 90


@pytest.mark.parametrize('block_type', ['TIME_UNSET', 'ALL_DAY', 'TIMED'])
def test_completed_task_allows_blocks_and_completion_never_deletes_them(client, block_type):
    task = create_task(client)
    block = create_block(client, task['id'], date='2099-10-02', type=block_type,
                         **({'startTime': '10:00'} if block_type == 'TIMED' else {}))
    assert client.patch(f"/tasks/{task['id']}/complete", json={'completed': True}).status_code == 200
    assert get_blocks(client) == [block]
    another = create_block(client, task['id'], date='2099-10-03', type=block_type,
                           **({'startTime': '11:00'} if block_type == 'TIMED' else {}))
    assert client.get(f"/tasks/{task['id']}").json()['completed'] is True
    assert client.patch(f"/tasks/{task['id']}/complete", json={'completed': False}).status_code == 200
    assert get_blocks(client) == [block, another]


def test_delete_removes_only_target_block(client, SessionLocal):
    project = client.post('/projects', json={'name': 'Keep project'}).json()
    task = create_task(client, projectId=project['id'])
    first = create_block(client, task['id'], type='TIMED', startTime='10:00')
    second = create_block(client, task['id'], type='ALL_DAY')
    with SessionLocal() as session:
        entry = TimeEntry(task_id=task['id'], project_id_snapshot=project['id'],
                          started_at=datetime(2026, 10, 2, 9), ended_at=datetime(2026, 10, 2, 9, 10))
        session.add(entry)
        session.commit()
        entry_id = entry.id
    before_task = client.get(f"/tasks/{task['id']}").json()
    before_entries = client.get(f"/tasks/{task['id']}/time-entries").json()
    response = client.delete(f"/schedule-blocks/{first['id']}")
    assert response.status_code == 200
    assert response.json() == {'deleted': True}
    assert get_blocks(client) == [second]
    assert client.get(f"/tasks/{task['id']}").json() == before_task
    assert client.get(f"/tasks/{task['id']}/time-entries").json() == before_entries
    assert client.delete(f"/schedule-blocks/{second['id']}").status_code == 200
    assert get_blocks(client) == []
    with SessionLocal() as session:
        assert session.query(Task).count() == 1
        assert session.query(Project).count() == 1
        assert session.query(TimeEntry).count() == 1
        assert session.get(TimeEntry, entry_id).project_id_snapshot == project['id']


def test_missing_block_patch_and_delete_return_not_found(client):
    assert client.patch('/schedule-blocks/99999', json={'date': '2026-10-02'}).status_code == 404
    assert client.delete('/schedule-blocks/99999').status_code == 404
    assert get_blocks(client) == []
