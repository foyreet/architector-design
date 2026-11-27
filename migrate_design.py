"""Import only design records from a previous local Architect installation."""
import argparse
from contextlib import closing
from pathlib import Path
import sqlite3
from local_workspace import Community

TABLES = ('design_documents', 'design_task_drafts', 'dismissed_tree_tasks',
          'problem_spaces', 'solution_spaces', 'metric_trees', 'tree_methods')


def migrate(source, target=None):
    with closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True)) as old, Community(target).db() as new:
        old.execute('BEGIN')
        tables = {row[0] for row in old.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'design_documents' not in tables:
            raise ValueError('В исходной базе нет таблицы дизайн-документов.')
        new.execute('BEGIN IMMEDIATE')
        if any(new.execute(f'SELECT 1 FROM {name} LIMIT 1').fetchone() for name in TABLES):
            raise ValueError('Целевая база уже содержит задачи или методики.')
        for name in TABLES:
            if name not in tables:
                continue
            existing = {r[1] for r in old.execute(f'PRAGMA table_info({name})')}
            columns = ','.join(r[1] for r in new.execute(f'PRAGMA table_info({name})') if r[1] in existing)
            cursor = old.execute(f'SELECT {columns} FROM {name}')
            placeholders = ','.join('?' for _ in cursor.description)
            new.executemany(f'INSERT INTO {name} ({columns}) VALUES ({placeholders})', cursor)
        if 'problem_spaces' not in tables:
            new.execute("""INSERT INTO problem_spaces
                SELECT id, owner, title, COALESCE(json_extract(sections, '$.problem'), ''), problem_tree, 1, updated
                FROM design_documents WHERE problem_tree != '[]'""")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Перенос задач из Архитектора в пустую базу Архитектор Дизайн')
    parser.add_argument('source', type=Path, help='Путь к прежней базе documents.sqlite3')
    try:
        migrate(parser.parse_args().source)
    except (sqlite3.Error, ValueError) as exc:
        parser.exit(1, str(exc) + '\n')
    print('Перенос завершён.')
