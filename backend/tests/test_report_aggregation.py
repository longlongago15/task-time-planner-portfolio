"""Step 24 aggregation rules through the Step 1 isolated database guard."""

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import URL
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app import main
from app.models import Project, ScheduleBlock, Task, TimeEntry
from helpers.revision_003 import build_revision_003_fixture
from helpers.current_schema import migrate_current_test_schema as migrate_sqlite_latest


START = datetime(2026, 10, 2, 10, tzinfo=timezone.utc)


def saved_values(factory):
    with factory() as session:
        return {
            table: session.execute(text(f'SELECT * FROM "{table}" ORDER BY rowid')).all()
            for table in inspect(session.bind).get_table_names()
        }


def seed(factory, *, start=START, estimate=30, closed_seconds=0, project=False):
    with factory() as session:
        membership = Project(name='Historical membership') if project else None
        if membership is not None:
            session.add(membership)
            session.flush()
        task = Task(title='Aggregation task', estimated_minutes=estimate,
                    planned_date=start.date(), project_id=membership.id if membership else None)
        session.add(task)
        session.flush()
        session.add(ScheduleBlock(task_id=task.id, date=start.date(), type='TIME_UNSET'))
        if closed_seconds:
            session.add(TimeEntry(task_id=task.id, project_id_snapshot=task.project_id,
                                  started_at=start - timedelta(seconds=closed_seconds), ended_at=start))
        session.add(TimeEntry(task_id=task.id, project_id_snapshot=task.project_id, started_at=start))
        session.commit()
        return task.id


def report(client, day, zone='UTC'):
    response = client.get('/reports/daily', params={'date': str(day), 'timezone': zone})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize('estimate', [30, None])
def test_closed_and_active_use_same_minutes_in_all_aggregates(client, SessionLocal, monkeypatch, estimate):
    task_id = seed(SessionLocal, estimate=estimate, closed_seconds=659, project=True)
    monkeypatch.setattr(main, '_utc_now', lambda: START + timedelta(minutes=7, seconds=59))
    assert client.get(f'/tasks/{task_id}/actual-minutes').json()['actualMinutes'] == 17
    difference = -13 if estimate is not None else None
    assert client.get(f'/tasks/{task_id}/diff').json() == {
        'taskId': task_id, 'actualMinutes': 17, 'estimatedMinutes': estimate,
        'differenceMinutes': difference,
    }
    for response in (client.get(f'/tasks/{task_id}').json(), client.get('/tasks').json()[0]):
        assert response['actualMinutes'] == 17 and response['differenceMinutes'] == difference
    assert client.get('/projects').json()[0]['actualMinutes'] == 17
    daily = report(client, START.date())
    assert daily['dailyActualMinutes'] == daily['tasks'][0]['actualMinutes'] == 17
    assert daily['tasks'][0]['estimatedMinutes'] == estimate
    assert daily['tasks'][0]['differenceMinutes'] == difference


@pytest.mark.parametrize('seconds,minutes', [(59, 0), (60, 1), (119, 1), (120, 2), (-60, 0)])
def test_active_rounding_and_future_start(client, SessionLocal, monkeypatch, seconds, minutes):
    task_id = seed(SessionLocal, project=True)
    before = saved_values(SessionLocal)
    monkeypatch.setattr(main, '_utc_now', lambda: START + timedelta(seconds=seconds))
    assert client.get(f'/tasks/{task_id}/actual-minutes').json()['actualMinutes'] == minutes
    assert client.get(f'/tasks/{task_id}/diff').json()['actualMinutes'] == minutes
    assert client.get(f'/tasks/{task_id}').json()['actualMinutes'] == minutes
    assert client.get('/projects').json()[0]['actualMinutes'] == minutes
    assert report(client, START.date())['dailyActualMinutes'] == minutes
    assert saved_values(SessionLocal) == before


def test_floor_each_entry_before_summing(client, SessionLocal, monkeypatch):
    task_id = seed(SessionLocal, closed_seconds=59)
    monkeypatch.setattr(main, '_utc_now', lambda: START + timedelta(seconds=59))
    assert client.get(f'/tasks/{task_id}/actual-minutes').json()['actualMinutes'] == 0
    assert report(client, START.date())['dailyActualMinutes'] == 0  # Not floor(118 / 60).


