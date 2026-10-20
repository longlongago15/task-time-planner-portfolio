"""Local schedule union through the API, using only Step 1 isolated databases."""

from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import inspect, text

from app import database, main
from app.models import Project, ScheduleBlock, Task, TimeEntry
from app.schedule_occupancy import merge_intervals, planned_occupied_minutes


DAY = date(2026, 10, 2)


def task(client, estimate=120):
    response = client.post('/tasks', json={'title': 'Schedule report task', 'estimatedMinutes': estimate})
    assert response.status_code == 201, response.text
    return response.json()['id']


def block(client, task_id, clock=None, duration=None, day=DAY, kind='TIMED'):
    response = client.post('/schedule-blocks', json={
        'taskId': task_id, 'date': str(day), 'type': kind,
        'startTime': clock, 'durationMinutes': duration,
    })
    assert response.status_code == 201, response.text


def daily(client, day=DAY, zone='UTC'):
    response = client.get('/reports/daily', params={'date': str(day), 'timezone': zone})
    assert response.status_code == 200, response.text
    value = response.json()
    assert type(value['plannedOccupiedMinutes']) is int
    return value


def saved_values(factory):
    with factory() as session:
        schema = session.execute(text('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name')).all()
        rows = {name: session.execute(text(f'SELECT * FROM "{name}" ORDER BY rowid')).all()
                for name in inspect(session.bind).get_table_names()}
        return schema, rows


@pytest.mark.parametrize('intervals,expected,same_task', [
    ([], 0, False),
    ([('10:00', 75)], 75, False),
    ([('10:00', 60), ('10:30', 60)], 90, False),
    ([('10:00', 60), ('10:30', 90)], 120, False),
    ([('10:00', 60), ('11:00', 60)], 120, False),
    ([('10:00', 120), ('10:30', 30)], 120, False),
    ([('11:30', 60), ('10:30', 30), ('10:00', 120)], 150, False),
    ([('09:00', 30), ('13:00', 60)], 90, True),
    ([('10:00', 60), ('10:00', 60)], 60, True),
])
def test_daily_timed_interval_union(client, SessionLocal, intervals, expected, same_task):
    identifier = task(client)
    for index, (clock, duration) in enumerate(intervals):
        if same_task and (clock, duration) in intervals[:index]:
            # Pre-41A duplicate history can still exist. Reading its union must
            # remain correct, while new API saves of this overlap are forbidden.
            with SessionLocal() as session:
                session.add(ScheduleBlock(task_id=identifier, date=DAY, type='TIMED',
                                          start_time=time.fromisoformat(clock), duration_minutes=duration))
                session.commit()
        else:
            block(client, identifier if same_task or index == 0 else task(client), clock, duration)
    before = saved_values(SessionLocal)
    result = daily(client)
    assert result['plannedOccupiedMinutes'] == expected
    # Schedule membership supplies estimates; occupancy still depends only on interval union.
    scheduled_count = (1 if same_task else len(intervals)) if intervals else 0
    assert result['dailyEstimatedMinutes'] == scheduled_count * 120
    assert result['dailyActualMinutes'] == 0
    assert len(result['tasks']) == scheduled_count
    assert saved_values(SessionLocal) == before


@pytest.mark.parametrize('kind', ['TIME_UNSET', 'ALL_DAY'])
def test_non_timed_blocks_do_not_occupy_time(client, kind):
    identifier = task(client)
    block(client, identifier, kind=kind)
    assert daily(client)['plannedOccupiedMinutes'] == 0
    block(client, identifier, '10:00', 30)
    assert daily(client)['plannedOccupiedMinutes'] == 30


@pytest.mark.parametrize('estimate', [None, 120, 999])
def test_schedule_duration_is_independent_of_estimate(client, estimate):
    identifier = task(client, estimate)
    block(client, identifier, '10:00', 30)
    assert daily(client)['plannedOccupiedMinutes'] == 30


