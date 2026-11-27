import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import ai_connection
from codex_chat import standalone_answer
from design_documents import request
from local_workspace import Community, LOCAL_USER
from migrate_design import migrate


class SplitTests(unittest.TestCase):
    def test_migrate_only_design_data_and_reject_existing_tasks(self):
        with tempfile.TemporaryDirectory() as folder:
            source, target = Path(folder) / 'old', Path(folder) / 'new'
            old = Community(source)
            task_id = '11111111-1111-4111-8111-111111111111'
            request(old, LOCAL_USER, {'id':task_id, 'title':'Пример'}, 'create-task')
            with old.db() as db:
                db.execute('CREATE TABLE boards(id TEXT)')
                db.execute("INSERT INTO tree_methods VALUES ('local','problems','Пример методики')")
            db_path = source / 'workspace/local/documents.sqlite3'
            migrate(db_path, target)
            with Community(target).db() as db:
                self.assertEqual(db.execute('SELECT title FROM design_task_drafts').fetchone()[0], 'Пример')
                self.assertEqual(db.execute('SELECT text FROM tree_methods').fetchone()[0], 'Пример методики')
                self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='boards'").fetchone())
            with self.assertRaises(ValueError):
                migrate(db_path, target)

    def test_standalone_ai_uses_own_configuration_and_method(self):
        calls = []
        class FakeModel(BaseHTTPRequestHandler):
            def do_POST(self):
                calls.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"choices":[{"message":{"content":"example"}}]}')

            def log_message(self, *args):
                pass

        with tempfile.TemporaryDirectory() as root, ThreadingHTTPServer(('127.0.0.1', 0), FakeModel) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                ai_connection.save(root, {'provider':'compatible', 'model':'test', 'base_url':f'http://127.0.0.1:{server.server_port}/v1'})
                self.assertEqual(standalone_answer(root, 'Задача', 'Методика'), 'example')
                self.assertEqual(calls[0]['messages'][0], {'role':'system','content':'Методика'})
            finally:
                server.shutdown()
                thread.join()
