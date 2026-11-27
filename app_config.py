"""Local-only application configuration."""
import os
from pathlib import Path

def data_root():
    value = os.environ.get('ARCHITECT_DESIGN_DATA_DIR')
    return Path(value).expanduser().resolve() if value else Path(__file__).resolve().parent / 'data'

