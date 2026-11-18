from fastapi import FastAPI

from .library import channels_router, playlists_router, users_router
from .sessions import CurrentUser, SessionUser
from .tasks import router as tasks_router

app = FastAPI(title='Tasks API', version='1.0.0')
app.include_router(tasks_router)
app.include_router(playlists_router)
app.include_router(channels_router)
app.include_router(users_router)


@app.get('/api/me', response_model=SessionUser, openapi_extra={'x-glirastes-ignore': True})
def me(user: CurrentUser) -> SessionUser:
    """The signed-in user; the chat runtime resolves the principal here."""
    return user


@app.get('/api/health', include_in_schema=False)
def health() -> dict[str, bool]:
    return {'ok': True}
