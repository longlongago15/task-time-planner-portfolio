"""007 only uses synthetic databases inside conftest-guarded test directories."""
import os
from pathlib import Path
import subprocess
import sys

import pytest
from sqlalchemy import create_engine, event, inspect

from app import database
from helpers.revision_003 import build_revision_003_fixture
from migrations.sqlite_task_tags import migrate_sqlite_task_tags
from migrations.sqlite_project_tag_colors import REVISION, migrate_sqlite_project_tag_colors
from migrations.sqlite_v1a import MigrationError


def migrate(engine):
    migrate_sqlite_project_tag_colors(engine, allow_pending=True, allow_tags_pending=True, allow_metadata_pending=True)


def rows(engine):
    with engine.connect() as connection:
        return {table: [dict(row._mapping) for row in connection.exec_driver_sql(f'SELECT * FROM {table} ORDER BY 1')]
                for table in ('projects', 'tasks', 'schedule_blocks', 'time_entries', 'tags', 'task_tags')}


@pytest.fixture
def source(tmp_path):
    path = tmp_path / 'synthetic-006.db'
    engine = create_engine(f'sqlite:///{path.as_posix()}')
    build_revision_003_fixture(engine)
    migrate_sqlite_task_tags(engine, allow_pending=True, allow_metadata_pending=True)
    with engine.begin() as connection:
        for index, name in enumerate(('FE', 'AWS', '復習'), 1):
            connection.exec_driver_sql('INSERT INTO tags VALUES (?, ?, ?, ?)', (index, name, '2026-10-07', '2026-10-07'))
        connection.exec_driver_sql('INSERT INTO task_tags VALUES (2,1),(2,2),(5,1),(11,3)')
    try:
        yield engine, path
    finally:
        engine.dispose()


def test_006_to_007_only_adds_null_columns_and_preserves_all_data(source):
    engine, path = source
    before = rows(engine)
    with engine.connect() as connection:
        schema = connection.exec_driver_sql("SELECT name,sql FROM sqlite_master WHERE type IN ('index','trigger') ORDER BY name").all()
    migrate(engine)
    after = rows(engine)
    for table, previous in before.items():
        assert len(after[table]) == len(previous)
        assert [{key: new[key] for key in old} for old, new in zip(previous, after[table])] == previous
    for table in ('projects', 'tags'):
        assert all(row['color'] is None for row in after[table])
        color = next(c for c in inspect(engine).get_columns(table) if c['name'] == 'color')
        assert color['nullable'] and color['default'] is None
    with engine.connect() as connection:
        assert connection.exec_driver_sql("SELECT name,sql FROM sqlite_master WHERE type IN ('index','trigger') ORDER BY name").all() == schema
        assert connection.exec_driver_sql('PRAGMA foreign_key_check').all() == []
        assert connection.exec_driver_sql('SELECT revision FROM schema_migrations ORDER BY revision DESC LIMIT 1').scalar_one() == REVISION
    with engine.begin() as connection:
        connection.exec_driver_sql("UPDATE projects SET color='#FFFFFF' WHERE id=1")
        connection.exec_driver_sql("UPDATE tags SET color='#A079BE' WHERE id=1")
    saved, digest = rows(engine), path.read_bytes()
    migrate_sqlite_project_tag_colors(engine)
    assert rows(engine) == saved and path.read_bytes() == digest


@pytest.mark.parametrize('phase', ['second_column', 'history'])
def test_failure_rolls_back_both_columns_atomically(source, phase):
    engine, path = source
    before = path.read_bytes()
    def fail(connection, cursor, statement, parameters, context, executemany):
        if (phase == 'second_column' and statement.startswith('ALTER TABLE tags ADD COLUMN color')
                or phase == 'history' and statement.startswith('INSERT INTO schema_migrations') and parameters[0] == REVISION):
            raise RuntimeError('Injected 007 failure')
    event.listen(engine, 'before_cursor_execute', fail)
    try:
        with pytest.raises(RuntimeError, match='Injected 007'):
            migrate(engine)
    finally:
        event.remove(engine, 'before_cursor_execute', fail)
    assert path.read_bytes() == before
    assert all('color' not in {c['name'] for c in inspect(engine).get_columns(table)} for table in ('projects', 'tags'))


def startup(path, approved):
    env = {**os.environ, 'DATABASE_URL': f'sqlite:///{path.as_posix()}', 'AUDIT_TEST_DB': str(path), 'PYTHONDONTWRITEBYTECODE': '1'}
    if approved:
        env['APPLY_PROJECT_TAG_COLORS_MIGRATION'] = '1'
    else:
        env.pop('APPLY_PROJECT_TAG_COLORS_MIGRATION', None)
    code = '''import os
from pathlib import Path
from sqlalchemy import event
from sqlalchemy.engine import Engine
expected = Path(os.environ['AUDIT_TEST_DB']).resolve()
def guard(dialect, record, args, kwargs):
    if dialect.name != 'sqlite' or not args or Path(args[0]).resolve() != expected:
        raise RuntimeError('Only guarded synthetic DB may be used')
event.listen(Engine, 'do_connect', guard)
from app.main import app
from fastapi.testclient import TestClient
with TestClient(app) as client:
    assert client.get('/projects').status_code == 200
    assert client.get('/tags').status_code == 200
'''
    return subprocess.run([sys.executable, '-B', '-c', code], cwd=Path(database.__file__).parents[1], env=env, capture_output=True, text=True, timeout=30)


def test_unapproved_startup_and_repeated_reload_leave_006_bytes_unchanged(source):
    engine, path = source
    before = path.read_bytes()
    for _ in range(2):
        result = startup(path, False)
        assert result.returncode != 0 and 'APPLY_PROJECT_TAG_COLORS_MIGRATION=1' in result.stderr
        assert path.read_bytes() == before
    with pytest.raises(MigrationError, match='007_project_tag_colors is pending'):
        migrate_sqlite_project_tag_colors(engine, allow_tags_pending=True, allow_metadata_pending=True)
    assert path.read_bytes() == before


def test_approved_test_startup_then_restart_without_approval(source):
    _, path = source
    first = startup(path, True)
    assert first.returncode == 0, first.stderr
    before = path.read_bytes()
    second = startup(path, False)
    assert second.returncode == 0, second.stderr
    assert path.read_bytes() == before


@pytest.mark.parametrize('orm_first', [False, True])
def test_fresh_and_empty_orm_schema(tmp_path, orm_first):
    engine = create_engine(f'sqlite:///{(tmp_path / "fresh.db").as_posix()}')
    try:
        if orm_first:
            database.Base.metadata.create_all(engine)
        migrate(engine)
        with engine.connect() as connection:
            assert REVISION in set(connection.exec_driver_sql('SELECT revision FROM schema_migrations').scalars())
        assert rows(engine) == {table: [] for table in rows(engine)}
    finally:
        engine.dispose()
