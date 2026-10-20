import base64
from dataclasses import replace
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL

from app import database
from app.preview import (PreviewConfigurationError, configure_preview_app,
                         drop_container_privileges, initialize_preview_database,
                         load_preview_settings, validate_preview_database)


@pytest.fixture
def preview(tmp_path, monkeypatch):
    directory, static = tmp_path / 'state', tmp_path / 'dist'
    directory.mkdir(); static.mkdir(); (static / 'assets').mkdir()
    (static / 'index.html').write_text('<html>Preview</html>', encoding='utf-8')
    (static / 'assets/app.js').write_text('console.log(1)', encoding='utf-8')
    (static / 'assets/app.css').write_text('body{}', encoding='utf-8')
    settings = {'APP_ENV': 'preview', 'DB_ENV': 'preview', 'DB_BACKEND': 'sqlite',
                'DATABASE_URL': URL.create('sqlite', database=str(directory / 'preview.db')).render_as_string(hide_password=False),
                'PREVIEW_DATA_DIR': str(directory), 'PREVIEW_STATIC_DIR': str(static),
                'PREVIEW_PUBLIC_ORIGIN': 'https://preview.example.invalid',
                'PREVIEW_USERNAME': 'local-owner', 'PREVIEW_PASSWORD': 'Only-for-isolated-preview-test-12345'}
    for key in ['RAILWAY_ENVIRONMENT_ID', 'RAILWAY_VOLUME_MOUNT_PATH']:
        monkeypatch.delenv(key, raising=False)
    for key, value in settings.items():
        monkeypatch.setenv(key, value)
    return load_preview_settings()


def preview_engine(settings):
    return create_engine(URL.create('sqlite', database=str(settings.database)), connect_args={'check_same_thread': False})


@pytest.mark.parametrize('key,value', [
    ('APP_ENV', ''), ('APP_ENV', 'development'), ('DB_ENV', ''), ('DB_ENV', 'production'),
    ('DB_BACKEND', ''), ('DB_BACKEND', 'mysql'), ('DATABASE_URL', ''),
    ('DATABASE_URL', 'sqlite:///relative.db'), ('DATABASE_URL', 'sqlite:///:memory:'),
    ('PREVIEW_DATA_DIR', ''), ('PREVIEW_DATA_DIR', 'relative'),
    ('PREVIEW_USERNAME', ''), ('PREVIEW_USERNAME', 'bad:name'),
    ('PREVIEW_PASSWORD', ''), ('PREVIEW_PASSWORD', 'short'),
    ('PREVIEW_PASSWORD', '<replace-with-a-random-password>'),
    ('PREVIEW_PUBLIC_ORIGIN', ''), ('PREVIEW_PUBLIC_ORIGIN', 'http://public.example.invalid'),
    ('PREVIEW_PUBLIC_ORIGIN', 'https://preview.example.invalid/path'),
    ('PREVIEW_PUBLIC_ORIGIN', 'https://user:secret@preview.example.invalid'),
    ('PREVIEW_STATIC_DIR', 'missing'),
])
def test_preview_configuration_refuses_before_database_open(preview, monkeypatch, key, value):
    monkeypatch.setenv(key, value)
    with pytest.raises(PreviewConfigurationError):
        load_preview_settings()
    assert not preview.database.exists()


def test_storage_rejects_source_tree_and_missing_railway_volume(preview, monkeypatch):
    monkeypatch.setenv('PREVIEW_DATA_DIR', str(Path(database.__file__).resolve().parents[1]))
    with pytest.raises(PreviewConfigurationError):
        load_preview_settings()
    monkeypatch.setenv('PREVIEW_DATA_DIR', str(preview.directory))
    monkeypatch.setenv('RAILWAY_ENVIRONMENT_ID', 'local-simulation')
    with pytest.raises(PreviewConfigurationError):
        load_preview_settings()
    monkeypatch.setenv('RAILWAY_VOLUME_MOUNT_PATH', str(preview.directory))
    assert load_preview_settings().database == preview.database


