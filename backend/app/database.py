import os
import ssl
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.engine import URL, make_url
from sqlalchemy.orm import declarative_base, sessionmaker


class DatabaseConfigurationError(RuntimeError):
    """Configuration errors must never include the supplied connection string."""


class DatabaseConnectionError(RuntimeError):
    """A connection failure with no credentials or driver diagnostics attached."""


def get_database_url() -> str:
    backend = os.getenv('DB_BACKEND')
    if backend is not None and backend not in {'sqlite', 'mysql'}:
        raise DatabaseConfigurationError('DB_BACKEND must be sqlite or mysql.')
    configured_url = os.getenv('DATABASE_URL')
    if configured_url is not None:
        if not configured_url.strip():
            raise DatabaseConfigurationError('DATABASE_URL must not be empty.')
        return configured_url
    if backend == 'mysql':
        raise DatabaseConfigurationError('MySQL requires an explicit DATABASE_URL.')
    database_path = Path(__file__).resolve().parents[1] / 'tasks.db'
    return URL.create('sqlite', database=str(database_path)).render_as_string(hide_password=False)


def _validated_database_url() -> URL:
    try:
        url = make_url(get_database_url())
    except DatabaseConfigurationError:
        raise
    except Exception:
        raise DatabaseConfigurationError('DATABASE_URL is invalid; check its format and port.') from None

    backend = url.get_backend_name()
    if backend not in {'sqlite', 'mysql'}:
        raise DatabaseConfigurationError('Only SQLite and MySQL database URLs are supported.')
    if os.getenv('DB_BACKEND', backend) != backend:
        raise DatabaseConfigurationError('DB_BACKEND does not match DATABASE_URL.')

    app_env = os.getenv('APP_ENV', 'development')
    if app_env not in {'development', 'test', 'production', 'preview'}:
        raise DatabaseConfigurationError('APP_ENV must be development, test, production or preview.')
    db_env = os.getenv('DB_ENV')
    if db_env is not None and db_env != app_env:
        raise DatabaseConfigurationError('DB_ENV must match APP_ENV.')

    if app_env == 'preview':
        from .preview import validate_preview_database
        try:
            validate_preview_database(url)
        except ValueError:
            raise DatabaseConfigurationError('Invalid preview storage configuration.') from None

    if backend == 'sqlite':
        if app_env == 'production':
            raise DatabaseConfigurationError('Production requires an explicit MySQL configuration.')
        return url

    if url.drivername != 'mysql+pymysql':
        raise DatabaseConfigurationError('MySQL requires the mysql+pymysql driver.')
    if not os.getenv('APP_ENV') or not db_env:
        raise DatabaseConfigurationError('MySQL requires explicit APP_ENV and DB_ENV values.')
    if not all((url.host, url.database, url.username, url.password)):
        raise DatabaseConfigurationError('MySQL requires host, database, username and password.')
    # URL query options can override DBAPI host/user/database and TLS settings.
    # Keep the approved endpoint authoritative; configure TLS separately.
    if set(url.query) - {'charset'} or url.query.get('charset', 'utf8mb4') != 'utf8mb4':
        raise DatabaseConfigurationError('MySQL URL query options may only specify charset=utf8mb4.')

    expected_host = os.getenv('DB_EXPECTED_HOST')
    expected_name = os.getenv('DB_EXPECTED_NAME')
    if not expected_host or not expected_name:
        raise DatabaseConfigurationError('MySQL requires DB_EXPECTED_HOST and DB_EXPECTED_NAME.')
    try:
        expected_port = int(os.getenv('DB_EXPECTED_PORT', '3306'))
    except ValueError:
        raise DatabaseConfigurationError('DB_EXPECTED_PORT must be a valid TCP port.') from None
    port = url.port if url.port is not None else 3306
    if not 1 <= expected_port <= 65535 or not 1 <= port <= 65535:
        raise DatabaseConfigurationError('MySQL ports must be between 1 and 65535.')
    if (url.host.casefold() != expected_host.casefold()
            or url.database != expected_name or port != expected_port):
        raise DatabaseConfigurationError('MySQL endpoint does not match the expected host, port and database.')
    return url


def _connect_mysql(dialect, connection_record, connection_args, connection_kwargs):
    try:
        return dialect.connect(*connection_args, **connection_kwargs)
    except Exception:
        # A DBAPI exception can contain the complete URL or password. Suppress
        # its traceback chain rather than copying its message into application logs.
        raise DatabaseConnectionError('MySQL connection failed; check connectivity, TLS and credentials.') from None


def create_database_engine():
    url = _validated_database_url()
    connect_args = {}
    if url.get_backend_name() == 'sqlite':
        connect_args['check_same_thread'] = False
    else:
        try:
            tls = ssl.create_default_context(cafile=os.getenv('MYSQL_SSL_CA'))
        except Exception:
            raise DatabaseConfigurationError('MYSQL_SSL_CA could not be loaded; use a valid CA certificate.') from None
        connect_args.update(ssl=tls, charset='utf8mb4', connect_timeout=10)
    try:
        configured_engine = create_engine(url, connect_args=connect_args, pool_pre_ping=True, hide_parameters=True)
    except Exception:
        raise DatabaseConfigurationError('Database engine initialization failed; check configuration and driver installation.') from None
    if url.get_backend_name() == 'mysql':
        event.listen(configured_engine, 'do_connect', _connect_mysql)
    return configured_engine


engine = create_database_engine()  # Lazy: validation creates no database connection.
# Preserve the existing SQLite string contract. MySQL URL repr masks its password.
SQLALCHEMY_DATABASE_URL = engine.url if engine.dialect.name == 'mysql' else get_database_url()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def migrate_schema() -> None:
    if engine.dialect.name != 'sqlite':
        raise DatabaseConfigurationError('MySQL schema changes require a separate migration command; automatic migration is disabled.')
    from migrations.sqlite_task_period import migrate_sqlite_task_period

    migrate_sqlite_task_period(
        engine,
        allow_metadata_pending=os.getenv('APPLY_TASK_METADATA_MIGRATION') == '1',
        allow_tags_pending=os.getenv('APPLY_TASK_TAGS_MIGRATION') == '1',
        allow_colors_pending=os.getenv('APPLY_PROJECT_TAG_COLORS_MIGRATION') == '1',
        allow_pending=os.getenv('APPLY_TASK_PERIOD_MIGRATION') == '1',
    )
