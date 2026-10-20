from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event

from app import main
from app.models import Tag, Task


def tag(client, name):
    response = client.post('/tags', json={'name': name})
    assert response.status_code == 201, response.text
    return response.json()


def task(client, **values):
    response = client.post('/tasks', json={'title': 'Tagged task', **values})
    assert response.status_code == 201, response.text
    return response.json()


def links(factory):
    with factory() as session:
        return session.execute(main.text('SELECT task_id,tag_id FROM task_tags ORDER BY task_id,tag_id')).all()


def old_rows(factory):
    with factory() as session:
        return {name: session.execute(main.text(f'SELECT * FROM {name} ORDER BY id')).all()
                for name in ('projects', 'tasks', 'schedule_blocks', 'time_entries')}


def test_tag_crud_trim_stable_order_and_timestamps(client):
    assert client.get('/tags').json() == []
    fe = tag(client, ' \tFE\n ')
    aws = tag(client, 'AWS')
    assert fe['name'] == 'FE'
    assert set(fe) == {'id', 'name', 'color', 'createdAt', 'updatedAt'}
    assert datetime.fromisoformat(fe['createdAt']).utcoffset() == timedelta(0)
    assert client.get('/tags').json() == [aws, fe]
    renamed = client.patch(f"/tags/{fe['id']}", json={'name': ' Java '})
    assert renamed.status_code == 200
    assert renamed.json()['id'] == fe['id']
    assert renamed.json()['name'] == 'Java'
    assert renamed.json()['createdAt'] == fe['createdAt']
    assert client.delete(f"/tags/{aws['id']}").json() == {'deleted': True}
    assert [item['name'] for item in client.get('/tags').json()] == ['Java']


@pytest.mark.parametrize('payload', [{}, {'name': ''}, {'name': ' \t\n '}, {'name': 'x' * 256}, {'name': None}, {'name': 42}])
def test_invalid_tag_names_do_not_create_or_rename(client, payload):
    saved = tag(client, 'Keep')
    assert client.post('/tags', json=payload).status_code == 422
    assert client.patch(f"/tags/{saved['id']}", json=payload).status_code == 422
    assert client.get('/tags').json() == [saved]


def test_max_length_is_measured_after_trim_and_supports_unicode(client):
    saved = tag(client, ' ' + '学' * 255 + '\n')
    assert saved['name'] == '学' * 255
    assert client.post('/tags', json={'name': '学' * 256}).status_code == 422


def test_exact_duplicate_and_rename_conflict_are_409_without_merge(client, SessionLocal):
    fe = tag(client, 'FE'); aws = tag(client, 'AWS')
    a = task(client, tagIds=[fe['id']]); b = task(client, tagIds=[aws['id']])
    before = links(SessionLocal)
    assert client.post('/tags', json={'name': ' FE '}).status_code == 409
    assert client.patch(f"/tags/{aws['id']}", json={'name': 'FE'}).status_code == 409
    assert links(SessionLocal) == before
    assert client.get(f"/tasks/{a['id']}").json()['tags'] == [fe]
    assert client.get(f"/tasks/{b['id']}").json()['tags'] == [aws]
    assert client.patch(f"/tags/{fe['id']}", json={'name': 'FE'}).status_code == 200


@pytest.mark.parametrize('method', ['patch', 'delete'])
@pytest.mark.parametrize('tag_id', [999, -1, 'invalid'])
def test_invalid_tag_id(client, method, tag_id):
    response = getattr(client, method)(f'/tags/{tag_id}', **({'json': {'name': 'New'}} if method == 'patch' else {}))
    assert response.status_code == (422 if tag_id == 'invalid' else 404)
    assert client.get('/tags').json() == []


@pytest.mark.parametrize('count', [0, 1, 3])
def test_create_and_read_task_tags_without_changing_existing_fields(client, count):
    tags = [tag(client, name) for name in ('復習', 'FE', 'AWS')][:count]
    values = {'title': 'Study', 'estimatedMinutes': 60, 'priority': 'HIGH', 'deadline': '2026-12-31'}
    if count:
        values['tagIds'] = [item['id'] for item in tags]
    saved = task(client, **values)
    assert saved['tags'] == sorted(tags, key=lambda item: item['name'])
    assert [item['name'] for item in saved['tags']] == sorted(item['name'] for item in tags)
    for field in ('title', 'estimatedMinutes', 'priority', 'deadline'):
        assert saved[field] == values[field]
    assert saved['status'] == 'NOT_STARTED' and saved['projectId'] is None
    assert client.get(f"/tasks/{saved['id']}").json() == saved
    assert client.get('/tasks').json() == [saved]
    assert client.get('/tasks?inbox=true').json() == [saved]


