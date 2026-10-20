"""Phase 0 checks: temporary SQLite only; MySQL uses lazy engines/mocked drivers."""

import os
from pathlib import Path
import ssl
import subprocess
import sys
import traceback

import pytest
from sqlalchemy.engine import URL

from app import database


BACKEND_DIRECTORY = Path(database.__file__).resolve().parents[1]
SETTING_NAMES = (
    'DATABASE_URL', 'DB_BACKEND', 'APP_ENV', 'DB_ENV',
    'DB_EXPECTED_HOST', 'DB_EXPECTED_PORT', 'DB_EXPECTED_NAME', 'MYSQL_SSL_CA',
)
PASSWORD = 'phase0-only:test@/password'
MYSQL_URL = URL.create(
    'mysql+pymysql', username='phase0_test', password=PASSWORD,
    host='dev-db.example.invalid', port=3306, database='task_development',
).render_as_string(hide_password=False)
MYSQL_SETTINGS = {
    'DATABASE_URL': MYSQL_URL, 'DB_BACKEND': 'mysql',
    'APP_ENV': 'development', 'DB_ENV': 'development',
    'DB_EXPECTED_HOST': 'dev-db.example.invalid', 'DB_EXPECTED_NAME': 'task_development',
}


@pytest.fixture
def configure(monkeypatch):
    def apply(settings=None):
        for name in SETTING_NAMES:
            monkeypatch.delenv(name, raising=False)
        for name, value in (settings or {}).items():
            monkeypatch.setenv(name, value)
    return apply


def test_unconfigured_engine_keeps_original_sqlite_path_without_opening_it(configure):
    configure()
    engine = database.create_database_engine()
    try:
        assert engine.dialect.name == 'sqlite'
        assert Path(engine.url.database) == BACKEND_DIRECTORY / 'tasks.db'
        assert engine.pool.checkedout() == 0
    finally:
        engine.dispose()


@pytest.mark.parametrize('settings', [
    {'DB_BACKEND': 'mysql'},
    {'DATABASE_URL': ''},
    {'DATABASE_URL': '   '},
    {'DB_BACKEND': 'unknown'},
    {'DB_BACKEND': 'mysql', 'DATABASE_URL': 'sqlite:///wrong.db'},
    {'DATABASE_URL': MYSQL_URL, 'DB_BACKEND': 'sqlite'},
    {'DATABASE_URL': MYSQL_URL},
    {'APP_ENV': 'production'},
    {'APP_ENV': 'unknown'},
    {'APP_ENV': 'development', 'DB_ENV': 'production'},
    {'DATABASE_URL': 'postgresql://example.invalid/test'},
])
def test_incomplete_or_conflicting_configuration_stops_before_engine_creation(configure, monkeypatch, settings):
    configure(settings)
    monkeypatch.setattr(database, 'create_engine', lambda *a, **k: pytest.fail('Invalid configuration reached create_engine'))
    with pytest.raises(database.DatabaseConfigurationError):
        database.create_database_engine()


@pytest.mark.parametrize('changes,removed', [
    ({}, 'APP_ENV'),
    ({}, 'DB_ENV'),
    ({}, 'DB_EXPECTED_HOST'),
    ({}, 'DB_EXPECTED_NAME'),
    ({'DB_ENV': 'production'}, None),
    ({'DB_EXPECTED_HOST': 'production-db.example.invalid'}, None),
    ({'DB_EXPECTED_NAME': 'task_production'}, None),
    ({'DB_EXPECTED_PORT': '3307'}, None),
    ({'DB_EXPECTED_PORT': 'invalid'}, None),
    ({'DB_EXPECTED_PORT': '0'}, None),
    ({'DB_EXPECTED_PORT': '65536'}, None),
    ({'DATABASE_URL': 'mysql+pymysql://user@dev-db.example.invalid/task_development'}, None),
    ({'DATABASE_URL': 'mysql+pymysql://user:example@/task_development'}, None),
    ({'DATABASE_URL': 'mysql+pymysql://user:example@dev-db.example.invalid'}, None),
    ({'DATABASE_URL': 'mysql+mysqldb://user:example@dev-db.example.invalid/task_development'}, None),
    ({'DATABASE_URL': MYSQL_URL + '?host=production-db.example.invalid'}, None),
    ({'DATABASE_URL': MYSQL_URL + '?ssl_disabled=true'}, None),
    ({'DATABASE_URL': MYSQL_URL + '?read_default_file=other.ini'}, None),
    ({'DATABASE_URL': MYSQL_URL + '?charset=latin1'}, None),
])
def test_mysql_validates_environment_endpoint_credentials_and_query(configure, monkeypatch, changes, removed):
    settings = {**MYSQL_SETTINGS, **changes}
    if removed:
        settings.pop(removed)
    configure(settings)
    monkeypatch.setattr(database, 'create_engine', lambda *a, **k: pytest.fail('Invalid configuration reached create_engine'))
    with pytest.raises(database.DatabaseConfigurationError):
        database.create_database_engine()


