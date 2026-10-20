"""ScheduleBlock alone determines report membership; all data is synthetic and isolated."""

from datetime import date, datetime, time, timedelta, timezone

import pytest
from sqlalchemy import event, inspect, text

from app import main
from app.models import ScheduleBlock, Task, TimeEntry


DAY = date(2026, 10, 2)


def daily(client, day=DAY, zone='UTC'):
    response = client.get('/reports/daily', params={'date': str(day), 'timezone': zone})
    assert response.status_code == 200, response.text
    return response.json()


def task(client, estimate=60, **fields):
    response = client.post('/tasks', json={'title': 'Scheduled task', 'estimatedMinutes': estimate, **fields})
    assert response.status_code == 201, response.text
    return response.json()


def block(client, task_id, day=DAY, kind='TIME_UNSET', clock=None, duration=None):
    response = client.post('/schedule-blocks', json={
        'taskId': task_id, 'date': str(day), 'type': kind,
        'startTime': clock, 'durationMinutes': duration,
    })
    assert response.status_code == 201, response.text
    return response.json()


def saved(factory):
    with factory() as db:
        return {name: db.execute(text(f'SELECT * FROM "{name}" ORDER BY rowid')).all()
                for name in inspect(db.bind).get_table_names()}


def test_legacy_only_is_inbox_and_never_a_daily_scheduled_task(client, SessionLocal):
    item = task(client, plannedDate=str(DAY), plannedStartTime='10:00')
    before = saved(SessionLocal)
    report = daily(client)
    assert report['dailyEstimatedMinutes'] == report['plannedOccupiedMinutes'] == 0
    assert report['tasks'] == []
    assert [row['id'] for row in client.get('/tasks?inbox=true').json()] == [item['id']]
    assert saved(SessionLocal) == before


@pytest.mark.parametrize('kind,estimate,clock,duration,occupied', [
    ('TIME_UNSET', 60, None, None, 0),
    ('ALL_DAY', 90, None, None, 0),
    ('TIMED', 120, '10:00', 30, 30),
    ('TIME_UNSET', None, None, None, 0),
    ('ALL_DAY', None, None, None, 0),
    ('TIMED', None, '10:00', 30, 30),
])
def test_all_types_define_membership_and_estimate_is_independent(client, SessionLocal, kind, estimate, clock, duration, occupied):
    item = task(client, estimate)
    block(client, item['id'], kind=kind, clock=clock, duration=duration)
    before = saved(SessionLocal)
    result = daily(client)
    assert result['dailyEstimatedMinutes'] == (estimate if estimate is not None else 0)
    assert result['plannedOccupiedMinutes'] == occupied
    assert result['dailyActualMinutes'] == 0
    assert result['dailyDifference'] == -result['dailyEstimatedMinutes']
    assert len(result['tasks']) == 1
    assert result['tasks'][0]['estimatedMinutes'] == estimate
    assert result['tasks'][0]['differenceMinutes'] == (-estimate if estimate is not None else None)
    assert client.get(f"/tasks/{item['id']}").json()['estimatedMinutes'] == estimate
    assert client.get('/tasks?inbox=true').json() == []
    assert saved(SessionLocal) == before


def test_multiple_blocks_and_mixed_types_count_a_task_once_each_day(client):
    item = task(client, 120)
    block(client, item['id'])
    block(client, item['id'], kind='ALL_DAY')
    block(client, item['id'], kind='TIMED', clock='09:00', duration=30)
    block(client, item['id'], kind='TIMED', clock='13:00', duration=30)
    result = daily(client)
    assert result['dailyEstimatedMinutes'] == 120
    assert result['plannedOccupiedMinutes'] == 60
    assert [row['taskId'] for row in result['tasks']] == [item['id']]


def test_distinct_tasks_sum_estimates_but_union_their_occupied_time(client):
    for estimate, duration in [(60, 60), (90, 90)]:
        item = task(client, estimate)
        block(client, item['id'], kind='TIMED', clock='10:00', duration=duration)
    result = daily(client)
    assert result['dailyEstimatedMinutes'] == 150
    assert result['plannedOccupiedMinutes'] == 90
    assert len(result['tasks']) == 2


def test_overnight_task_counts_once_on_each_overlapped_day(client):
    item = task(client)
    block(client, item['id'], kind='TIMED', clock='23:30', duration=120)
    for offset, occupied in [(0, 30), (1, 90)]:
        result = daily(client, DAY + timedelta(days=offset))
        assert result['dailyEstimatedMinutes'] == 60
        assert result['plannedOccupiedMinutes'] == occupied
        assert [row['taskId'] for row in result['tasks']] == [item['id']]
    assert daily(client, DAY + timedelta(days=2))['tasks'] == []


