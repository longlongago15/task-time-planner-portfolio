import pytest
from pathlib import Path
from run_portfolio import select_database


def test_new_local_database_is_empty_and_cannot_be_reinitialized(tmp_path):
    path = select_database(tmp_path, 'demo', True, {})
    assert path == tmp_path / '.local-data/demo/portfolio.sqlite3'
    assert path.read_bytes() == b''
    path.write_bytes(b'preserve synthetic state')
    with pytest.raises(FileExistsError):
        select_database(tmp_path, 'demo', True, {})
    assert path.read_bytes() == b'preserve synthetic state'
    assert select_database(tmp_path, 'demo', False, {}) == path


@pytest.mark.parametrize('environment', [
    {'DATABASE_URL': 'sqlite:///existing.db'},
    {'DATABASE_URL': 'mysql+pymysql://example.invalid/database'},
    {'DB_BACKEND': 'mysql'},
])
def test_inherited_database_settings_are_rejected_before_writes(tmp_path, environment):
    with pytest.raises(ValueError):
        select_database(tmp_path, 'demo', True, environment)
    assert not (tmp_path / '.local-data').exists()


@pytest.mark.parametrize('directory', ['../escape', '../../elsewhere'])
def test_parent_directory_is_rejected(tmp_path, directory):
    with pytest.raises(ValueError):
        select_database(tmp_path, directory, True, {})


def test_existing_database_required_for_normal_startup(tmp_path):
    with pytest.raises(ValueError):
        select_database(tmp_path, 'local', False, {})


def test_absolute_directory_is_rejected(tmp_path):
    with pytest.raises(ValueError):
        select_database(tmp_path, str(tmp_path / 'outside'), True, {})


@pytest.mark.parametrize('link_method', ['is_symlink', 'is_junction'])
def test_linked_data_root_is_rejected_before_creation(tmp_path, monkeypatch, link_method):
    monkeypatch.setattr(Path, link_method, lambda path: path == tmp_path / '.local-data', raising=False)
    with pytest.raises(ValueError):
        select_database(tmp_path, 'local', True, {})
    assert not (tmp_path / '.local-data').exists()