def test_update_tags_preserves_common_relation_and_omitted_field_then_clears(client, SessionLocal):
    aws = tag(client, 'AWS'); fe = tag(client, 'FE'); java = tag(client, 'Java')
    saved = task(client, tagIds=[fe['id'], aws['id']])
    updated = client.put(f"/tasks/{saved['id']}", json={'tagIds': [java['id'], fe['id']]})
    assert updated.status_code == 200
    assert updated.json()['tags'] == [fe, java]
    assert links(SessionLocal) == [(saved['id'], fe['id']), (saved['id'], java['id'])]
    renamed = client.put(f"/tasks/{saved['id']}", json={'title': 'Rename only'})
    assert renamed.json()['tags'] == [fe, java]
    assert client.put(f"/tasks/{saved['id']}", json={'tagIds': [fe['id']]}).json()['tags'] == [fe]
    assert client.put(f"/tasks/{saved['id']}", json={'tagIds': []}).json()['tags'] == []
    assert links(SessionLocal) == []
    assert client.get('/tags').json() == [aws, fe, java], 'Unused tags are not automatically deleted'


def test_duplicate_tag_ids_are_deduplicated_consistently(client, SessionLocal):
    fe = tag(client, 'FE'); aws = tag(client, 'AWS')
    saved = task(client, tagIds=[fe['id'], fe['id'], aws['id']])
    assert saved['tags'] == [aws, fe]
    assert len(links(SessionLocal)) == 2
    response = client.put(f"/tasks/{saved['id']}", json={'tagIds': [aws['id'], fe['id'], aws['id']]})
    assert response.status_code == 200 and response.json()['tags'] == [aws, fe]
    assert len(links(SessionLocal)) == 2


def test_nonexistent_tag_rejects_entire_create_or_update(client, SessionLocal):
    fe = tag(client, 'FE')
    saved = task(client, tagIds=[fe['id']], priority='LOW')
    before = old_rows(SessionLocal)
    assert client.post('/tasks', json={'title': 'Must not exist', 'tagIds': [fe['id'], 999]}).status_code == 422
    assert client.put(f"/tasks/{saved['id']}", json={'title': 'Must not change', 'priority': 'HIGH', 'tagIds': [999]}).status_code == 422
    assert old_rows(SessionLocal) == before
    assert links(SessionLocal) == [(saved['id'], fe['id'])]
    assert client.get('/tags').json() == [fe]


@pytest.mark.parametrize('ids', [None, '1', [0], [-1], [True], [1.5], ['1'], [None], {'id': 1}])
def test_tag_ids_require_a_list_of_positive_strict_integers(client, ids):
    saved = task(client)
    assert client.post('/tasks', json={'title': 'Invalid IDs', 'tagIds': ids}).status_code == 422
    assert client.put(f"/tasks/{saved['id']}", json={'tagIds': ids}).status_code == 422
    assert client.get(f"/tasks/{saved['id']}").json() == saved


def test_later_task_validation_rolls_back_relation_changes(client, SessionLocal):
    a = tag(client, 'A'); b = tag(client, 'B'); saved = task(client, tagIds=[a['id']])
    before = old_rows(SessionLocal)
    assert client.put(f"/tasks/{saved['id']}", json={'tagIds': [b['id']], 'projectId': 999}).status_code == 404
    assert client.put(f"/tasks/{saved['id']}", json={'tagIds': [b['id']], 'plannedStartTime': '10:00'}).status_code == 422
    assert old_rows(SessionLocal) == before
    assert links(SessionLocal) == [(saved['id'], a['id'])]


def test_rename_preserves_all_associations_and_old_entity_rows(client, SessionLocal):
    fe = tag(client, 'FE')
    a = task(client, tagIds=[fe['id']]); b = task(client, tagIds=[fe['id']])
    before = old_rows(SessionLocal); associations = links(SessionLocal)
    response = client.patch(f"/tags/{fe['id']}", json={'name': '学習'})
    assert response.status_code == 200
    assert old_rows(SessionLocal) == before and links(SessionLocal) == associations
    for saved in (a, b):
        assert client.get(f"/tasks/{saved['id']}").json()['tags'] == [response.json()]


