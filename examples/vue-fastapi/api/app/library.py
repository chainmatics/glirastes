"""Second acceptance fixture: data shapes that deliberately differ from the pilot app.

Integer ids under entity-specific keys (`playlist_id`, `item_id`, `version_id`,
`revision_id`), a slug-like `key` for channels, `displayName` instead of
`name`, a version record without any name (`versionNumber`) and a variant
with `rev`, users whose integer ids collide with playlist ids, and signed
file URLs that must never reach the model.

The data is seeded deterministically per user on first access; nothing is
stored, so a restart of the API resets every delete and rollback.
See docs/acceptance/second-app-vue-fastapi.md.
"""
import hashlib
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, ConfigDict

from .sessions import CurrentUser, session_user

PlaylistStatus = Literal['draft', 'published', 'archived']

PLAYLIST_COUNT = 60
"""Every 10th playlist (10, 20, ...) has this many items, the others 3 to 14."""
LARGE_PLAYLIST_ITEMS = 64

_ADJECTIVES = [
    'Morning', 'Evening', 'Lobby', 'Quiet', 'Summer', 'Winter', 'Weekend', 'Rush Hour',
    'Holiday', 'Night', 'Spring', 'Autumn', 'Lunch', 'Opening', 'Closing',
]
_NOUNS = ['Loop', 'Showcase', 'Highlights', 'Rotation']
_STATUSES: list[PlaylistStatus] = ['published', 'draft', 'published', 'archived', 'published']


# Declared identity (docs/acceptance/second-app-vue-fastapi.md): every declaration
# site once. Schema level (`x-glirastes-entity` via pydantic json_schema_extra)
# for playlists, their items and users; operation level (`x-glirastes-entities`)
# for versions and revisions; parameters (`x-glirastes-entity-ref`); channels in
# .glirastes/tools.json `identity`.


class PlaylistItem(BaseModel):
    model_config = ConfigDict(json_schema_extra={'x-glirastes-entity': {'id': 'item_id', 'name': 'displayName'}})

    item_id: int
    displayName: str
    durationSec: int
    fileUrl: str


class Playlist(BaseModel):
    model_config = ConfigDict(json_schema_extra={'x-glirastes-entity': {'id': 'playlist_id', 'name': 'displayName'}})

    playlist_id: int
    displayName: str
    status: PlaylistStatus
    ownerKey: str
    items: list[PlaylistItem]


class PlaylistPage(BaseModel):
    playlists: list[Playlist]
    total: int
    limit: int | None = None
    offset: int = 0


class PlaylistVersion(BaseModel):
    version_id: int
    versionNumber: int
    playlist_id: int
    createdAt: str


class PlaylistVersionList(BaseModel):
    versions: list[PlaylistVersion]


class Channel(BaseModel):
    key: str
    title: str
    playlist_id: int | None
    live: bool


class ChannelList(BaseModel):
    channels: list[Channel]


class ChannelRevision(BaseModel):
    """The variant of a version record: `rev` instead of `versionNumber`, no name."""
    revision_id: int
    rev: int
    channelKey: str
    createdAt: str


class ChannelRevisionList(BaseModel):
    revisions: list[ChannelRevision]


class User(BaseModel):
    model_config = ConfigDict(json_schema_extra={'x-glirastes-entity': {'type': 'user', 'id': 'id', 'name': 'displayName'}})

    id: int
    displayName: str


class UserList(BaseModel):
    users: list[User]


def _signed_url(playlist_id: int, item_id: int) -> str:
    signature = hashlib.sha256(f'fixture:{playlist_id}:{item_id}'.encode()).hexdigest()
    return (f'https://media.example.test/playlists/{playlist_id}/items/{item_id}.mp4'
            f'?X-Amz-Expires=900&X-Amz-Signature={signature}')


def _playlist(playlist_id: int) -> Playlist:
    index = playlist_id - 1
    name = f'{_ADJECTIVES[index % len(_ADJECTIVES)]} {_NOUNS[index // len(_ADJECTIVES)]}'
    count = LARGE_PLAYLIST_ITEMS if playlist_id % 10 == 0 else 3 + (playlist_id * 7) % 12
    items = [
        PlaylistItem(
            item_id=playlist_id * 1000 + position,
            displayName=f'{name} clip {position}',
            durationSec=15 + (playlist_id + position) % 4 * 15,
            fileUrl=_signed_url(playlist_id, playlist_id * 1000 + position),
        )
        for position in range(1, count + 1)
    ]
    return Playlist(
        playlist_id=playlist_id,
        displayName=name,
        status=_STATUSES[index % len(_STATUSES)],
        ownerKey=['ada', 'grace', 'linus'][index % 3],
        items=items,
    )


def _versions(playlist_id: int) -> list[PlaylistVersion]:
    return [
        PlaylistVersion(
            version_id=playlist_id * 100 + number,
            versionNumber=number,
            playlist_id=playlist_id,
            createdAt=f'2026-0{number}-1{playlist_id % 10}T09:00:00Z',
        )
        for number in range(1, 5)
    ]