@pytest.mark.parametrize('closed', [False, True])
@pytest.mark.parametrize('zone_name', ['Asia/Tokyo', 'America/New_York'])
def test_cross_midnight_uses_local_not_utc_boundary(client, SessionLocal, monkeypatch, closed, zone_name):
    zone = ZoneInfo(zone_name)
    start = datetime(2026, 10, 1, 23, 50, tzinfo=zone).astimezone(timezone.utc)
    end = datetime(2026, 10, 2, 0, 20, tzinfo=zone).astimezone(timezone.utc)
    task_id = seed(SessionLocal, start=start)
    if closed:
        with SessionLocal() as session:
            session.query(TimeEntry).one().ended_at = end
            session.commit()
    monkeypatch.setattr(main, '_utc_now', lambda: end)
    assert report(client, '2026-10-01', zone_name)['dailyActualMinutes'] == 10
    assert report(client, '2026-10-02', zone_name)['dailyActualMinutes'] == 20
    assert client.get(f'/tasks/{task_id}/actual-minutes').json()['actualMinutes'] == 30


def test_active_today_is_capped_at_now(client, SessionLocal, monkeypatch):
    seed(SessionLocal)
    monkeypatch.setattr(main, '_utc_now', lambda: START + timedelta(minutes=37))
    assert report(client, START.date())['dailyActualMinutes'] == 37


def test_active_spanning_days_includes_past_day_but_not_future_day(client, SessionLocal, monkeypatch):
    start = datetime(2026, 10, 1, 23, 30, tzinfo=timezone.utc)
    task_id = seed(SessionLocal, start=start)
    monkeypatch.setattr(main, '_utc_now', lambda: datetime(2026, 10, 3, 1, tzinfo=timezone.utc))
    assert report(client, '2026-10-01')['dailyActualMinutes'] == 30
    assert report(client, '2026-10-02')['dailyActualMinutes'] == 1440
    assert report(client, '2026-10-03')['dailyActualMinutes'] == 60
    assert report(client, '2026-10-04')['dailyActualMinutes'] == 0
    assert client.get(f'/tasks/{task_id}/actual-minutes').json()['actualMinutes'] == 1530


@pytest.mark.parametrize('day,expected', [('2026-03-08', 1380), ('2026-11-01', 1500)])
def test_dst_local_day_has_23_or_25_hours(client, SessionLocal, monkeypatch, day, expected):
    zone = ZoneInfo('America/New_York')
    local_day = date.fromisoformat(day)
    start = datetime.combine(local_day, time.min, tzinfo=zone).astimezone(timezone.utc)
    end = datetime.combine(local_day + timedelta(days=1), time.min, tzinfo=zone).astimezone(timezone.utc)
    seed(SessionLocal, start=start)
    monkeypatch.setattr(main, '_utc_now', lambda: end + timedelta(hours=1))
    assert report(client, day, 'America/New_York')['dailyActualMinutes'] == expected


def test_half_open_boundaries_and_range_flooring(client, SessionLocal, monkeypatch):
    midnight = datetime(2026, 10, 2, tzinfo=timezone.utc)
    with SessionLocal() as session:
        task = Task(title='Boundary task', estimated_minutes=30, planned_date=midnight.date())
        session.add(task)
        session.flush()
        session.add_all([
            TimeEntry(task_id=task.id, started_at=midnight - timedelta(minutes=1), ended_at=midnight),
            TimeEntry(task_id=task.id, started_at=midnight + timedelta(days=1),
                      ended_at=midnight + timedelta(days=1, minutes=1)),
            TimeEntry(task_id=task.id, started_at=midnight - timedelta(seconds=30),
                      ended_at=midnight + timedelta(seconds=59)),
        ])
        session.commit()
    monkeypatch.setattr(main, '_utc_now', lambda: midnight + timedelta(days=2))
    assert report(client, midnight.date())['dailyActualMinutes'] == 0


