# Async Patterns: Background Tasks, Streaming, WebSocket, File Uploads

## Background Tasks

### Lightweight: `BackgroundTasks`

Runs after response is sent. For quick, non-critical work (send email, log analytics).

```python
from fastapi import BackgroundTasks

@router.post("/orders")
async def create_order(body: CreateOrderRequest, bg: BackgroundTasks):
    order = await order_service.create(body)
    bg.add_task(send_confirmation_email, order.id)
    return order
```

### Heavy/Reliable: External Task Queue

Use Celery, ARQ, or Dramatiq for: long-running tasks, tasks that must not be lost, tasks needing retry/monitoring.

```python
# With ARQ
@router.post("/reports")
async def generate_report(body: ReportRequest, redis: RedisDep):
    job = await redis.enqueue_job("generate_report", body.dict())
    return {"job_id": job.job_id}
```

## Streaming Responses

### Large Data Streaming

```python
from fastapi.responses import StreamingResponse

@router.get("/export")
async def export_data():
    async def generate():
        async for batch in db.stream_batches():
            yield batch.to_csv()

    return StreamingResponse(generate(), media_type="text/csv")
```

### JSON Lines Streaming (FastAPI 0.134.0+)

```python
@router.get("/events")
async def stream_jsonl():
    async def generate():
        async for event in event_source:
            yield event  # Pydantic model or dict — auto-serialized as JSON line

    return StreamingResponse(generate(), media_type="application/x-ndjson")
```

## WebSocket

```python
@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    try:
        async for message in ws.iter_text():  # preferred over while True + receive
            response = await process(message)
            await ws.send_text(response)
    except WebSocketDisconnect:
        pass
```

Use `async for` with `iter_text()`/`iter_bytes()` instead of `while True` + `receive_text()` loops.

## File Uploads

### Small Files (in-memory)

```python
from fastapi import UploadFile

@router.post("/upload")
async def upload(file: UploadFile):
    contents = await file.read()
    return {"filename": file.filename, "size": len(contents)}
```

### Large Files (streaming to disk)

```python
import aiofiles

@router.post("/upload-large")
async def upload_large(file: UploadFile):
    async with aiofiles.open(f"uploads/{file.filename}", "wb") as f:
        while chunk := await file.read(1024 * 1024):  # 1MB chunks
            await f.write(chunk)
    return {"filename": file.filename}
```

### Cloud Offload (presigned URLs)

For production: generate presigned upload URLs (S3, GCS) and let clients upload directly to cloud storage. Avoids routing large files through your API.
