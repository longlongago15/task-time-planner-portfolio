from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from app import main
from app.models import ScheduleBlock, Task, TimeEntry


def test_health_endpoint(client):
    response = client.get('/health')
    assert response.status_code == 200
    assert response.json()['status'] == 'ok'


def test_task_crud_flow(client):
    create_response = client.post('/tasks', json={'title': 'Study planning', 'estimatedMinutes': 60, 'plannedDate': '2026-09-04'})
    assert create_response.status_code == 201, create_response.text
    task = create_response.json()
    assert task['title'] == 'Study planning'
    assert task['estimatedMinutes'] == 60
    assert task['plannedDate'] == '2026-09-04'
    assert task['completed'] is False

    list_response = client.get('/tasks')
    assert list_response.status_code == 200
    task_list = list_response.json()
    assert any(item['id'] == task['id'] and item['plannedDate'] == '2026-09-04' for item in task_list)

    update_response = client.put(f"/tasks/{task['id']}", json={'title': 'Study planning revised', 'estimatedMinutes': 90, 'plannedDate': '2026-09-05'})
    assert update_response.status_code == 200
    assert update_response.json()['title'] == 'Study planning revised'
    assert update_response.json()['estimatedMinutes'] == 90
    assert update_response.json()['plannedDate'] == '2026-09-05'

    toggle_response = client.patch(f"/tasks/{task['id']}/complete", json={'completed': True})
    assert toggle_response.status_code == 200
    assert toggle_response.json()['completed'] is True

    delete_response = client.delete(f"/tasks/{task['id']}")
    assert delete_response.status_code == 200
    assert delete_response.json()['deleted'] is True


def test_projects_and_unscheduled_task_scheduling_flow(client):
    project_name = f"Study project {datetime.now().timestamp()}"
    project_response = client.post('/projects', json={'name': project_name})
    assert project_response.status_code == 200, project_response.text
    project = project_response.json()
    assert project['name'] == project_name
    assert project['taskCount'] == 0

    duplicate = client.post('/projects', json={'name': project_name})
    assert duplicate.status_code == 409

    task_response = client.post('/tasks', json={
        'title': 'Unscheduled task',
        'estimatedMinutes': 60,
        'plannedDate': None,
        'projectId': project['id'],
    })
    assert task_response.status_code == 201, task_response.text
    task = task_response.json()
    assert task['plannedDate'] is None
    assert task['plannedStartTime'] is None
    assert task['projectId'] == project['id']

    invalid_schedule = client.post('/tasks', json={
        'title': 'Time without date',
        'estimatedMinutes': 30,
        'plannedStartTime': '09:00',
    })
    assert invalid_schedule.status_code == 422

    scheduled = client.put(f"/tasks/{task['id']}", json={
        'plannedDate': '2099-09-07',
        'plannedStartTime': '09:00',
    })
    assert scheduled.status_code == 200
    assert scheduled.json()['plannedDate'] == '2099-09-07'
    assert scheduled.json()['plannedStartTime'].startswith('09:00')

    project_stats = client.get('/projects')
    stats = next(item for item in project_stats.json() if item['id'] == project['id'])
    assert stats['taskCount'] == 1
    assert stats['estimatedMinutes'] == 60

    cleared = client.put(f"/tasks/{task['id']}", json={
        'plannedDate': None,
        'plannedStartTime': None,
    })
    assert cleared.status_code == 200
    assert cleared.json()['plannedDate'] is None

    deleted_project = client.delete(f"/projects/{project['id']}")
    assert deleted_project.status_code == 200
    remaining_task = client.get(f"/tasks/{task['id']}").json()
    assert remaining_task['projectId'] is None
    assert remaining_task['title'] == 'Unscheduled task'
    assert client.delete(f"/tasks/{task['id']}").status_code == 200


