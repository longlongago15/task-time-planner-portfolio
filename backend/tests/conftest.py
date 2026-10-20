"""Isolate database initialization before any application module is imported."""

import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from urllib.parse import unquote, urlsplit

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine, URL
from sqlalchemy.orm import sessionmaker

# A late replacement cannot undo an import-time migration. Fail instead.
if 'app.database' in sys.modules or 'app.main' in sys.modules:
    raise pytest.UsageError('Application modules were imported before test DB isolation.')

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
_original_database_url = os.environ.get('DATABASE_URL')
_database_setting_names = (
    'DB_BACKEND', 'APP_ENV', 'DB_ENV', 'DB_EXPECTED_HOST',
    'DB_EXPECTED_PORT', 'DB_EXPECTED_NAME', 'MYSQL_SSL_CA',
)
_original_database_settings = {name: os.environ.get(name) for name in _database_setting_names}
_original_task_migration_approval = os.environ.get('APPLY_TASK_METADATA_MIGRATION')
_original_tag_migration_approval = os.environ.get('APPLY_TASK_TAGS_MIGRATION')
_original_color_migration_approval = os.environ.get('APPLY_PROJECT_TAG_COLORS_MIGRATION')
_original_period_migration_approval = os.environ.get('APPLY_TASK_PERIOD_MIGRATION')
_bootstrap_directory = TemporaryDirectory(prefix='task-tests-bootstrap-')
_bootstrap_path = Path(_bootstrap_directory.name).resolve() / 'bootstrap.db'
_bootstrap_url = URL.create('sqlite', database=str(_bootstrap_path)).render_as_string(hide_password=False)
_allowed_directories = {Path(_bootstrap_directory.name).resolve()}
os.environ['DATABASE_URL'] = _bootstrap_url
os.environ.update(DB_BACKEND='sqlite', APP_ENV='test', DB_ENV='test')
for _name in _database_setting_names[3:]:
    os.environ.pop(_name, None)
os.environ['APPLY_TASK_METADATA_MIGRATION'] = '1'  # Only the isolated test DB may migrate.
os.environ['APPLY_TASK_TAGS_MIGRATION'] = '1'  # Separate 006 approval, exclusively for this isolated DB.
os.environ['APPLY_PROJECT_TAG_COLORS_MIGRATION'] = '1'  # Only the guarded temporary DB.
os.environ['APPLY_TASK_PERIOD_MIGRATION'] = '1'  # Only the guarded temporary DB.

# SQLAlchemy's connection guard does not cover Path.read_bytes(), open(), or a
# direct sqlite3 connection. Deny these before collection/import as well, so a
# developer database (or recovery backup) can never become a test input.
_backend_directory = Path(__file__).resolve().parents[1]
_project_db_directories = {_backend_directory, _backend_directory.parent}
_file_guard_enabled = True


def _deny_project_database_files(event_name, arguments):
    if not _file_guard_enabled or event_name not in {'open', 'sqlite3.connect'}:
        return
    filename = arguments[0]
    if isinstance(filename, int):  # Already-open file descriptors, not paths.
        return
    filename = os.fsdecode(filename)
    if filename.startswith('file:'):
        filename = unquote(urlsplit(filename).path)
        if len(filename) > 2 and filename[0] == '/' and filename[2] == ':':
            filename = filename[1:]  # file:///C:/... on Windows.
    path = Path(filename).resolve()
    if path.suffix.lower() == '.db' and path.parent in _project_db_directories:
        raise RuntimeError('Project database file access is forbidden during tests.')


sys.addaudithook(_deny_project_database_files)


def _allow_only_test_databases(dialect, connection_record, connection_args, connection_kwargs):
    if dialect.name != 'sqlite' or not connection_args:
        raise RuntimeError('Tests may connect only to temporary SQLite databases.')
    database_path = Path(connection_args[0]).resolve()
    if not any(database_path.is_relative_to(directory) for directory in _allowed_directories):
        raise RuntimeError('Database connection outside the test temporary directories was blocked.')


event.listen(Engine, 'do_connect', _allow_only_test_databases)

# main.py runs migrate_schema here, exclusively on bootstrap.db.
from app import database, main  # noqa: E402
from app.models import Project, ScheduleBlock, Task, TimeEntry  # noqa: E402

_bootstrap_engine = database.engine


def pytest_unconfigure(config):
    global _file_guard_enabled
    _bootstrap_engine.dispose()
    event.remove(Engine, 'do_connect', _allow_only_test_databases)
    if _original_database_url is None:
        os.environ.pop('DATABASE_URL', None)
    else:
        os.environ['DATABASE_URL'] = _original_database_url
    for name, value in _original_database_settings.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
    _bootstrap_directory.cleanup()
    if _original_task_migration_approval is None:
        os.environ.pop('APPLY_TASK_METADATA_MIGRATION', None)
    else:
        os.environ['APPLY_TASK_METADATA_MIGRATION'] = _original_task_migration_approval
    if _original_tag_migration_approval is None:
        os.environ.pop('APPLY_TASK_TAGS_MIGRATION', None)
    else:
        os.environ['APPLY_TASK_TAGS_MIGRATION'] = _original_tag_migration_approval
    # Audit hooks cannot be removed; deactivate this one after the test session.
    if _original_color_migration_approval is None:
        os.environ.pop('APPLY_PROJECT_TAG_COLORS_MIGRATION', None)
    else:
        os.environ['APPLY_PROJECT_TAG_COLORS_MIGRATION'] = _original_color_migration_approval
    _file_guard_enabled = False
    if _original_period_migration_approval is None:
        os.environ.pop('APPLY_TASK_PERIOD_MIGRATION', None)
    else:
        os.environ['APPLY_TASK_PERIOD_MIGRATION'] = _original_period_migration_approval


@pytest.fixture(autouse=True)
def isolated_database(tmp_path, monkeypatch):
    directory = tmp_path.resolve()
    _allowed_directories.add(directory)
    engine = create_engine(
        URL.create('sqlite', database=str(directory / 'api.db')),
        connect_args={'check_same_thread': False},
    )
    factory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    try:
        database.Base.metadata.create_all(bind=engine)
        monkeypatch.setattr(database, 'engine', engine)
        monkeypatch.setattr(database, 'SessionLocal', factory)
        monkeypatch.setattr(main, 'engine', engine)
        monkeypatch.setattr(main, 'SessionLocal', factory)
        with factory() as session:
            assert all(session.query(model).count() == 0 for model in (Project, Task, TimeEntry, ScheduleBlock))
        yield factory
    finally:
        engine.dispose()
        _allowed_directories.discard(directory)


@pytest.fixture
def client(isolated_database):
    with TestClient(main.app) as test_client:
        yield test_client


@pytest.fixture(name='SessionLocal')
def session_factory(isolated_database):
    return isolated_database


@pytest.fixture
def bootstrap_database_path():
    return _bootstrap_path
