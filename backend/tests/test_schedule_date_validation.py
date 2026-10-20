import datetime as dt

import pytest
from pydantic import ValidationError

from app.schemas import ScheduleBlockCreate, ScheduleBlockUpdate


@pytest.mark.parametrize('value', ['0080-10-08', '0002-01-01', '0020-01-01', '1999-12-31', '2101-01-01', '10000-10-08', '2026-13-01', '2026-02-30', '2026-00-01', '2026-10-00', '2026-10-32', '2100-02-29', '20261008', '2026/10/08'])
def test_invalid_schedule_dates_reject_create_update_without_changing_rows(client, value):
    task = client.post('/tasks', json={'title': 'Protected schedule'}).json()
    block = client.post('/schedule-blocks', json={'taskId': task['id'], 'date': '2026-10-08', 'type': 'TIME_UNSET'}).json()
    assert client.post('/schedule-blocks', json={'taskId': task['id'], 'date': value, 'type': 'TIME_UNSET'}).status_code == 422
    assert client.patch(f"/schedule-blocks/{block['id']}", json={'date': value}).status_code == 422
    assert client.get('/schedule-blocks').json() == [block]


@pytest.mark.parametrize('value', ['2000-01-01', '2000-02-29', '2026-10-08', '2100-12-31'])
def test_inclusive_schedule_date_limits_persist(client, value):
    task = client.post('/tasks', json={'title': 'Valid schedule'}).json()
    block = client.post('/schedule-blocks', json={'taskId': task['id'], 'date': value, 'type': 'TIME_UNSET'}).json()
    assert block['date'] == value
    assert client.patch(f"/schedule-blocks/{block['id']}", json={'date': value}).json()['date'] == value


@pytest.mark.parametrize('schema', [ScheduleBlockCreate, ScheduleBlockUpdate])
def test_schedule_date_objects_also_obey_year_limits(schema):
    fields = {'taskId': 1, 'type': 'TIME_UNSET'} if schema is ScheduleBlockCreate else {}
    with pytest.raises(ValidationError):
        schema(date=dt.date(80, 10, 8), **fields)
    assert schema(date=dt.date(2000, 1, 1), **fields).date == dt.date(2000, 1, 1)
