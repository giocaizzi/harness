# Security Patterns

## OAuth2 + JWT

```python
from fastapi import Depends, Security
from fastapi.security import OAuth2PasswordBearer, SecurityScopes

oauth2_scheme = OAuth2PasswordBearer(
    tokenUrl="auth/token",
    scopes={"users:read": "Read users", "users:write": "Modify users"},
)

async def get_current_user(
    token: Annotated[str, Depends(oauth2_scheme)],
    security_scopes: SecurityScopes,
) -> User:
    payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
    token_scopes = payload.get("scopes", [])
    for scope in security_scopes.scopes:
        if scope not in token_scopes:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
    return await get_user(payload["sub"])
```

### Using Scopes on Endpoints

```python
@router.get("/users", dependencies=[Security(get_current_user, scopes=["users:read"])])
async def list_users(): ...

@router.post("/users", dependencies=[Security(get_current_user, scopes=["users:write"])])
async def create_user(): ...
```

### Security() vs Depends()

- `Depends()` — standard dependency injection. No OpenAPI security metadata.
- `Security()` — extends `Depends()` with OAuth2 scopes. Adds security requirements to OpenAPI docs. Use for auth dependencies.

## API Key Authentication

```python
from fastapi.security import APIKeyHeader

api_key_header = APIKeyHeader(name="X-API-Key")

async def verify_api_key(key: Annotated[str, Security(api_key_header)]) -> None:
    if key not in valid_api_keys:
        raise HTTPException(status_code=403, detail="Invalid API key")
```

## JWT Token Creation

```python
from datetime import datetime, timedelta, timezone
import jwt

def create_access_token(user_id: str, scopes: list[str], expires_delta: timedelta = timedelta(hours=1)) -> str:
    payload = {
        "sub": user_id,
        "scopes": scopes,
        "exp": datetime.now(timezone.utc) + expires_delta,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")
```

## CORS

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://myapp.com"],  # NEVER ["*"] in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

## Best Practices

- Store secrets in environment variables via `BaseSettings`, never in code.
- Use short-lived access tokens (15-60 min) + refresh tokens.
- Hash passwords with `bcrypt` or `argon2`.
- Always validate JWT signature AND expiration.
- Use HTTPS in production — enforce via reverse proxy.
- Rate limit auth endpoints to prevent brute force.