def test_validation_rejects_invalid_task_input(client):
    empty_title = client.post('/tasks', json={'title': '   ', 'estimatedMinutes': 60, 'plannedDate': '2026-09-04'})
    assert empty_title.status_code == 422

    invalid_minutes = client.post('/tasks', json={'title': 'Invalid estimate', 'estimatedMinutes': 0, 'plannedDate': '2026-09-04'})
    assert invalid_minutes.status_code == 422

    invalid_date = client.post('/tasks', json={'title': 'Invalid date', 'estimatedMinutes': 20, 'plannedDate': '09-04-2026'})
    assert invalid_date.status_code == 422

    missing_date = client.post('/tasks', json={'title': 'Missing date', 'estimatedMinutes': 20})
    assert missing_date.status_code == 201
    assert missing_date.json()['plannedDate'] is None
    assert client.delete(f"/tasks/{missing_date.json()['id']}").status_code == 200


def test_timer_entries_are_accumulated_per_task(client, monkeypatch):
    now = datetime(2026, 10, 2, 1, tzinfo=timezone.utc)
    monkeypatch.setattr(main, '_utc_now', lambda: now)
    create_response = client.post('/tasks', json={'title': 'Timer task', 'estimatedMinutes': 120, 'plannedDate': '2026-09-04'})
    task = create_response.json()

    start_response = client.post('/tasks/time/start', json={'taskId': task['id']})
    assert start_response.status_code == 200
    assert start_response.json()['running'] is True

    now += timedelta(minutes=45)
    first_end = now.isoformat()
    stop_response = client.post('/tasks/time/stop', json={'taskId': task['id'], 'endAt': first_end})
    assert stop_response.status_code == 200
    assert stop_response.json()['durationMinutes'] == 45

    second_response = client.post('/tasks/time/start', json={'taskId': task['id']})
    assert second_response.status_code == 200

    now += timedelta(minutes=45)
    second_end = now.isoformat()
    final_stop = client.post('/tasks/time/stop', json={'taskId': task['id'], 'endAt': second_end})
    assert final_stop.status_code == 200
    assert final_stop.json()['durationMinutes'] == 45

    actual_response = client.get(f"/tasks/{task['id']}/actual-minutes")
    assert actual_response.status_code == 200
    assert actual_response.json()['actualMinutes'] == 90
    task_detail = client.get(f"/tasks/{task['id']}").json()
    assert task_detail['actualStartedAt'] is not None
    history = client.get(f"/tasks/{task['id']}/time-entries")
    assert history.status_code == 200
    assert len(history.json()) == 2
    assert sum(entry['durationMinutes'] for entry in history.json()) == 90

    diff_response = client.get(f"/tasks/{task['id']}/diff")
    assert diff_response.status_code == 200
    assert diff_response.json()['differenceMinutes'] == -30
    assert client.delete(f"/tasks/{task['id']}").status_code == 409
    assert client.get(f"/tasks/{task['id']}/actual-minutes").json()['actualMinutes'] == 90


def test_timer_errors_return_statuses_and_preserve_running_timer(client, monkeypatch):
    start = datetime(2026, 10, 2, 1, tzinfo=timezone.utc)
    monkeypatch.setattr(main, '_utc_now', lambda: start)
    create_response = client.post('/tasks', json={'title': 'Error task', 'estimatedMinutes': 30, 'plannedDate': '2099-09-04'})
    task = create_response.json()

    stop_without_start = client.post('/tasks/time/stop', json={'taskId': task['id']})
    assert stop_without_start.status_code == 409

    start_response = client.post('/tasks/time/start', json={'taskId': task['id']})
    assert start_response.status_code == 200
    active_timer = client.get('/tasks/time/active').json()
    assert active_timer['running'] is True
    assert active_timer['taskId'] == task['id']
    monkeypatch.setattr(main, '_utc_now', lambda: start - timedelta(minutes=1))
    invalid_stop = client.post('/tasks/time/stop', json={'taskId': task['id']})
    assert invalid_stop.status_code == 409
    assert client.get('/tasks/time/active').json() == active_timer

    monkeypatch.setattr(main, '_utc_now', lambda: start + timedelta(minutes=1))
    valid_stop = client.post('/tasks/time/stop', json={'taskId': task['id']})
    assert valid_stop.status_code == 200
    assert client.get('/tasks/time/active').json()['running'] is False

    missing_task = client.post('/tasks/time/start', json={'taskId': 999999})
    assert missing_task.status_code == 404
    assert client.delete(f"/tasks/{task['id']}").status_code == 409