@pytest.mark.parametrize('clock,duration,expected', [
    ('23:30', 120, [0, 30, 90, 0]),
    ('12:00', 1800, [0, 720, 1080, 0]),
    ('12:00', 3000, [0, 720, 1440, 840, 0]),
])
def test_cross_day_and_long_blocks_are_clipped_per_day(client, SessionLocal, clock, duration, expected):
    block(client, task(client), clock, duration)
    before = saved_values(SessionLocal)
    for offset, minutes in enumerate(expected, start=-1):
        assert daily(client, DAY + timedelta(days=offset))['plannedOccupiedMinutes'] == minutes
    assert saved_values(SessionLocal) == before


def test_previous_day_start_and_overlap_after_midnight(client):
    block(client, task(client), '23:30', 120, DAY - timedelta(days=1))
    assert daily(client)['plannedOccupiedMinutes'] == 90
    block(client, task(client), '01:00', 60)
    assert daily(client)['plannedOccupiedMinutes'] == 120


def test_overlap_and_cross_day_union(client):
    block(client, task(client), '23:00', 120)
    block(client, task(client), '00:30', 60, DAY + timedelta(days=1))
    assert daily(client, DAY)['plannedOccupiedMinutes'] == 60
    assert daily(client, DAY + timedelta(days=1))['plannedOccupiedMinutes'] == 90


def test_midnight_end_is_excluded_and_midnight_start_is_included(client):
    block(client, task(client), '23:00', 60, DAY - timedelta(days=1))
    block(client, task(client), '00:00', 15)
    block(client, task(client), '00:00', 30, DAY + timedelta(days=1))
    assert daily(client)['plannedOccupiedMinutes'] == 15


def test_large_duration_and_old_start_cannot_overflow_calendar(client):
    block(client, task(client), '12:00', 10**12, date(2000, 1, 1))
    assert daily(client)['plannedOccupiedMinutes'] == 1440


@pytest.mark.parametrize('day', [date(2026, 3, 8), date(2026, 11, 1)])
def test_planned_wall_day_stays_1440_minutes_across_timezones_and_dst(client, day):
    block(client, task(client), '00:00', 1440, day)
    for zone in ('UTC', 'Asia/Tokyo', 'America/New_York'):
        assert daily(client, day, zone)['plannedOccupiedMinutes'] == 1440


def test_fractional_minutes_are_floored_after_union_not_per_block(client):
    # Each day's clipped contribution is 30 seconds; their union totals 1 minute.
    block(client, task(client), '23:59:30', 1)
    block(client, task(client), '23:59:30', 1, DAY - timedelta(days=1))
    assert daily(client)['plannedOccupiedMinutes'] == 1


@pytest.mark.parametrize('clock,duration,block_day', [
    (None, 60, DAY.isoformat()), ('10:00', None, DAY.isoformat()),
    ('10:00', 0, DAY.isoformat()), ('10:00', -1, DAY.isoformat()),
    ('10:00', 'invalid', DAY.isoformat()), ('10:00', 1.5, DAY.isoformat()),
    ('invalid', 60, DAY.isoformat()), ('10:00+09:00', 60, DAY.isoformat()),
    ('10:00', 60, '2026-00-32'),
])
def test_invalid_timed_data_is_ignored_without_repair(client, SessionLocal, clock, duration, block_day):
    identifier = task(client)
    block(client, identifier, '09:00', 30)
    # Bypass only the CHECK in this isolated fixture to represent corrupt data.
    with database.engine.connect() as connection:
        try:
            connection.exec_driver_sql('PRAGMA ignore_check_constraints=ON')
            connection.exec_driver_sql(
                'INSERT INTO schedule_blocks (task_id,date,type,start_time,duration_minutes,created_at,updated_at) '
                "VALUES (?,?,'TIMED',?,?,?,?)",
                (identifier, block_day, clock, duration, '2026-10-01 00:00:00', '2026-10-01 00:00:00'),
            )
            connection.commit()
        finally:
            connection.exec_driver_sql('PRAGMA ignore_check_constraints=OFF')
            connection.commit()
    before = saved_values(SessionLocal)
    assert daily(client)['plannedOccupiedMinutes'] == 30
    assert saved_values(SessionLocal) == before


