import datetime as dt
import re
from datetime import date, datetime, time
from typing import Annotated, Literal, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator, root_validator, validator


class TaskMetadata(BaseModel):
    priority: Optional[Literal['HIGH', 'MEDIUM', 'LOW']] = None
    deadline: Optional[date] = None
    startDate: Optional[date] = None
    tagIds: list[Annotated[int, Field(gt=0, strict=True)]] = Field(default_factory=list)

    @field_validator('tagIds')
    @classmethod
    def deduplicate_tag_ids(cls, value):
        return list(dict.fromkeys(value))

    @field_validator('deadline', 'startDate', mode='before')
    @classmethod
    def validate_deadline(cls, value, info):
        if value is None or type(value) is dt.date:
            return value
        if isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
            return value
        raise ValueError(f'{info.field_name} must be a YYYY-MM-DD local date or null')

    @field_validator('deadline', 'startDate')
    @classmethod
    def validate_deadline_range(cls, value, info):
        if value is not None and not dt.date(2000, 1, 1) <= value <= dt.date(2100, 12, 31):
            raise ValueError(f'{info.field_name} must be between 2000-01-01 and 2100-12-31')
        return value

    @model_validator(mode='after')
    def validate_period(self):
        if self.startDate is not None and self.deadline is not None and self.startDate > self.deadline:
            raise ValueError('startDate must not be after deadline')
        return self