def test_task_delete_removes_only_links_and_preserves_shared_tag(client, SessionLocal):
    fe = tag(client, 'FE')
    a = task(client, tagIds=[fe['id']]); b = task(client, tagIds=[fe['id']])
    assert client.delete(f"/tasks/{a['id']}").status_code == 200
    assert links(SessionLocal) == [(b['id'], fe['id'])]
    assert client.get('/tags').json() == [fe]
    assert client.get(f"/tasks/{b['id']}").status_code == 200


def test_tag_delete_keeps_tasks_schedules_active_history_and_reports(client, SessionLocal, monkeypatch):
    now = datetime(2026, 10, 7, 8, tzinfo=timezone.utc)
    monkeypatch.setattr(main, '_utc_now', lambda: now)
    project = client.post('/projects', json={'name': 'Main project'}).json()
    fe = tag(client, 'FE'); other = tag(client, 'Other')
    saved = task(client, tagIds=[fe['id'], other['id']], projectId=project['id'], estimatedMinutes=60, priority='HIGH', deadline='2026-10-08')
    client.post('/schedule-blocks', json={'taskId': saved['id'], 'date': '2026-10-07', 'type': 'TIMED', 'startTime': '08:00', 'durationMinutes': 45})
    assert client.post('/tasks/time/start', json={'taskId': saved['id']}).status_code == 200
    paths = [f"/tasks/{saved['id']}/time-entries", '/tasks/time/active', '/schedule-blocks', '/projects', '/reports/daily?date=2026-10-07&timezone=UTC', '/reports/weekly?date=2026-10-07&timezone=UTC', '/reports/monthly?month=2026-10&timezone=UTC']
    responses = {path: client.get(path).json() for path in paths}
    before = old_rows(SessionLocal)
    # Renaming and changing tags on an Active Task must also preserve its Snapshot.
    assert client.patch(f"/tags/{fe['id']}", json={'name': 'Renamed'}).status_code == 200
    assert client.put(f"/tasks/{saved['id']}", json={'tagIds': [other['id']]}).status_code == 200
    assert {path: client.get(path).json() for path in paths} == responses
    assert client.put(f"/tasks/{saved['id']}", json={'tagIds': [fe['id'], other['id']]}).status_code == 200
    before_delete = old_rows(SessionLocal)
    assert client.delete(f"/tags/{fe['id']}").status_code == 200
    assert old_rows(SessionLocal) == before_delete
    assert {path: client.get(path).json() for path in paths} == responses
    assert client.get(f"/tasks/{saved['id']}").json()['tags'] == [other]
    assert client.delete(f"/tasks/{saved['id']}").status_code == 409
    assert client.delete(f"/projects/{project['id']}").status_code == 409
    assert len(before['tasks']) == len(old_rows(SessionLocal)['tasks']) == 1
    assert client.get(f"/tasks/{saved['id']}/time-entries").json()[0]['projectIdSnapshot'] == project['id']


@pytest.mark.parametrize('operation', ['create', 'update'])
def test_association_database_failure_rolls_back_task_and_links(client, SessionLocal, operation):
    a = tag(client, 'A'); b = tag(client, 'B'); saved = task(client, tagIds=[a['id']])
    before = old_rows(SessionLocal); associations = links(SessionLocal)
    engine = SessionLocal.kw['bind']
    def fail(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith('INSERT INTO task_tags'):
            raise RuntimeError('Injected association save failure')
    event.listen(engine, 'before_cursor_execute', fail)
    try:
        with pytest.raises(RuntimeError, match='association save failure'):
            if operation == 'create':
                client.post('/tasks', json={'title': 'Do not retain', 'tagIds': [b['id']]})
            else:
                client.put(f"/tasks/{saved['id']}", json={'title': 'Do not retain', 'tagIds': [b['id']]})
    finally:
        event.remove(engine, 'before_cursor_execute', fail)
    assert old_rows(SessionLocal) == before and links(SessionLocal) == associations
    with SessionLocal() as session:
        assert session.query(Tag).count() == 2 and session.query(Task).count() == 1
