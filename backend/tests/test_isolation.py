"""Regression coverage for import-time and per-test isolation."""

from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import sqlite3

import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import URL, make_url

from app import database, main
from app.models import Project, Task, TimeEntry


def test_application_import_used_temporary_database(bootstrap_database_path, SessionLocal, tmp_path):
    assert Path(make_url(os.environ['DATABASE_URL']).database).resolve() == bootstrap_database_path
    assert bootstrap_database_path.exists()
    assert bootstrap_database_path.name == 'bootstrap.db'
    with SessionLocal() as session:
        assert Path(session.get_bind().url.database).resolve() == tmp_path.resolve() / 'api.db'
        assert session.get_bind() is database.engine
        assert session.get_bind() is main.engine


@pytest.mark.parametrize('attempt', [1, 2])
def test_each_test_starts_empty_and_can_leave_data_and_timer(client, SessionLocal, attempt):
    # Intentionally leave committed rows and a running timer for fixture teardown.
    with SessionLocal() as session:
        assert session.query(Project).count() == 0
        assert session.query(Task).count() == 0
        assert session.query(TimeEntry).count() == 0
    assert client.get('/tasks/time/active').json()['running'] is False
    project = client.post('/projects', json={'name': f'Isolation {attempt}'})
    assert project.status_code == 200
    task = client.post('/tasks', json={
        'title': 'Left behind intentionally', 'estimatedMinutes': 60,
        'projectId': project.json()['id'],
    })
    assert task.status_code == 201
    task_id = task.json()['id']
    assert client.post('/tasks/time/start', json={'taskId': task_id}).status_code == 200
    stopped = client.post('/tasks/time/stop', json={
        'taskId': task_id,
        'endAt': (datetime.now(timezone.utc) + timedelta(minutes=2)).isoformat(),
    })
    assert stopped.status_code == 200
    assert client.post('/tasks/time/start', json={'taskId': task_id}).status_code == 200
    with SessionLocal() as session:
        assert session.query(Project).count() == 1
        assert session.query(Task).count() == 1
        assert session.query(TimeEntry).count() == 2
        assert session.query(TimeEntry).filter(TimeEntry.ended_at.is_(None)).count() == 1
    assert client.get('/tasks/time/active').json()['running'] is True


def test_connection_outside_test_directory_is_blocked(tmp_path):
    forbidden_path = tmp_path.parent / 'not-a-test-database.db'
    engine = create_engine(URL.create('sqlite', database=str(forbidden_path)))
    try:
        with pytest.raises(RuntimeError, match='outside the test temporary directories'):
            with engine.connect():
                pytest.fail('An outside database connection was allowed.')
        assert not forbidden_path.exists()
    finally:
        engine.dispose()


@pytest.mark.parametrize('location', ['root', 'backend', 'backup'])
def test_project_database_file_reads_are_blocked(location):
    backend = Path(database.__file__).resolve().parents[1]
    path = {
        'root': backend.parent / 'tasks.db',
        'backend': backend / 'tasks.db',
        'backup': backend / 'tasks_before_004_apply.db',
    }[location]
    # This raises before the file opens, regardless of existence or revision.
    with pytest.raises(RuntimeError, match='Project database file access is forbidden'):
        path.read_bytes()


@pytest.mark.parametrize('uri', [False, True])
def test_direct_project_sqlite_connection_is_blocked(uri):
    path = Path(database.__file__).resolve().parents[1] / 'tasks.db'
    target = path.as_uri() + '?mode=ro' if uri else str(path)
    with pytest.raises(RuntimeError, match='Project database file access is forbidden'):
        sqlite3.connect(target, uri=uri)


def test_sqlalchemy_project_database_connection_is_blocked():
    path = Path(database.__file__).resolve().parents[1] / 'tasks.db'
    engine = create_engine(URL.create('sqlite', database=str(path)))
    try:
        with pytest.raises(RuntimeError, match='outside the test temporary directories'):
            engine.connect()
    finally:
        engine.dispose()