_CHANNELS = [
    ('lobby', 'Lobby screens', 3),
    ('foyer', 'Foyer wall', 1),
    ('cafeteria', 'Cafeteria', None),
]
_USERS = ['Ada Lovelace', 'Grace Hopper', 'Linus Torvalds', 'Margaret Hamilton', 'Alan Turing']


class _Library:
    def __init__(self) -> None:
        self.playlists = {playlist_id: _playlist(playlist_id) for playlist_id in range(1, PLAYLIST_COUNT + 1)}
        self.versions = {playlist_id: _versions(playlist_id) for playlist_id in self.playlists}
        self.channels = {key: Channel(key=key, title=title, playlist_id=playlist, live=key != 'cafeteria')
                         for key, title, playlist in _CHANNELS}
        self.revisions = {
            key: [ChannelRevision(revision_id=500 + position * 10 + rev, rev=rev, channelKey=key,
                                  createdAt=f'2026-10-0{rev}T08:00:00Z') for rev in range(1, 4)]
            for position, key in enumerate(self.channels)
        }
        self.users = {user_id: User(id=user_id, displayName=name) for user_id, name in enumerate(_USERS, start=1)}


# One deterministic library per signed-in user; a real app reads its database here.
_libraries: dict[str, _Library] = {}


def library_of(subject_id: str) -> _Library:
    if subject_id not in _libraries:
        _libraries[subject_id] = _Library()
    return _libraries[subject_id]


def _playlist_or_404(library: _Library, playlist_id: int) -> Playlist:
    playlist = library.playlists.get(playlist_id)
    if playlist is None:
        raise HTTPException(status_code=404, detail=f'Playlist {playlist_id} not found')
    return playlist


def _channel_or_404(library: _Library, key: str) -> Channel:
    channel = library.channels.get(key)
    if channel is None:
        raise HTTPException(status_code=404, detail=f'Channel {key} not found')
    return channel


playlists_router = APIRouter(prefix='/api/playlists', tags=['playlists'], dependencies=[Depends(session_user)])
channels_router = APIRouter(prefix='/api/channels', tags=['channels'], dependencies=[Depends(session_user)])
users_router = APIRouter(prefix='/api/users', tags=['users'], dependencies=[Depends(session_user)])


@playlists_router.get('', response_model=PlaylistPage, openapi_extra={
    'x-glirastes-output-allowed-fields': [
        'playlists[].playlist_id', 'playlists[].displayName', 'playlists[].status', 'playlists[].ownerKey',
        'playlists[].items', 'total', 'limit', 'offset',
    ],
    'x-glirastes-output-default-fields': [
        'playlists[].playlist_id', 'playlists[].displayName', 'playlists[].status', 'total',
    ],
    # Search only, never sent to the model: Polish words find the tool too.
    'x-glirastes-synonyms': {'pl': ['playlisty', 'listy odtwarzania']},
})
def list_playlists(
    user: CurrentUser,
    status: PlaylistStatus | None = None,
    limit: int | None = Query(default=None, ge=1, le=100, description='Omit to get all playlists'),
    offset: int = Query(default=0, ge=0, description='Number of playlists to skip'),
) -> PlaylistPage:
    """List your playlists with their items, optionally only one status."""
    matching = [playlist for playlist in library_of(user.subjectId).playlists.values()
                if status is None or playlist.status == status]
    page = matching[offset:] if limit is None else matching[offset:offset + limit]
    return PlaylistPage(playlists=page, total=len(matching), limit=limit, offset=offset)


# Titles in three languages; tool-semantics.json overrides German only (mixing per language).
@playlists_router.get('/{playlist_id}', response_model=Playlist, openapi_extra={
    'x-glirastes-title': {'en': 'Show playlist', 'de': 'Playlist anzeigen', 'pl': 'Pokaż playlistę'},
})
def get_playlist(user: CurrentUser, playlist_id: int = Path(json_schema_extra={'x-glirastes-entity-ref': {'type': 'playlist'}})) -> Playlist:
    """Get one playlist with all its items."""
    return _playlist_or_404(library_of(user.subjectId), playlist_id)


@playlists_router.delete('/{playlist_id}', status_code=204, openapi_extra={
    'x-glirastes-effect': 'destructive',
    'x-glirastes-title': {'en': 'Delete playlist', 'de': 'Playlist löschen', 'pl': 'Usuń playlistę'},
})
def delete_playlist(user: CurrentUser, playlist_id: int = Path(json_schema_extra={'x-glirastes-entity-ref': {'type': 'playlist'}})) -> None:
    """Delete a playlist and its versions."""
    library = library_of(user.subjectId)
    _playlist_or_404(library, playlist_id)
    del library.playlists[playlist_id]
    del library.versions[playlist_id]


