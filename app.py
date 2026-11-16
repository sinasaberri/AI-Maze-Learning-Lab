import asyncio
import os
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, Response, WebSocket, WebSocketDisconnect
from pydantic import Field, ValidationError

from lab import MAZES, Configuration, Model, Snapshot, Trainer, Transition


app = FastAPI(title="AI Maze Learning Lab", docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
BatchSize = Annotated[int, Field(ge=1, le=8)]


class OpenSession(Model):
    type: Literal["open"]
    config: Configuration
    snapshot: Snapshot | None = None


class Advance(Model):
    type: Literal["advance"]
    count: BatchSize


class StepRequest(Model):
    snapshot: Snapshot
    count: BatchSize = 1


class Batch(Model):
    type: Literal["batch"] = "batch"
    events: list[Transition]
    snapshot: Snapshot


@app.get("/api/health")
def health():
    return {"status": "ok", "protocol": 1}


@app.get("/api/experiments")
def experiments():
    return [
        {"id": name, "name": label, "rows": rows, "config": Configuration(maze=name)}
        for name, (label, rows) in MAZES.items()
    ]


@app.post("/api/training/start", response_model=Snapshot)
@app.post("/api/training/reset", response_model=Snapshot)
def start_training(config: Configuration, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return Trainer(config).snapshot()


@app.post("/api/training/step", response_model=Batch)
def step_training(request: StepRequest, response: Response):
    response.headers["Cache-Control"] = "no-store"
    trainer = Trainer(request.snapshot.config, request.snapshot)
    return Batch(events=trainer.advance(request.count), snapshot=trainer.snapshot())


def lease_seconds() -> int:
    try:
        return min(55, max(1, int(os.getenv("MAZE_WS_LEASE_SECONDS", "55"))))
    except ValueError:
        return 55


async def receive(websocket: WebSocket, model, maximum: int):
    message = await websocket.receive()
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", 1000))
    data = message.get("text")
    if data is None or len(data.encode()) > maximum:
        raise ValueError("Expected a bounded JSON text message")
    return model.model_validate_json(data)


@app.websocket("/api/ws")
async def training_stream(websocket: WebSocket):
    origin = websocket.headers.get("origin")
    if origin and urlsplit(origin).netloc.lower() != websocket.headers.get("host", "").lower():
        await websocket.close(code=1008)
        return

    await websocket.accept()
    ready = False
    try:
        async with asyncio.timeout(lease_seconds()):
            async with asyncio.timeout(8):
                session = await receive(websocket, OpenSession, 65_536)
            if session.snapshot is not None and session.snapshot.config != session.config:
                raise ValueError("Snapshot configuration does not match")
            trainer = Trainer(session.config, session.snapshot)
            await websocket.send_json({"type": "ready", "snapshot": trainer.snapshot().model_dump(mode="json")})
            ready = True
            while True:
                command = await receive(websocket, Advance, 256)
                batch = Batch(events=trainer.advance(command.count), snapshot=trainer.snapshot())
                await websocket.send_text(batch.model_dump_json())
    except TimeoutError:
        try:
            await websocket.close(code=1012, reason="Training lease ended")
        except (WebSocketDisconnect, OSError):
            pass
    except (WebSocketDisconnect, OSError):
        pass
    except (ValidationError, ValueError):
        try:
            await websocket.send_json({"type": "error", "message": (
                "Invalid training command." if ready else "The saved session or configuration could not be restored."
            )})
            await websocket.close(code=1008)
        except (WebSocketDisconnect, OSError):
            pass


app.frontend("/", directory="dist", fallback=None, check_dir=False)