def test_second_timer_is_rejected_while_another_task_is_running(client):
    first = client.post('/tasks', json={'title': 'First timer', 'estimatedMinutes': 30, 'plannedDate': '2099-09-04'}).json()
    second = client.post('/tasks', json={'title': 'Second timer', 'estimatedMinutes': 30, 'plannedDate': '2099-09-04'}).json()
    assert client.post('/tasks/time/start', json={'taskId': first['id']}).status_code == 200
    assert client.post('/tasks/time/start', json={'taskId': second['id']}).status_code == 409
    assert client.post('/tasks/time/stop', json={'taskId': first['id']}).status_code == 200
    assert client.delete(f"/tasks/{first['id']}").status_code == 409
    assert client.delete(f"/tasks/{second['id']}").status_code == 200


def test_daily_summary_uses_schedule_blocks_and_splits_cross_midnight_entries(client, SessionLocal):
    db = SessionLocal()
    first_task = Task(title='Daily task A', estimated_minutes=60, planned_date=date(2099, 9, 4), completed=False)
    second_task = Task(title='Daily task B', estimated_minutes=30, planned_date=date(2099, 9, 4), completed=False)
    other_day_task = Task(title='Other day task', estimated_minutes=120, planned_date=date(2099, 9, 5), completed=False)
    db.add_all([first_task, second_task, other_day_task])
    db.flush()
    db.add_all(ScheduleBlock(task_id=task.id, date=day, type='TIME_UNSET')
               for task, day in [(first_task, date(2099, 9, 4)), (second_task, date(2099, 9, 4)),
                                 (other_day_task, date(2099, 9, 5))])
    db.add(TimeEntry(
        task_id=first_task.id,
        started_at=datetime(2099, 9, 4, 23, 50),
        ended_at=datetime(2099, 9, 5, 0, 20),
    ))
    task_ids = [first_task.id, second_task.id, other_day_task.id]
    first_task_id, second_task_id, other_day_task_id = task_ids
    db.commit()
    db.close()

    response = client.get('/reports/daily', params={'date': '2099-09-04', 'timezone': 'UTC'})
    assert response.status_code == 200
    assert response.json() == {
        'date': '2099-09-04',
        'plannedOccupiedMinutes': 0,
        'dailyEstimatedMinutes': 90,
        'dailyActualMinutes': 10,
        'dailyDifference': -80,
        'tasks': [
            {
                'taskId': first_task_id,
                'title': 'Daily task A',
                'estimatedMinutes': 60,
                'actualMinutes': 10,
                'differenceMinutes': -50,
            },
            {
                'taskId': second_task_id,
                'title': 'Daily task B',
                'estimatedMinutes': 30,
                'actualMinutes': 0,
                'differenceMinutes': -30,
            },
        ],
    }
    task_response = client.get(f'/tasks/{first_task_id}')
    assert task_response.status_code == 200
    assert task_response.json()['actualMinutes'] == 30

    next_day_response = client.get('/reports/daily', params={'date': '2099-09-05', 'timezone': 'UTC'})
    assert next_day_response.status_code == 200
    assert next_day_response.json()['dailyEstimatedMinutes'] == 120
    assert next_day_response.json()['dailyActualMinutes'] == 20
    assert next_day_response.json()['tasks'][0]['taskId'] == other_day_task_id
    assert next_day_response.json()['tasks'][0]['actualMinutes'] == 0

    db = SessionLocal()
    db.query(TimeEntry).filter(TimeEntry.task_id.in_(task_ids)).delete(synchronize_session=False)
    db.query(Task).filter(Task.id.in_(task_ids)).delete(synchronize_session=False)
    db.commit()
    db.close()


