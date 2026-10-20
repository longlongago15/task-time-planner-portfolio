"""Project history correction, validation and attribution regression coverage."""
from datetime import datetime, timezone
import pytest
from app import main


@pytest.fixture
def record(client, monkeypatch):
    monkeypatch.setattr(main, '_utc_now', lambda: datetime(2026, 10, 8, 12, tzinfo=timezone.utc))
    a = client.post('/projects', json={'name': 'A'}).json()['id']
    b = client.post('/projects', json={'name': 'B'}).json()['id']
    task = client.post('/tasks', json={'title': 'Recorded', 'projectId': a, 'estimatedMinutes': 60}).json()['id']
    entry = client.post('/time-entries', json={'taskId': task, 'startedAt': '2026-10-07T04:00:00Z', 'endedAt': '2026-10-07T04:30:00Z'}).json()
    client.put(f'/tasks/{task}', json={'projectId': b})
    return a, b, task, entry


@pytest.mark.parametrize('field,value,expected_status', [
    ('id', 99, 422),
    ('taskId', 99, 404),
    ('projectIdSnapshot', 99, 404),
    ('createdAt', '2026-10-01T00:00:00Z', 422),
    ('durationMinutes', 45, 422),
    ('updatedAt', '2026-10-01T00:00:00Z', 422),
])
def test_invalid_payload_rejected_atomically(client, record, field, value, expected_status):
    _, _, task, entry = record
    response = client.patch(f"/time-entries/{entry['id']}", json={'endedAt': '2026-10-07T04:45:00Z', field: value})
    assert response.status_code == expected_status
    assert client.get(f'/tasks/{task}/time-entries').json() == [entry]


def test_snapshot_task_project_and_all_reports_follow_edit_and_delete(client, record):
    a, b, task, entry = record
    def check(minutes):
        assert client.get(f'/tasks/{task}').json()['actualMinutes'] == minutes
        projects = {p['id']: p for p in client.get('/projects').json()}
        assert projects[a]['actualMinutes'] == minutes
        assert projects[b]['actualMinutes'] == 0
        for mode, key, query in [('daily', 'dailyActualMinutes', 'date=2026-10-07'), ('weekly', 'weeklyActualMinutes', 'date=2026-10-07'), ('monthly', 'monthlyActualMinutes', 'month=2026-10')]:
            report = client.get(f'/reports/{mode}?{query}&timezone=Asia/Tokyo').json()
            assert report[key] == minutes
    check(30)
    response = client.patch(f"/time-entries/{entry['id']}", json={'startedAt': '2026-10-07T04:00:00Z', 'endedAt': '2026-10-07T04:45:00Z'})
    assert response.status_code == 200
    for field in ('id', 'taskId', 'projectIdSnapshot', 'createdAt'):
        assert response.json()[field] == entry[field]
    check(45)
    assert client.delete(f'/tasks/{task}').status_code == 409
    assert client.delete(f"/time-entries/{entry['id']}").status_code == 200
    check(0)
    assert client.delete(f'/tasks/{task}').status_code == 200


def test_cross_day_edit_changes_report_days_without_changing_snapshot(client, record):
    _, _, _, entry = record
    response = client.patch(f"/time-entries/{entry['id']}", json={'startedAt': '2026-10-07T23:30:00+09:00', 'endedAt': '2026-10-08T00:45:00+09:00'})
    assert response.status_code == 200 and response.json()['durationMinutes'] == 75
    assert response.json()['projectIdSnapshot'] == entry['projectIdSnapshot']
    for day, minutes in [('2026-10-07', 30), ('2026-10-08', 45)]:
        assert client.get(f'/reports/daily?date={day}&timezone=Asia/Tokyo').json()['dailyActualMinutes'] == minutes
