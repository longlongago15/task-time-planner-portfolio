"""Monthly API integration on isolated synthetic DBs; daily/weekly stay authoritative."""

from calendar import monthrange
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import event, inspect, text

from app import main
from app.models import Project, ScheduleBlock, Task, TimeEntry


NOW = datetime(2026, 11, 2, 12, tzinfo=timezone.utc)


def report(client, month='2026-10', zone='UTC'):
    response = client.get('/reports/monthly', params={'month': month, 'timezone': zone})
    assert response.status_code == 200, response.text
    return response.json()


def saved(factory):
    with factory() as db:
        return {name: db.execute(text(f'SELECT * FROM "{name}" ORDER BY rowid')).all()
                for name in inspect(db.bind).get_table_names()}


def assert_totals(result):
    fields = [('monthlyEstimatedMinutes', 'dailyEstimatedMinutes', 'estimatedMinutes'),
              ('monthlyPlannedOccupiedMinutes', 'plannedOccupiedMinutes', 'plannedOccupiedMinutes'),
              ('monthlyActualMinutes', 'dailyActualMinutes', 'actualMinutes')]
    assert [row['weekday'] for row in result['weekdayTotals']] == list(range(7))
    for monthly, daily, weekday in fields:
        assert type(result[monthly]) is int
        assert result[monthly] == sum(day[daily] for day in result['daily'])
        assert result[monthly] == sum(row[weekday] for row in result['weekdayTotals'])
        for row in result['weekdayTotals']:
            assert row[weekday] == sum(day[daily] for day in result['daily']
                                      if date.fromisoformat(day['date']).weekday() == row['weekday'])


def assert_daily_matches(client, result, zone='UTC'):
    start = date.fromisoformat(result['monthStart'])
    assert [day['date'] for day in result['daily']] == [str(start + timedelta(days=i)) for i in range(len(result['daily']))]
    for daily in result['daily']:
        assert daily == client.get('/reports/daily', params={'date': daily['date'], 'timezone': zone}).json()
    assert_totals(result)


@pytest.mark.parametrize('month,days', [('2026-02', 28), ('2028-02', 29), ('2026-04', 30), ('2026-10', 31)])
def test_calendar_month_lengths_and_all_zero(client, monkeypatch, month, days):
    monkeypatch.setattr(main, '_utc_now', lambda: NOW)
    result = report(client, month)
    assert result['month'] == month and result['monthStart'] == f'{month}-01'
    assert result['monthEnd'] == f'{month}-{days}'
    assert len(result['daily']) == days
    assert all(day[field] == 0 for day in result['daily']
               for field in ['dailyEstimatedMinutes', 'plannedOccupiedMinutes', 'dailyActualMinutes'])
    assert result['monthlyEstimatedMinutes'] == result['monthlyPlannedOccupiedMinutes'] == result['monthlyActualMinutes'] == 0
    assert_daily_matches(client, result)


def test_known_estimates_null_snapshot_weekday_totals_and_weekly_regression(client, SessionLocal, monkeypatch):
    monkeypatch.setattr(main, '_utc_now', lambda: NOW)
    with SessionLocal() as db:
        old, current = Project(name='Historical'), Project(name='Current')
        db.add_all([old, current]); db.flush()
        for day, estimate, actual in [(date(2026, 10, 5), 60, 30), (date(2026, 10, 12), 120, 45), (date(2026, 10, 19), None, 60)]:
            task = Task(title=str(day), planned_date=day, estimated_minutes=estimate, project_id=current.id)
            db.add(task); db.flush()
            db.add(ScheduleBlock(task_id=task.id, date=day, type='TIMED', start_time=time(10), duration_minutes=30))
            start = datetime.combine(day, time(12), tzinfo=timezone.utc)
            db.add(TimeEntry(task_id=task.id, project_id_snapshot=old.id, started_at=start, ended_at=start + timedelta(minutes=actual)))
        db.commit()
    before = saved(SessionLocal)
    weekly_before = client.get('/reports/weekly', params={'date': '2026-10-05', 'timezone': 'UTC'}).json()
    result = report(client)
    assert [result[field] for field in ['monthlyEstimatedMinutes', 'monthlyPlannedOccupiedMinutes', 'monthlyActualMinutes']] == [180, 90, 135]
    assert result['weekdayTotals'][0] == {'weekday': 0, 'estimatedMinutes': 180, 'plannedOccupiedMinutes': 90, 'actualMinutes': 135}
    assert result['daily'][18]['tasks'][0]['estimatedMinutes'] is None
    assert result['daily'][18]['tasks'][0]['differenceMinutes'] is None
    assert_daily_matches(client, result)
    assert weekly_before == client.get('/reports/weekly', params={'date': '2026-10-05', 'timezone': 'UTC'}).json()
    assert {p['name']: p['actualMinutes'] for p in client.get('/projects').json()} == {'Historical': 135, 'Current': 0}
    assert saved(SessionLocal) == before