def test_old_metrics_snapshot_membership_and_gets_are_unchanged(client, SessionLocal, monkeypatch):
    database.migrate_schema()  # Record history only in the empty, isolated fixture.
    with SessionLocal() as session:
        original, current = Project(name='Original'), Project(name='Current')
        session.add_all([original, current]); session.flush()
        historical_id = original.id
        known = Task(title='Known estimate', estimated_minutes=120, planned_date=DAY, project_id=current.id)
        unknown = Task(title='Unknown estimate', estimated_minutes=None, planned_date=DAY, project_id=current.id, status='IN_PROGRESS')
        session.add_all([known, unknown]); session.flush()
        known_id, unknown_id = known.id, unknown.id
        session.add_all(ScheduleBlock(task_id=task.id, date=DAY, type='TIME_UNSET') for task in (known, unknown))
        session.add_all([
            TimeEntry(task_id=known.id, project_id_snapshot=original.id,
                      started_at=datetime(2026, 10, 1, 23, 50), ended_at=datetime(2026, 10, 2, 0, 20)),
            TimeEntry(task_id=unknown.id, project_id_snapshot=None, started_at=datetime(2026, 10, 2, 0, 30)),
        ])
        session.commit()
    monkeypatch.setattr(main, '_utc_now', lambda: datetime(2026, 10, 2, 0, 37, 59, tzinfo=timezone.utc))
    paths = [f'/tasks/{identifier}/{suffix}' for identifier in (known_id, unknown_id)
             for suffix in ('actual-minutes', 'diff', 'time-entries')] + ['/projects', '/tasks/time/active']
    before_responses = {path: client.get(path).json() for path in paths}
    previous_reports = {zone: daily(client, zone=zone) for zone in ('UTC', 'Asia/Tokyo')}
    assert previous_reports['UTC']['dailyActualMinutes'] == 27
    assert previous_reports['Asia/Tokyo']['dailyActualMinutes'] == 37
    assert previous_reports['UTC']['dailyEstimatedMinutes'] == 120
    assert before_responses[f'/tasks/{unknown_id}/diff']['differenceMinutes'] is None
    assert {p['id']: p['actualMinutes'] for p in before_responses['/projects']}[historical_id] == 30
    block(client, known_id, '10:00', 60)
    block(client, unknown_id, '10:30', 60)
    stored = saved_values(SessionLocal)
    raw = Path(database.engine.url.database).read_bytes()
    for _ in range(2):
        for zone, previous in previous_reports.items():
            response = daily(client, zone=zone)
            assert response.pop('plannedOccupiedMinutes') == 90
            assert response == {k: v for k, v in previous.items() if k != 'plannedOccupiedMinutes'}
        assert {path: client.get(path).json() for path in paths} == before_responses
    assert saved_values(SessionLocal) == stored
    assert Path(database.engine.url.database).read_bytes() == raw


def test_merge_intervals_sorts_unions_and_preserves_input():
    intervals = [(630, 690), (600, 660), (690, 720), (610, 620), (800, 800)]
    assert merge_intervals(intervals) == [(600, 720)]
    assert intervals == [(630, 690), (600, 660), (690, 720), (610, 620), (800, 800)]


def test_local_helper_ignores_malformed_values_without_inventing_defaults():
    def candidate(**fields):
        return SimpleNamespace(type='TIMED', date=fields.get('date', DAY),
                               start_time=fields.get('start_time', time(10)),
                               duration_minutes=fields.get('duration_minutes', 30))
    assert planned_occupied_minutes(DAY, [candidate(date=None), candidate(start_time='bad'),
                                          candidate(start_time=time(10, tzinfo=timezone.utc)),
                                          candidate(duration_minutes=True), candidate()]) == 30
