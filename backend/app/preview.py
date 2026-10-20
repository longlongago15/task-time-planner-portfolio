"""Owner-only preview deployment. Normal development does not use this gate."""
import base64
import binascii
from dataclasses import dataclass, field
import os
from pathlib import Path
import secrets
from urllib.parse import urlsplit

from sqlalchemy import text
from sqlalchemy.engine import make_url
from starlette.responses import JSONResponse
from starlette.staticfiles import StaticFiles


class PreviewConfigurationError(ValueError):
    """Messages must contain no environment values or driver details."""


def validate_preview_database(url):
    if (os.getenv('APP_ENV') != 'preview' or os.getenv('DB_ENV') != 'preview'
            or os.getenv('DB_BACKEND') != 'sqlite' or not os.getenv('DATABASE_URL')):
        raise PreviewConfigurationError('Preview requires explicit matching environment and SQLite settings.')
    directory = Path(os.getenv('PREVIEW_DATA_DIR', ''))
    path = Path(url.database or '')
    if (url.drivername != 'sqlite' or url.query or not directory.is_absolute()
            or not path.is_absolute() or path.name != 'preview.db'):
        raise PreviewConfigurationError('Preview requires an absolute dedicated SQLite path.')
    resolved = directory.resolve()
    source = Path(__file__).resolve().parents[2]
    if (resolved == Path(resolved.anchor) or resolved.is_relative_to(source)
            or any((parent / '.git').exists() for parent in [resolved, *resolved.parents])
            or directory != resolved or path != resolved / 'preview.db'
            or path.is_symlink() or not directory.is_dir()):
        raise PreviewConfigurationError('Preview storage must be a dedicated existing directory outside source trees.')
    railway = os.getenv('RAILWAY_ENVIRONMENT_ID')
    if railway and os.getenv('RAILWAY_VOLUME_MOUNT_PATH') != str(directory):
        raise PreviewConfigurationError('Railway preview requires its persistent volume at the configured path.')
    return directory, path


@dataclass(frozen=True)
class PreviewSettings:
    directory: Path
    database: Path
    static: Path
    origin: str
    username: bytes = field(repr=False)
    password: bytes = field(repr=False)
    railway_proxy: bool = False


def load_preview_settings():
    try:
        directory, database = validate_preview_database(make_url(os.getenv('DATABASE_URL', '')))
    except Exception:
        raise PreviewConfigurationError('Invalid preview database configuration.') from None
    username, password = os.getenv('PREVIEW_USERNAME', ''), os.getenv('PREVIEW_PASSWORD', '')
    if (not 1 <= len(username) <= 64 or ':' in username or not 24 <= len(password) <= 256
            or any(ord(c) < 33 or ord(c) > 126 or c in '<>' for c in username + password)):
        raise PreviewConfigurationError('Preview requires a valid username and a random password of at least 24 characters.')
    origin = os.getenv('PREVIEW_PUBLIC_ORIGIN', '')
    try:
        parsed = urlsplit(origin)
        valid = (parsed.scheme in {'https', 'http'} and parsed.hostname and not parsed.username
                 and not parsed.password and parsed.path == '' and not parsed.query and not parsed.fragment
                 and not any(c.isspace() for c in origin) and not parsed.netloc.endswith(':')
                 and (parsed.scheme == 'https' or parsed.hostname in {'127.0.0.1', 'localhost', '::1'}))
        parsed.port
    except ValueError:
        valid = False
    if valid and os.getenv('RAILWAY_ENVIRONMENT_ID') and (parsed.scheme != 'https' or parsed.hostname in {'localhost', '127.0.0.1', '::1'}):
        valid = False
    if not valid:
        raise PreviewConfigurationError('Preview requires a canonical HTTPS public origin; HTTP is local-loopback only.')
    static = Path(os.getenv('PREVIEW_STATIC_DIR', str(Path(__file__).resolve().parents[2] / 'frontend/dist')))
    if (not static.is_absolute() or not (static / 'index.html').is_file()
            or not (static / 'assets').is_dir() or static.resolve().is_relative_to(directory)):
        raise PreviewConfigurationError('Preview frontend build is missing.')
    return PreviewSettings(directory, database, static, parsed.scheme + '://' + parsed.netloc.lower(), username.encode(), password.encode(), bool(os.getenv('RAILWAY_ENVIRONMENT_ID')))


