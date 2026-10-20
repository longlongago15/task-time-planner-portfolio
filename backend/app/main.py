import os
from calendar import monthrange
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta, timezone
from typing import List
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ValidationError
from sqlalchemy import String, cast, or_, text
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session, selectinload

from .database import SessionLocal, engine, migrate_schema
from .models import Project, ScheduleBlock, Tag, Task, TimeEntry
from .schedule_occupancy import planned_occupied_minutes, scheduled_task_ids
from .schemas import (
    ProjectCreate,
    ProjectRead,
    ProjectUpdate,
    ScheduleBlockCreate,
    ScheduleBlockRead,
    ScheduleBlockUpdate,
    TaskComplete,
    TaskCreate,
    TaskDiffRead,
    DailySummaryRead,
    DailyTaskSummaryRead,
    WeeklySummaryRead,
    MonthlySummaryRead,
    WeekdayTotalRead,
    TaskRead,
    TaskUpdate,
    TimeEntryRead,
    ManualTimeEntryCreate,
    ManualTimeEntryUpdate,
    TimeStartRequest,
    TimeStopRequest,
    TagCreate,
    TagRead,
    TagUpdate,
)

preview_settings = None
if os.getenv('APP_ENV') == 'preview':
    from .preview import load_preview_settings, initialize_preview_database
    preview_settings = load_preview_settings()
    initialize_preview_database(engine, preview_settings)
elif engine.dialect.name == 'sqlite':
    # Pending revisions must run before the new ORM schema is used against an old DB.
    migrate_schema()
# MySQL startup is read-only with respect to schema. A separate migration
# command will own schema creation/upgrades; importing this app never runs it.

app = FastAPI(title='Task Management API')
app.add_middleware(
    CORSMiddleware,
    allow_origins=[] if preview_settings is not None else ['*'],
    allow_credentials=preview_settings is None,
    allow_methods=['*'],
    allow_headers=['*'],
)

def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def _timer_transaction(db: Session):
    """Serialize SQLite lifecycle decisions before reading, and roll back every failure."""
    try:
        if db.get_bind().dialect.name == 'sqlite':
            db.execute(text('BEGIN IMMEDIATE'))
        yield
        db.commit()
    except BaseException:
        db.rollback()
        raise


def _active_entry(db: Session, task_id: int | None = None) -> TimeEntry | None:
    query = db.query(TimeEntry).filter(TimeEntry.ended_at.is_(None))
    if task_id is not None:
        query = query.filter(TimeEntry.task_id == task_id)
    return query.order_by(TimeEntry.id).first()


def _timer_conflict(error: IntegrityError | OperationalError) -> HTTPException | None:
    # Convert only the Active unique constraint and SQLite lock contention.
    if isinstance(error, IntegrityError) and 'uq_time_entries_single_active' in str(error.orig):
        return HTTPException(status_code=409, detail='Only one task can be timed at a time')
    code = getattr(error.orig, 'sqlite_errorcode', 0)
    if isinstance(error, OperationalError) and (code & 255) in (5, 6):
        return HTTPException(status_code=409, detail='Timer state is busy; please retry')
    return None


