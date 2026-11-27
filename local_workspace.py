"""One local workspace. No accounts, passwords, sessions or remote catalog."""
from contextlib import contextmanager
import os
import sqlite3
import threading
import project_store as ps

LOCK = threading.RLock()
LOCAL_USER = {'id': 'local', 'username': 'На этом компьютере', 'primary': True}

class Community:
    def __init__(self, root=None):
        self.store = ps.ProjectStore(root)
        self.root = self.store.root

    @contextmanager
    def db(self):
        with LOCK:
            path = self.store.path('workspace/local/documents.sqlite3')
            path.parent.mkdir(parents=True, exist_ok=True)
            db = sqlite3.connect(path, timeout=10)
            os.chmod(path, 0o600)
            db.row_factory = sqlite3.Row
            try:
                db.execute('CREATE TABLE IF NOT EXISTS design_documents(id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, sections TEXT NOT NULL, revision INTEGER NOT NULL, updated REAL NOT NULL, source_release TEXT)')
                db.execute('''CREATE TABLE IF NOT EXISTS design_task_drafts(
                    owner TEXT NOT NULL, id TEXT NOT NULL, tree_id TEXT, metric_tree_id TEXT,
                    PRIMARY KEY(owner,id))''')
                draft_columns = {r['name'] for r in db.execute('PRAGMA table_info(design_task_drafts)')}
                if 'title' not in draft_columns:
                    db.execute('ALTER TABLE design_task_drafts ADD COLUMN title TEXT')
                if 'created' not in draft_columns:
                    db.execute('ALTER TABLE design_task_drafts ADD COLUMN created REAL')
                db.execute('''CREATE TABLE IF NOT EXISTS dismissed_tree_tasks(
                    owner TEXT NOT NULL, kind TEXT NOT NULL, tree_id TEXT NOT NULL,
                    PRIMARY KEY(owner,kind,tree_id))''')
                if 'sources' not in {r['name'] for r in db.execute('PRAGMA table_info(design_documents)')}:
                    db.execute("ALTER TABLE design_documents ADD COLUMN sources TEXT NOT NULL DEFAULT '{}'")
                if 'task_links' not in {r['name'] for r in db.execute('PRAGMA table_info(design_documents)')}:
                    db.execute("ALTER TABLE design_documents ADD COLUMN task_links TEXT NOT NULL DEFAULT '{}'")
                if 'problem_tree' not in {r['name'] for r in db.execute('PRAGMA table_info(design_documents)')}:
                    db.execute("ALTER TABLE design_documents ADD COLUMN problem_tree TEXT NOT NULL DEFAULT '[]'")
                if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='problem_spaces'").fetchone():
                    with db:
                        db.execute('BEGIN IMMEDIATE')
                        db.execute('CREATE TABLE IF NOT EXISTS problem_spaces(id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, problem TEXT NOT NULL, tree TEXT NOT NULL, revision INTEGER NOT NULL, updated REAL NOT NULL)')
                        db.execute("""INSERT OR IGNORE INTO problem_spaces
                            SELECT id, owner, title, json_extract(sections, '$.problem'), problem_tree, 1, updated
                            FROM design_documents WHERE problem_tree != '[]'""")
                db.execute('CREATE TABLE IF NOT EXISTS tree_methods(owner TEXT NOT NULL, mode TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY(owner,mode))')
                db.execute('CREATE TABLE IF NOT EXISTS metric_trees(id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, problem TEXT NOT NULL, tree TEXT NOT NULL, revision INTEGER NOT NULL, updated REAL NOT NULL)')
                db.execute('CREATE TABLE IF NOT EXISTS solution_spaces(tree_id TEXT PRIMARY KEY, content TEXT NOT NULL, version INTEGER NOT NULL)')
                with db: yield db
            finally: db.close()

