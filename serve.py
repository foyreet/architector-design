"""Local HTTP entry point for the four design stages."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from urllib.parse import urlsplit
import webbrowser

import codex_chat
import design_documents
import metric_trees
import problem_spaces
import solution_spaces
from block_contracts import ContractError
from local_workspace import Community, LOCAL_USER

WEB = Path(__file__).resolve().parent / 'annotator'
TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css'}
ASSETS = {'/' + p.relative_to(WEB).as_posix(): p for p in WEB.rglob('*') if p.suffix in TYPES}
ASSETS['/'] = WEB / 'design-docs.html'
ROUTES = {'design-documents': design_documents, 'problem-spaces': problem_spaces,
          'solution-spaces': solution_spaces, 'metric-trees': metric_trees}


class Handler(BaseHTTPRequestHandler):
    def local(self):
        host = self.headers.get('Host')
        if host not in {f'{name}:{self.server.server_port}' for name in ('127.0.0.1', 'localhost')}:
            raise ContractError('Недопустимый адрес сервера.', 403)
        if self.headers.get('Origin') not in (None, 'http://' + host):
            raise ContractError('Запрос разрешён только из этого приложения.', 403)

    def send(self, body, mime, status=200):
        self.send_response(status)
        self.send_header('Content-Type', mime + '; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def json(self, value, status=200):
        self.send(json.dumps(value, ensure_ascii=False).encode(), 'application/json', status)

    def do_GET(self):
        try:
            self.local()
            asset = ASSETS.get(urlsplit(self.path).path)
            if asset is None:
                raise ContractError('Страница не найдена.', 404)
            self.send(asset.read_bytes(), TYPES[asset.suffix])
        except ContractError as exc:
            self.json({'error': str(exc)}, exc.status)

    def do_POST(self):
        try:
            self.local()
            if (self.headers.get('X-Architect-Request') != '1' or self.headers.get_content_type() != 'application/json'
                    or self.headers.get('Sec-Fetch-Site') not in (None, 'same-origin', 'none')):
                raise ContractError('Ожидается запрос из приложения.', 403)
            if self.headers.get('Transfer-Encoding'):
                raise ContractError('Неподдерживаемый формат запроса.')
            size = int(self.headers.get('Content-Length', 0))
            if size <= 0:
                raise ContractError('Пустой запрос.')
            self.connection.settimeout(100)
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                raise ContractError('Ожидается JSON-объект.')
            parts = urlsplit(self.path).path.strip('/').split('/')
            if len(parts) != 3 or parts[0] != 'api':
                raise ContractError('Маршрут не найден.', 404)
            _, resource, action = parts
            if resource == 'community' and action == 'session':
                result = {'enabled': False, 'local': True, 'user': LOCAL_USER, 'registration_open': False}
            elif resource == 'codex':
                result = codex_chat.request(Community().root, LOCAL_USER, body, action)
            elif resource in ROUTES:
                result = ROUTES[resource].request(Community(), LOCAL_USER, body, action)
            else:
                raise ContractError('Маршрут не найден.', 404)
            self.json(result)
        except ContractError as exc:
            self.json({'error': str(exc)}, exc.status)
        except (ValueError, UnicodeError):
            self.json({'error': 'Некорректный формат запроса.'}, 400)


def main(open_browser=False):
    parser = argparse.ArgumentParser(description='Запустить Архитектор Дизайн')
    parser.add_argument('--port', type=int, default=8771)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    with ThreadingHTTPServer(('127.0.0.1', args.port), Handler) as server:
        origin = f'http://127.0.0.1:{server.server_port}'
        print('Архитектор Дизайн — ' + origin, flush=True)
        if open_browser and not args.no_browser:
            webbrowser.open(origin)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