@pytest.mark.parametrize('estimates,total', [([30, None, 45], 75), ([None, None], 0)])
def test_nullable_estimates_preserve_unknown_task_values(client, SessionLocal, monkeypatch, estimates, total):
    task_id = seed(SessionLocal, estimate=None)
    with SessionLocal() as session:
        existing = session.get(Task, task_id)
        existing.estimated_minutes = estimates[0]
        added = [Task(title=str(i), estimated_minutes=value) for i, value in enumerate(estimates[1:])]
        session.add_all(added); session.flush()
        session.add_all(ScheduleBlock(task_id=task.id, date=START.date(), type='TIME_UNSET') for task in added)
        session.commit()
    before = saved_values(SessionLocal)
    monkeypatch.setattr(main, '_utc_now', lambda: START + timedelta(minutes=7, seconds=59))
    daily = report(client, START.date())
    assert daily['dailyEstimatedMinutes'] == total
    assert daily['dailyActualMinutes'] == 7
    assert daily['dailyDifference'] == 7 - total
    assert [task['estimatedMinutes'] for task in daily['tasks']] == estimates
    for task in daily['tasks']:
        if task['estimatedMinutes'] is None:
            assert task['differenceMinutes'] is None
    assert saved_values(SessionLocal) == before


def test_project_actual_uses_snapshot_after_task_moves_and_null_stays_unassigned(client, SessionLocal, monkeypatch):
    task_id = seed(SessionLocal, project=True, closed_seconds=600)
    with SessionLocal() as session:
        other = Project(name='Current membership')
        session.add(other)
        session.flush()
        current_id = other.id
        task = session.get(Task, task_id)
        historical_id = task.project_id
        task.project_id = current_id
        session.add(TimeEntry(task_id=task.id, project_id_snapshot=None,
                              started_at=START - timedelta(minutes=20), ended_at=START - timedelta(minutes=15)))
        session.commit()
    monkeypatch.setattr(main, '_utc_now', lambda: START + timedelta(minutes=7, seconds=59))
    before = saved_values(SessionLocal)
    stats = {item['id']: item for item in client.get('/projects').json()}
    assert stats[historical_id]['actualMinutes'] == 17
    assert stats[historical_id]['taskCount'] == 0
    assert stats[current_id]['actualMinutes'] == 0
    assert stats[current_id]['taskCount'] == 1
    assert client.get(f'/tasks/{task_id}/actual-minutes').json()['actualMinutes'] == 22
    assert saved_values(SessionLocal) == before
    renamed = client.put(f'/projects/{historical_id}', json={'name': 'Renamed history'})
    assert renamed.status_code == 200 and renamed.json()['actualMinutes'] == 17


def test_repeated_gets_do_not_write_and_active_response_stays_null(client, SessionLocal, monkeypatch):
    task_id = seed(SessionLocal, estimate=None, closed_seconds=600, project=True)
    before = saved_values(SessionLocal)
    monkeypatch.setattr(main, '_utc_now', lambda: START + timedelta(minutes=7, seconds=59))
    for _ in range(3):
        for path in (f'/tasks/{task_id}/actual-minutes', f'/tasks/{task_id}/diff',
                     f'/tasks/{task_id}', '/tasks', '/projects'):
            assert client.get(path).status_code == 200
        report(client, START.date())
        response = client.get(f'/tasks/{task_id}/time-entries')
        assert response.status_code == 200
        closed, active = response.json()
        assert closed['durationMinutes'] == 10
        assert active['endedAt'] is active['endAt'] is active['durationMinutes'] is None
        assert active['startedAt'] == active['startAt']
        assert saved_values(SessionLocal) == before


@pytest.mark.parametrize('path', ['/reports/daily?date=2026-10-02&timezone=UTC', '/tasks', '/projects'])
def test_capture_now_once_per_response(client, SessionLocal, monkeypatch, path):
    seed(SessionLocal, project=True)
    with SessionLocal() as session:
        session.add_all([Task(title='Second', planned_date=START.date(), estimated_minutes=15),
                         Project(name='Second project')])
        session.commit()
    calls = []

    def now():
        calls.append(1)
        assert len(calls) == 1
        return START + timedelta(minutes=7, seconds=59)

    monkeypatch.setattr(main, '_utc_now', now)
    response = client.get(path)
    assert response.status_code == 200
    assert len(calls) == 1
    if path.startswith('/reports'):
        assert response.json()['dailyActualMinutes'] == response.json()['tasks'][0]['actualMinutes'] == 7


