import datetime as dt

import pytest
from pydantic import ValidationError

from app.schemas import TaskCreate, TaskUpdate


@pytest.mark.parametrize('value', ['0080-10-08', '0002-01-01', '0020-01-01', '0999-01-01', '10000-10-10', '202610-10-10', '1999-12-31', '2101-01-01', '2026-00-10', '2026-13-10', '2026-02-30', '2026-10-00', '2026-10-32', '2100-02-29'])
def test_invalid_deadline_create_and_update_do_not_write(client, value):
    task = client.post('/tasks', json={'title': 'Unchanged', 'deadline': '2026-10-10'}).json()
    assert client.post('/tasks', json={'title': 'Invalid', 'deadline': value}).status_code == 422
    assert client.put(f"/tasks/{task['id']}", json={'deadline': value}).status_code == 422
    assert client.get('/tasks').json() == [task]


@pytest.mark.parametrize('value', ['2000-01-01', '2000-02-29', '2026-10-10', '2100-12-31', None])
def test_valid_deadlines_persist_and_clear(client, value):
    task = client.post('/tasks', json={'title': 'Valid', 'deadline': value}).json()
    assert task['deadline'] == value
    assert client.put(f"/tasks/{task['id']}", json={'deadline': value}).json()['deadline'] == value
    assert client.put(f"/tasks/{task['id']}", json={'deadline': None}).json()['deadline'] is None


@pytest.mark.parametrize('schema', [TaskCreate, TaskUpdate])
def test_date_objects_also_obey_year_range(schema):
    with pytest.raises(ValidationError):
        schema(title='Invalid', deadline=dt.date(80, 10, 8))
    assert schema(title='Valid', deadline=dt.date(2000, 1, 1)).deadline == dt.date(2000, 1, 1)