def initialize_preview_database(engine, settings):
    """Only a file created exclusively by this invocation may receive pending DDL."""
    from migrations.sqlite_task_period import migrate_sqlite_task_period
    lock = settings.directory / '.preview-initialize.lock'
    descriptor = None
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            fresh = os.open(settings.database, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            created = False
        else:
            os.close(fresh)
            created = True
        migrate_sqlite_task_period(engine, allow_pending=created, allow_colors_pending=created,
                                   allow_tags_pending=created, allow_metadata_pending=created)
        with engine.connect() as connection:
            connection.execute(text('SELECT 1'))
    except Exception:
        raise PreviewConfigurationError('Preview database startup failed; check permissions, initialization lock and schema. No existing database is auto-upgraded.') from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
            lock.unlink()


class OwnerGate:
    def __init__(self, app, settings):
        self.app, self.settings = app, settings

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'websocket':
            await send({'type': 'websocket.close', 'code': 1008})
            return
        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return
        if scope['path'] == '/_health/ready' and scope['method'] in {'GET', 'HEAD'}:
            await self.app(scope, receive, send)
            return
        headers = scope['headers']
        forwarded = next((v for k, v in headers if k == b'x-forwarded-proto'), None)
        if (self.settings.origin.startswith('https://') and scope['scheme'] != 'https'
                and not (self.settings.railway_proxy and forwarded == b'https')):
            await JSONResponse({'detail': 'HTTPS required'}, status_code=400)(scope, receive, send)
            return
        values = [value for key, value in headers if key.lower() == b'authorization']
        authenticated = False
        if len(values) == 1 and len(values[0]) <= 1024:
            try:
                scheme, encoded = values[0].split(b' ', 1)
                raw = base64.b64decode(encoded, validate=True)
                username, password = raw.split(b':', 1)
                user_ok = secrets.compare_digest(username, self.settings.username)
                password_ok = secrets.compare_digest(password, self.settings.password)
                authenticated = scheme.lower() == b'basic' and user_ok and password_ok
            except (ValueError, binascii.Error):
                pass
        if not authenticated:
            response = JSONResponse({'detail': 'Authentication required'}, status_code=401,
                                    headers={'WWW-Authenticate': 'Basic realm="Private preview", charset="UTF-8"', 'Cache-Control': 'no-store'})
        else:
            host = next((v.decode('latin1') for k, v in headers if k == b'host'), '')
            origin = next((v.decode('latin1') for k, v in headers if k == b'origin'), None)
            site = next((v for k, v in headers if k == b'sec-fetch-site'), None)
            if (host.lower() != urlsplit(self.settings.origin).netloc.lower()
                    or origin is not None and origin != self.settings.origin
                    or site == b'cross-site' and scope['method'] not in {'GET', 'HEAD'}):
                response = JSONResponse({'detail': 'Origin not permitted'}, status_code=403)
            else:
                async def protected_send(message):
                    if message['type'] == 'http.response.start':
                        message = {**message, 'headers': [*message['headers'],
                            (b'x-frame-options', b'DENY'),
                            (b'content-security-policy', b"frame-ancestors 'none'")] }
                    await send(message)
                await self.app(scope, receive, protected_send)
                return
        await response(scope, receive, send)


def configure_preview_app(app, engine, settings):
    @app.api_route('/_health/ready', methods=['GET', 'HEAD'], include_in_schema=False)
    def ready():
        try:
            if not settings.database.is_file():
                raise OSError
            with engine.connect() as connection:
                connection.execute(text('SELECT 1'))
        except Exception:
            return JSONResponse({'status': 'unavailable'}, status_code=503)
        return JSONResponse({'status': 'ok'})

    # Existing API routes win; missing assets/routes remain JSON 404, never index.html.
    # Workspace uses state navigation, so only / requires an HTML entry document.
    app.mount('/', StaticFiles(directory=settings.static, html=True), name='preview-frontend')
    app.add_middleware(OwnerGate, settings=settings)


def drop_container_privileges(settings):
    # Railway volumes are root-owned. Only this fixed dedicated mount is repaired;
    # the HTTP server and SQLite initialization subsequently run as uid/gid 10001.
    if hasattr(os, 'getuid') and os.getuid() == 0:
        if settings.directory != Path('/data'):
            raise PreviewConfigurationError('Root bootstrap only supports the dedicated /data mount.')
        for path in [settings.directory, settings.database,
                     *[Path(str(settings.database) + suffix) for suffix in ['-journal', '-wal', '-shm']]]:
            if path.is_symlink():
                raise PreviewConfigurationError('Storage links are not allowed.')
            if path.exists():
                os.chown(path, 10001, 10001)
        os.setgroups([])
        os.setgid(10001)
        os.setuid(10001)


def main():
    try:
        settings = load_preview_settings()  # Fails before importing the application/DB.
        port = int(os.getenv('PORT', '8000'))
        if not 1 <= port <= 65535:
            raise ValueError
        drop_container_privileges(settings)
    except Exception:
        raise SystemExit('Preview startup refused: verify environment, credentials, origin, frontend and storage configuration.') from None
    import uvicorn
    uvicorn.run('app.main:app', host='0.0.0.0', port=port, workers=1,
                access_log=False, proxy_headers=False)


if __name__ == '__main__':
    main()