def test_union_and_both_month_boundaries(client, SessionLocal, monkeypatch):
    monkeypatch.setattr(main, '_utc_now', lambda: NOW)
    with SessionLocal() as db:
        task = Task(title='Boundary', estimated_minutes=None)
        db.add(task); db.flush()
        for day, clock, duration in [(date(2026, 9, 30), time(23, 30), 120),
                                     (date(2026, 10, 5), time(10), 60),
                                     (date(2026, 10, 5), time(10, 30), 60),
                                     (date(2026, 10, 31), time(23, 30), 120)]:
            db.add(ScheduleBlock(task_id=task.id, date=day, type='TIMED', start_time=clock, duration_minutes=duration))
        for kind in ['ALL_DAY', 'TIME_UNSET']:
            db.add(ScheduleBlock(task_id=task.id, date=date(2026, 10, 5), type=kind))
        for day in [date(2026, 9, 30), date(2026, 10, 31)]:
            start = datetime.combine(day, time(23, 30), tzinfo=timezone.utc)
            db.add(TimeEntry(task_id=task.id, started_at=start, ended_at=start + timedelta(minutes=90)))
        db.commit()
    before = saved(SessionLocal)
    september, october, november = [report(client, month) for month in ['2026-09', '2026-10', '2026-11']]
    assert [r['monthlyPlannedOccupiedMinutes'] for r in [september, october, november]] == [30, 210, 90]
    assert [r['monthlyActualMinutes'] for r in [september, october, november]] == [30, 90, 60]
    assert october['daily'][0]['plannedOccupiedMinutes'] == 90
    assert october['daily'][4]['plannedOccupiedMinutes'] == 90
    assert october['daily'][30]['plannedOccupiedMinutes'] == 30
    for result in [september, october, november]:
        assert_daily_matches(client, result)
    assert saved(SessionLocal) == before


def test_active_crosses_month_with_one_now_and_daily_flooring(client, SessionLocal, monkeypatch):
    now = datetime(2026, 11, 1, 1, tzinfo=timezone.utc)
    calls = []
    def clock():
        calls.append(1)
        return now
    monkeypatch.setattr(main, '_utc_now', clock)
    with SessionLocal() as db:
        task = Task(title='Active', estimated_minutes=None)
        db.add(task); db.flush()
        db.add(TimeEntry(task_id=task.id, started_at=datetime(2026, 10, 31, 23, 30), ended_at=None))
        db.add(TimeEntry(task_id=task.id, started_at=datetime(2026, 10, 1, 23, 59, 30), ended_at=datetime(2026, 10, 2, 0, 0, 30)))
        db.commit()
    before = saved(SessionLocal)
    october = report(client)
    assert len(calls) == 1
    assert october['monthlyActualMinutes'] == 30
    november = report(client, '2026-11')
    assert len(calls) == 2
    assert november['monthlyActualMinutes'] == 60
    assert november['daily'][0]['dailyActualMinutes'] == 60
    assert all(day['dailyActualMinutes'] == 0 for day in november['daily'][1:])
    assert_daily_matches(client, october); assert_daily_matches(client, november)
    assert saved(SessionLocal) == before