def test_single_active_constraint_survives_reads(client, SessionLocal, monkeypatch):
    task_id = seed(SessionLocal)
    monkeypatch.setattr(main, '_utc_now', lambda: START + timedelta(minutes=7))
    report(client, START.date())
    client.get(f'/tasks/{task_id}/actual-minutes')
    with SessionLocal() as session:
        session.add(TimeEntry(task_id=task_id, started_at=START + timedelta(minutes=1)))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()
        assert session.query(TimeEntry).filter(TimeEntry.ended_at.is_(None)).count() == 1


def test_database_start_is_counted_immediately_as_active_entry(client, SessionLocal, monkeypatch):
    task = client.post('/tasks', json={'title': 'DB timer', 'estimatedMinutes': 30,
                                     'plannedDate': '2026-10-02'}).json()
    monkeypatch.setattr(main, '_utc_now', lambda: START)
    assert client.post('/tasks/time/start', json={'taskId': task['id']}).status_code == 200
    monkeypatch.setattr(main, '_utc_now', lambda: START + timedelta(minutes=7))
    assert client.get(f"/tasks/{task['id']}/actual-minutes").json()['actualMinutes'] == 7
    assert report(client, START.date())['dailyActualMinutes'] == 7
    with SessionLocal() as session:
        assert session.query(TimeEntry).count() == 1
        assert session.query(TimeEntry).one().ended_at is None
        assert session.get(Task, task['id']).status == 'IN_PROGRESS'
    stopped = client.post('/tasks/time/stop', json={'taskId': task['id'], 'endAt': (START + timedelta(minutes=7)).isoformat()})
    assert stopped.status_code == 200
    assert stopped.json()['durationMinutes'] == 7
    with SessionLocal() as session:
        assert session.query(TimeEntry).count() == 1
        assert session.query(TimeEntry).one().ended_at is not None


