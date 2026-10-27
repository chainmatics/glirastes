"""Reference session store. Never use it in place of the app's own auth.

The sessions come from the FIXTURE_SESSIONS environment variable, a JSON
object of token to user, so the fixture has no login route of its own.
"""
import json
import os
from typing import Annotated

from fastapi import Depends, HTTPException, Security
from fastapi.security import APIKeyCookie, HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel


class SessionUser(BaseModel):
    subjectId: str
    tenantId: str
    roles: list[str]
    attributes: dict[str, object] = {}


_sessions: dict[str, SessionUser] = {
    token: SessionUser.model_validate(user)
    for token, user in json.loads(os.environ.get('FIXTURE_SESSIONS', '{}')).items()
}

session_cookie = APIKeyCookie(name='session', auto_error=False)
bearer_token = HTTPBearer(auto_error=False)


def session_user(
    cookie: Annotated[str | None, Security(session_cookie)],
    bearer: Annotated[HTTPAuthorizationCredentials | None, Security(bearer_token)],
) -> SessionUser:
    """The user of the `session` cookie of the browser, or of a bearer token."""
    token = bearer.credentials if bearer else cookie
    user = _sessions.get(token or '')
    if user is None:
        raise HTTPException(status_code=401, detail='Unauthenticated')
    return user.model_copy(deep=True)


CurrentUser = Annotated[SessionUser, Depends(session_user)]
