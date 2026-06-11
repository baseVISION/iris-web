#  IRIS Source Code
#  Copyright (C) 2026 - DFIR-IRIS
#  contact@dfir-iris.org
#
#  This program is free software; you can redistribute it and/or modify
#  it under the terms of the GNU Lesser General Public License as
#  published by the Free Software Foundation; either version 3 of the
#  License, or (at your option) any later version.

from __future__ import annotations

import os
import re
from asyncio import Task, create_task
from collections.abc import Awaitable, Callable
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
from typing import Any, NamedTuple

from flask.sessions import SecureCookieSessionInterface
from itsdangerous import BadSignature
from pycrdt.store import SQLiteYStore, YDocNotFound
from pycrdt.websocket.asgi_server import ASGIWebsocket
from pycrdt.websocket.websocket_server import WebsocketServer, exception_logger
from pycrdt.websocket.yroom import YRoom

from app import app as flask_app
from app.business.access_controls import ac_fast_check_user_has_case_access
from app.models.authorization import CaseAccessLevel, User
from app.models.models import Notes


COLLAB_PATH_RE = re.compile(
    r"^/collab/(?P<room>(?:note-(?P<note_id>[0-9]+)|summary-(?P<summary_case_id>[0-9]+)))/?$"
)
COLLAB_STORE_DIR = Path(
    os.environ.get(
        "IRIS_COLLAB_STORE_PATH",
        str(
            Path(flask_app.config.get("DATASTORE_PATH", "/home/iris/server_data/datastore"))
            / "collab"
        ),
    )
)
COLLAB_STORE_DB = COLLAB_STORE_DIR / "yjs.sqlite3"


class AuthorizedRoom(NamedTuple):
    room_name: str
    user_id: int
    note_id: int | None
    case_id: int


class IrisSQLiteYStore(SQLiteYStore):
    db_path = str(COLLAB_STORE_DB)


class PersistedYRoom(YRoom):
    async def _start(self, task_status):
        if self.ystore is not None:
            assert self._task_group is not None
            async with self.ystore.start_lock:
                if not self.ystore.started.is_set():
                    await self._task_group.start(self.ystore.start)
            try:
                await self.ystore.apply_updates(self.ydoc)
            except YDocNotFound:
                pass

        await super()._start(task_status)

    async def stop(self) -> None:
        if self.ystore is not None and self.ystore.started.is_set():
            await self.ystore.stop()
        await super().stop()


class IrisCollabWebsocketServer(WebsocketServer):
    async def get_room(self, name: str) -> YRoom:
        if name not in self.rooms:
            ystore = IrisSQLiteYStore(path=name, log=self.log)
            self.rooms[name] = PersistedYRoom(
                ready=True,
                ystore=ystore,
                exception_handler=self.exception_handler,
                log=self.log,
            )

        room = self.rooms[name]
        await self.start_room(room)
        return room


