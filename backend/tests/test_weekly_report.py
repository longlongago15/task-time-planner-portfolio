"""Weekly reports share daily aggregation, using only guarded synthetic databases."""

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import event, inspect, text

from app import main
from app.models import Project, ScheduleBlock, Task, TimeEntry


MONDAY = date(2026, 9, 28)
NOW = datetime(2026, 10, 5, 12, tzinfo=timezone.utc)


def report(client, anchor=MONDAY, zone='UTC'):
    response = client.get('/reports/weekly', params={'date': str(anchor), 'timezone': zone})
    assert response.status_code == 200, response.text
    return response.json()


def saved(factory):
    with factory() as db:
        return {name: db.execute(text(f'SELECT * FROM "{name}" ORDER BY rowid')).all()
                for name in inspect(db.bind).get_table_names()}


def assert_daily_matches(client, response, zone='UTC'):
    assert len(response['daily']) == 7
    for offset, daily in enumerate(response['daily']):
        assert daily['date'] == str(date.fromisoformat(response['weekStart']) + timedelta(days=offset))
        assert daily == client.get('/reports/daily', params={'date': daily['date'], 'timezone': zone}).json()
    for weekly, daily in [('weeklyEstimatedMinutes', 'dailyEstimatedMinutes'),
                          ('weeklyPlannedOccupiedMinutes', 'plannedOccupiedMinutes'),
                          ('weeklyActualMinutes', 'dailyActualMinutes')]:
        assert type(response[weekly]) is int
        assert response[weekly] == sum(day[daily] for day in response['daily'])


@pytest.mark.parametrize('offset', range(7))
def test_week_is_monday_through_sunday_and_empty_week_is_zero(client, monkeypatch, offset):
    monkeypatch.setattr(main, '_utc_now', lambda: NOW)
    result = report(client, MONDAY + timedelta(days=offset))
    assert result['weekStart'] == '2026-09-28' and result['weekEnd'] == '2026-10-04'
    assert result['weeklyEstimatedMinutes'] == result['weeklyPlannedOccupiedMinutes'] == result['weeklyActualMinutes'] == 0
    assert_daily_matches(client, result)


def test_normal_week_null_estimate_snapshot_and_reads_are_unchanged(client, SessionLocal, monkeypatch):
    monkeypatch.setattr(main, '_utc_now', lambda: NOW)
    with SessionLocal() as db:
        old, current = Project(name='Historical'), Project(name='Current')
        db.add_all([old, current]); db.flush()
        for offset, (estimate, occupied, actual) in enumerate([(60, 30, 45), (120, 90, 100), (None, 0, 30)]):
            day = MONDAY + timedelta(days=offset)
            task = Task(title=f'Day {offset}', planned_date=day, estimated_minutes=estimate, project_id=current.id)
            db.add(task); db.flush()
            if occupied:
                db.add(ScheduleBlock(task_id=task.id, date=day, type='TIMED', start_time=time(10), duration_minutes=occupied))
            else:
                db.add(ScheduleBlock(task_id=task.id, date=day, type='TIME_UNSET'))
            start = datetime.combine(day, time(12), tzinfo=timezone.utc)
            db.add(TimeEntry(task_id=task.id, project_id_snapshot=old.id, started_at=start, ended_at=start + timedelta(minutes=actual)))
        db.commit()
    before = saved(SessionLocal)
    result = report(client)
    assert [result[k] for k in ['weeklyEstimatedMinutes', 'weeklyPlannedOccupiedMinutes', 'weeklyActualMinutes']] == [180, 120, 175]
    assert result['daily'][2]['tasks'][0]['estimatedMinutes'] is None
    assert result['daily'][2]['tasks'][0]['differenceMinutes'] is None
    assert_daily_matches(client, result)
    projects = {row['name']: row['actualMinutes'] for row in client.get('/projects').json()}
    assert projects == {'Historical': 175, 'Current': 0}
    assert saved(SessionLocal) == before


def test_union_midnight_and_both_week_boundaries(client, SessionLocal, monkeypatch):
    monkeypatch.setattr(main, '_utc_now', lambda: NOW)
    with SessionLocal() as db:
        task = Task(title='Schedule', estimated_minutes=None)
        db.add(task); db.flush()
        for day, clock, duration in [(MONDAY - timedelta(days=1), time(23, 30), 120),
                                     (MONDAY + timedelta(days=1), time(10), 60),
                                     (MONDAY + timedelta(days=1), time(10, 30), 60),
                                     (MONDAY + timedelta(days=3), time(23, 30), 120),
                                     (MONDAY + timedelta(days=6), time(23, 30), 120)]:
            db.add(ScheduleBlock(task_id=task.id, date=day, type='TIMED', start_time=clock, duration_minutes=duration))
        for kind in ['ALL_DAY', 'TIME_UNSET']:
            db.add(ScheduleBlock(task_id=task.id, date=MONDAY, type=kind))
        db.commit()
    before = saved(SessionLocal)
    result = report(client)
    assert [day['plannedOccupiedMinutes'] for day in result['daily']] == [90, 90, 0, 30, 90, 0, 30]
    assert result['weeklyPlannedOccupiedMinutes'] == 330
    next_week = report(client, MONDAY + timedelta(days=7))
    assert [day['plannedOccupiedMinutes'] for day in next_week['daily']] == [90, 0, 0, 0, 0, 0, 0]
    assert_daily_matches(client, result); assert_daily_matches(client, next_week)
    assert saved(SessionLocal) == before


