"""Loopback-only SQLite launcher. Initialization requires an explicit new-file action."""
import argparse
import os
from pathlib import Path
import socket
import sys

PROJECT_ROOT = Path(__file__).resolve().parent.parent
APPROVALS = (
    'APPLY_TASK_METADATA_MIGRATION', 'APPLY_TASK_TAGS_MIGRATION',
    'APPLY_PROJECT_TAG_COLORS_MIGRATION', 'APPLY_TASK_PERIOD_MIGRATION',
)


def select_database(root: Path, directory: str, initialize: bool, environment):
    """Select one local database; never adopt an inherited URL or existing file on init."""
    if environment.get('DATABASE_URL') or environment.get('DB_BACKEND', 'sqlite') != 'sqlite':
        raise ValueError('Clear inherited database configuration before using the local launcher.')
    relative = Path(directory)
    if relative.is_absolute() or '..' in relative.parts:
        raise ValueError('Data directory must be relative to the portfolio data root.')
    data_root = root.resolve() / '.local-data'
    target = data_root / relative
    for part in (data_root, *[data_root.joinpath(*relative.parts[:i]) for i in range(1, len(relative.parts)+1)]):
        if part.is_symlink() or getattr(part, 'is_junction', lambda: False)():
            raise ValueError('Linked data directories are not accepted.')
    if not target.resolve().is_relative_to(data_root):
        raise ValueError('Data directory is outside the portfolio data root.')
    database = target / 'portfolio.sqlite3'
    if database.is_symlink():
        raise ValueError('Linked database files are not accepted.')
    if initialize:
        target.mkdir(parents=True, exist_ok=True)
        # An existing database or a concurrent initializer must stop, never overwrite.
        descriptor = os.open(database, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
    elif not database.is_file():
        raise ValueError('No local database exists. Initialize a new database explicitly.')
    return database.resolve()


def main():
    parser = argparse.ArgumentParser(description='Start the local SQLite portfolio on loopback.')
    parser.add_argument('--initialize', action='store_true', help='Initialize only a new empty database.')
    parser.add_argument('--data-dir', default='local', help='Subdirectory of .local-data (default: local).')
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error('Port must be between 0 and 65535.')
    try:
        database = select_database(PROJECT_ROOT, args.data_dir, args.initialize, os.environ)
        from sqlalchemy import event
        from sqlalchemy.engine import Engine, URL

        def local_database_only(dialect, record, connect_args, connect_kwargs):
            if (dialect.name != 'sqlite' or not connect_args
                    or Path(connect_args[0]).resolve() != database):
                raise RuntimeError('A connection outside the local portfolio database was blocked.')

        event.listen(Engine, 'do_connect', local_database_only)
        os.environ.update(DB_BACKEND='sqlite', APP_ENV='development', DB_ENV='development',
                          DATABASE_URL=URL.create('sqlite', database=str(database)).render_as_string(hide_password=False))
        for name in APPROVALS:
            os.environ.pop(name, None)
            if args.initialize:
                os.environ[name] = '1'
        from app.main import app
        import uvicorn
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', args.port))
            print(f'PORTFOLIO_PORT={listener.getsockname()[1]}', flush=True)
            uvicorn.Server(uvicorn.Config(app, log_level='warning')).run(sockets=[listener])
    except Exception:
        # A failed initialization may have partial state. Preserve it; do not retry/delete.
        print('STOP: local startup failed. Preserve local data; review configuration and schema. No retry or cleanup.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
