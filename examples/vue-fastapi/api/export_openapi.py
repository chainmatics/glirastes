"""Write openapi.json next to this file: python3 export_openapi.py

This imports the app, so run it in the API's own environment. Glirastes
reads the written document and never imports the app.
"""
import json
from pathlib import Path

from app.main import app

Path(__file__).with_name('openapi.json').write_text(json.dumps(app.openapi(), indent=2, sort_keys=True) + '\n')
