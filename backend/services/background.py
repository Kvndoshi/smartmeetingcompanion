"""Fire-and-forget task helpers with logging and per-key serialisation."""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Any, Awaitable, Callable

logger = logging.getLogger("interpreter.background")

_tasks: set[asyncio.Task[Any]] = set()
_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


def _done(task: asyncio.Task[Any]) -> None:
    _tasks.discard(task)
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.error("Background task %s failed: %s", task.get_name(), exc, exc_info=exc)


def spawn(coro: Awaitable[Any], name: str | None = None) -> asyncio.Task[Any]:
    task = asyncio.ensure_future(coro)
    if name:
        task.set_name(name)
    _tasks.add(task)
    task.add_done_callback(_done)
    return task


def lock_for(key: str) -> asyncio.Lock:
    """Serialise work on one resource (e.g. summarising one meeting)."""
    return _locks[key]


async def run_locked(key: str, fn: Callable[[], Awaitable[Any]]) -> Any:
    async with lock_for(key):
        return await fn()


async def drain(timeout: float = 10.0) -> None:
    pending = [t for t in _tasks if not t.done()]
    if not pending:
        return
    done, still = await asyncio.wait(pending, timeout=timeout)
    for task in still:
        task.cancel()
