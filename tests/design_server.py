from pathlib import Path
import tempfile
import threading
from unittest.mock import patch
import serve


class DesignServer:
    def __enter__(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patch = patch('project_store.ROOT', self.root); self.patch.start()
        self.server = serve.ThreadingHTTPServer(('127.0.0.1',0),serve.Handler)
        self.origin = f'http://127.0.0.1:{self.server.server_port}'
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        return self
    def __exit__(self,*args):
        self.server.shutdown();self.server.server_close();self.thread.join();self.patch.stop();self.temp.cleanup()


