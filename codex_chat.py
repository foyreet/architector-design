import atexit
from copy import deepcopy
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import threading
import time
import uuid

import block_contracts as bc
import project_store as ps
import ai_connection

LOCK = threading.RLock()
CLIENTS = {}
JOBS = {}
ACCOUNT_LOCKS = {}
ERROR = 'Codex недоступен. Проверьте подключение аккаунта и лимиты Codex. Автоматический повтор не выполнялся.'
def fail(message, status=400):
    raise bc.ContractError(message, status)


def process_environment(home):
    # Keep networking/CA support; never inherit API keys, owner login or MCP config.
    allowed = {'PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
               'CODEX_CA_CERTIFICATE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
               'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'}
    env = {key: value for key, value in os.environ.items() if key in allowed}
    env['CODEX_HOME'] = str(home)
    return env


class Client:
    def __init__(self, root):
        executable = shutil.which(os.environ.get('ARCHITECT_CODEX_BIN', 'codex'))
        if not executable:
            fail('Установите Codex CLI в среде запуска или выберите совместимый API.', 503)
        store = ps.ProjectStore(root)
        home = store.path('workspace/codex/home')
        work = store.path('workspace/codex/empty')
        for path in (home, work):
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
            path.chmod(0o700)
        config = '''forced_login_method = "chatgpt"
cli_auth_credentials_store = "file"
web_search = "disabled"
[features]
shell_tool = false
apps = false
plugins = false
multi_agent = false
view_image = false
[shell_environment_policy]
inherit = "none"
'''
        store.path('workspace/codex/home/config.toml').write_text(config, encoding='utf-8')
        self.work = work
        self.pending = {}
        self.events = queue.Queue(maxsize=10000)
        self.write_lock = threading.Lock()
        self.state_lock = threading.RLock()
        self.sequence = 0
        self.last_used = time.monotonic()
        self.login = None
        self.login_error = False
        try:
            self.process = subprocess.Popen([executable, 'app-server', '--listen', 'stdio://'],
                cwd=work, env=process_environment(home), stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                encoding='utf-8', start_new_session=True)
        except OSError:
            fail('Не удалось запустить Codex CLI. Обратитесь к владельцу сервера.', 503)
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()
        try:
            self.rpc('initialize', {'clientInfo': {'name': 'architect_chat', 'title': 'Архитектор', 'version': '1.0'},
                                    'capabilities': {'experimentalApi': True}})
            self.write({'method': 'initialized', 'params': {}})
        except Exception:
            self.close()
            raise

    def write(self, value):
        self.last_used = time.monotonic()
        try:
            with self.write_lock:
                self.process.stdin.write(json.dumps(value, ensure_ascii=False) + '\n')
                self.process.stdin.flush()
        except (OSError, ValueError):
            fail(ERROR, 503)

    def read(self):
        try:
            while True:
                line = self.process.stdout.readline()
                if not line:
                    break
                event = json.loads(line)
                if 'id' in event and 'method' not in event:
                    with self.state_lock:
                        waiting = self.pending.get(event['id'])
                    if waiting:
                        waiting.put_nowait(event)
                elif 'id' in event:
                    self.write({'id': event['id'], 'error': {'code': -32601, 'message': 'Tools unavailable'}})
                else:
                    if event.get('method') == 'account/login/completed':
                        with self.state_lock:
                            self.login = None
                            self.login_error = not event.get('params', {}).get('success')
                    self.events.put_nowait(event)
        except (OSError, ValueError, queue.Full, bc.ContractError):
            pass
        finally:
            with self.state_lock:
                for waiting in self.pending.values():
                    try: waiting.put_nowait({'error': {}})
                    except queue.Full: pass
            self.process.terminate() if self.process.poll() is None else None

    def rpc(self, method, params=None, timeout=35):
        with self.state_lock:
            self.sequence += 1
            identity = self.sequence
            waiting = queue.Queue(maxsize=1)
            self.pending[identity] = waiting
        try:
            self.write({'id': identity, 'method': method, 'params': params or {}})
            response = waiting.get(timeout=timeout)
            if 'error' in response:
                fail(ERROR, 502)
            return response.get('result', {})
        except queue.Empty:
            self.close()
            fail('Codex не ответил вовремя. Проверьте подключение; автоматический повтор не выполнялся.', 504)
        finally:
            with self.state_lock:
                self.pending.pop(identity, None)

    def status(self):
        account = self.rpc('account/read', {'refreshToken': False}).get('account')
        connected = isinstance(account, dict) and account.get('type') == 'chatgpt'
        with self.state_lock:
            expired = self.login if self.login and self.login['expires_at'] <= time.time() else None
        if expired:
            self.rpc('account/login/cancel', {'loginId': expired['login_id']})
        with self.state_lock:
            if connected:
                self.login = None
            if expired:
                self.login = None
            return {'available': True, 'connected': connected,
                    'plan': account.get('planType') if connected else None,
                    'login': deepcopy(self.login), 'login_error': self.login_error}

    def models(self):
        cached = getattr(self, '_model_cache', None)
        if cached and time.monotonic() - cached[0] < 60:
            return deepcopy(cached[1])
        models, seen, cursors, cursor = [], set(), set(), None
        while True:
            response = self.rpc('model/list', {'limit': 100, 'includeHidden': False, **({'cursor': cursor} if cursor else {})})
            for item in response.get('data', []):
                identity = item.get('model')
                if item.get('hidden') or not isinstance(identity, str) or not identity or identity in seen:
                    continue
                if item.get('inputModalities') is not None and 'text' not in item['inputModalities']:
                    continue
                efforts = list(dict.fromkeys(value['reasoningEffort'] for value in item.get('supportedReasoningEfforts', [])
                    if isinstance(value, dict) and isinstance(value.get('reasoningEffort'), str) and value['reasoningEffort']))
                models.append({'id': identity, 'name': str(item.get('displayName') or identity),
                    'efforts': efforts, 'default_effort': item.get('defaultReasoningEffort') if item.get('defaultReasoningEffort') in efforts else None,
                    'default': item.get('isDefault') is True})
                seen.add(identity)
            cursor = response.get('nextCursor')
            if not cursor: break
            if cursor in cursors: fail('Codex вернул некорректный список моделей.', 502)
            cursors.add(cursor)
        self._model_cache = (time.monotonic(), models)
        return deepcopy(models)

    def start_login(self):
        if self.status()['connected']:
            return self.status()
        with self.state_lock:
            existing = bool(self.login)
        if existing:
            return self.status()
        result = self.rpc('account/login/start', {'type': 'chatgptDeviceCode'})
        # Do not let an unexpected upstream URL become a frontend navigation target.
        if result.get('type') != 'chatgptDeviceCode' or result.get('verificationUrl') != 'https://auth.openai.com/codex/device':
            fail('Эта версия Codex не поддерживает вход по коду. Обновите Codex CLI.', 502)
        with self.state_lock:
            self.login_error = False
            self.login = {'login_id': result['loginId'], 'url': result['verificationUrl'],
                          'code': result['userCode'], 'expires_at': time.time() + 14 * 60}
        return self.status()

    def answer(self, prompt, instructions):
        while not self.events.empty():
            try: self.events.get_nowait()
            except queue.Empty: break
        thread = self.rpc('thread/start', {'cwd': str(self.work), 'sandbox': 'read-only',
            'approvalPolicy': 'never', 'ephemeral': True, 'environments': [],
            'baseInstructions': instructions,
            'dynamicTools': [],
            'config': {'features.shell_tool': False, 'features.apps': False, 'features.plugins': False,
                       'features.multi_agent': False, 'features.view_image': False, 'web_search': 'disabled'}})['thread']['id']
        try:
            self.rpc('turn/start', {'threadId': thread, 'input': [{'type': 'text', 'text': prompt}]})
            text = ''
            while True:
                try: event = self.events.get(timeout=1)
                except queue.Empty:
                    if self.process.poll() is not None: fail(ERROR, 503)
                    continue
                params = event.get('params', {})
                if params.get('threadId') != thread:
                    continue
                if event.get('method') == 'item/completed' and params.get('item', {}).get('type') == 'agentMessage':
                    item = params['item']
                    if item.get('phase') != 'commentary': text = item.get('text', '')
                if event.get('method') == 'turn/completed':
                    if params.get('turn', {}).get('status') != 'completed' or not text.strip():
                        fail(ERROR, 502)
                    return text
        finally:
            # Unload ephemeral context; credentials stay available for the next turn.
            try: self.rpc('thread/unsubscribe', {'threadId': thread}, timeout=5)
            except bc.ContractError: pass

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try: self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        if threading.current_thread() is not self.reader:
            self.reader.join(timeout=3)
            for pipe in (self.process.stdin, self.process.stdout):
                if pipe: pipe.close()


