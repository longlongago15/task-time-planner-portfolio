"""API deletion preserves actual history on the Step 1 temporary database."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event, select

from app import main
from app.models import Project, ScheduleBlock, Task, TimeEntry


START = datetime(2026, 10, 2, 10, tzinfo=timezone.utc)


def stored_values(factory):
    with factory() as session:
        return {
            model.__tablename__: session.execute(select(model.__table__).order_by(model.id)).all()
            for model in (Project, Task, ScheduleBlock, TimeEntry)
        }


def seed(client):
    project = client.post('/projects', json={'name': 'Historical project'}).json()
    task = client.post('/tasks', json={
        'title': 'Historical task', 'estimatedMinutes': 30,
        'projectId': project['id'], 'plannedDate': '2026-10-02',
    }).json()
    block = client.post('/schedule-blocks', json={
        'taskId': task['id'], 'date': '2026-10-02', 'type': 'TIMED',
        'startTime': '10:00', 'durationMinutes': 30,
    })
    assert block.status_code == 201
    return project, task


def record_history(client, monkeypatch, task, active=False, completed=False):
    monkeypatch.setattr(main, '_utc_now', lambda: START)
    assert client.post('/tasks/time/start', json={'taskId': task['id']}).status_code == 200
    monkeypatch.setattr(main, '_utc_now', lambda: START + timedelta(minutes=10))
    if not active:
        assert client.post('/tasks/time/stop', json={'taskId': task['id']}).status_code == 200
    if completed:
        assert client.patch(f"/tasks/{task['id']}/complete", json={'completed': True}).status_code == 200


def reports(client):
    return [client.get(path).json() for path in (
        '/reports/daily?date=2026-10-02&timezone=UTC',
        '/reports/weekly?date=2026-10-02&timezone=UTC',
        '/reports/monthly?month=2026-10&timezone=UTC',
    )]


def test_task_without_entries_still_deletes_with_its_schedule(client, SessionLocal):
    project, task = seed(client)
    response = client.delete(f"/tasks/{task['id']}")
    assert response.status_code == 200
    assert response.json() == {'deleted': True}
    with SessionLocal() as session:
        assert session.get(Task, task['id']) is None
        assert session.query(ScheduleBlock).count() == session.query(TimeEntry).count() == 0
        assert session.get(Project, project['id']) is not None


@pytest.mark.parametrize('history', ['closed', 'active', 'completed'])
def test_task_history_blocks_delete_without_changing_any_entity(client, SessionLocal, monkeypatch, history):
    _, task = seed(client)
    record_history(client, monkeypatch, task, active=history == 'active', completed=history == 'completed')
    before, before_reports = stored_values(SessionLocal), reports(client)
    active = client.get('/tasks/time/active').json()
    response = client.delete(f"/tasks/{task['id']}")
    assert response.status_code == 409
    assert '実績履歴' in response.json()['detail']
    assert stored_values(SessionLocal) == before
    assert reports(client) == before_reports
    assert client.get('/tasks/time/active').json() == active


def test_rejected_task_delete_retains_all_100_actual_minutes(client, SessionLocal, monkeypatch):
    _, task = seed(client)
    record_history(client, monkeypatch, task)
    other = client.post('/tasks', json={'title': 'Other 90 minutes', 'plannedDate': '2026-10-02'}).json()
    with SessionLocal() as session:
        session.add(TimeEntry(task_id=other['id'], started_at=START - timedelta(minutes=90), ended_at=START))
        session.commit()
    before = reports(client)
    assert before[0]['dailyActualMinutes'] == 100
    assert before[1]['weeklyActualMinutes'] == before[2]['monthlyActualMinutes'] == 100
    assert client.delete(f"/tasks/{task['id']}").status_code == 409
    assert reports(client) == before


@pytest.mark.parametrize('active', [False, True])
@pytest.mark.parametrize('moved', [False, True])
def test_project_snapshot_blocks_delete_even_after_task_move(client, SessionLocal, monkeypatch, active, moved):
    project, task = seed(client)
    record_history(client, monkeypatch, task, active=active)
    if moved:
        other = client.post('/projects', json={'name': 'Current project'}).json()
        assert client.put(f"/tasks/{task['id']}", json={'projectId': other['id']}).status_code == 200
    before = stored_values(SessionLocal)
    projects_before, reports_before = client.get('/projects').json(), reports(client)
    assert next(item for item in projects_before if item['id'] == project['id'])['actualMinutes'] == 10
    active_before = client.get('/tasks/time/active').json()
    response = client.delete(f"/projects/{project['id']}")
    assert response.status_code == 409
    assert '実績履歴' in response.json()['detail']
    assert stored_values(SessionLocal) == before
    assert client.get('/projects').json() == projects_before
    assert reports(client) == reports_before
    assert client.get('/tasks/time/active').json() == active_before


@pytest.mark.parametrize('other_snapshot', [False, True])
def test_project_without_its_own_snapshot_still_unassigns_tasks(client, SessionLocal, monkeypatch, other_snapshot):
    project, task = seed(client)
    historical_id = client.post('/projects', json={'name': 'Other history'}).json()['id'] if other_snapshot else None
    assert client.put(f"/tasks/{task['id']}", json={'projectId': historical_id}).status_code == 200
    record_history(client, monkeypatch, task)
    assert client.put(f"/tasks/{task['id']}", json={'projectId': project['id']}).status_code == 200
    entries_before = client.get(f"/tasks/{task['id']}/time-entries").json()
    assert entries_before[0]['projectIdSnapshot'] == historical_id
    response = client.delete(f"/projects/{project['id']}")
    assert response.status_code == 200
    assert response.json() == {'deleted': True}
    assert client.get(f"/tasks/{task['id']}").json()['projectId'] is None
    assert client.get(f"/tasks/{task['id']}/time-entries").json() == entries_before
    with SessionLocal() as session:
        assert session.get(Project, project['id']) is None
        assert session.query(ScheduleBlock).count() == 1


@pytest.mark.parametrize('entity', ['tasks', 'projects'])
def test_history_conflict_explicitly_rolls_back_transaction(client, SessionLocal, monkeypatch, entity):
    project, task = seed(client)
    record_history(client, monkeypatch, task)
    rollbacks = []

    def rolled_back(session):
        rollbacks.append(session)

    event.listen(SessionLocal, 'after_rollback', rolled_back)
    try:
        identifier = task['id'] if entity == 'tasks' else project['id']
        assert client.delete(f'/{entity}/{identifier}').status_code == 409
    finally:
        event.remove(SessionLocal, 'after_rollback', rolled_back)
    assert len(rollbacks) == 1
    # The failed DELETE must release its SQLite write lock for the next operation.
    assert client.post('/tasks', json={'title': 'After rollback'}).status_code == 201


@pytest.mark.parametrize('entity', ['tasks', 'projects'])
def test_missing_entity_delete_remains_404(client, entity):
    assert client.delete(f'/{entity}/999999').status_code == 404