class IrisCollabASGIApp:
    def __init__(self, websocket_server: WebsocketServer):
        self._websocket_server = websocket_server
        self._server_task: Task | None = None

    async def __call__(
        self,
        scope: dict[str, Any],
        receive: Callable[[], Awaitable[dict[str, Any]]],
        send: Callable[[dict[str, Any]], Awaitable[None]],
    ):
        if scope["type"] == "lifespan":
            await self._handle_lifespan(receive, send)
            return

        if scope["type"] == "http":
            await self._handle_http(scope, receive, send)
            return

        if scope["type"] != "websocket":
            return

        msg = await receive()
        if msg["type"] != "websocket.connect":
            return

        auth = authorize_scope(scope)
        if auth is None:
            await send({"type": "websocket.accept"})
            await send({"type": "websocket.close", "code": 1008})
            return

        await send({"type": "websocket.accept"})
        websocket = ASGIWebsocket(receive, send, auth.room_name)
        await self._websocket_server.serve(websocket)

    async def _handle_lifespan(
        self,
        receive: Callable[[], Awaitable[dict[str, Any]]],
        send: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> None:
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                COLLAB_STORE_DIR.mkdir(parents=True, exist_ok=True)
                self._server_task = create_task(self._websocket_server.start())
                await self._websocket_server.started.wait()
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                await self._websocket_server.stop()
                if self._server_task is not None:
                    await self._server_task
                    self._server_task = None
                await send({"type": "lifespan.shutdown.complete"})
                return

    async def _handle_http(
        self,
        scope: dict[str, Any],
        receive: Callable[[], Awaitable[dict[str, Any]]],
        send: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> None:
        if scope.get("method") == "GET" and scope.get("path") in {"/healthz", "/collab/healthz"}:
            body = b"ok\n"
            status = 200
        else:
            body = b"not found\n"
            status = 404

        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"text/plain; charset=utf-8"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


def authorize_scope(scope: dict[str, Any]) -> AuthorizedRoom | None:
    path = scope.get("path") or ""
    match = COLLAB_PATH_RE.match(path)
    if not match:
        flask_app.logger.warning(
            "Rejected collab websocket with invalid path: %s",
            path,
        )
        return None

    room_name = match.group("room")
    note_id = int(match.group("note_id")) if match.group("note_id") else None
    summary_case_id = int(match.group("summary_case_id")) if match.group("summary_case_id") else None
    session_data = _decode_session_cookie(scope)
    if not session_data:
        flask_app.logger.warning(
            "Rejected collab websocket for %s: missing or invalid session",
            room_name,
        )
        return None

    try:
        user_id = int(session_data.get("_user_id") or 0)
    except (TypeError, ValueError):
        user_id = 0

    if not user_id:
        flask_app.logger.warning("Rejected collab websocket for %s: missing user id", room_name)
        return None

    with flask_app.app_context():
        user = User.query.filter(User.id == user_id, User.active == True).first()
        if user is None:
            flask_app.logger.warning(
                "Rejected collab websocket for %s: inactive or unknown user %s",
                room_name,
                user_id,
            )
            return None

        if note_id is not None:
            note = Notes.query.with_entities(Notes.note_case_id).filter(
                Notes.note_id == note_id
            ).first()
            if note is None or note.note_case_id is None:
                flask_app.logger.warning("Rejected collab websocket for %s: unknown note", room_name)
                return None

            case_id = int(note.note_case_id)
        elif summary_case_id is not None:
            case_id = summary_case_id
        else:
            flask_app.logger.warning("Rejected collab websocket for %s: unknown room type", room_name)
            return None

        try:
            access = ac_fast_check_user_has_case_access(user_id, case_id, [CaseAccessLevel.full_access])
        except Exception:
            flask_app.logger.exception(
                "Rejected collab websocket for %s: access check failed for user %s case %s",
                room_name,
                user_id,
                case_id,
            )
            return None
        if access is None:
            flask_app.logger.warning(
                "Rejected collab websocket for %s: user %s lacks full access to case %s",
                room_name,
                user_id,
                case_id,
            )
            return None

    return AuthorizedRoom(room_name=room_name, user_id=user_id, note_id=note_id, case_id=case_id)


def _decode_session_cookie(scope: dict[str, Any]) -> dict[str, Any] | None:
    cookie_header = _get_header(scope, b"cookie")
    if not cookie_header:
        return None

    cookies = SimpleCookie()
    try:
        cookies.load(cookie_header.decode("latin1"))
    except CookieError:
        return None
    cookie_name = flask_app.config.get("SESSION_COOKIE_NAME", "session")
    session_cookie = cookies.get(cookie_name)
    if session_cookie is None or not session_cookie.value:
        return None

    serializer = SecureCookieSessionInterface().get_signing_serializer(flask_app)
    if serializer is None:
        return None

    try:
        max_age = int(flask_app.permanent_session_lifetime.total_seconds())
        session_data = serializer.loads(session_cookie.value, max_age=max_age)
    except BadSignature:
        return None

    return dict(session_data)


def _get_header(scope: dict[str, Any], header_name: bytes) -> bytes | None:
    for name, value in scope.get("headers") or []:
        if name.lower() == header_name:
            return value
    return None


websocket_server = IrisCollabWebsocketServer(exception_handler=exception_logger)
app = IrisCollabASGIApp(websocket_server)
