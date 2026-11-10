# /// script
# requires-python = ">=3.10"
# dependencies = ["parakeet-mlx", "fastapi", "uvicorn", "python-multipart"]
# ///
"""Local speech-to-text for a finished recording: Parakeet on Apple Silicon.

Speaks the common transcription API (`POST /v1/audio/transcriptions`,
multipart with `file`), so the app's route works unchanged against any other
server with that API. For local development; it listens on 127.0.0.1 only.

Run:  uv run examples/stt-parakeet-mlx/server.py
The first start downloads the model (a few hundred MB) from Hugging Face.

Environment:
  STT_MODEL    model id, default mlx-community/parakeet-tdt-0.6b-v3
  STT_PORT     default 8765
  STT_API_KEY  when set, requests need `Authorization: Bearer <key>`
"""
import asyncio
import os
import tempfile
from concurrent.futures import ThreadPoolExecutor

import uvicorn
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from parakeet_mlx import from_pretrained

MODEL_ID = os.environ.get("STT_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")
API_KEY = os.environ.get("STT_API_KEY")
MAX_BYTES = 25 * 1024 * 1024

app = FastAPI(title="Parakeet transcription (local)")
# MLX ties a model to the thread that loaded it, so one worker thread loads it
# and runs every transcription. That also keeps them one at a time.
worker = ThreadPoolExecutor(max_workers=1)
model = worker.submit(from_pretrained, MODEL_ID).result()


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_ID}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model_name: str | None = Form(default=None, alias="model"),
    language: str | None = Form(default=None),
    authorization: str | None = Header(default=None),
):
    # Parakeet v3 detects the language itself; `language` and `model` are accepted for API parity.
    del model_name, language
    if API_KEY and authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="Unauthorized")
    audio = await file.read(MAX_BYTES + 1)
    if len(audio) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Recording too large")
    suffix = os.path.splitext(file.filename or "")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix) as recording:
        recording.write(audio)
        recording.flush()
        result = await asyncio.get_running_loop().run_in_executor(worker, model.transcribe, recording.name)
    return {"text": result.text.strip()}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("STT_PORT", "8765")))
