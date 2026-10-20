from datetime import date, datetime, time, timezone

from sqlalchemy import Boolean, CheckConstraint, Column, Date, DateTime, ForeignKey, Index, Integer, String, Table, Time, UniqueConstraint, text
from sqlalchemy.orm import relationship

from .database import Base


task_tags = Table(
    'task_tags', Base.metadata,
    Column('task_id', Integer, ForeignKey('tasks.id', ondelete='CASCADE'), primary_key=True, nullable=False),
    Column('tag_id', Integer, ForeignKey('tags.id', ondelete='CASCADE'), primary_key=True, nullable=False),
    Index('ix_task_tags_tag_id', 'tag_id'),
)


class Tag(Base):
    __tablename__ = 'tags'
    __table_args__ = (
        UniqueConstraint('name', name='uq_tags_name'),
        CheckConstraint('length(name) BETWEEN 1 AND 255', name='ck_tags_name_length').ddl_if(dialect='sqlite'),
    )

    id = Column(Integer, primary_key=True)
    name = Column(String(255), nullable=False)
    color = Column(String(7), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False)

    tasks = relationship('Task', secondary=task_tags, back_populates='tags')


class Project(Base):
    __tablename__ = 'projects'

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, unique=True)
    color = Column(String(7), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False)

    tasks = relationship('Task', back_populates='project')


class Task(Base):
    __tablename__ = 'tasks'
    __table_args__ = (
        CheckConstraint("status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED')", name='ck_tasks_status'),
        CheckConstraint("priority IS NULL OR priority IN ('HIGH', 'MEDIUM', 'LOW')", name='ck_tasks_priority'),
    )

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(255), nullable=False)
    estimated_minutes = Column(Integer, nullable=True)
    priority = Column(String(6), nullable=True)
    deadline = Column(Date, nullable=True)
    start_date = Column(Date, nullable=True)
    planned_date = Column(Date, nullable=True)
    planned_start_time = Column(Time, nullable=True)
    project_id = Column(Integer, ForeignKey('projects.id', ondelete='SET NULL'), nullable=True)
    completed = Column(Boolean, default=False, nullable=False)
    status = Column(String(11), default='NOT_STARTED', server_default='NOT_STARTED', nullable=False)
    completed_at = Column(DateTime, nullable=True)
    completed_estimate_minutes = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False)

    time_entries = relationship('TimeEntry', back_populates='task', cascade='all, delete-orphan')
    schedule_blocks = relationship('ScheduleBlock', back_populates='task', cascade='all, delete-orphan')
    project = relationship('Project', back_populates='tasks')
    tags = relationship('Tag', secondary=task_tags, back_populates='tasks', order_by=(Tag.name, Tag.id))


class ScheduleBlock(Base):
    __tablename__ = 'schedule_blocks'
    __table_args__ = (
        CheckConstraint("type IN ('TIME_UNSET', 'TIMED', 'ALL_DAY')", name='ck_schedule_blocks_type'),
        CheckConstraint(
            "(type = 'TIMED' AND start_time IS NOT NULL AND duration_minutes IS NOT NULL "
            "AND duration_minutes >= 1) OR "
            "(type IN ('TIME_UNSET', 'ALL_DAY') AND start_time IS NULL AND duration_minutes IS NULL)",
            name='ck_schedule_blocks_fields',
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(Integer, ForeignKey('tasks.id', ondelete='CASCADE'), nullable=False, index=True)
    date = Column(Date, nullable=False)
    type = Column(String(10), nullable=False)
    start_time = Column(Time, nullable=True)
    duration_minutes = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False)

    task = relationship('Task', back_populates='schedule_blocks')


class TimeEntry(Base):
    __tablename__ = 'time_entries'
    __table_args__ = (
        Index('uq_time_entries_single_active', text('(1)'), unique=True,
              sqlite_where=text('ended_at IS NULL')).ddl_if(dialect='sqlite'),
    )

    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(Integer, ForeignKey('tasks.id', ondelete='CASCADE'), nullable=False)
    # Historical membership must survive later Project changes/deletion.
    project_id_snapshot = Column(Integer, nullable=True)
    started_at = Column(DateTime, nullable=False)
    ended_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False)

    @property
    def duration_minutes(self) -> int | None:
        if self.ended_at is None:
            return None
        start = self.started_at.replace(tzinfo=timezone.utc) if self.started_at.tzinfo is None else self.started_at.astimezone(timezone.utc)
        end = self.ended_at.replace(tzinfo=timezone.utc) if self.ended_at.tzinfo is None else self.ended_at.astimezone(timezone.utc)
        return int((end - start).total_seconds() // 60)

    task = relationship('Task', back_populates='time_entries')
