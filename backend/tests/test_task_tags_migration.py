"""006 coverage uses invented 005 rows and guarded temporary databases only."""

import hashlib
import os
from pathlib import Path
import subprocess
import sys

import pytest
from sqlalchemy import create_engine, event, inspect
from sqlalchemy.exc import IntegrityError

from app import database
from helpers.revision_003 import build_revision_003_fixture
from migrations.sqlite_task_fields import migrate_sqlite_task_fields
from migrations.sqlite_task_tags import REVISION, migrate_sqlite_task_tags
from migrations.sqlite_v1a import MigrationError


def rows(engine, table):
    with engine.connect() as connection:
        return [dict(row._mapping) for row in connection.exec_driver_sql(f'SELECT * FROM {table} ORDER BY 1, 2')]


@pytest.fixture
def old_database(tmp_path):
    path = tmp_path / 'synthetic-005.db'
    engine = create_engine(f'sqlite:///{path.as_posix()}')
    try:
        build_revision_003_fixture(engine)
        migrate_sqlite_task_fields(engine)
        with engine.begin() as connection:
            connection.exec_driver_sql("UPDATE tasks SET priority='HIGH',deadline='2026-12-31',status='IN_PROGRESS' WHERE id=2")
        yield engine, path
    finally:
        engine.dispose()


def migrate(engine):
    migrate_sqlite_task_tags(engine, allow_pending=True, allow_metadata_pending=True)


def startup(path, approve=False):
    env = {**os.environ, 'DATABASE_URL': f'sqlite:///{path.as_posix()}', 'AUDIT_TEST_DB': str(path), 'PYTHONDONTWRITEBYTECODE': '1'}
    # A remaining 005 approval must never grant permission for 006.
    env['APPLY_TASK_METADATA_MIGRATION'] = '1'
    if approve:
        env['APPLY_TASK_TAGS_MIGRATION'] = '1'
    else:
        env.pop('APPLY_TASK_TAGS_MIGRATION', None)
    code = '''import os
from pathlib import Path
from sqlalchemy import event
from sqlalchemy.engine import Engine
expected = Path(os.environ['AUDIT_TEST_DB']).resolve()
def guard(dialect, record, args, kwargs):
    if dialect.name != 'sqlite' or not args or Path(args[0]).resolve() != expected:
        raise RuntimeError('Only the guarded temporary startup DB may be used.')
event.listen(Engine, 'do_connect', guard)
from app.main import app
from fastapi.testclient import TestClient
with TestClient(app) as client:
    assert client.get('/health').status_code == 200
    response = client.get('/tasks')
    assert response.status_code == 200
    assert all(task['tags'] == [] for task in response.json())
'''
    return subprocess.run([sys.executable, '-B', '-c', code], cwd=Path(database.__file__).parents[1], env=env, capture_output=True, text=True, timeout=30)


def test_005_to_006_keeps_all_old_rows_and_relations(old_database):
    engine, _ = old_database
    names = ('projects', 'tasks', 'schedule_blocks', 'time_entries')
    before = {name: rows(engine, name) for name in names}
    with engine.connect() as connection:
        old_schema = connection.exec_driver_sql("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('projects','tasks','schedule_blocks','time_entries') ORDER BY name").all()
    migrate(engine)
    assert {name: rows(engine, name) for name in names} == before
    with engine.connect() as connection:
        assert connection.exec_driver_sql("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('projects','tasks','schedule_blocks','time_entries') ORDER BY name").all() == old_schema
    assert rows(engine, 'tags') == rows(engine, 'task_tags') == []
    with engine.connect() as connection:
        assert connection.exec_driver_sql('SELECT revision FROM schema_migrations ORDER BY revision').scalars().all() == [
            '003_v1a_schedule_blocks', '004_timer_timeentry_lifecycle_schema', '005_task_priority_deadline', REVISION,
        ]
        assert connection.exec_driver_sql('PRAGMA foreign_key_check').all() == []


def test_rerun_keeps_tag_names_and_associations(old_database):
    engine, path = old_database
    migrate(engine)
    with engine.begin() as connection:
        connection.exec_driver_sql("INSERT INTO tags VALUES (7,'FE','2026-10-07 01:00:00','2026-10-07 01:00:00')")
        connection.exec_driver_sql('INSERT INTO task_tags VALUES (2,7)')
    before = {name: rows(engine, name) for name in inspect(engine).get_table_names()}
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    migrate(engine)
    assert {name: rows(engine, name) for name in before} == before
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest


