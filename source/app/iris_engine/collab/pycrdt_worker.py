#  IRIS Source Code
#  Copyright (C) 2026 - DFIR-IRIS
#  contact@dfir-iris.org
#
#  This program is free software; you can redistribute it and/or
#  modify it under the terms of the GNU Lesser General Public
#  License as published by the Free Software Foundation; either
#  version 3 of the License, or (at your option) any later version.

"""Confines all pycrdt (Yrs) work to a single dedicated thread.

pycrdt's Rust objects (`Doc`, `XmlFragment`, and the transaction/
subscription handles pyo3 wraps around them) are `!Send`: yrs uses
`Rc<RefCell<...>>` internally, so if Python's cyclic garbage collector
drops one of these objects on a thread other than the one that created
it, pyo3 raises:

    RuntimeError: pycrdt::subscription::Subscription is unsendable,
    but is being dropped on another thread

Gunicorn runs this app under a `gthread` worker (many request-handling
threads sharing one heap/GIL). CPython's *automatic* generational
collector can fire from any thread the moment its allocation counter
crosses a threshold — so a `Doc` created while resolving a note on
thread A can get collected, and crash, while thread B is busy doing
something completely unrelated (e.g. a SQLAlchemy query). That's why
the traceback in production never mentions collab code.

Fix: disable automatic collection process-wide and route every pycrdt
call, plus the `gc.collect()` that reclaims it, through this one
worker thread. Objects are then always created and destroyed on the
same thread, which is what pyo3 requires.
"""
from __future__ import annotations

import gc
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, TypeVar

T = TypeVar("T")

# Automatic, threshold-triggered collection can run on any thread. Disabling
# it process-wide is what makes the explicit gc.collect() below in
# `_run_and_collect` (always on `_executor`'s single thread) the only place
# cyclic garbage collection ever happens.
gc.disable()

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="pycrdt-worker")


def run(fn: Callable[..., T], *args, **kwargs) -> T:
    """Run `fn(*args, **kwargs)` on the dedicated pycrdt thread and return its result.

    Every pycrdt `Doc`/`XmlFragment` created inside `fn` is guaranteed to be
    garbage-collected on this same thread before `run()` returns.
    """
    return _executor.submit(_run_and_collect, fn, args, kwargs).result()


def _run_and_collect(fn, args, kwargs):
    try:
        return fn(*args, **kwargs)
    finally:
        gc.collect()