def test_mysql_engine_is_lazy_and_uses_verified_tls_without_logging_password(configure, monkeypatch, caplog):
    configure({**MYSQL_SETTINGS, 'DATABASE_URL': MYSQL_URL + '?charset=utf8mb4'})
    captured = {}
    create_engine = database.create_engine

    def capture(url, **options):
        captured.update(options)
        return create_engine(url, **options)

    monkeypatch.setattr(database, 'create_engine', capture)
    engine = database.create_database_engine()
    try:
        assert engine.dialect.name == 'mysql'
        assert engine.url.password == PASSWORD
        assert engine.pool.checkedout() == 0
        assert captured['hide_parameters'] is True
        assert captured['pool_pre_ping'] is True
        assert captured['connect_args']['connect_timeout'] == 10
        tls = captured['connect_args']['ssl']
        assert tls.verify_mode == ssl.CERT_REQUIRED
        assert tls.check_hostname is True
        assert PASSWORD not in str(engine.url) + repr(engine.url) + caplog.text
    finally:
        engine.dispose()


@pytest.mark.parametrize('source', ['url', 'engine', 'certificate'])
def test_configuration_errors_do_not_expose_password_or_original_traceback(configure, monkeypatch, tmp_path, source):
    settings = dict(MYSQL_SETTINGS)
    if source == 'url':
        settings['DATABASE_URL'] = MYSQL_URL.replace(':3306/', ':invalid-port/')
    elif source == 'engine':
        def fail(*args, **kwargs):
            raise ValueError(PASSWORD + MYSQL_URL)
        monkeypatch.setattr(database, 'create_engine', fail)
    else:
        settings['MYSQL_SSL_CA'] = str(tmp_path / 'missing-ca.pem')
    configure(settings)
    with pytest.raises(database.DatabaseConfigurationError) as failure:
        database.create_database_engine()
    rendered = ''.join(traceback.format_exception(failure.value))
    assert PASSWORD not in rendered
    assert MYSQL_URL not in rendered
    assert failure.value.__suppress_context__ is True


def run_mysql_child(script, environment='development'):
    # No credentials inherited from the developer environment. All database
    # operations in these children are forbidden or mocked before app import.
    child_env = {name: value for name, value in os.environ.items() if name not in SETTING_NAMES}
    child_env.update(MYSQL_SETTINGS, APP_ENV=environment, DB_ENV=environment, PYTHONDONTWRITEBYTECODE='1')
    return subprocess.run(
        [sys.executable, '-B', '-c', script], cwd=BACKEND_DIRECTORY,
        env=child_env, capture_output=True, text=True, timeout=30,
    )


@pytest.mark.parametrize('environment', ['development', 'test', 'production'])
def test_mysql_import_and_application_startup_do_not_connect_or_change_schema(environment):
    result = run_mysql_child(r'''
from unittest.mock import patch
from sqlalchemy import event
from sqlalchemy.engine import Engine
from fastapi.testclient import TestClient

attempts = []
@event.listens_for(Engine, 'do_connect')
def deny_connection(*args, **kwargs):
    attempts.append('connection')
    raise AssertionError('No DB connections are allowed in this test')

from app import database
assert database.engine.dialect.name == 'mysql'
with patch.object(database.Base.metadata, 'create_all', side_effect=AssertionError('Unexpected DDL')) as ddl:
    with patch.object(database, 'migrate_schema', side_effect=AssertionError('Unexpected migration')) as migration:
        from app import main
        with TestClient(main.app) as client:
            assert client.get('/health').json() == {'status': 'ok'}
        ddl.assert_not_called()
        migration.assert_not_called()
try:
    database.migrate_schema()
except database.DatabaseConfigurationError:
    pass
else:
    raise AssertionError('MySQL must not use the SQLite migration helper')
assert not attempts
assert '***' in repr(database.SQLALCHEMY_DATABASE_URL)
database.engine.dispose()
print('MYSQL_STARTUP_SAFE')
''', environment)
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'MYSQL_STARTUP_SAFE' in result.stdout


def test_mocked_mysql_connection_failure_is_redacted_and_never_falls_back():
    result = run_mysql_child(r'''
import io
import logging
import os
import socket
import sqlite3
import traceback
from unittest.mock import patch
import pymysql
from sqlalchemy.engine import make_url

secret = make_url(os.environ['DATABASE_URL']).password
log = io.StringIO()
logging.basicConfig(stream=log, level=logging.DEBUG)
from app import database

def driver_failure(*args, **kwargs):
    raise pymysql.OperationalError(2003, secret + os.environ['DATABASE_URL'])

with patch.object(pymysql, 'connect', side_effect=driver_failure) as driver:
    with patch.object(socket.socket, 'connect', side_effect=AssertionError('Network forbidden')) as network:
        with patch.object(sqlite3, 'connect', side_effect=AssertionError('SQLite fallback forbidden')) as sqlite:
            try:
                database.engine.connect()
            except database.DatabaseConnectionError as error:
                rendered = ''.join(traceback.format_exception(error))
            else:
                raise AssertionError('Mocked connection should fail')
            assert driver.call_count == 1
            network.assert_not_called()
            sqlite.assert_not_called()
assert secret not in rendered + log.getvalue()
assert os.environ['DATABASE_URL'] not in rendered + log.getvalue()
assert database.engine.dialect.name == 'mysql'
database.engine.dispose()
print('MYSQL_FAILURE_REDACTED')
''')
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'MYSQL_FAILURE_REDACTED' in result.stdout