@pytest.mark.parametrize('failure', ['association', 'revision'])
def test_006_failure_rolls_back_tables_and_history(old_database, failure):
    engine, path = old_database
    before = path.read_bytes()
    def fail(connection, cursor, statement, parameters, context, executemany):
        if (failure == 'association' and statement.startswith('CREATE TABLE task_tags')
                or failure == 'revision' and statement.startswith('INSERT INTO schema_migrations') and parameters[0] == REVISION):
            raise RuntimeError('Injected 006 migration failure')
    event.listen(engine, 'before_cursor_execute', fail)
    try:
        with pytest.raises(RuntimeError, match='Injected 006'):
            migrate(engine)
    finally:
        event.remove(engine, 'before_cursor_execute', fail)
    assert path.read_bytes() == before
    assert not {'tags', 'task_tags'} & set(inspect(engine).get_table_names())


def test_unapproved_006_refuses_auto_reload_and_keeps_005_bytes(old_database):
    engine, path = old_database
    before = path.read_bytes()
    result = startup(path)
    assert result.returncode != 0
    assert 'APPLY_TASK_TAGS_MIGRATION=1' in result.stderr
    assert path.read_bytes() == before
    assert not {'tags', 'task_tags'} & set(inspect(engine).get_table_names())
    with pytest.raises(MigrationError, match='006 is pending'):
        migrate_sqlite_task_tags(engine)
    assert path.read_bytes() == before


def test_approved_temporary_startup_and_normal_006_restart(old_database):
    _, path = old_database
    first = startup(path, approve=True)
    assert first.returncode == 0, first.stderr
    before = path.read_bytes()
    second = startup(path)
    assert second.returncode == 0, second.stderr
    assert path.read_bytes() == before


@pytest.mark.parametrize('metadata_first', [False, True])
def test_fresh_and_empty_orm_schema_are_supported(tmp_path, metadata_first):
    engine = create_engine(f'sqlite:///{(tmp_path / "fresh.db").as_posix()}')
    try:
        if metadata_first:
            database.Base.metadata.create_all(engine)
        migrate(engine)
        assert {'tags', 'task_tags'}.issubset(inspect(engine).get_table_names())
        assert inspect(engine).get_pk_constraint('task_tags')['constrained_columns'] == ['task_id', 'tag_id']
        assert rows(engine, 'tags') == rows(engine, 'task_tags') == []
    finally:
        engine.dispose()


def test_006_fk_and_duplicate_association_constraints(old_database):
    engine, _ = old_database
    migrate(engine)
    with engine.connect() as connection:
        connection.exec_driver_sql('PRAGMA foreign_keys=ON'); connection.commit()
        connection.exec_driver_sql("INSERT INTO tags VALUES (7,'FE','2026-10-07','2026-10-07')")
        connection.exec_driver_sql('INSERT INTO task_tags VALUES (2,7)'); connection.commit()
        for values in ((2,7), (999,7), (2,999)):
            with pytest.raises(IntegrityError):
                connection.exec_driver_sql('INSERT INTO task_tags VALUES (?,?)', values)
            connection.rollback()
        connection.exec_driver_sql('DELETE FROM tasks WHERE id=2'); connection.commit()
        assert connection.exec_driver_sql('SELECT count(*) FROM task_tags').scalar_one() == 0
        assert connection.exec_driver_sql('SELECT count(*) FROM tags').scalar_one() == 1
        connection.exec_driver_sql('INSERT INTO task_tags VALUES (5,7)'); connection.commit()
        connection.exec_driver_sql('DELETE FROM tags WHERE id=7'); connection.commit()
        assert connection.exec_driver_sql('SELECT count(*) FROM task_tags').scalar_one() == 0
        assert connection.exec_driver_sql('SELECT count(*) FROM tasks WHERE id=5').scalar_one() == 1


def test_unrecorded_nonempty_tag_schema_is_not_adopted(old_database):
    engine, _ = old_database
    migrate(engine)
    with engine.begin() as connection:
        connection.exec_driver_sql("INSERT INTO tags VALUES (7,'FE','2026-10-07','2026-10-07')")
        connection.exec_driver_sql('DELETE FROM schema_migrations WHERE revision=?', (REVISION,))
    before = rows(engine, 'tags')
    with pytest.raises(MigrationError, match='manual review'):
        migrate(engine)
    assert rows(engine, 'tags') == before