def test_daily_summary_returns_zero_for_empty_day(client):
    response = client.get('/reports/daily', params={'date': '2099-09-06', 'timezone': 'UTC'})
    assert response.status_code == 200
    assert response.json() == {
        'date': '2099-09-06',
        'plannedOccupiedMinutes': 0,
        'dailyEstimatedMinutes': 0,
        'dailyActualMinutes': 0,
        'dailyDifference': 0,
        'tasks': [],
    }


def test_daily_summary_uses_requested_timezone_and_rejects_invalid_timezone(client, SessionLocal):
    db = SessionLocal()
    task = Task(title='Tokyo timezone task', estimated_minutes=60, planned_date=date(2098, 9, 6), completed=False)
    db.add(task)
    db.flush()
    db.add(ScheduleBlock(task_id=task.id, date=date(2098, 9, 6), type='TIME_UNSET'))
    tokyo = ZoneInfo('Asia/Tokyo')
    local_start = datetime.combine(date(2098, 9, 6), time(0, 15), tzinfo=tokyo)
    db.add(TimeEntry(
        task_id=task.id,
        started_at=local_start.astimezone(timezone.utc),
        ended_at=(local_start + timedelta(minutes=30)).astimezone(timezone.utc),
    ))
    db.commit()
    task_id = task.id
    db.close()

    current_day = client.get('/reports/daily', params={'date': '2098-09-06', 'timezone': 'Asia/Tokyo'})
    assert current_day.status_code == 200
    assert current_day.json()['dailyActualMinutes'] == 30
    assert current_day.json()['tasks'][0]['taskId'] == task_id
    assert current_day.json()['tasks'][0]['actualMinutes'] == 30

    previous_day = client.get('/reports/daily', params={'date': '2098-09-05', 'timezone': 'Asia/Tokyo'})
    assert previous_day.status_code == 200
    assert previous_day.json()['dailyActualMinutes'] == 0

    invalid_timezone = client.get('/reports/daily', params={'date': '2098-09-06', 'timezone': 'Not/A_Timezone'})
    assert invalid_timezone.status_code == 422

    db = SessionLocal()
    db.query(TimeEntry).filter(TimeEntry.task_id == task_id).delete(synchronize_session=False)
    db.query(Task).filter(Task.id == task_id).delete(synchronize_session=False)
    db.commit()
    db.close()


def test_daily_summary_splits_entry_at_requested_timezone_midnight(client, SessionLocal):
    db = SessionLocal()
    task = Task(title='Tokyo midnight task', estimated_minutes=60, planned_date=date(2098, 9, 6), completed=False)
    db.add(task)
    db.flush()
    tokyo = ZoneInfo('Asia/Tokyo')
    local_start = datetime.combine(date(2098, 9, 5), time(23, 50), tzinfo=tokyo)
    local_end = datetime.combine(date(2098, 9, 6), time(0, 20), tzinfo=tokyo)
    db.add(TimeEntry(
        task_id=task.id,
        started_at=local_start.astimezone(timezone.utc),
        ended_at=local_end.astimezone(timezone.utc),
    ))
    db.commit()
    task_id = task.id
    db.close()

    previous_day = client.get('/reports/daily', params={'date': '2098-09-05', 'timezone': 'Asia/Tokyo'})
    current_day = client.get('/reports/daily', params={'date': '2098-09-06', 'timezone': 'Asia/Tokyo'})
    assert previous_day.status_code == 200
    assert previous_day.json()['dailyActualMinutes'] == 10
    assert current_day.status_code == 200
    assert current_day.json()['dailyActualMinutes'] == 20

    db = SessionLocal()
    db.query(TimeEntry).filter(TimeEntry.task_id == task_id).delete(synchronize_session=False)
    db.query(Task).filter(Task.id == task_id).delete(synchronize_session=False)
    db.commit()
    db.close()
