"""Inbox is derived from ScheduleBlock existence, with no persisted state."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event

from app import main
from app.models import ScheduleBlock, Task


def create_task(client, **fields):
    response = client.post('/tasks', json={'title': 'Inbox task', **fields})
    assert response.status_code == 201, response.text
    return response.json()


def create_block(client, task_id, block_type='TIME_UNSET'):
    response = client.post('/schedule-blocks', json={
        'taskId': task_id, 'date': '2026-10-02', 'type': block_type,
        **({'startTime': '13:00', 'durationMinutes': 60} if block_type == 'TIMED' else {}),
    })
    assert response.status_code == 201, response.text
    return response.json()


def get_tasks(client, inbox=None):
    response = client.get('/tasks', params={} if inbox is None else {'inbox': str(inbox).lower()})
    assert response.status_code == 200, response.text
    return response.json()


def ids(tasks):
    return [task['id'] for task in tasks]


def test_basic_types_filters_response_and_existing_order(client, SessionLocal):
    tasks = [create_task(client, title=name) for name in ('A', 'B', 'C', 'D')]
    for task, block_type in zip(tasks[1:], ('TIME_UNSET', 'TIMED', 'ALL_DAY')):
        create_block(client, task['id'], block_type)
    # Use distinct timestamps so the existing created_at DESC order is explicit.
    with SessionLocal() as session:
        for offset, task in enumerate(tasks):
            session.get(Task, task['id']).created_at = datetime(2026, 10, 1) + timedelta(days=offset)
        session.commit()
    all_tasks = get_tasks(client)
    assert ids(all_tasks) == [task['id'] for task in reversed(tasks)]
    inbox_tasks = get_tasks(client, True)
    scheduled_tasks = get_tasks(client, False)
    assert inbox_tasks == [all_tasks[-1]]
    assert scheduled_tasks == all_tasks[:-1]
    assert client.get(f"/tasks/{tasks[0]['id']}").json() == inbox_tasks[0]


@pytest.mark.parametrize('inbox', [None, True, False])
def test_empty_database_returns_empty_list(client, inbox):
    assert get_tasks(client, inbox) == []


def test_addition_and_last_deletion_immediately_change_inbox_membership(client):
    task = create_task(client)
    assert ids(get_tasks(client, True)) == [task['id']]
    assert get_tasks(client, False) == []
    blocks = [create_block(client, task['id'], kind) for kind in ('TIME_UNSET', 'TIMED', 'ALL_DAY')]
    assert get_tasks(client, True) == []
    assert ids(get_tasks(client, False)) == [task['id']]  # No duplicate Tasks from multiple Blocks.
    for block in blocks[:-1]:
        assert client.delete(f"/schedule-blocks/{block['id']}").status_code == 200
        assert get_tasks(client, True) == []
        assert ids(get_tasks(client, False)) == [task['id']]
    assert client.delete(f"/schedule-blocks/{blocks[-1]['id']}").status_code == 200
    assert get_tasks(client, True) == [task]
    assert get_tasks(client, False) == []
    assert get_tasks(client) == [task]


def test_project_membership_is_independent(client):
    project_response = client.post('/projects', json={'name': 'Inbox project'})
    assert project_response.status_code == 200
    project_id = project_response.json()['id']
    assigned = create_task(client, projectId=project_id)
    unassigned = create_task(client)
    create_block(client, unassigned['id'])
    assert get_tasks(client, True) == [assigned]
    assert get_tasks(client, False) == [unassigned]
    assert client.put(f"/tasks/{assigned['id']}", json={'projectId': None}).status_code == 200
    assert client.put(f"/tasks/{unassigned['id']}", json={'projectId': project_id}).status_code == 200
    assert ids(get_tasks(client, True)) == [assigned['id']]
    assert ids(get_tasks(client, False)) == [unassigned['id']]


def test_completion_and_snapshots_do_not_change_membership(client):
    inbox_task = create_task(client, estimatedMinutes=30)
    scheduled_task = create_task(client, estimatedMinutes=60)
    create_block(client, scheduled_task['id'])
    for task in (inbox_task, scheduled_task):
        completed = client.patch(f"/tasks/{task['id']}/complete", json={'completed': True})
        assert completed.status_code == 200
        assert completed.json()['completedAt'] is not None
    inbox_response = get_tasks(client, True)
    assert ids(inbox_response) == [inbox_task['id']]
    assert inbox_response[0]['completed'] is True
    assert inbox_response[0]['completedEstimateMinutes'] == 30
    assert ids(get_tasks(client, False)) == [scheduled_task['id']]
    assert client.patch(f"/tasks/{inbox_task['id']}/complete", json={'completed': False}).status_code == 200
    assert ids(get_tasks(client, True)) == [inbox_task['id']]


def test_legacy_schedule_columns_and_null_estimate_do_not_affect_inbox(client):
    task = create_task(client, plannedDate='2026-10-02', plannedStartTime='09:00')
    assert task['estimatedMinutes'] is None
    assert client.get('/schedule-blocks').json() == []
    assert get_tasks(client, True) == [task]
    assert get_tasks(client, False) == []
    assert client.put(f"/tasks/{task['id']}", json={'estimatedMinutes': 60}).status_code == 200
    assert ids(get_tasks(client, True)) == [task['id']]


def test_time_entries_and_running_timer_are_independent(client, monkeypatch):
    task = create_task(client)
    started_at = datetime(2026, 10, 2, 1, tzinfo=timezone.utc)
    monkeypatch.setattr(main, '_utc_now', lambda: started_at)
    assert client.post('/tasks/time/start', json={'taskId': task['id']}).status_code == 200
    active = client.get('/tasks/time/active').json()
    assert ids(get_tasks(client, True)) == [task['id']]
    assert client.get('/tasks/time/active').json() == active
    monkeypatch.setattr(main, '_utc_now', lambda: started_at + timedelta(minutes=2))
    stopped = client.post('/tasks/time/stop', json={
        'taskId': task['id'], 'endAt': (started_at + timedelta(minutes=2)).isoformat(),
    })
    assert stopped.status_code == 200
    inbox_tasks = get_tasks(client, True)
    assert ids(inbox_tasks) == [task['id']]
    assert inbox_tasks[0]['actualMinutes'] == 2
    assert get_tasks(client, False) == []
    assert client.post('/tasks/time/start', json={'taskId': task['id']}).status_code == 200
    assert ids(get_tasks(client, True)) == [task['id']]


def test_invalid_boolean_returns_validation_error(client):
    assert client.get('/tasks', params={'inbox': 'invalid'}).status_code == 422


@pytest.mark.parametrize('inbox', [True, False])
def test_schedule_filter_does_not_issue_per_task_block_queries(client, SessionLocal, inbox):
    with SessionLocal() as session:
        engine = session.get_bind()
        tasks = [Task(title=f'Query test {index}', estimated_minutes=None) for index in range(20)]
        session.add_all(tasks)
        session.flush()
        from datetime import date

        for task in tasks[::2]:
            session.add(ScheduleBlock(task_id=task.id, date=date(2026, 10, 2), type='TIME_UNSET'))
        session.commit()
    schedule_queries = []

    def record_query(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith('SELECT') and 'schedule_blocks' in statement.lower():
            schedule_queries.append(statement)

    event.listen(engine, 'before_cursor_execute', record_query)
    try:
        assert len(get_tasks(client, inbox)) == 10
    finally:
        event.remove(engine, 'before_cursor_execute', record_query)
    assert len(schedule_queries) == 1
