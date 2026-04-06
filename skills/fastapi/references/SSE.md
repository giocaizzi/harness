# Server-Sent Events (SSE)

FastAPI 0.135.0+ has built-in SSE support via `fastapi.sse`.

## Basic Usage

```python
from fastapi.sse import EventSourceResponse, ServerSentEvent

@router.get("/stream")
async def stream_events():
    async def generate():
        for i in range(10):
            yield ServerSentEvent(data=f"Event {i}", event="update", id=str(i))
            await asyncio.sleep(1)

    return EventSourceResponse(generate())
```

## ServerSentEvent Fields

| Field | Purpose |
|-------|---------|
| `data` | Event payload (string or Pydantic model — auto-serialized) |
| `event` | Event type name (client uses `addEventListener(type, ...)`) |
| `id` | Event ID for resume via `Last-Event-ID` header |
| `retry` | Client reconnection delay in milliseconds |

## Resumable Streams

Use `id` field + `Last-Event-ID` header for resume after disconnect:

```python
@router.get("/stream")
async def stream(request: Request):
    last_id = request.headers.get("Last-Event-ID", "0")

    async def generate():
        offset = int(last_id)
        async for event in get_events_from(offset):
            yield ServerSentEvent(data=event.data, id=str(event.id))

    return EventSourceResponse(generate())
```

## Keep-Alive

`EventSourceResponse` sends automatic keep-alive pings. Configure with `ping` parameter (seconds):

```python
return EventSourceResponse(generate(), ping=15)  # ping every 15s
```

## Pydantic Model Serialization

```python
class StatusUpdate(BaseModel):
    progress: float
    message: str

yield ServerSentEvent(data=StatusUpdate(progress=0.5, message="Processing..."))
# Serialized via Pydantic on the Rust side for performance
```

## AI/LLM Streaming Pattern

```python
@router.post("/chat")
async def chat(request: ChatRequest):
    async def generate():
        async for chunk in llm.stream(request.messages):
            yield ServerSentEvent(data=chunk.text, event="chunk")
        yield ServerSentEvent(data="", event="done")

    return EventSourceResponse(generate())
```
