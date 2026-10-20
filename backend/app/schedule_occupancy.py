"""Schedule occupancy in local wall time, independent of estimates and UTC/DST."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date, time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import ScheduleBlock


MINUTE_MICROSECONDS = 60 * 1_000_000
DAY_MICROSECONDS = 1440 * MINUTE_MICROSECONDS


def merge_intervals(intervals: Iterable[tuple[int, int]]) -> list[tuple[int, int]]:
    """Union half-open intervals, including touching boundaries, in input units."""
    merged = []
    for start, end in sorted((start, end) for start, end in intervals if end > start):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def timed_interval_for_day(target_date: date, block: ScheduleBlock) -> tuple[int, int] | None:
    """A valid TIMED block's overlap with a local wall day, in microseconds."""
    if (block.type != 'TIMED' or type(block.duration_minutes) is not int
            or block.duration_minutes <= 0):
        return None
    try:
        block_date = date.fromisoformat(block.date) if isinstance(block.date, str) else block.date
        clock = time.fromisoformat(block.start_time) if isinstance(block.start_time, str) else block.start_time
    except ValueError:
        return None
    if type(block_date) is not date or not isinstance(clock, time) or clock.tzinfo is not None:
        return None
    start = ((block_date - target_date).days * DAY_MICROSECONDS
             + ((clock.hour * 60 + clock.minute) * 60 + clock.second) * 1_000_000
             + clock.microsecond)
    end = start + block.duration_minutes * MINUTE_MICROSECONDS
    lower, upper = max(0, start), min(DAY_MICROSECONDS, end)
    return (lower, upper) if upper > lower else None


def scheduled_task_ids(target_date: date, blocks: Iterable[ScheduleBlock]) -> set[int]:
    """Tasks scheduled on this day, deduplicated across blocks and types."""
    return {
        block.task_id for block in blocks
        if (block.type in {'TIME_UNSET', 'ALL_DAY'}
            and block.date in (target_date, target_date.isoformat()))
        or timed_interval_for_day(target_date, block) is not None
    }


def planned_occupied_minutes(target_date: date, blocks: Iterable[ScheduleBlock]) -> int:
    """Clip TIMED blocks to a local day, union, then floor the total to minutes.

    Integer offsets retain seconds/microseconds and allow arbitrarily long
    durations without constructing a datetime beyond Python's calendar range.
    Malformed fields contribute nothing; no block or persisted value is edited.
    """
    intervals = []
    for block in blocks:
        interval = timed_interval_for_day(target_date, block)
        if interval is not None:
            intervals.append(interval)
    return sum(end - start for start, end in merge_intervals(intervals)) // MINUTE_MICROSECONDS
