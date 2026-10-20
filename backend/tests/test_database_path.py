"""Check URL resolution without connecting to either normal database."""

from pathlib import Path
import runpy

import pytest
from sqlalchemy.engine import URL, make_url

from app import database


DATABASE_MODULE = Path(database.__file__).resolve()
BACKEND_DIRECTORY = DATABASE_MODULE.parents[1]


def load_database_configuration():
    # database.py creates a lazy engine; main.py is never loaded by this helper.
    namespace = runpy.run_path(str(DATABASE_MODULE))
    engine = namespace['engine']
    try:
        connection_args, _ = engine.dialect.create_connect_args(engine.url)
        return namespace['SQLALCHEMY_DATABASE_URL'], connection_args[0]
    finally:
        engine.dispose()


def test_unset_url_uses_backend_database(monkeypatch):
    monkeypatch.delenv('DATABASE_URL', raising=False)
    url, connection_path = load_database_configuration()
    expected = BACKEND_DIRECTORY / 'tasks.db'
    assert Path(make_url(url).database) == expected
    assert Path(connection_path) == expected
    assert expected.is_absolute()


@pytest.mark.parametrize('configured_url', [
    'mysql+pymysql://task_user:example@localhost/task_management',
    'sqlite:///./explicit.db',
])
def test_explicit_url_has_priority(monkeypatch, configured_url):
    monkeypatch.setenv('DATABASE_URL', configured_url)
    assert database.get_database_url() == configured_url


def test_explicit_sqlite_engine_uses_requested_path(monkeypatch, tmp_path):
    expected = tmp_path / 'explicit.db'
    configured_url = URL.create('sqlite', database=str(expected)).render_as_string(hide_password=False)
    monkeypatch.setenv('DATABASE_URL', configured_url)
    url, connection_path = load_database_configuration()
    assert url == configured_url
    assert Path(connection_path) == expected
    assert not expected.exists()


def test_working_directory_does_not_change_default(monkeypatch, tmp_path):
    monkeypatch.delenv('DATABASE_URL', raising=False)
    resolved = []
    for directory in (BACKEND_DIRECTORY.parent, BACKEND_DIRECTORY, tmp_path):
        monkeypatch.chdir(directory)
        resolved.append(load_database_configuration())
    assert resolved[0] == resolved[1] == resolved[2]
    assert Path(resolved[0][1]) == BACKEND_DIRECTORY / 'tasks.db'
    assert not (tmp_path / 'tasks.db').exists()


def test_relocated_module_uses_its_own_backend(monkeypatch, tmp_path):
    monkeypatch.delenv('DATABASE_URL', raising=False)
    relocated = tmp_path / 'moved-project' / 'backend' / 'app' / 'database.py'
    relocated.parent.mkdir(parents=True)
    relocated.write_bytes(DATABASE_MODULE.read_bytes())
    namespace = runpy.run_path(str(relocated))
    try:
        expected = relocated.parents[1] / 'tasks.db'
        assert Path(namespace['engine'].url.database) == expected
        assert not expected.exists()
    finally:
        namespace['engine'].dispose()


def test_step_one_isolation_overrides_default(bootstrap_database_path, SessionLocal, tmp_path):
    assert Path(make_url(database.get_database_url()).database) == bootstrap_database_path
    assert Path(make_url(database.SQLALCHEMY_DATABASE_URL).database) == bootstrap_database_path
    with SessionLocal() as session:
        assert Path(session.get_bind().url.database) == tmp_path / 'api.db'
        databases = {
            name: filename
            for _, name, filename in session.connection().exec_driver_sql('PRAGMA database_list')
        }
        assert Path(databases['main']) == tmp_path / 'api.db'