@pytest.mark.parametrize('zone_name', ['UTC', 'Asia/Tokyo', 'America/New_York'])
def test_revision_003_historical_actuals_and_schedule_reports_survive_migration(client, tmp_path, monkeypatch, zone_name):
    engine = create_engine(URL.create('sqlite', database=str(tmp_path / 'historical.db')))
    factory = sessionmaker(bind=engine)
    try:
        build_revision_003_fixture(engine)
        with engine.connect() as connection:
            old_tasks = connection.exec_driver_sql('SELECT * FROM tasks ORDER BY id').mappings().all()
            old_entries = connection.exec_driver_sql('SELECT * FROM time_entries ORDER BY id').mappings().all()
            old_projects = connection.exec_driver_sql('SELECT * FROM projects ORDER BY id').mappings().all()
            old_blocks = connection.exec_driver_sql('SELECT * FROM schedule_blocks ORDER BY id').mappings().all()

        # Capture pre-004 actuals and ScheduleBlock membership independently of the current ORM.
        # Do not load the current ORM against the old schema or use its helpers.
        expected_actual = {}
        expected_diff = {}
        for task in old_tasks:
            actual = sum(entry['duration_minutes'] for entry in old_entries if entry['task_id'] == task['id'])
            difference = actual - task['estimated_minutes'] if task['estimated_minutes'] is not None else None
            expected_actual[task['id']] = {'taskId': task['id'], 'actualMinutes': actual}
            expected_diff[task['id']] = {
                'taskId': task['id'], 'estimatedMinutes': task['estimated_minutes'],
                'actualMinutes': actual, 'differenceMinutes': difference,
            }
        assert {identifier: value['actualMinutes'] for identifier, value in expected_actual.items()} == {
            2: 7, 5: 3, 11: 20, 18: 10,
        }
        expected_project = {
            project['id']: {
                'id': project['id'], 'name': project['name'],
                'color': None,
                'taskCount': sum(task['project_id'] == project['id'] for task in old_tasks),
                'completedCount': sum(bool(task['completed']) for task in old_tasks if task['project_id'] == project['id']),
                'estimatedMinutes': sum(task['estimated_minutes'] for task in old_tasks
                                        if task['project_id'] == project['id'] and task['estimated_minutes'] is not None),
                'actualMinutes': sum(entry['duration_minutes'] for entry in old_entries
                                     if entry['project_id_snapshot'] == project['id']),
            } for project in old_projects
        }
        assert {identifier: value['actualMinutes'] for identifier, value in expected_project.items()} == {7: 27, 9: 11}
        assert sum(entry['duration_minutes'] for entry in old_entries if entry['project_id_snapshot'] is None) == 2

        zone = ZoneInfo(zone_name)
        history = [(entry, datetime.fromisoformat(entry['start_at']).replace(tzinfo=timezone.utc),
                    datetime.fromisoformat(entry['end_at']).replace(tzinfo=timezone.utc)) for entry in old_entries]
        days = {stamp.astimezone(zone).date() for _, start, end in history for stamp in (start, end)}
        days.update(date.fromisoformat(block['date']) for block in old_blocks)
        expected_daily = {}
        for day in sorted(days):
            lower = datetime.combine(day, time.min, tzinfo=zone).astimezone(timezone.utc)
            upper = datetime.combine(day + timedelta(days=1), time.min, tzinfo=zone).astimezone(timezone.utc)
            minutes = [(entry['task_id'], int(max(0, (min(end, upper) - max(start, lower)).total_seconds()) // 60))
                       for entry, start, end in history]
            local_lower = datetime.combine(day, time.min)
            local_upper = local_lower + timedelta(days=1)
            scheduled_ids = set()
            for block in old_blocks:
                if block['type'] in ('TIME_UNSET', 'ALL_DAY'):
                    if block['date'] == day.isoformat():
                        scheduled_ids.add(block['task_id'])
                else:
                    start = datetime.fromisoformat(f"{block['date']}T{block['start_time']}")
                    end = start + timedelta(minutes=block['duration_minutes'])
                    if start < local_upper and end > local_lower:
                        scheduled_ids.add(block['task_id'])
            planned = [task for task in old_tasks if task['id'] in scheduled_ids]
            estimate = sum(task['estimated_minutes'] for task in planned if task['estimated_minutes'] is not None)
            actual = sum(value for _, value in minutes)
            tasks = []
            for task in planned:
                task_actual = sum(value for identifier, value in minutes if identifier == task['id'])
                tasks.append({
                    'taskId': task['id'], 'title': task['title'], 'estimatedMinutes': task['estimated_minutes'],
                    'actualMinutes': task_actual,
                    'differenceMinutes': task_actual - task['estimated_minutes'] if task['estimated_minutes'] is not None else None,
                })
            expected_daily[day] = {
                'date': day.isoformat(), 'dailyActualMinutes': actual,
                'dailyEstimatedMinutes': estimate, 'dailyDifference': actual - estimate, 'tasks': tasks,
            }
        assert [expected_daily[date(2026, 10, day)]['dailyActualMinutes'] for day in (1, 2)] == {
            'UTC': [23, 17], 'Asia/Tokyo': [20, 20], 'America/New_York': [39, 1],
        }[zone_name]

        migrate_sqlite_latest(engine)
        monkeypatch.setattr(main, 'SessionLocal', factory)
        monkeypatch.setattr(main, '_utc_now', lambda: START)
        before_get = saved_values(factory)
        for identifier in expected_actual:
            assert client.get(f'/tasks/{identifier}/actual-minutes').json() == expected_actual[identifier]
            assert client.get(f'/tasks/{identifier}/diff').json() == expected_diff[identifier]
        assert {item['id']: item for item in client.get('/projects').json()} == expected_project
        for day, expected in expected_daily.items():
            daily = report(client, day, zone_name)
            # Actuals survive the lifecycle migration; scheduled tasks come from the existing blocks.
            assert daily.pop('plannedOccupiedMinutes') == (60 if day == date(2026, 10, 1) else 0)
            daily['tasks'].sort(key=lambda task: task['taskId'])
            assert daily == expected
        assert saved_values(factory) == before_get
    finally:
        engine.dispose()
