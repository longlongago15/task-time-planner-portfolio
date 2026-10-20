import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect
from sqlalchemy.exc import IntegrityError

from app import database
from migrations.sqlite_timer_schema import migrate_sqlite_latest
from migrations.sqlite_task_fields import REVISION, migrate_sqlite_task_fields
from migrations import sqlite_task_fields
from tests.helpers.revision_003 import build_revision_003_fixture


def rows(engine, table):
    with engine.connect() as connection:
        return [dict(row._mapping) for row in connection.exec_driver_sql(f'SELECT * FROM {table} ORDER BY id')]


def test_004_app_startup_adds_nullable_fields_preserves_all_data(tmp_path):
    path = tmp_path / 'old-schema.db'
    engine = create_engine(f'sqlite:///{path.as_posix()}')
    try:
        build_revision_003_fixture(engine)
        migrate_sqlite_latest(engine)
        before = {table: rows(engine, table) for table in ('projects', 'tasks', 'schedule_blocks', 'time_entries')}
        assert 'priority' not in {c['name'] for c in inspect(engine).get_columns('tasks')}
        # Import-time migration runs on this isolated database, exactly as application startup does.
        env = {**os.environ, 'DATABASE_URL': f'sqlite:///{path.as_posix()}', 'APPLY_TASK_METADATA_MIGRATION': '1', 'PYTHONDONTWRITEBYTECODE': '1'}
        result = subprocess.run([sys.executable, '-B', '-c', 'from app.main import app'], cwd=Path(database.__file__).parents[1], env=env, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        for table, previous in before.items():
            after = rows(engine, table)
            assert len(previous) == len(after)
            if table == 'tasks':
                for old, new in zip(previous, after):
                    assert {key: new[key] for key in old} == old
                    assert new['priority'] is None and new['deadline'] is None
            else:
                assert [{key: row[key] for key in old} for old, row in zip(previous, after)] == previous
                if table == 'projects':
                    assert all(row['color'] is None for row in after)
        with engine.connect() as connection:
            assert REVISION in connection.exec_driver_sql('SELECT revision FROM schema_migrations').scalars().all()
            assert connection.exec_driver_sql('PRAGMA foreign_key_check').all() == []
        migrated = rows(engine, 'tasks')
        with engine.begin() as connection:
            connection.exec_driver_sql("UPDATE tasks SET priority='HIGH',deadline='2026-10-12' WHERE id=1")
        saved = rows(engine, 'tasks')
        migrate_sqlite_task_fields(engine)
        assert rows(engine, 'tasks') == saved
        assert len(migrated) == len(saved)
    finally:
        engine.dispose()


def test_005_failure_rolls_back_both_columns_and_revision(tmp_path, monkeypatch):
    engine = create_engine(f'sqlite:///{(tmp_path / "rollback.db").as_posix()}')
    try:
        build_revision_003_fixture(engine)
        migrate_sqlite_latest(engine)
        before = rows(engine, 'tasks')
        def fail_record(connection, revision):
            raise RuntimeError('Injected revision recording failure')
        monkeypatch.setattr(sqlite_task_fields, '_record', fail_record)
        with pytest.raises(RuntimeError, match='Injected'):
            migrate_sqlite_task_fields(engine)
        assert rows(engine, 'tasks') == before
        assert not {'priority', 'deadline'} & {c['name'] for c in inspect(engine).get_columns('tasks')}
        with engine.connect() as connection:
            assert REVISION not in connection.exec_driver_sql('SELECT revision FROM schema_migrations').scalars().all()
    finally:
        engine.dispose()


def test_app_startup_refuses_pending_005_without_explicit_approval(tmp_path):
    path = tmp_path / 'approval-guard.db'
    engine = create_engine(f'sqlite:///{path.as_posix()}')
    try:
        build_revision_003_fixture(engine)
        migrate_sqlite_latest(engine)
        before = path.read_bytes()
        env = {**os.environ, 'DATABASE_URL': f'sqlite:///{path.as_posix()}', 'PYTHONDONTWRITEBYTECODE': '1'}
        env.pop('APPLY_TASK_METADATA_MIGRATION', None)
        result = subprocess.run([sys.executable, '-B', '-c', 'from app.main import app'], cwd=Path(database.__file__).parents[1], env=env, capture_output=True, text=True)
        assert result.returncode != 0
        assert 'APPLY_TASK_METADATA_MIGRATION=1' in result.stderr
        assert path.read_bytes() == before
    finally:
        engine.dispose()


@pytest.mark.parametrize('metadata_first', [False, True])
def test_fresh_database_and_priority_constraint(tmp_path, metadata_first):
    engine = create_engine(f'sqlite:///{(tmp_path / "fresh.db").as_posix()}')
    try:
        if metadata_first:
            database.Base.metadata.create_all(engine)
        migrate_sqlite_task_fields(engine)
        for table in ('schedule_blocks', 'time_entries'):
            assert not {'priority', 'deadline'} & {column['name'] for column in inspect(engine).get_columns(table)}
        with engine.begin() as connection:
            connection.exec_driver_sql("INSERT INTO tasks(title,completed,created_at,updated_at) VALUES('Task',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
            for value in ('HIGH', 'MEDIUM', 'LOW', None):
                connection.exec_driver_sql('UPDATE tasks SET priority=?', (value,))
        with pytest.raises(IntegrityError), engine.begin() as connection:
            connection.exec_driver_sql("UPDATE tasks SET priority='URGENT'")
    finally:
        engine.dispose()