def codex_client(root):
    key = str(Path(root).resolve())
    with LOCK:
        for other, value in list(CLIENTS.items()):
            if other not in JOBS and (value.process.poll() is not None or time.monotonic() - value.last_used > 900):
                value.close(); del CLIENTS[other]
        if key not in CLIENTS:
            CLIENTS[key] = Client(root)
        return CLIENTS[key]


def client(root):
    settings = ai_connection.config(root)
    if settings['provider'] == 'compatible': return ai_connection.Compatible(settings)
    if settings['provider'] == 'codex': return codex_client(root)
    fail('Сначала настройте свою модель в настройках AI.', 409)


def standalone_answer(root, prompt, instructions):
    """Use the configured connection without writing to a project conversation."""
    key = str(Path(root).resolve())
    with LOCK:
        account_lock = ACCOUNT_LOCKS.setdefault(key, threading.RLock())
    with account_lock:
        if key in JOBS:
            fail('Модель ещё готовит предыдущий ответ.', 409)
        connection = client(root)
        if not connection.status()['connected']:
            fail('Подключите модель в настройках AI.', 401)
        JOBS[key] = str(uuid.uuid4())
    try:
        return connection.answer(prompt, instructions=instructions)
    finally:
        with account_lock:
            JOBS.pop(key, None)