@playlists_router.get('/{playlist_id}/versions', response_model=PlaylistVersionList, openapi_extra={
    'x-glirastes-entities': [
        {'type': 'playlist-version', 'id': 'version_id', 'fallback': 'versionNumber', 'path': 'versions[]'},
    ],
})
def list_playlist_versions(user: CurrentUser, playlist_id: int = Path(json_schema_extra={'x-glirastes-entity-ref': {'type': 'playlist', 'role': 'parent'}})) -> PlaylistVersionList:
    """List the saved versions of a playlist, oldest first."""
    library = library_of(user.subjectId)
    _playlist_or_404(library, playlist_id)
    return PlaylistVersionList(versions=library.versions[playlist_id])


@playlists_router.post('/{playlist_id}/versions/{version_id}/rollback', response_model=PlaylistVersion,
                       openapi_extra={'x-glirastes-effect': 'write', 'x-glirastes-entities': [
                           {'type': 'playlist-version', 'id': 'version_id', 'fallback': 'versionNumber', 'path': ''},
                       ]})
def roll_back_playlist(user: CurrentUser, playlist_id: int = Path(json_schema_extra={'x-glirastes-entity-ref': {'type': 'playlist', 'role': 'parent'}}),
                       version_id: int = Path(json_schema_extra={'x-glirastes-entity-ref': {'type': 'playlist-version'}})) -> PlaylistVersion:
    """Roll a playlist back to one of its saved versions."""
    library = library_of(user.subjectId)
    _playlist_or_404(library, playlist_id)
    for version in library.versions[playlist_id]:
        if version.version_id == version_id:
            return version
    raise HTTPException(status_code=404, detail=f'Version {version_id} not found')


@channels_router.get('', response_model=ChannelList)
def list_channels(user: CurrentUser) -> ChannelList:
    """List the screen channels and the playlist each one plays."""
    return ChannelList(channels=list(library_of(user.subjectId).channels.values()))


# A partial translation: German only. English comes from the template, Polish falls back to English.
@channels_router.delete('/{key}', status_code=204, openapi_extra={
    'x-glirastes-effect': 'destructive',
    'x-glirastes-title': {'de': 'Kanal löschen'},
})
def delete_channel(user: CurrentUser, key: str = Path(json_schema_extra={'x-glirastes-entity-ref': {'type': 'channel'}, 'x-glirastes-id-kind': 'speaking'})) -> None:
    """Delete a channel by its key."""
    library = library_of(user.subjectId)
    _channel_or_404(library, key)
    del library.channels[key]


@channels_router.get('/{key}/revisions', response_model=ChannelRevisionList, openapi_extra={
    'x-glirastes-entities': [
        {'type': 'channel-revision', 'id': 'revision_id', 'fallback': 'rev', 'path': 'revisions[]'},
    ],
})
def list_channel_revisions(user: CurrentUser, key: str = Path(json_schema_extra={'x-glirastes-entity-ref': {'type': 'channel', 'role': 'parent'}, 'x-glirastes-id-kind': 'speaking'})) -> ChannelRevisionList:
    """List the saved revisions of a channel's settings, oldest first."""
    library = library_of(user.subjectId)
    _channel_or_404(library, key)
    return ChannelRevisionList(revisions=library.revisions[key])


@channels_router.post('/{key}/revisions/{revision_id}/rollback', response_model=ChannelRevision,
                      openapi_extra={'x-glirastes-effect': 'write', 'x-glirastes-entities': [
                          {'type': 'channel-revision', 'id': 'revision_id', 'fallback': 'rev', 'path': ''},
                      ]})
def roll_back_channel(user: CurrentUser, key: str = Path(json_schema_extra={'x-glirastes-entity-ref': {'type': 'channel', 'role': 'parent'}, 'x-glirastes-id-kind': 'speaking'}),
                      revision_id: int = Path(json_schema_extra={'x-glirastes-entity-ref': {'type': 'channel-revision'}})) -> ChannelRevision:
    """Roll a channel's settings back to one of its saved revisions."""
    library = library_of(user.subjectId)
    _channel_or_404(library, key)
    for revision in library.revisions[key]:
        if revision.revision_id == revision_id:
            return revision
    raise HTTPException(status_code=404, detail=f'Revision {revision_id} not found')


@users_router.get('', response_model=UserList)
def list_users(user: CurrentUser) -> UserList:
    """List the users of your workspace."""
    return UserList(users=list(library_of(user.subjectId).users.values()))


@users_router.delete('/{user_id}', status_code=204, openapi_extra={'x-glirastes-effect': 'destructive'})
def delete_user(user: CurrentUser, user_id: int = Path(json_schema_extra={'x-glirastes-entity-ref': {'type': 'user'}})) -> None:
    """Remove a user from your workspace."""
    library = library_of(user.subjectId)
    if user_id not in library.users:
        raise HTTPException(status_code=404, detail=f'User {user_id} not found')
    del library.users[user_id]
