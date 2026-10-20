"""Browser-test server. Set and guard a temporary DB before importing app.main."""

from datetime import datetime
import os
from pathlib import Path
import socket
import sys
import tempfile
import time

from sqlalchemy import event
from sqlalchemy.engine import Engine, URL

directory = Path(sys.argv[1]).resolve()
temporary_root = Path(tempfile.gettempdir()).resolve()
if directory.parent != temporary_root or not directory.name.startswith('task-timer-db-'):
    raise RuntimeError('The browser-test server requires its own temporary directory.')
database_path = directory / 'timer.db'
os.environ['DATABASE_URL'] = URL.create('sqlite', database=str(database_path)).render_as_string(hide_password=False)
os.environ['APPLY_TASK_METADATA_MIGRATION'] = '1'  # Authorized exclusively for the guarded temporary DB.
os.environ['APPLY_TASK_TAGS_MIGRATION'] = '1'  # 006 is allowed only after selecting the temporary DB above.
os.environ['APPLY_PROJECT_TAG_COLORS_MIGRATION'] = '1'  # 007 only on this guarded temporary DB.
os.environ['APPLY_TASK_PERIOD_MIGRATION'] = '1'  # 008 only on this guarded temporary DB.


def temporary_database_only(dialect, connection_record, connection_args, connection_kwargs):
    if dialect.name != 'sqlite' or not connection_args or Path(connection_args[0]).resolve() != database_path:
        raise RuntimeError('Database connection outside the browser-test DB was blocked.')


event.listen(Engine, 'do_connect', temporary_database_only)
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
from app import main  # noqa: E402 (intentionally after the connection guard)
import uvicorn  # noqa: E402

# An isolated test clock makes 0s/30s/restart checks deterministic; no production code changes.
def test_utc_now():
    # Windows can briefly deny reads while the test replaces its clock file.
    for attempt in range(30):
        try:
            return datetime.fromisoformat((directory / 'clock.txt').read_text(encoding='utf-8').strip())
        except PermissionError:
            if attempt == 29:
                raise
            time.sleep(0.01)


main._utc_now = test_utc_now
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    print(f'TIMER_TEST_PORT={listener.getsockname()[1]}', flush=True)
    uvicorn.Server(uvicorn.Config(main.app, log_level='warning')).run(sockets=[listener])
