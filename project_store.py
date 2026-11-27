import json
import os
from pathlib import Path
import threading

import block_contracts as bc
from app_config import data_root

ROOT = data_root()
LOCK = threading.RLock()


class ProjectStore:
    def __init__(self, root=None):
        self.root = Path(root or ROOT)

    def path(self, relative):
        path = self.root / relative
        if not path.is_relative_to(self.root):
            raise bc.ContractError('Недопустимый путь проекта.')
        for part in (path, *path.parents):
            if part == self.root.parent:
                break
            if part.is_symlink():
                raise bc.ContractError('Папка проекта не должна содержать символические ссылки.', 409)
        return path

    def read(self, relative):
        path = self.path(relative)
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            raise bc.ContractError('Проект или его редакция не найдены.', 404) from None
        except (OSError, ValueError, UnicodeError):
            raise bc.ContractError('Не удалось прочитать файл проекта.', 500) from None

    def write(self, relative, value, plain=False):
        path = self.path(relative)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path(relative + '.tmp')
            with temp.open('w', encoding='utf-8') as file:
                if plain: file.write(value)
                else:
                    json.dump(value, file, ensure_ascii=False, allow_nan=False)
                    file.write('\n')
                file.flush(); os.fsync(file.fileno())
            os.replace(temp, path)
        except OSError:
            raise bc.ContractError('Не удалось сохранить проект. Проверьте свободное место и права на папку.', 507) from None