class TaskCreate(TaskMetadata):
    title: str
    estimatedMinutes: Optional[int] = Field(
        None, gt=0, validation_alias=AliasChoices('estimatedMinutes', 'estimated_minutes'),
    )
    plannedDate: Optional[date] = None
    plannedStartTime: Optional[time] = None
    projectId: Optional[int] = None

    @validator('title')
    def validate_title(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError('title must not be empty')
        return cleaned

    @root_validator(skip_on_failure=True)
    def validate_schedule(cls, values):
        if values.get('plannedStartTime') is not None and values.get('plannedDate') is None:
            raise ValueError('plannedDate is required when plannedStartTime is set')
        return values


class TaskUpdate(TaskMetadata):
    status: Optional[Literal['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED']] = None

    @field_validator('status')
    @classmethod
    def require_status(cls, value):
        if value is None:
            raise ValueError('status must not be null')
        return value

    title: Optional[str] = None
    estimatedMinutes: Optional[int] = Field(
        None, gt=0, validation_alias=AliasChoices('estimatedMinutes', 'estimated_minutes'),
    )
    plannedDate: Optional[date] = None
    plannedStartTime: Optional[time] = None
    projectId: Optional[int] = None

    @root_validator(skip_on_failure=True)
    def validate_fields(cls, values):
        title = values.get('title')
        if title is not None:
            cleaned = title.strip()
            if not cleaned:
                raise ValueError('title must not be empty')
            values['title'] = cleaned

        minutes = values.get('estimatedMinutes')
        if minutes is not None and minutes <= 0:
            raise ValueError('estimatedMinutes must be greater than 0')
        return values


class TaskComplete(BaseModel):
    completed: bool


class IdentificationColor(BaseModel):
    color: Optional[str] = None

    @field_validator('color', mode='before')
    @classmethod
    def validate_color(cls, value):
        if value is None:
            return None
        if not isinstance(value, str) or re.fullmatch(r'#[0-9a-fA-F]{6}', value) is None:
            raise ValueError('color must be #RRGGBB or null')
        return value.upper()


class TagCreate(IdentificationColor):
    name: str

    @field_validator('name')
    @classmethod
    def validate_name(cls, value):
        cleaned = value.strip()
        if not cleaned or len(cleaned) > 255:
            raise ValueError('Tag name must contain 1 to 255 characters after trimming')
        return cleaned


class TagUpdate(TagCreate):
    pass


class TagRead(BaseModel):
    id: int
    name: str
    color: Optional[str] = None
    createdAt: datetime
    updatedAt: datetime


class TaskRead(BaseModel):
    id: int
    title: str
    estimatedMinutes: Optional[int]
    priority: Optional[Literal['HIGH', 'MEDIUM', 'LOW']]
    deadline: Optional[date]
    startDate: Optional[date]
    plannedDate: Optional[date]
    plannedStartTime: Optional[time]
    projectId: Optional[int]
    projectName: Optional[str]
    completed: bool
    status: Literal['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED']
    completedAt: Optional[datetime]
    completedEstimateMinutes: Optional[int]
    actualMinutes: int = 0
    differenceMinutes: Optional[int] = None
    actualStartedAt: Optional[datetime] = None
    createdAt: datetime
    updatedAt: datetime
    tags: list[TagRead] = Field(default_factory=list)

    class Config:
        orm_mode = True


class TimeEntryRead(BaseModel):
    id: int
    taskId: int
    projectIdSnapshot: Optional[int]
    startedAt: datetime
    endedAt: Optional[datetime]
    startAt: datetime
    endAt: Optional[datetime]
    durationMinutes: Optional[int]
    createdAt: datetime
    updatedAt: datetime

    class Config:
        orm_mode = True


class TimeStartRequest(BaseModel):
    taskId: int


class ManualTimeEntryUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid')

    taskId: Optional[int] = Field(None, gt=0, strict=True)
    projectIdSnapshot: Optional[int] = Field(None, gt=0, strict=True)
    startedAt: Optional[datetime] = None
    endedAt: Optional[datetime] = None

    @field_validator('taskId')
    @classmethod
    def require_task_id(cls, value):
        if value is None:
            raise ValueError('Taskは必須です')
        return value

    @field_validator('startedAt', 'endedAt')
    @classmethod
    def require_non_null(cls, value):
        if value is None:
            raise ValueError('開始日時・終了日時は必須です')
        if isinstance(value, datetime) and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError('日時にはUTCまたはタイムゾーンを指定してください')
        return value


class ManualTimeEntryCreate(ManualTimeEntryUpdate):
    taskId: int = Field(..., gt=0, strict=True)
    startedAt: datetime
    endedAt: datetime

    @field_validator('projectIdSnapshot')
    @classmethod
    def reject_create_snapshot(cls, value):
        raise ValueError('新規記録のProjectはTaskから取得します')


class TimeStopRequest(BaseModel):
    taskId: int
    # Accept the legacy field while server time determines the stored end.
    endAt: Optional[datetime] = None


class TaskDiffRead(BaseModel):
    taskId: int
    estimatedMinutes: Optional[int]
    actualMinutes: int
    differenceMinutes: Optional[int]


class DailyTaskSummaryRead(BaseModel):
    taskId: int
    title: str
    estimatedMinutes: Optional[int]
    actualMinutes: int
    differenceMinutes: Optional[int]


class DailySummaryRead(BaseModel):
    date: date
    plannedOccupiedMinutes: int
    dailyEstimatedMinutes: int
    dailyActualMinutes: int
    dailyDifference: int
    tasks: list[DailyTaskSummaryRead]


class WeeklySummaryRead(BaseModel):
    weekStart: date
    weekEnd: date
    daily: list[DailySummaryRead]
    weeklyEstimatedMinutes: int
    weeklyPlannedOccupiedMinutes: int
    weeklyActualMinutes: int


class WeekdayTotalRead(BaseModel):
    weekday: int  # Monday = 0 through Sunday = 6, matching date.weekday().
    estimatedMinutes: int
    plannedOccupiedMinutes: int
    actualMinutes: int


class MonthlySummaryRead(BaseModel):
    month: str
    monthStart: date
    monthEnd: date  # Inclusive last date, as with WeeklySummaryRead.weekEnd.
    daily: list[DailySummaryRead]
    monthlyEstimatedMinutes: int
    monthlyPlannedOccupiedMinutes: int
    monthlyActualMinutes: int
    weekdayTotals: list[WeekdayTotalRead]


class ProjectCreate(IdentificationColor):
    name: str

    @validator('name')
    def validate_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError('name must not be empty')
        return cleaned


class ProjectUpdate(IdentificationColor):
    name: str

    @validator('name')
    def validate_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError('name must not be empty')
        return cleaned


class ProjectRead(BaseModel):
    id: int
    name: str
    color: Optional[str] = None
    taskCount: int
    completedCount: int
    estimatedMinutes: int
    actualMinutes: int


ScheduleBlockType = Literal['TIME_UNSET', 'TIMED', 'ALL_DAY']


class ScheduleBlockUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid')

    date: Optional[dt.date] = None
    type: Optional[ScheduleBlockType] = None
    startTime: Optional[dt.time] = None
    durationMinutes: Optional[int] = Field(None, gt=0)

    @field_validator('date', mode='before')
    @classmethod
    def validate_local_date(cls, value):
        if type(value) is dt.date:
            return value
        if isinstance(value, str) and len(value) == 10 and value[4] == '-' and value[7] == '-':
            return value
        raise ValueError('date must be a YYYY-MM-DD local date')

    @field_validator('date')
    @classmethod
    def validate_date_range(cls, value):
        if value is not None and not dt.date(2000, 1, 1) <= value <= dt.date(2100, 12, 31):
            raise ValueError('date must be between 2000-01-01 and 2100-12-31')
        return value

    @field_validator('type')
    @classmethod
    def require_type_when_provided(cls, value):
        if value is None:
            raise ValueError('type must not be null')
        return value

    @field_validator('startTime')
    @classmethod
    def validate_local_time(cls, value):
        if value is not None and value.tzinfo is not None:
            raise ValueError('startTime must be a local time without a timezone')
        return value


class ScheduleBlockCreate(ScheduleBlockUpdate):
    taskId: int = Field(..., gt=0)
    date: dt.date
    type: ScheduleBlockType

    @model_validator(mode='after')
    def validate_type_fields(self):
        if self.type == 'TIMED':
            if self.startTime is None:
                raise ValueError('TIMED requires startTime')
            if self.durationMinutes is None:
                raise ValueError('TIMED requires durationMinutes')
        elif self.startTime is not None or self.durationMinutes is not None:
            raise ValueError('TIME_UNSET and ALL_DAY require null startTime and durationMinutes')
        return self


class ScheduleBlockRead(BaseModel):
    id: int
    taskId: int
    date: dt.date
    type: ScheduleBlockType
    startTime: Optional[dt.time]
    durationMinutes: Optional[int]
    createdAt: datetime
    updatedAt: datetime
