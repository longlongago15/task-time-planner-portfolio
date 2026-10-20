"""Identification color API behavior, associations and historical snapshots."""
import pytest


@pytest.mark.parametrize('resource,method', [('projects', 'put'), ('tags', 'patch')])
def test_color_create_update_omission_reset_and_normalization(client, resource, method):
    plain = client.post(f'/{resource}', json={'name': 'Default'}).json()
    assert plain['color'] is None
    explicit = client.post(f'/{resource}', json={'name': 'Explicit null', 'color': None}).json()
    assert explicit['color'] is None
    response = client.post(f'/{resource}', json={'name': 'Colored', 'color': '#3b82f6'})
    assert response.status_code in (200, 201)
    saved = response.json()
    assert saved['color'] == '#3B82F6'
    url = f"/{resource}/{saved['id']}"
    update = getattr(client, method)
    assert update(url, json={'name': 'Renamed'}).json()['color'] == '#3B82F6'
    changed = update(url, json={'name': 'Renamed again', 'color': '#8b5cf6'}).json()
    assert changed['id'] == saved['id'] and changed['color'] == '#8B5CF6'
    assert next(item for item in client.get(f'/{resource}').json() if item['id'] == saved['id'])['color'] == '#8B5CF6'
    assert update(url, json={'name': 'Reset', 'color': None}).json()['color'] is None


@pytest.mark.parametrize('resource,method', [('projects', 'put'), ('tags', 'patch')])
@pytest.mark.parametrize('invalid', ['red', 'blue', '3B82F6', '#FFF', '#12345', '#1234567', '#GG0000', '#123456\n', ' #123456', '', 123456, True, {}, []])
def test_invalid_color_is_rejected_without_mutation(client, resource, method, invalid):
    saved = client.post(f'/{resource}', json={'name': 'Kept', 'color': '#FFFFFF'}).json()
    before = client.get(f'/{resource}').json()
    assert client.post(f'/{resource}', json={'name': 'Invalid', 'color': invalid}).status_code == 422
    assert getattr(client, method)(f"/{resource}/{saved['id']}", json={'name': 'Changed', 'color': invalid}).status_code == 422
    assert client.get(f'/{resource}').json() == before


def test_rename_and_color_keep_links_schedules_and_time_entry_snapshots(client):
    project = client.post('/projects', json={'name': 'Project', 'color': '#568BC7'}).json()
    tag = client.post('/tags', json={'name': 'FE', 'color': '#568BC7'}).json()
    task = client.post('/tasks', json={'title': 'Keep associations', 'projectId': project['id'], 'tagIds': [tag['id']]}).json()
    block = client.post('/schedule-blocks', json={'taskId': task['id'], 'date': '2026-10-07', 'type': 'ALL_DAY'}).json()
    entry = client.post('/time-entries', json={'taskId': task['id'], 'startedAt': '2026-10-07T00:00:00Z', 'endedAt': '2026-10-07T00:30:00Z'}).json()
    changed = client.patch(f"/tags/{tag['id']}", json={'name': '基本情報', 'color': '#A079BE'}).json()
    client.put(f"/projects/{project['id']}", json={'name': 'Updated project', 'color': '#000000'})
    current = client.get(f"/tasks/{task['id']}").json()
    assert current['tags'] == [changed] and current['projectId'] == project['id']
    assert client.get('/schedule-blocks').json() == [block]
    assert client.get(f"/tasks/{task['id']}/time-entries").json() == [entry]
    duplicate = client.post('/tags', json={'name': '基本情報', 'color': '#DC6262'})
    assert duplicate.status_code == 409
    client.patch(f"/tags/{tag['id']}", json={'name': '基本情報', 'color': None})
    assert client.get(f"/tasks/{task['id']}").json()['tags'][0]['color'] is None