def test_active_midnight_uses_one_now_and_closed_fractional_minutes_stay_daily(client, SessionLocal, monkeypatch):
    with SessionLocal() as db:
        task = Task(title='Timer', estimated_minutes=None)
        db.add(task); db.flush()
        db.add(TimeEntry(task_id=task.id, started_at=datetime(2026, 9, 30, 23, 59, 30), ended_at=datetime(2026, 10, 1, 0, 0, 30)))
        db.add(TimeEntry(task_id=task.id, started_at=datetime(2026, 10, 3, 23, 30), ended_at=None))
        db.commit()
    before = saved(SessionLocal)
    calls = []
    def now():
        calls.append(1)
        return datetime(2026, 10, 4, 1, tzinfo=timezone.utc)
    monkeypatch.setattr(main, '_utc_now', now)
    result = report(client)
    assert len(calls) == 1
    assert [day['dailyActualMinutes'] for day in result['daily']] == [0, 0, 0, 0, 0, 30, 60]
    assert result['weeklyActualMinutes'] == 90  # 30s on each day are separately floored to zero.
    assert_daily_matches(client, result)
    assert saved(SessionLocal) == before


@pytest.mark.parametrize('zone,expected', [('UTC', 60), ('Asia/Tokyo', 90), ('America/New_York', 0)])
def test_utc_entry_is_assigned_by_local_week_boundary(client, SessionLocal, monkeypatch, zone, expected):
    monkeypatch.setattr(main, '_utc_now', lambda: NOW)
    with SessionLocal() as db:
        task = Task(title='Week boundary')
        db.add(task); db.flush()
        db.add(TimeEntry(task_id=task.id, started_at=datetime(2026, 10, 4, 23, 30), ended_at=datetime(2026, 10, 5, 1)))
        db.commit()
    result = report(client, date(2026, 10, 5), zone)
    assert result['weeklyActualMinutes'] == expected
    assert_daily_matches(client, result, zone)


@pytest.mark.parametrize('monday,sunday_minutes,total', [(date(2026, 3, 2), 1380, 10020), (date(2026, 10, 26), 1500, 10140)])
def test_dst_week_uses_real_local_days_for_actual_and_wall_time_for_schedule(client, SessionLocal, monkeypatch, monday, sunday_minutes, total):
    zone = ZoneInfo('America/New_York')
    start = datetime.combine(monday, time.min, tzinfo=zone).astimezone(timezone.utc)
    end = datetime.combine(monday + timedelta(days=7), time.min, tzinfo=zone).astimezone(timezone.utc)
    monkeypatch.setattr(main, '_utc_now', lambda: end)
    with SessionLocal() as db:
        task = Task(title='DST week')
        db.add(task); db.flush()
        db.add(TimeEntry(task_id=task.id, started_at=start, ended_at=end))
        db.add(ScheduleBlock(task_id=task.id, date=monday, type='TIMED', start_time=time.min, duration_minutes=10080))
        db.commit()
    result = report(client, monday, 'America/New_York')
    assert result['weeklyActualMinutes'] == total
    assert result['daily'][6]['dailyActualMinutes'] == sunday_minutes
    assert result['weeklyPlannedOccupiedMinutes'] == 10080
    assert_daily_matches(client, result, 'America/New_York')


def test_weekly_queries_do_not_multiply_by_task_or_day(client, SessionLocal, monkeypatch):
    monkeypatch.setattr(main, '_utc_now', lambda: NOW)
    with SessionLocal() as db:
        db.add_all([Task(title=f'Task {i}', planned_date=MONDAY, estimated_minutes=1) for i in range(40)])
        db.flush()
        db.add_all(ScheduleBlock(task_id=task.id, date=MONDAY, type='TIME_UNSET') for task in db.query(Task).all())
        db.commit()
    with SessionLocal() as db:
        engine = db.get_bind()
    statements = []
    def record(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith('SELECT'): statements.append(statement)
    event.listen(engine, 'before_cursor_execute', record)
    try:
        result = report(client)
    finally:
        event.remove(engine, 'before_cursor_execute', record)
    assert result['weeklyEstimatedMinutes'] == 40
    assert len(statements) == 3


@pytest.mark.parametrize('params', [{}, {'date': 'bad', 'timezone': 'UTC'}, {'date': '2026-10-02'},
                                  {'date': '2026-10-02', 'timezone': 'Invalid/Timezone'}])
def test_weekly_validation(client, params):
    assert client.get('/reports/weekly', params=params).status_code == 422
