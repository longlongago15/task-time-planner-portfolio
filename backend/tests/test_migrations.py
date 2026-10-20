from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import URL

from app import database


def test_sqlite_migration_preserves_tasks_and_time_entries(tmp_path, monkeypatch):
    database_path = tmp_path / 'legacy.db'
    legacy_engine = create_engine(URL.create('sqlite', database=str(database_path)))
    try:
        with legacy_engine.begin() as connection:
            connection.execute(text(
                'CREATE TABLE projects (id INTEGER PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, '
                'created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)'
            ))
            connection.execute(text(
                'CREATE TABLE tasks ('
                'id INTEGER PRIMARY KEY, title VARCHAR(255) NOT NULL, estimated_minutes INTEGER NOT NULL, '
                'planned_date DATE NOT NULL, completed BOOLEAN NOT NULL, created_at DATETIME NOT NULL, '
                'updated_at DATETIME NOT NULL)'
            ))
            connection.execute(text(
                'CREATE TABLE time_entries ('
                'id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, '
                'start_at DATETIME NOT NULL, end_at DATETIME NOT NULL, duration_minutes INTEGER NOT NULL, '
                'created_at DATETIME NOT NULL)'
            ))
            connection.execute(text(
                "INSERT INTO tasks VALUES (1, 'Legacy task', 45, '2025-01-02', 0, "
                "'2025-01-01 00:00:00', '2025-01-01 00:00:00')"
            ))
            connection.execute(text(
                "INSERT INTO time_entries VALUES (1, 1, '2025-01-02 09:00:00', "
                "'2025-01-02 09:30:00', 30, '2025-01-02 09:30:00')"
            ))

        monkeypatch.setattr(database, 'engine', legacy_engine)
        database.migrate_schema()

        columns = {column['name']: column for column in inspect(legacy_engine).get_columns('tasks')}
        assert columns['planned_date']['nullable'] is True
        assert 'planned_start_time' in columns
        assert 'project_id' in columns
        with legacy_engine.connect() as connection:
            task = connection.execute(text(
                'SELECT id, title, estimated_minutes, planned_date FROM tasks WHERE id = 1'
            )).one()
            entry = connection.execute(text(
                'SELECT id, task_id, started_at, ended_at FROM time_entries WHERE id = 1'
            )).one()
        assert tuple(task) == (1, 'Legacy task', 45, '2025-01-02')
        assert tuple(entry) == (1, 1, '2025-01-02 09:00:00', '2025-01-02 09:30:00')
    finally:
        legacy_engine.dispose()
