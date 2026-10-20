import pytest


@pytest.mark.parametrize('metadata', [
    {'priority': 'HIGH'}, {'priority': 'MEDIUM'}, {'priority': 'LOW'},
    {'deadline': '2026-10-12'}, {'priority': 'HIGH', 'deadline': '2026-10-12'},
    {'priority': None, 'deadline': None}, {},
])
def test_create_and_read_metadata(client, metadata):
    response = client.post('/tasks', json={'title': 'Metadata task', **metadata})
    assert response.status_code == 201
    task = response.json()
    for key in ('priority', 'deadline'):
        assert task[key] == metadata.get(key)
    assert client.get(f"/tasks/{task['id']}").json() == task
    assert client.get('/tasks').json()[0] == task


@pytest.mark.parametrize('field,value', [('priority', 'LOW'), ('deadline', '2027-01-01'), ('priority', None), ('deadline', None)])
def test_partial_update_and_clear(client, field, value):
    task = client.post('/tasks', json={'title': 'Keep title', 'estimatedMinutes': 150, 'priority': 'HIGH', 'deadline': '2026-10-12'}).json()
    response = client.put(f"/tasks/{task['id']}", json={field: value})
    assert response.status_code == 200
    updated = response.json()
    assert updated[field] == value
    for key in ('title', 'estimatedMinutes', 'priority', 'deadline'):
        if key != field:
            assert updated[key] == task[key]


@pytest.mark.parametrize('field,value', [
    ('priority', 'URGENT'), ('priority', 'high'), ('priority', ''), ('priority', 1), ('priority', True),
    ('deadline', '2026-02-30'), ('deadline', '2026-1-01'), ('deadline', '2026-10-12T00:00:00Z'),
    ('deadline', '20261012'), ('deadline', 0), ('deadline', True), ('deadline', ''),
    ('status', None), ('status', 'PAUSED'),
])
def test_invalid_metadata_never_changes_existing_task(client, field, value):
    task = client.post('/tasks', json={'title': 'Unchanged'}).json()
    if field != 'status':
        assert client.post('/tasks', json={'title': 'Invalid', field: value}).status_code == 422
    assert client.put(f"/tasks/{task['id']}", json={field: value}).status_code == 422
    assert client.get(f"/tasks/{task['id']}").json() == task


def test_metadata_does_not_change_schedule_or_snapshots(client):
    old = client.post('/projects', json={'name': 'Old'}).json()
    new = client.post('/projects', json={'name': 'New'}).json()
    task = client.post('/tasks', json={'title': 'History', 'projectId': old['id']}).json()
    block = client.post('/schedule-blocks', json={'taskId': task['id'], 'date': '2026-10-01', 'type': 'ALL_DAY'}).json()
    assert client.post('/tasks/time/start', json={'taskId': task['id']}).status_code == 200
    entries = client.get(f"/tasks/{task['id']}/time-entries").json()
    assert client.put(f"/tasks/{task['id']}", json={'priority': 'HIGH', 'deadline': '2026-10-12', 'projectId': new['id']}).status_code == 200
    assert client.get('/schedule-blocks').json() == [block]
    assert client.get(f"/tasks/{task['id']}/time-entries").json() == entries
    assert entries[0]['projectIdSnapshot'] == old['id']
    assert client.put(f"/tasks/{task['id']}", json={'status': 'COMPLETED', 'priority': 'LOW'}).status_code == 409
    assert client.get(f"/tasks/{task['id']}").json()['priority'] == 'HIGH'
    assert client.delete(f"/tasks/{task['id']}").status_code == 409


def test_status_select_keeps_completion_contract(client):
    task = client.post('/tasks', json={'title': 'Status', 'estimatedMinutes': 30}).json()
    for status in ('IN_PROGRESS', 'COMPLETED', 'NOT_STARTED'):
        response = client.put(f"/tasks/{task['id']}", json={'status': status})
        assert response.status_code == 200
        updated = response.json()
        assert updated['status'] == status
        assert updated['completed'] == (status == 'COMPLETED')
        assert (updated['completedAt'] is not None) == updated['completed']
        assert updated['completedEstimateMinutes'] == (30 if updated['completed'] else None)
    assert client.get(f"/tasks/{task['id']}/time-entries").json() == []
