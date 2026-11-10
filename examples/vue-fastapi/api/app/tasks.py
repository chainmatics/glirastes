from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from .sessions import CurrentUser, session_user

TaskStatus = Literal['open', 'done']


class Task(BaseModel):
    id: str
    title: str
    status: TaskStatus


class TaskList(BaseModel):
    tasks: list[Task]


class TaskCreate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str = Field(min_length=1)


# Reference data per user; a real app reads its database here.
_tasks: dict[str, list[Task]] = {}


def tasks_of(subject_id: str) -> list[Task]:
    if subject_id not in _tasks:
        _tasks[subject_id] = [
            Task(id='1', title='Write tests', status='open'),
            Task(id='2', title='Ship the fixture', status='done'),
        ]
    return _tasks[subject_id]


router = APIRouter(prefix='/api/tasks', tags=['tasks'], dependencies=[Depends(session_user)])


@router.get('', response_model=TaskList)
def list_tasks(user: CurrentUser, status: TaskStatus | None = None) -> TaskList:
    """List your tasks, optionally only open or done ones."""
    return TaskList(tasks=[task for task in tasks_of(user.subjectId) if status is None or task.status == status])


@router.post('', status_code=201, response_model=Task, openapi_extra={'x-glirastes-effect': 'write'})
def create_task(user: CurrentUser, body: TaskCreate) -> Task:
    """Create a task with a title."""
    tasks = tasks_of(user.subjectId)
    task = Task(id=str(len(tasks) + 1), title=body.title, status='open')
    tasks.append(task)
    return task