def test_long_active_clips_to_entire_past_month_without_future_extension(client, SessionLocal, monkeypatch):
    monkeypatch.setattr(main, '_utc_now', lambda: datetime(2026, 11, 2, tzinfo=timezone.utc))
    with SessionLocal() as db:
        task = Task(title='Long Active')
        db.add(task); db.flush()
        db.add(TimeEntry(task_id=task.id, started_at=datetime(2026, 9, 30, 23, 30), ended_at=None))
        db.commit()
    october = report(client)
    assert october['monthlyActualMinutes'] == 31 * 1440
    november = report(client, '2026-11')
    assert november['monthlyActualMinutes'] == 1440
    assert all(day['dailyActualMinutes'] == 0 for day in november['daily'][1:])
    assert_totals(october); assert_totals(november)


@pytest.mark.parametrize('zone,october,november', [('UTC', 30, 60), ('Asia/Tokyo', 0, 90), ('America/New_York', 90, 0)])
def test_local_month_and_weekday_boundaries(client, SessionLocal, monkeypatch, zone, october, november):
    monkeypatch.setattr(main, '_utc_now', lambda: NOW)
    with SessionLocal() as db:
        task = Task(title='Timezone')
        db.add(task); db.flush()
        db.add(TimeEntry(task_id=task.id, started_at=datetime(2026, 10, 31, 23, 30), ended_at=datetime(2026, 11, 1, 1)))
        db.commit()
    for month, expected in [('2026-10', october), ('2026-11', november)]:
        result = report(client, month, zone)
        assert result['monthlyActualMinutes'] == expected
        assert result['weekdayTotals'][5 if month == '2026-10' else 6]['actualMinutes'] == expected
        assert_daily_matches(client, result, zone)


@pytest.mark.parametrize('month,actual', [('2026-03', 44580), ('2026-11', 43260)])
def test_dst_month_uses_actual_local_days_and_wall_time_schedule(client, SessionLocal, monkeypatch, month, actual):
    start_date = date.fromisoformat(f'{month}-01')
    days = monthrange(start_date.year, start_date.month)[1]
    zone = ZoneInfo('America/New_York')
    start = datetime.combine(start_date, time.min, tzinfo=zone).astimezone(timezone.utc)
    end = datetime.combine(start_date + timedelta(days=days), time.min, tzinfo=zone).astimezone(timezone.utc)
    monkeypatch.setattr(main, '_utc_now', lambda: end)
    with SessionLocal() as db:
        task = Task(title='DST')
        db.add(task); db.flush()
        db.add(TimeEntry(task_id=task.id, started_at=start, ended_at=end))
        db.add(ScheduleBlock(task_id=task.id, date=start_date, type='TIMED', start_time=time.min, duration_minutes=days * 1440))
        db.commit()
    result = report(client, month, 'America/New_York')
    assert result['monthlyActualMinutes'] == actual
    assert result['monthlyPlannedOccupiedMinutes'] == days * 1440
    assert result['daily'][7 if month == '2026-03' else 0]['dailyActualMinutes'] == (1380 if month == '2026-03' else 1500)
    assert_daily_matches(client, result, 'America/New_York')


def test_monthly_uses_three_queries_independent_of_tasks_and_days(client, SessionLocal, monkeypatch):
    monkeypatch.setattr(main, '_utc_now', lambda: NOW)
    with SessionLocal() as db:
        db.add_all([Task(title=str(i), planned_date=date(2026, 10, 5), estimated_minutes=1) for i in range(40)])
        db.flush()
        db.add_all(ScheduleBlock(task_id=task.id, date=date(2026, 10, 5), type='TIME_UNSET') for task in db.query(Task).all())
        db.commit(); engine = db.get_bind()
    statements = []
    def record(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith('SELECT'):
            statements.append(statement)
    event.listen(engine, 'before_cursor_execute', record)
    try:
        result = report(client)
    finally:
        event.remove(engine, 'before_cursor_execute', record)
    assert result['monthlyEstimatedMinutes'] == 40 and len(statements) == 3


@pytest.mark.parametrize('params', [{}, {'month': '2026-10'}, {'month': '2026-10', 'timezone': 'Invalid/Timezone'},
                                  *[{'month': month, 'timezone': 'UTC'} for month in ['bad', '2026-2', '2026-13', '0000-01', '9999-12']]])
def test_monthly_validation(client, params):
    assert client.get('/reports/monthly', params=params).status_code == 422