@pytest.mark.parametrize('clock,duration,next_estimate,next_occupied', [
    ('23:30', 30, 0, 0), ('23:59:59', 1, 60, 0),
])
def test_half_open_boundary_and_subminute_overlap(client, clock, duration, next_estimate, next_occupied):
    item = task(client)
    block(client, item['id'], kind='TIMED', clock=clock, duration=duration)
    result = daily(client, DAY + timedelta(days=1))
    assert result['dailyEstimatedMinutes'] == next_estimate
    assert result['plannedOccupiedMinutes'] == next_occupied


def test_long_block_before_period_and_period_totals_use_daily_estimates(client, SessionLocal, monkeypatch):
    monkeypatch.setattr(main, '_utc_now', lambda: datetime(2026, 10, 5, tzinfo=timezone.utc))
    item = task(client)
    block(client, item['id'], date(2026, 9, 30), 'TIMED', '23:30', 3000)
    # Two overlapping blocks on one day must not double this day's estimate.
    block(client, item['id'], kind='ALL_DAY')
    with SessionLocal() as db:
        db.add(TimeEntry(task_id=item['id'], started_at=datetime(2026, 10, 1, 23, 50),
                         ended_at=datetime(2026, 10, 2, 0, 20)))
        db.commit()
    before = saved(SessionLocal)
    for route, params, prefix, estimate in [
        ('weekly', {'date': str(DAY)}, 'weekly', 240),
        ('monthly', {'month': '2026-10'}, 'monthly', 180),
    ]:
        response = client.get(f'/reports/{route}', params={**params, 'timezone': 'UTC'})
        assert response.status_code == 200
        result = response.json()
        assert result[f'{prefix}EstimatedMinutes'] == estimate
        for total, field in [('EstimatedMinutes', 'dailyEstimatedMinutes'),
                             ('PlannedOccupiedMinutes', 'plannedOccupiedMinutes'),
                             ('ActualMinutes', 'dailyActualMinutes')]:
            assert result[f'{prefix}{total}'] == sum(row[field] for row in result['daily'])
        for row in result['daily']:
            assert row == daily(client, date.fromisoformat(row['date']))
    assert [daily(client, date(2026, 10, day))['plannedOccupiedMinutes'] for day in (1, 2, 3)] == [1440, 1440, 90]
    assert daily(client, DAY)['tasks'][0]['actualMinutes'] == 20
    assert saved(SessionLocal) == before


def test_changing_only_legacy_values_leaves_all_reports_and_inbox_unchanged(client, SessionLocal):
    legacy_day = date(2026, 10, 5)
    item = task(client, plannedDate=str(legacy_day), plannedStartTime='10:00')
    block(client, item['id'], DAY)
    paths = [f'/reports/daily?date={day}&timezone=UTC' for day in (DAY, legacy_day, legacy_day + timedelta(days=1))]
    paths += ['/reports/weekly?date=2026-10-02&timezone=UTC', '/reports/monthly?month=2026-10&timezone=UTC', '/tasks?inbox=true']
    before = [client.get(path).json() for path in paths]
    assert before[0]['dailyEstimatedMinutes'] == 60
    assert before[1]['tasks'] == before[2]['tasks'] == []
    response = client.put(f"/tasks/{item['id']}", json={'plannedDate': '2026-10-06', 'plannedStartTime': '18:00'})
    assert response.status_code == 200  # Legacy API compatibility remains available.
    assert [client.get(path).json() for path in paths] == before
    with SessionLocal() as db:
        assert db.get(Task, item['id']).planned_date == date(2026, 10, 6)


@pytest.mark.parametrize('route', ['daily', 'weekly', 'monthly'])
def test_period_queries_are_batched_instead_of_per_task_or_day(client, SessionLocal, route):
    with SessionLocal() as db:
        for index in range(40):
            item = Task(title=str(index), estimated_minutes=1)
            db.add(item); db.flush()
            for kind in ('TIME_UNSET', 'ALL_DAY'):
                db.add(ScheduleBlock(task_id=item.id, date=DAY, type=kind))
        db.commit(); engine = db.get_bind()
    statements = []
    def record(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith('SELECT'):
            statements.append(statement)
    event.listen(engine, 'before_cursor_execute', record)
    try:
        params = {'month': '2026-10'} if route == 'monthly' else {'date': str(DAY)}
        response = client.get(f'/reports/{route}', params={**params, 'timezone': 'UTC'})
    finally:
        event.remove(engine, 'before_cursor_execute', record)
    assert response.status_code == 200
    assert response.json()[{'daily': 'daily', 'weekly': 'weekly', 'monthly': 'monthly'}[route] + 'EstimatedMinutes'] == 40
    assert len(statements) == 3