def test_production_rejects_sqlite_and_preview_never_accepts_mysql(preview, monkeypatch):
    monkeypatch.setenv('APP_ENV', 'production'); monkeypatch.setenv('DB_ENV', 'production')
    with pytest.raises(database.DatabaseConfigurationError):
        database.create_database_engine()
    monkeypatch.setenv('APP_ENV', 'preview'); monkeypatch.setenv('DB_ENV', 'preview')
    engine = database.create_database_engine()
    assert engine.pool.checkedout() == 0
    engine.dispose()
    monkeypatch.setenv('DB_BACKEND', 'mysql')
    with pytest.raises(database.DatabaseConfigurationError):
        database.create_database_engine()


def test_fresh_schema_is_ordered_and_restart_retains_rows(preview):
    engine = preview_engine(preview)
    try:
        initialize_preview_database(engine, preview)
        with engine.begin() as conn:
            revisions = list(conn.execute(text('SELECT revision FROM schema_migrations ORDER BY revision')).scalars())
            assert [r[:3] for r in revisions] == ['003','004','005','006','007','008']
            conn.execute(text("INSERT INTO projects(name,created_at,updated_at) VALUES ('Retained',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"))
        engine.dispose()
        initialize_preview_database(engine, preview)
        with engine.connect() as conn:
            assert conn.execute(text('SELECT count(*) FROM projects')).scalar_one() == 1
            assert list(conn.execute(text('SELECT revision FROM schema_migrations ORDER BY revision')).scalars()) == revisions
    finally:
        engine.dispose()


def test_existing_incomplete_database_and_init_lock_are_not_overwritten(preview):
    preview.database.write_bytes(b'')
    engine = preview_engine(preview)
    try:
        with pytest.raises(PreviewConfigurationError):
            initialize_preview_database(engine, preview)
        assert preview.database.read_bytes() == b''
        lock = preview.directory / '.preview-initialize.lock'; lock.write_text('another initializer')
        with pytest.raises(PreviewConfigurationError):
            initialize_preview_database(engine, preview)
        assert lock.read_text() == 'another initializer'
    finally:
        engine.dispose()


@pytest.fixture
def protected(preview):
    engine = preview_engine(preview)
    initialize_preview_database(engine, preview)
    app = FastAPI()
    @app.get('/health')
    def health():
        return {'status': 'ok'}
    @app.get('/tasks')
    @app.post('/tasks')
    def tasks():
        return []
    configure_preview_app(app, engine, preview)
    with TestClient(app, base_url=preview.origin) as client:
        yield client, engine
    engine.dispose()


@pytest.mark.parametrize('path', ['/', '/assets/app.js', '/assets/app.css', '/tasks',
    '/projects', '/tags', '/schedule-blocks', '/time-entries/1', '/tasks/time/start',
    '/reports/daily', '/docs', '/redoc', '/openapi.json', '/health'])
def test_every_application_surface_requires_auth(protected, preview, path):
    client, _ = protected
    for headers in [{}, {'Authorization': 'Basic !!!'}, {'Authorization': 'Bearer invalid'},
                    {'Authorization': 'Basic ' + base64.b64encode(b'wrong:wrong').decode()}]:
        response = client.get(path, headers=headers)
        assert response.status_code == 401
        assert response.headers['www-authenticate'].startswith('Basic ')
        assert preview.password.decode() not in response.text
    assert client.post(path).status_code == 401


def test_authenticated_api_and_static_have_correct_types_and_unknown_routes_are_not_html(protected, preview):
    client, _ = protected
    auth = (preview.username.decode(), preview.password.decode())
    assert client.get('/', auth=auth).text == '<html>Preview</html>'
    assert client.get('/tasks', auth=auth).json() == []
    assert client.post('/tasks', auth=auth).json() == []
    assert client.get('/health', auth=auth).json() == {'status': 'ok'}
    assert 'javascript' in client.get('/assets/app.js', auth=auth).headers['content-type']
    assert client.get('/assets/app.css', auth=auth).headers['content-type'].startswith('text/css')
    for path in ['/api/missing', '/reports/missing', '/assets/missing.js', '/missing']:
        response = client.get(path, auth=auth)
        assert response.status_code == 404
        assert response.headers['content-type'].startswith('application/json')
    assert client.get('/openapi.json', auth=auth).json()['openapi']
    assert client.get('/docs', auth=auth).status_code == 200
    assert client.get('/redoc', auth=auth).status_code == 200
    assert client.get('/tasks', auth=auth, headers={'Origin': 'https://other.invalid'}).status_code == 403
    assert client.post('/tasks', auth=auth, headers={'Sec-Fetch-Site': 'cross-site'}).status_code == 403
    linked = client.get('/', auth=auth, headers={'Sec-Fetch-Site': 'cross-site'})
    assert linked.status_code == 200 and linked.headers['x-frame-options'] == 'DENY'
    assert linked.headers['content-security-policy'] == "frame-ancestors 'none'"
    assert client.get('/tasks', auth=auth, headers={'Host': 'other.invalid'}).status_code == 403


