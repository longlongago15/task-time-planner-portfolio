"""Task V1-A behavior using the Step 1 isolated API database."""

from datetime import date, datetime, time, timezone

import pytest

from app import main
from app.models import Project, ScheduleBlock, Task, TimeEntry


def create_task(client, **fields):
    response = client.post('/tasks', json={'title': 'V1-A task', **fields})
    assert response.status_code == 201, response.text
    return response.json()


def set_completed(client, task_id, completed):
    response = client.patch(f'/tasks/{task_id}/complete', json={'completed': completed})
    assert response.status_code == 200, response.text
    return response.json()


def response_datetime(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def test_title_only_create_returns_null_estimate_in_create_get_and_list(client, SessionLocal):
    task = create_task(client, title='テスト')
    assert task['title'] == 'テスト'
    assert task['estimatedMinutes'] is None
    assert task['differenceMinutes'] is None
    assert task['actualMinutes'] == 0
    assert task['completed'] is False
    assert task['completedAt'] is None
    assert task['completedEstimateMinutes'] is None
    assert task['plannedDate'] is None
    assert task['plannedStartTime'] is None
    assert task['projectId'] is None
    get = client.get(f"/tasks/{task['id']}")
    listed = client.get('/tasks')
    assert get.status_code == listed.status_code == 200
    assert get.json() == task
    assert listed.json() == [task]
    with SessionLocal() as session:
        stored = session.get(Task, task['id'])
        assert stored.estimated_minutes is None
        assert stored.completed_at is None
        assert stored.completed_estimate_minutes is None
        assert session.query(ScheduleBlock).count() == 0


@pytest.mark.parametrize('field', ['estimatedMinutes', 'estimated_minutes'])
@pytest.mark.parametrize('estimate', [None, 1, 60])
def test_create_accepts_optional_positive_estimates_and_input_alias(client, field, estimate):
    task = create_task(client, **{field: estimate})
    assert task['estimatedMinutes'] == estimate


@pytest.mark.parametrize('field', ['estimatedMinutes', 'estimated_minutes'])
@pytest.mark.parametrize('estimate', [0, -1])
def test_create_rejects_non_positive_estimate(client, SessionLocal, field, estimate):
    response = client.post('/tasks', json={'title': 'Invalid', field: estimate})
    assert response.status_code == 422
    with SessionLocal() as session:
        assert session.query(Task).count() == 0


@pytest.mark.parametrize('payload', [{}, {'title': 'Title edit'}])
def test_update_omitted_estimate_preserves_value(client, SessionLocal, payload):
    task = create_task(client, estimatedMinutes=30)
    response = client.put(f"/tasks/{task['id']}", json=payload)
    assert response.status_code == 200
    assert response.json()['estimatedMinutes'] == 30
    with SessionLocal() as session:
        assert session.get(Task, task['id']).estimated_minutes == 30


@pytest.mark.parametrize('field', ['estimatedMinutes', 'estimated_minutes'])
def test_explicit_null_clears_estimate_and_can_be_set_again(client, SessionLocal, field):
    task = create_task(client, estimatedMinutes=30)
    cleared = client.put(f"/tasks/{task['id']}", json={field: None})
    assert cleared.status_code == 200
    assert cleared.json()['estimatedMinutes'] is None
    assert cleared.json()['differenceMinutes'] is None
    with SessionLocal() as session:
        assert session.get(Task, task['id']).estimated_minutes is None
    changed = client.put(f"/tasks/{task['id']}", json={field: 1})
    assert changed.status_code == 200
    assert changed.json()['estimatedMinutes'] == 1


@pytest.mark.parametrize('field', ['estimatedMinutes', 'estimated_minutes'])
@pytest.mark.parametrize('estimate', [0, -1])
def test_update_rejects_non_positive_estimate_without_changing_task(client, field, estimate):
    task = create_task(client, estimatedMinutes=60)
    response = client.put(f"/tasks/{task['id']}", json={field: estimate})
    assert response.status_code == 422
    assert client.get(f"/tasks/{task['id']}").json() == task


def test_complete_records_operation_time_and_current_estimate(client, SessionLocal, monkeypatch):
    task = create_task(client, estimatedMinutes=45)
    now = datetime(2026, 10, 2, 1, 2, 3, 456789, tzinfo=timezone.utc)
    monkeypatch.setattr(main, '_utc_now', lambda: now)
    completed = set_completed(client, task['id'], True)
    assert completed['completed'] is True
    assert response_datetime(completed['completedAt']) == now
    assert response_datetime(completed['updatedAt']) == now
    assert completed['completedEstimateMinutes'] == 45
    assert client.get(f"/tasks/{task['id']}").json() == completed
    assert client.get('/tasks').json() == [completed]
    with SessionLocal() as session:
        stored = session.get(Task, task['id'])
        assert main._as_utc(stored.completed_at) == now
        assert stored.completed_estimate_minutes == 45


def test_complete_without_estimate_keeps_snapshot_null(client, monkeypatch):
    task = create_task(client)
    now = datetime(2026, 10, 2, 2, tzinfo=timezone.utc)
    monkeypatch.setattr(main, '_utc_now', lambda: now)
    completed = set_completed(client, task['id'], True)
    assert completed['completed'] is True
    assert response_datetime(completed['completedAt']) == now
    assert completed['estimatedMinutes'] is None
    assert completed['completedEstimateMinutes'] is None
    # A later estimate must not retroactively populate a NULL completion snapshot.
    updated = client.put(f"/tasks/{task['id']}", json={'estimatedMinutes': 60})
    assert updated.status_code == 200
    assert updated.json()['completedAt'] == completed['completedAt']
    assert updated.json()['completedEstimateMinutes'] is None


def test_editing_completed_task_preserves_snapshot_and_legacy_fields(client, monkeypatch):
    project = client.post('/projects', json={'name': 'Original project'}).json()
    other_project = client.post('/projects', json={'name': 'New project'}).json()
    task = create_task(client, estimatedMinutes=30, projectId=project['id'],
                       plannedDate='2026-10-02', plannedStartTime='09:00:00')
    first_time = datetime(2026, 10, 2, 3, tzinfo=timezone.utc)
    monkeypatch.setattr(main, '_utc_now', lambda: first_time)
    completed = set_completed(client, task['id'], True)
    edit_time = datetime(2026, 10, 2, 4, tzinfo=timezone.utc)
    monkeypatch.setattr(main, '_utc_now', lambda: edit_time)
    response = client.put(f"/tasks/{task['id']}", json={
        'title': 'Edited completed task', 'estimatedMinutes': 60, 'projectId': other_project['id'],
        'plannedDate': '2026-10-03', 'plannedStartTime': '10:00:00',
    })
    assert response.status_code == 200
    edited = response.json()
    assert edited['title'] == 'Edited completed task'
    assert edited['estimatedMinutes'] == 60
    assert edited['projectId'] == other_project['id']
    assert edited['projectName'] == 'New project'
    assert edited['plannedDate'] == '2026-10-03'
    assert edited['plannedStartTime'] == '10:00:00'
    assert edited['completed'] is True
    assert edited['completedAt'] == completed['completedAt']
    assert edited['completedEstimateMinutes'] == 30
    assert response_datetime(edited['updatedAt']) == edit_time
    cleared = client.put(f"/tasks/{task['id']}", json={'estimatedMinutes': None})
    assert cleared.status_code == 200
    assert cleared.json()['estimatedMinutes'] is None
    assert cleared.json()['completedAt'] == completed['completedAt']
    assert cleared.json()['completedEstimateMinutes'] == 30


def test_uncomplete_and_recomplete_capture_new_estimate_and_time(client, monkeypatch):
    task = create_task(client, estimatedMinutes=30)
    first_time = datetime(2026, 10, 2, 3, tzinfo=timezone.utc)
    monkeypatch.setattr(main, '_utc_now', lambda: first_time)
    first = set_completed(client, task['id'], True)
    assert first['completedEstimateMinutes'] == 30
    uncompleted = set_completed(client, task['id'], False)
    assert uncompleted['completed'] is False
    assert uncompleted['completedAt'] is None
    assert uncompleted['completedEstimateMinutes'] is None
    updated = client.put(f"/tasks/{task['id']}", json={'estimatedMinutes': 60})
    assert updated.status_code == 200
    second_time = datetime(2026, 10, 2, 5, tzinfo=timezone.utc)
    monkeypatch.setattr(main, '_utc_now', lambda: second_time)
    second = set_completed(client, task['id'], True)
    assert response_datetime(second['completedAt']) == second_time
    assert second['completedAt'] != first['completedAt']
    assert second['completedEstimateMinutes'] == 60


def test_repeated_complete_does_not_refresh_snapshot_or_updated_at(client, monkeypatch):
    task = create_task(client, estimatedMinutes=30)
    first_time = datetime(2026, 10, 2, 3, tzinfo=timezone.utc)
    monkeypatch.setattr(main, '_utc_now', lambda: first_time)
    first = set_completed(client, task['id'], True)
    edited = client.put(f"/tasks/{task['id']}", json={'estimatedMinutes': 60}).json()
    later = datetime(2026, 10, 2, 7, tzinfo=timezone.utc)
    monkeypatch.setattr(main, '_utc_now', lambda: later)
    repeated = set_completed(client, task['id'], True)
    assert repeated == edited
    assert repeated['completedAt'] == first['completedAt']
    assert repeated['completedEstimateMinutes'] == 30


def test_legacy_completed_task_does_not_get_invented_history(client, SessionLocal, monkeypatch):
    with SessionLocal() as session:
        task = Task(title='Migrated completed task', estimated_minutes=45, completed=True)
        session.add(task)
        session.commit()
        task_id = task.id
    before = client.get(f'/tasks/{task_id}').json()
    assert before['completedAt'] is None
    assert before['completedEstimateMinutes'] is None
    now = datetime(2026, 10, 2, 7, tzinfo=timezone.utc)
    monkeypatch.setattr(main, '_utc_now', lambda: now)
    assert set_completed(client, task_id, True) == before
    edit = client.put(f'/tasks/{task_id}', json={'title': 'Legacy edit', 'estimatedMinutes': 60})
    assert edit.status_code == 200
    assert edit.json()['completedAt'] is None
    assert edit.json()['completedEstimateMinutes'] is None


def test_unestimated_task_diff_preserves_actual_minutes(client, SessionLocal):
    task = create_task(client, estimatedMinutes=30)
    with SessionLocal() as session:
        session.add(TimeEntry(task_id=task['id'], started_at=datetime(2026, 10, 2, 9),
                              ended_at=datetime(2026, 10, 2, 9, 25)))
        session.commit()
    before = client.get(f"/tasks/{task['id']}/diff")
    assert before.status_code == 200
    assert before.json()['differenceMinutes'] == -5
    assert client.put(f"/tasks/{task['id']}", json={'estimatedMinutes': None}).status_code == 200
    diff = client.get(f"/tasks/{task['id']}/diff")
    assert diff.status_code == 200
    assert diff.json() == {
        'taskId': task['id'], 'estimatedMinutes': None, 'actualMinutes': 25, 'differenceMinutes': None,
    }
    read = client.get(f"/tasks/{task['id']}").json()
    assert read['actualMinutes'] == 25
    assert read['differenceMinutes'] is None


def test_project_compatibility_with_estimated_and_unestimated_tasks(client):
    created = client.post('/projects', json={'name': 'Mixed estimates'})
    assert created.status_code == 200
    project_id = created.json()['id']
    estimated = create_task(client, projectId=project_id, estimatedMinutes=30)
    unknown = create_task(client, projectId=project_id)
    listed = client.get('/projects')
    assert listed.status_code == 200
    assert listed.json() == [{
        'id': project_id, 'name': 'Mixed estimates', 'color': None, 'taskCount': 2, 'completedCount': 0,
        'estimatedMinutes': 30, 'actualMinutes': 0,
    }]
    renamed = client.put(f'/projects/{project_id}', json={'name': 'Renamed project'})
    assert renamed.status_code == 200
    assert renamed.json()['estimatedMinutes'] == 30
    assert client.delete(f'/projects/{project_id}').status_code == 200
    for task in (estimated, unknown):
        remaining = client.get(f"/tasks/{task['id']}")
        assert remaining.status_code == 200
        assert remaining.json()['projectId'] is None
        assert remaining.json()['estimatedMinutes'] == task['estimatedMinutes']


def test_completion_rejects_active_then_preserves_entries_and_blocks_after_stop(client, SessionLocal):
    task = create_task(client, estimatedMinutes=30, plannedDate='2026-10-02', plannedStartTime='09:00:00')
    with SessionLocal() as session:
        assert session.query(ScheduleBlock).count() == 0
        entry = TimeEntry(task_id=task['id'], started_at=datetime(2026, 10, 2, 9),
                          ended_at=datetime(2026, 10, 2, 9, 20))
        block = ScheduleBlock(task_id=task['id'], date=date(2026, 10, 2), type='TIMED',
                              start_time=time(9), duration_minutes=30)
        session.add_all([entry, block])
        session.commit()
        entry_id, block_id = entry.id, block.id
    started = client.post('/tasks/time/start', json={'taskId': task['id']})
    assert started.status_code == 200
    before_timer = client.get('/tasks/time/active').json()
    assert client.patch(f"/tasks/{task['id']}/complete", json={'completed': True}).status_code == 409
    assert client.get('/tasks/time/active').json() == before_timer
    assert client.post('/tasks/time/stop', json={'taskId': task['id']}).status_code == 200
    for completed in (True, False):
        state = set_completed(client, task['id'], completed)
        assert state['completed'] == completed
        assert client.get('/tasks/time/active').json()['running'] is False
    assert state['completedAt'] is None
    assert state['completedEstimateMinutes'] is None
    edited = client.put(f"/tasks/{task['id']}", json={
        'plannedDate': '2026-10-03', 'plannedStartTime': '10:00:00',
    })
    assert edited.status_code == 200
    with SessionLocal() as session:
        assert session.query(Task).count() == 1
        assert session.query(TimeEntry).count() == 2
        assert session.query(ScheduleBlock).count() == 1
        entry = session.get(TimeEntry, entry_id)
        assert entry.task_id == task['id']
        assert entry.duration_minutes == 20
        assert entry.started_at == datetime(2026, 10, 2, 9)
        assert entry.ended_at == datetime(2026, 10, 2, 9, 20)
        block = session.get(ScheduleBlock, block_id)
        assert block.date == date(2026, 10, 2)
        assert block.start_time == time(9)
        assert block.duration_minutes == 30