def request(root, user, body, action, hub=None):
    root = ps.ProjectStore(root).root
    if action in ('config', 'configure', 'test'):
        if action == 'config':
            return {**ai_connection.public(ai_connection.config(root)), 'codex': {
                'available': bool(shutil.which(os.environ.get('ARCHITECT_CODEX_BIN', 'codex'))),
                'npm_available': bool(shutil.which('npm')),
                        'platform': sys.platform}}
        if str(Path(root).resolve()) in JOBS: fail('Дождитесь ответа перед изменением подключения.', 409)
        if action == 'configure':
            if body.get('provider') == 'codex' and not shutil.which(os.environ.get('ARCHITECT_CODEX_BIN', 'codex')):
                fail('Архитектор не находит Codex. Откройте инструкцию в настройках AI, затем нажмите «Проверить снова».', 409)
            return ai_connection.save(root, body)
        settings = ai_connection.config(root)
        if settings['provider'] != 'compatible': fail('Сначала сохраните адрес своей модели.')
        result = ai_connection.Compatible(settings).http('models', timeout=15)
        if not isinstance(result.get('data'), list): fail('API не вернул список моделей.', 502)
        return {'ok': True, 'model_found': any(m.get('id') == settings['model'] for m in result['data'] if isinstance(m, dict))}
    key = str(Path(root).resolve())
    if action in ('status', 'login', 'logout'):
        if action == 'logout' and key in JOBS: fail('Дождитесь ответа перед отключением.', 409)
        settings = ai_connection.config(root)
        if settings['provider'] == 'none':
            return {'available': True, 'connected': False, 'provider': 'none', 'login': None}
        if settings['provider'] == 'compatible':
            if action == 'logout':
                if key in JOBS: fail('Дождитесь ответа перед отключением.', 409)
                ai_connection.save(root, {'provider': 'none'})
                return {'available': True, 'connected': False, 'provider': 'none', 'login': None}
            return ai_connection.Compatible(settings).status()
        if not shutil.which(os.environ.get('ARCHITECT_CODEX_BIN', 'codex')):
            if action == 'login': fail('Сначала подготовьте подключение: откройте настройки AI и нажмите «Проверить снова».', 409)
            return {'available': False, 'connected': False, 'provider': 'codex', 'reason': 'codex_missing', 'login': None}
        connection = client(root)
        if action == 'login': return connection.start_login()
        if action == 'logout':
            if key in JOBS: fail('Дождитесь ответа перед отключением Codex.', 409)
            if connection.login:
                connection.rpc('account/login/cancel', {'loginId': connection.login['login_id']})
                connection.login = None
            connection.rpc('account/logout')
            connection.login_error = False
            connection._model_cache = None
        return connection.status()
    fail('Маршрут не найден.', 404)

@atexit.register
def shutdown():
    for connection in list(CLIENTS.values()):
        connection.close()