def _entry_minutes(
    entry: TimeEntry, now: datetime,
    range_start: datetime | None = None, range_end: datetime | None = None,
) -> int:
    """Floor each entry's half-open interval after clipping; never mutate history."""
    start = _as_utc(entry.started_at)
    end = _as_utc(entry.ended_at) if entry.ended_at is not None else _as_utc(now)
    if range_start is not None:
        start = max(start, _as_utc(range_start))
    if range_end is not None:
        end = min(end, _as_utc(range_end))
    if end <= start:
        return 0
    return int((end - start).total_seconds() // 60)


def _task_to_response(task: Task, now: datetime | None = None) -> TaskRead:
    now = _utc_now() if now is None else now
    actual_minutes = sum(_entry_minutes(entry, now) for entry in task.time_entries)
    diff = actual_minutes - task.estimated_minutes if task.estimated_minutes is not None else None
    actual_started_at = min((_as_utc(entry.started_at) for entry in task.time_entries), default=None)
    return TaskRead(
        id=task.id,
        title=task.title,
        estimatedMinutes=task.estimated_minutes,
        priority=task.priority,
        deadline=task.deadline,
        startDate=task.start_date,
        plannedDate=task.planned_date,
        plannedStartTime=task.planned_start_time,
        projectId=task.project_id,
        projectName=task.project.name if task.project is not None else None,
        completed=task.completed,
        status=task.status,
        completedAt=_as_utc(task.completed_at) if task.completed_at is not None else None,
        completedEstimateMinutes=task.completed_estimate_minutes,
        actualMinutes=actual_minutes,
        differenceMinutes=diff,
        actualStartedAt=actual_started_at,
        createdAt=_as_utc(task.created_at),
        updatedAt=_as_utc(task.updated_at),
        tags=[_tag_to_response(tag) for tag in sorted(task.tags, key=lambda tag: (tag.name, tag.id))],
    )


def _tag_to_response(tag: Tag) -> TagRead:
    return TagRead(id=tag.id, name=tag.name, color=tag.color, createdAt=_as_utc(tag.created_at), updatedAt=_as_utc(tag.updated_at))


def _task_tags(db: Session, tag_ids: list[int]) -> list[Tag]:
    if not tag_ids:
        return []
    tags = db.query(Tag).filter(Tag.id.in_(tag_ids)).order_by(Tag.id).with_for_update().all()
    missing = set(tag_ids) - {tag.id for tag in tags}
    if missing:
        raise HTTPException(status_code=422, detail=f'Tag not found: {sorted(missing)}')
    return tags


def _tag_name_conflict(error: IntegrityError) -> bool:
    message = str(error.orig)
    return 'tags.name' in message or 'uq_tags_name' in message


def _project_to_response(project: Project, db: Session, now: datetime | None = None) -> ProjectRead:
    now = _utc_now() if now is None else now
    entries = db.query(TimeEntry).filter(TimeEntry.project_id_snapshot == project.id).all()
    return ProjectRead(
        id=project.id,
        name=project.name,
        color=project.color,
        taskCount=len(project.tasks),
        completedCount=sum(task.completed for task in project.tasks),
        estimatedMinutes=sum(task.estimated_minutes for task in project.tasks if task.estimated_minutes is not None),
        actualMinutes=sum(_entry_minutes(entry, now) for entry in entries),
    )


def _schedule_block_to_response(block: ScheduleBlock) -> ScheduleBlockRead:
    return ScheduleBlockRead(
        id=block.id,
        taskId=block.task_id,
        date=block.date,
        type=block.type,
        startTime=block.start_time,
        durationMinutes=block.duration_minutes,
        createdAt=_as_utc(block.created_at),
        updatedAt=_as_utc(block.updated_at),
    )


def _time_entry_to_response(entry: TimeEntry) -> TimeEntryRead:
    started_at = _as_utc(entry.started_at)
    ended_at = _as_utc(entry.ended_at) if entry.ended_at is not None else None
    return TimeEntryRead(
        id=entry.id, taskId=entry.task_id, projectIdSnapshot=entry.project_id_snapshot,
        startedAt=started_at, endedAt=ended_at, startAt=started_at, endAt=ended_at,
        durationMinutes=entry.duration_minutes, createdAt=_as_utc(entry.created_at),
        updatedAt=_as_utc(entry.updated_at),
    )


def _validate_schedule_values(values: dict) -> ScheduleBlockCreate:
    try:
        return ScheduleBlockCreate.model_validate(values)
    except ValidationError as error:
        raise HTTPException(
            status_code=422, detail=error.errors(include_context=False, include_input=False),
        ) from error


def _schedule_interval(day: date, clock: time, duration: int) -> tuple[int, int]:
    # Local civil time on an integer axis avoids UTC/DST conversion and datetime
    # overflow for long blocks. Preserve the API's seconds/microseconds precision.
    start = (day.toordinal() * 86400 + clock.hour * 3600 + clock.minute * 60 + clock.second) * 1_000_000 + clock.microsecond
    return start, start + duration * 60_000_000


def _reject_same_task_schedule_overlap(db: Session, values: ScheduleBlockCreate, block_id: int | None = None):
    """Compare local [start, end) intervals, including blocks spanning other days."""
    if values.type != 'TIMED':
        return
    start, end = _schedule_interval(values.date, values.startTime, values.durationMinutes)
    query = db.query(ScheduleBlock).filter(
        ScheduleBlock.task_id == values.taskId, ScheduleBlock.type == 'TIMED',
    )
    if block_id is not None:
        query = query.filter(ScheduleBlock.id != block_id)
    for other in query.all():
        other_start, other_end = _schedule_interval(other.date, other.start_time, other.duration_minutes)
        if start < other_end and other_start < end:
            raise HTTPException(status_code=409, detail='同じタスクの時間指定予定と重複しています。開始時刻・予定時間を変更してください。')


@app.get('/health')
def health():
    return {'status': 'ok'}


@app.get('/tasks', response_model=List[TaskRead])
def list_tasks(inbox: bool | None = Query(None), db: Session = Depends(get_db)):
    query = db.query(Task).options(selectinload(Task.tags))
    if inbox is True:
        query = query.filter(~Task.schedule_blocks.any())
    elif inbox is False:
        query = query.filter(Task.schedule_blocks.any())
    tasks = query.order_by(Task.created_at.desc()).all()
    now = _utc_now()
    return [_task_to_response(task, now) for task in tasks]


@app.get('/projects', response_model=list[ProjectRead])
def list_projects(db: Session = Depends(get_db)):
    projects = db.query(Project).order_by(Project.name).all()
    now = _utc_now()
    return [_project_to_response(project, db, now) for project in projects]


@app.get('/tags', response_model=list[TagRead])
def list_tags(db: Session = Depends(get_db)):
    return [_tag_to_response(tag) for tag in db.query(Tag).order_by(Tag.name, Tag.id).all()]


@app.post('/tags', response_model=TagRead, status_code=status.HTTP_201_CREATED)
def create_tag(payload: TagCreate, db: Session = Depends(get_db)):
    try:
        with _timer_transaction(db):
            if db.query(Tag.id).filter(Tag.name == payload.name).first() is not None:
                raise HTTPException(status_code=409, detail='Tag name already exists')
            tag = Tag(name=payload.name, color=payload.color)
            db.add(tag)
            db.flush()
            response = _tag_to_response(tag)
    except IntegrityError as error:
        if _tag_name_conflict(error):
            raise HTTPException(status_code=409, detail='Tag name already exists') from error
        raise
    return response


@app.patch('/tags/{tag_id}', response_model=TagRead)
def update_tag(tag_id: int, payload: TagUpdate, db: Session = Depends(get_db)):
    try:
        with _timer_transaction(db):
            tag = db.query(Tag).filter(Tag.id == tag_id).with_for_update().first()
            if tag is None:
                raise HTTPException(status_code=404, detail='Tag not found')
            if db.query(Tag.id).filter(Tag.name == payload.name, Tag.id != tag_id).first() is not None:
                raise HTTPException(status_code=409, detail='Tag name already exists')
            tag.name = payload.name
            if 'color' in payload.model_fields_set:
                tag.color = payload.color
            tag.updated_at = _utc_now()
            db.flush()
            response = _tag_to_response(tag)
    except IntegrityError as error:
        if _tag_name_conflict(error):
            raise HTTPException(status_code=409, detail='Tag name already exists') from error
        raise
    return response


@app.delete('/tags/{tag_id}')
def delete_tag(tag_id: int, db: Session = Depends(get_db)):
    with _timer_transaction(db):
        tag = db.query(Tag).filter(Tag.id == tag_id).with_for_update().first()
        if tag is None:
            raise HTTPException(status_code=404, detail='Tag not found')
        db.delete(tag)
    return {'deleted': True}


@app.post('/projects', response_model=ProjectRead)
def create_project(project_in: ProjectCreate, db: Session = Depends(get_db)):
    if db.query(Project).filter(Project.name == project_in.name).first() is not None:
        raise HTTPException(status_code=409, detail='Project name already exists')
    project = Project(name=project_in.name, color=project_in.color)
    db.add(project)
    db.commit()
    db.refresh(project)
    return _project_to_response(project, db)


@app.put('/projects/{project_id}', response_model=ProjectRead)
def update_project(project_id: int, project_in: ProjectUpdate, db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if project is None:
        raise HTTPException(status_code=404, detail='Project not found')
    duplicate = db.query(Project).filter(Project.name == project_in.name, Project.id != project_id).first()
    if duplicate is not None:
        raise HTTPException(status_code=409, detail='Project name already exists')
    project.name = project_in.name
    if 'color' in project_in.model_fields_set:
        project.color = project_in.color
    project.updated_at = _utc_now()
    db.commit()
    db.refresh(project)
    return _project_to_response(project, db)


@app.delete('/projects/{project_id}')
def delete_project(project_id: int, db: Session = Depends(get_db)):
    try:
        with _timer_transaction(db):
            project = db.query(Project).filter(Project.id == project_id).with_for_update().first()
            if project is None:
                raise HTTPException(status_code=404, detail='Project not found')
            if db.query(TimeEntry.id).filter(TimeEntry.project_id_snapshot == project_id).first() is not None:
                raise HTTPException(status_code=409, detail='実績履歴から参照されているため、このプロジェクトは削除できません')
            for task in project.tasks:
                task.project_id = None
            db.delete(project)
    except OperationalError as error:
        conflict = _timer_conflict(error)
        if conflict is not None:
            raise conflict from error
        raise
    return {'deleted': True}


@app.post('/schedule-blocks', response_model=ScheduleBlockRead, status_code=status.HTTP_201_CREATED)
def create_schedule_block(block_in: ScheduleBlockCreate, db: Session = Depends(get_db)):
    with _timer_transaction(db):
        # Lock the Task as well on databases supporting row locks. The same Task's
        # concurrent saves must not both pass the overlap check before committing.
        task = db.query(Task).filter(Task.id == block_in.taskId).with_for_update().first()
        if task is None:
            raise HTTPException(status_code=404, detail='Task not found')
        _reject_same_task_schedule_overlap(db, block_in)
        block = ScheduleBlock(
            task_id=block_in.taskId, date=block_in.date, type=block_in.type,
            start_time=block_in.startTime, duration_minutes=block_in.durationMinutes,
        )
        db.add(block)
    db.refresh(block)
    return _schedule_block_to_response(block)


@app.get('/schedule-blocks', response_model=list[ScheduleBlockRead])
def list_schedule_blocks(
    start_date: date | None = Query(None, alias='startDate'),
    end_date: date | None = Query(None, alias='endDate'),
    task_id: int | None = Query(None, alias='taskId', gt=0),
    db: Session = Depends(get_db),
):
    if start_date is not None and end_date is not None and start_date > end_date:
        raise HTTPException(status_code=422, detail='startDate must not be later than endDate')
    query = db.query(ScheduleBlock)
    if start_date is not None:
        query = query.filter(ScheduleBlock.date >= start_date)
    if end_date is not None:
        query = query.filter(ScheduleBlock.date <= end_date)
    if task_id is not None:
        query = query.filter(ScheduleBlock.task_id == task_id)
    blocks = query.order_by(ScheduleBlock.date.asc(), ScheduleBlock.id.asc()).all()
    return [_schedule_block_to_response(block) for block in blocks]


@app.patch('/schedule-blocks/{block_id}', response_model=ScheduleBlockRead)
def update_schedule_block(block_id: int, block_in: ScheduleBlockUpdate, db: Session = Depends(get_db)):
    with _timer_transaction(db):
        block = db.query(ScheduleBlock).filter(ScheduleBlock.id == block_id).with_for_update().first()
        if block is None:
            raise HTTPException(status_code=404, detail='ScheduleBlock not found')
        changes = block_in.model_dump(exclude_unset=True)
        if not changes:
            return _schedule_block_to_response(block)
        db.query(Task).filter(Task.id == block.task_id).with_for_update().first()
        values = {
            'taskId': block.task_id, 'date': block.date, 'type': block.type,
            'startTime': block.start_time, 'durationMinutes': block.duration_minutes,
            **changes,
        }
        if values['type'] != 'TIMED' and 'type' in changes:
            # Clear inherited TIMED fields, but reject explicitly supplied non-NULLs.
            values['startTime'] = changes.get('startTime')
            values['durationMinutes'] = changes.get('durationMinutes')
        # Validate the merged state before changing any persistent ORM attributes.
        validated = _validate_schedule_values(values)
        _reject_same_task_schedule_overlap(db, validated, block_id)
        block.date = validated.date
        block.type = validated.type
        block.start_time = validated.startTime
        block.duration_minutes = validated.durationMinutes
        block.updated_at = _utc_now()
    db.refresh(block)
    return _schedule_block_to_response(block)


@app.delete('/schedule-blocks/{block_id}')
def delete_schedule_block(block_id: int, db: Session = Depends(get_db)):
    block = db.get(ScheduleBlock, block_id)
    if block is None:
        raise HTTPException(status_code=404, detail='ScheduleBlock not found')
    db.delete(block)
    db.commit()
    return {'deleted': True}


@app.post('/tasks', response_model=TaskRead, status_code=status.HTTP_201_CREATED)
def create_task(task_in: TaskCreate, db: Session = Depends(get_db)):
    with _timer_transaction(db):
        if task_in.projectId is not None and db.query(Project).filter(Project.id == task_in.projectId).first() is None:
            raise HTTPException(status_code=404, detail='Project not found')
        tags = _task_tags(db, task_in.tagIds)
        task = Task(
            title=task_in.title.strip(),
            estimated_minutes=task_in.estimatedMinutes,
            priority=task_in.priority,
            deadline=task_in.deadline,
            start_date=task_in.startDate,
            planned_date=task_in.plannedDate,
            planned_start_time=task_in.plannedStartTime,
            project_id=task_in.projectId,
            completed=False,
            tags=tags,
        )
        db.add(task)
        db.flush()
        response = _task_to_response(task)
    return response


@app.put('/tasks/{task_id}', response_model=TaskRead)
def update_task(task_id: int, task_in: TaskUpdate, db: Session = Depends(get_db)):
    with _timer_transaction(db):
        task = db.query(Task).filter(Task.id == task_id).with_for_update().first()
        if task is None:
            raise HTTPException(status_code=404, detail='Task not found')

        if 'tagIds' in task_in.model_fields_set:
            task.tags = _task_tags(db, task_in.tagIds)
        if task_in.title is not None:
            task.title = task_in.title.strip()
        if 'estimatedMinutes' in task_in.model_fields_set:
            task.estimated_minutes = task_in.estimatedMinutes
        if 'priority' in task_in.model_fields_set:
            task.priority = task_in.priority
        if 'deadline' in task_in.model_fields_set:
            task.deadline = task_in.deadline
        if 'startDate' in task_in.model_fields_set:
            task.start_date = task_in.startDate
        if task.start_date is not None and task.deadline is not None and task.start_date > task.deadline:
            raise HTTPException(status_code=422, detail='開始日は期限以前の日付を指定してください。')
        if 'status' in task_in.model_fields_set and task.status != task_in.status:
            if task_in.status == 'COMPLETED' and _active_entry(db, task_id) is not None:
                raise HTTPException(status_code=409, detail='Please stop the timer before completing this task')
            task.status = task_in.status
            task.completed = task_in.status == 'COMPLETED'
            task.completed_at = _utc_now() if task.completed else None
            task.completed_estimate_minutes = task.estimated_minutes if task.completed else None
        if 'plannedDate' in task_in.model_fields_set:
            task.planned_date = task_in.plannedDate
        if 'plannedStartTime' in task_in.model_fields_set:
            task.planned_start_time = task_in.plannedStartTime
        if task.planned_start_time is not None and task.planned_date is None:
            raise HTTPException(status_code=422, detail='plannedDate is required when plannedStartTime is set')
        if 'projectId' in task_in.model_fields_set:
            if task_in.projectId is not None and db.query(Project).filter(Project.id == task_in.projectId).first() is None:
                raise HTTPException(status_code=404, detail='Project not found')
            task.project_id = task_in.projectId

        task.updated_at = _utc_now()
        db.flush()
        response = _task_to_response(task)
    return response


@app.patch('/tasks/{task_id}/complete', response_model=TaskRead)
def toggle_task_complete(task_id: int, payload: TaskComplete, db: Session = Depends(get_db)):
    try:
        with _timer_transaction(db):
            task = db.query(Task).filter(Task.id == task_id).with_for_update().first()
            if task is None:
                raise HTTPException(status_code=404, detail='Task not found')
            if task.completed != payload.completed:
                if payload.completed and _active_entry(db, task_id) is not None:
                    raise HTTPException(status_code=409, detail='Please stop the timer before completing this task')
                now = _utc_now()
                task.completed = payload.completed
                task.status = 'COMPLETED' if payload.completed else 'NOT_STARTED'
                task.completed_at = now if payload.completed else None
                task.completed_estimate_minutes = task.estimated_minutes if payload.completed else None
                task.updated_at = now
                db.flush()
            response = _task_to_response(task)
    except OperationalError as error:
        conflict = _timer_conflict(error)
        if conflict is not None:
            raise conflict from error
        raise
    return response


@app.delete('/tasks/{task_id}')
def delete_task(task_id: int, db: Session = Depends(get_db)):
    try:
        with _timer_transaction(db):
            task = db.query(Task).filter(Task.id == task_id).with_for_update().first()
            if task is None:
                raise HTTPException(status_code=404, detail='Task not found')
            # Check both closed and Active history under the same lock as Start.
            if db.query(TimeEntry.id).filter(TimeEntry.task_id == task_id).first() is not None:
                raise HTTPException(status_code=409, detail='実績履歴があるため、このタスクは削除できません')
            db.delete(task)
    except OperationalError as error:
        conflict = _timer_conflict(error)
        if conflict is not None:
            raise conflict from error
        raise
    return {'deleted': True}


@app.get('/tasks/time/active')
def get_active_timer(db: Session = Depends(get_db)):
    entry = _active_entry(db)
    if entry is None:
        return {'taskId': None, 'running': False, 'startedAt': None}
    return {'taskId': entry.task_id, 'running': True, 'startedAt': _as_utc(entry.started_at).isoformat()}


@app.post('/tasks/time/start', response_model=dict)
def start_timer(payload: TimeStartRequest, db: Session = Depends(get_db)):
    try:
        with _timer_transaction(db):
            task = db.query(Task).filter(Task.id == payload.taskId).with_for_update().first()
            if task is None:
                raise HTTPException(status_code=404, detail='Task not found')
            if task.status == 'COMPLETED' or task.completed:
                raise HTTPException(status_code=409, detail='Completed tasks cannot be timed')
            if _active_entry(db) is not None:
                raise HTTPException(status_code=409, detail='Only one task can be timed at a time')
            now = _as_utc(_utc_now())
            _reject_time_entry_overlap(db, now, None)
            db.add(TimeEntry(task_id=task.id, project_id_snapshot=task.project_id,
                             started_at=now, ended_at=None, created_at=now, updated_at=now))
            if task.status == 'NOT_STARTED':
                task.status = 'IN_PROGRESS'
                task.updated_at = now
    except (IntegrityError, OperationalError) as error:
        conflict = _timer_conflict(error)
        if conflict is not None:
            raise conflict from error
        raise
    return {'taskId': payload.taskId, 'running': True, 'startedAt': now.isoformat()}


@app.post('/tasks/time/stop', response_model=TimeEntryRead)
def stop_timer(payload: TimeStopRequest, db: Session = Depends(get_db)):
    try:
        with _timer_transaction(db):
            entry = _active_entry(db, payload.taskId)
            if entry is None:
                raise HTTPException(status_code=409, detail='Task is not currently running')
            now = _as_utc(_utc_now())
            if now < _as_utc(entry.started_at):
                raise HTTPException(status_code=409, detail='Server clock is earlier than the timer start')
            _reject_time_entry_overlap(db, _as_utc(entry.started_at), now, entry.id)
            changed = db.query(TimeEntry).filter(
                TimeEntry.id == entry.id, TimeEntry.ended_at.is_(None),
            ).update({TimeEntry.ended_at: now, TimeEntry.updated_at: now}, synchronize_session='fetch')
            if changed != 1:
                raise HTTPException(status_code=409, detail='Task is not currently running')
            response = _time_entry_to_response(entry)
    except OperationalError as error:
        conflict = _timer_conflict(error)
        if conflict is not None:
            raise conflict from error
        raise
    return response


TIME_ENTRY_OVERLAP_DETAIL = 'この時間帯には別の実績があります'


def _reject_time_entry_overlap(db: Session, start: datetime, end: datetime | None, entry_id: int | None = None):
    if end == start:
        return  # Start immediately followed by Stop is an empty interval.
    # Half-open intervals, across every Task. Active occupies [start, infinity).
    # Timer-created zero-second entries are empty intervals, not collisions.
    query = db.query(TimeEntry.id).filter(
        or_(TimeEntry.ended_at.is_(None), TimeEntry.ended_at > start),
        or_(TimeEntry.ended_at.is_(None), TimeEntry.ended_at > TimeEntry.started_at),
    )
    if end is not None:
        query = query.filter(TimeEntry.started_at < end)
    if entry_id is not None:
        query = query.filter(TimeEntry.id != entry_id)
    if query.first() is not None:
        raise HTTPException(status_code=409, detail=TIME_ENTRY_OVERLAP_DETAIL)


def _validate_manual_interval(db: Session, start: datetime, end: datetime, now: datetime, entry_id: int | None = None):
    if start >= end:
        raise HTTPException(status_code=422, detail='終了日時は開始日時より後にしてください')
    if end > now:
        raise HTTPException(status_code=422, detail='未来の実績は登録できません')
    _reject_time_entry_overlap(db, start, end, entry_id)


def _manual_task(db: Session, task_id: int) -> Task:
    task = db.query(Task).filter(Task.id == task_id).with_for_update().first()
    if task is None:
        raise HTTPException(status_code=404, detail='選択したTaskが見つかりません')
    return task


def _manual_task_started(task: Task, now: datetime):
    if task.status == 'NOT_STARTED' and not task.completed:
        task.status = 'IN_PROGRESS'
        task.updated_at = now


@app.post('/time-entries', response_model=TimeEntryRead, status_code=status.HTTP_201_CREATED)
def create_manual_time_entry(payload: ManualTimeEntryCreate, db: Session = Depends(get_db)):
    try:
        # Same SQLite write lock as Start/Stop and history-protected deletion:
        # validate first, then mutate; failed requests roll back every field.
        with _timer_transaction(db):
            task = _manual_task(db, payload.taskId)
            now = _as_utc(_utc_now())
            start, end = _as_utc(payload.startedAt), _as_utc(payload.endedAt)
            _validate_manual_interval(db, start, end, now)
            entry = TimeEntry(task_id=task.id, project_id_snapshot=task.project_id,
                              started_at=start, ended_at=end, created_at=now, updated_at=now)
            db.add(entry)
            _manual_task_started(task, now)
            db.flush()
            response = _time_entry_to_response(entry)
    except OperationalError as error:
        conflict = _timer_conflict(error)
        if conflict is not None:
            raise conflict from error
        raise
    return response


@app.patch('/time-entries/{entry_id}', response_model=TimeEntryRead)
def update_manual_time_entry(entry_id: int, payload: ManualTimeEntryUpdate, db: Session = Depends(get_db)):
    try:
        with _timer_transaction(db):
            entry = db.query(TimeEntry).filter(TimeEntry.id == entry_id).with_for_update().first()
            if entry is None:
                raise HTTPException(status_code=404, detail='実績が見つかりません')
            if entry.ended_at is None:
                raise HTTPException(status_code=409, detail='計測中の実績は直接編集できません。一度停止または一時停止してください。')
            changes = payload.model_dump(exclude_unset=True)
            if not changes:
                return _time_entry_to_response(entry)
            target_task = _manual_task(db, changes['taskId']) if 'taskId' in changes else None
            if changes.get('projectIdSnapshot') is not None and db.query(Project.id).filter(Project.id == changes['projectIdSnapshot']).first() is None:
                raise HTTPException(status_code=404, detail='プロジェクトが見つかりません')
            now = _as_utc(_utc_now())
            start = _as_utc(changes.get('startedAt', entry.started_at))
            end = _as_utc(changes.get('endedAt', entry.ended_at))
            _validate_manual_interval(db, start, end, now, entry.id)
            # Project history attribution stays immutable when correcting a Task.
            entry.started_at, entry.ended_at, entry.updated_at = start, end, now
            if target_task is not None:
                entry.task_id = target_task.id
            if 'projectIdSnapshot' in changes:
                entry.project_id_snapshot = changes['projectIdSnapshot']
            db.flush()
            response = _time_entry_to_response(entry)
    except OperationalError as error:
        conflict = _timer_conflict(error)
        if conflict is not None:
            raise conflict from error
        raise
    return response


@app.delete('/time-entries/{entry_id}')
def delete_manual_time_entry(entry_id: int, db: Session = Depends(get_db)):
    try:
        with _timer_transaction(db):
            entry = db.query(TimeEntry).filter(TimeEntry.id == entry_id).with_for_update().first()
            if entry is None:
                raise HTTPException(status_code=404, detail='実績が見つかりません')
            if entry.ended_at is None:
                raise HTTPException(status_code=409, detail='計測中の実績は直接削除できません。一度停止または一時停止してください。')
            db.delete(entry)
    except OperationalError as error:
        conflict = _timer_conflict(error)
        if conflict is not None:
            raise conflict from error
        raise
    return {'deleted': True}


@app.get('/tasks/{task_id}/actual-minutes')
def get_actual_minutes(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if task is None:
        raise HTTPException(status_code=404, detail='Task not found')
    now = _utc_now()
    actual_minutes = sum(_entry_minutes(entry, now) for entry in task.time_entries)
    return {'taskId': task.id, 'actualMinutes': actual_minutes}


@app.get('/tasks/{task_id}/time-entries', response_model=list[TimeEntryRead])
def list_time_entries(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if task is None:
        raise HTTPException(status_code=404, detail='Task not found')
    return [
        _time_entry_to_response(entry)
        for entry in sorted(task.time_entries, key=lambda item: _as_utc(item.started_at))
    ]


@app.get('/tasks/{task_id}/diff', response_model=TaskDiffRead)
def get_task_diff(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if task is None:
        raise HTTPException(status_code=404, detail='Task not found')
    now = _utc_now()
    actual_minutes = sum(_entry_minutes(entry, now) for entry in task.time_entries)
    diff = actual_minutes - task.estimated_minutes if task.estimated_minutes is not None else None
    return TaskDiffRead(taskId=task.id, estimatedMinutes=task.estimated_minutes, actualMinutes=actual_minutes, differenceMinutes=diff)


def _report_timezone(timezone_name: str) -> ZoneInfo:
    try:
        return ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        raise HTTPException(status_code=422, detail='Invalid timezone')


def _report_schedule(db: Session, from_date: date, until_date: date):
    # Text casts preserve the daily report's defense against malformed legacy date/time values.
    # Earlier TIMED blocks can continue into the period; untimed blocks belong to one date.
    blocks = db.query(
        ScheduleBlock.task_id,
        ScheduleBlock.type,
        cast(ScheduleBlock.date, String).label('date'),
        cast(ScheduleBlock.start_time, String).label('start_time'),
        ScheduleBlock.duration_minutes,
    ).filter(
        ScheduleBlock.date <= until_date,
        or_(ScheduleBlock.type == 'TIMED', ScheduleBlock.date >= from_date),
    ).all()
    tasks = db.query(Task).filter(Task.id.in_({block.task_id for block in blocks})).all()
    return tasks, blocks


def _daily_report_summary(target_date, local_timezone, now, report_tasks, entries, blocks):
    task_ids = scheduled_task_ids(target_date, blocks)
    report_tasks = [task for task in report_tasks if task.id in task_ids]
    local_start = datetime.combine(target_date, time.min, tzinfo=local_timezone)
    local_end = datetime.combine(target_date + timedelta(days=1), time.min, tzinfo=local_timezone)
    utc_start = local_start.astimezone(timezone.utc)
    utc_end = local_end.astimezone(timezone.utc)
    estimated_minutes = sum(task.estimated_minutes for task in report_tasks if task.estimated_minutes is not None)
    actual_by_task: dict[int, int] = {}
    for entry in entries:
        actual_by_task[entry.task_id] = actual_by_task.get(entry.task_id, 0) + _entry_minutes(entry, now, utc_start, utc_end)
    actual_minutes = sum(actual_by_task.values())
    task_summaries = []
    for task in report_tasks:
        task_actual_minutes = actual_by_task.get(task.id, 0)
        task_summaries.append(DailyTaskSummaryRead(
            taskId=task.id,
            title=task.title,
            estimatedMinutes=task.estimated_minutes,
            actualMinutes=task_actual_minutes,
            differenceMinutes=task_actual_minutes - task.estimated_minutes if task.estimated_minutes is not None else None,
        ))
    return DailySummaryRead(
        date=target_date,
        plannedOccupiedMinutes=planned_occupied_minutes(target_date, blocks),
        dailyEstimatedMinutes=estimated_minutes,
        dailyActualMinutes=actual_minutes,
        dailyDifference=actual_minutes - estimated_minutes,
        tasks=task_summaries,
    )


@app.get('/reports/daily', response_model=DailySummaryRead)
def get_daily_summary(
    target_date: date = Query(..., alias='date'),
    timezone_name: str = Query(..., alias='timezone'),
    db: Session = Depends(get_db),
):
    local_timezone = _report_timezone(timezone_name)
    now = _utc_now()
    tasks, blocks = _report_schedule(db, target_date, target_date)
    return _daily_report_summary(
        target_date, local_timezone, now,
        tasks, db.query(TimeEntry).all(), blocks,
    )


@app.get('/reports/weekly', response_model=WeeklySummaryRead)
def get_weekly_summary(
    target_date: date = Query(..., alias='date'),
    timezone_name: str = Query(..., alias='timezone'),
    db: Session = Depends(get_db),
):
    local_timezone = _report_timezone(timezone_name)
    week_start = target_date - timedelta(days=target_date.weekday())
    week_end = week_start + timedelta(days=6)
    now = _utc_now()  # One cutoff for all seven days, including Active entries.
    tasks, blocks = _report_schedule(db, week_start, week_end)
    entries = db.query(TimeEntry).all()
    daily = [
        _daily_report_summary(day, local_timezone, now, tasks, entries, blocks)
        for day in (week_start + timedelta(days=offset) for offset in range(7))
    ]
    return WeeklySummaryRead(
        weekStart=week_start, weekEnd=week_end, daily=daily,
        weeklyEstimatedMinutes=sum(day.dailyEstimatedMinutes for day in daily),
        weeklyPlannedOccupiedMinutes=sum(day.plannedOccupiedMinutes for day in daily),
        weeklyActualMinutes=sum(day.dailyActualMinutes for day in daily),
    )


@app.get('/reports/monthly', response_model=MonthlySummaryRead)
def get_monthly_summary(
    month: str = Query(..., pattern=r'^[0-9]{4}-(0[1-9]|1[0-2])$'),
    timezone_name: str = Query(..., alias='timezone'),
    db: Session = Depends(get_db),
):
    local_timezone = _report_timezone(timezone_name)
    try:
        month_start = date.fromisoformat(f'{month}-01')
        # Daily clipping requires the midnight following the last day.
        if month == '9999-12':
            raise ValueError('Following midnight is outside the supported date range')
    except ValueError:
        raise HTTPException(status_code=422, detail='Invalid month')
    days = monthrange(month_start.year, month_start.month)[1]
    month_end = month_start + timedelta(days=days - 1)
    now = _utc_now()  # Use the same Active cutoff for every local day.
    tasks, blocks = _report_schedule(db, month_start, month_end)
    entries = db.query(TimeEntry).all()
    daily = [
        _daily_report_summary(day, local_timezone, now, tasks, entries, blocks)
        for day in (month_start + timedelta(days=offset) for offset in range(days))
    ]
    weekday_totals = [WeekdayTotalRead(weekday=weekday, estimatedMinutes=0,
                                     plannedOccupiedMinutes=0, actualMinutes=0)
                      for weekday in range(7)]
    for day in daily:
        totals = weekday_totals[day.date.weekday()]
        totals.estimatedMinutes += day.dailyEstimatedMinutes
        totals.plannedOccupiedMinutes += day.plannedOccupiedMinutes
        totals.actualMinutes += day.dailyActualMinutes
    return MonthlySummaryRead(
        month=month, monthStart=month_start, monthEnd=month_end, daily=daily,
        monthlyEstimatedMinutes=sum(day.dailyEstimatedMinutes for day in daily),
        monthlyPlannedOccupiedMinutes=sum(day.plannedOccupiedMinutes for day in daily),
        monthlyActualMinutes=sum(day.dailyActualMinutes for day in daily),
        weekdayTotals=weekday_totals,
    )


@app.get('/tasks/{task_id}', response_model=TaskRead)
def get_task(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if task is None:
        raise HTTPException(status_code=404, detail='Task not found')
    return _task_to_response(task)


if preview_settings is not None:
    from .preview import configure_preview_app
    configure_preview_app(app, engine, preview_settings)