def test_readiness_is_minimal_and_detects_connection_failure(protected, monkeypatch):
    client, engine = protected
    assert client.get('/_health/ready').json() == {'status': 'ok'}
    assert client.head('/_health/ready').status_code == 200
    assert client.post('/_health/ready').status_code == 401
    def failure():
        raise RuntimeError('driver secret must not escape')
    monkeypatch.setattr(engine, 'connect', failure)
    response = client.get('/_health/ready')
    assert response.status_code == 503 and response.json() == {'status': 'unavailable'}


def test_container_bootstrap_drops_identity_after_only_owned_mount_paths(preview, monkeypatch):
    from app import preview as module
    calls = []
    monkeypatch.setattr(module.os, 'getuid', lambda: 0, raising=False)
    for method in ['chown', 'setgroups', 'setgid', 'setuid']:
        monkeypatch.setattr(module.os, method, lambda *args, name=method: calls.append((name, args)), raising=False)
    with pytest.raises(PreviewConfigurationError):
        drop_container_privileges(preview)
    assert calls == []
    settings = replace(preview, directory=Path('/data'), database=Path('/data/preview.db'))
    monkeypatch.setattr(Path, 'exists', lambda p: str(p).replace('\\', '/') in ['/data', '/data/preview.db'])
    monkeypatch.setattr(Path, 'is_symlink', lambda p: False)
    drop_container_privileges(settings)
    assert [name for name, _ in calls] == ['chown', 'chown', 'setgroups', 'setgid', 'setuid']
    assert calls[-1] == ('setuid', (10001,))


def test_runtime_requirements_and_container_exclude_development_dependencies():
    root = Path(__file__).resolve().parents[2]
    runtime = set((root / 'backend/requirements-runtime.txt').read_text().splitlines())
    assert runtime <= set((root / 'backend/requirements.txt').read_text().splitlines())
    assert not any(line.startswith(('pytest', 'httpx', 'alembic')) for line in runtime)
    docker = (root / 'Dockerfile').read_text()
    assert 'COPY --from=frontend /build/dist' in docker
    assert 'COPY . .' not in docker and 'COPY backend/tests' not in docker
    assert '"app.preview"' in docker


def test_entrypoint_refuses_missing_environment_without_opening_database(preview, monkeypatch):
    from app.preview import main
    monkeypatch.delenv('APP_ENV')
    with pytest.raises(SystemExit) as failure:
        main()
    assert preview.password.decode() not in str(failure.value)
    assert not preview.database.exists()


def test_https_gate_rejects_plaintext_and_only_accepts_platform_forwarding(protected, preview):
    client, engine = protected
    auth = (preview.username.decode(), preview.password.decode())
    response = client.get('http://preview.example.invalid/tasks', auth=auth)
    assert response.status_code == 400 and 'www-authenticate' not in response.headers
    assert client.get('http://preview.example.invalid/tasks', auth=auth,
                      headers={'X-Forwarded-Proto': 'https'}).status_code == 400
    app = FastAPI()
    @app.get('/health')
    def health():
        return {'status': 'ok'}
    configure_preview_app(app, engine, replace(preview, railway_proxy=True))
    with TestClient(app, base_url='http://preview.example.invalid') as platform:
        assert platform.get('/health', auth=auth).status_code == 400
        assert platform.get('/health', auth=auth, headers={'X-Forwarded-Proto': 'https'}).status_code == 200
