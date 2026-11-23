"""Dependency-free defaults shared by the desktop Runner and Hub services.

Keep values that are needed while the standalone Runner is starting out of
database-backed service modules.  The Runner intentionally ships without the
Hub's SQLAlchemy dependencies, so importing a convenience constant from a Hub
model service makes every non-Pi runtime fail before it can accept a job.
"""

from __future__ import annotations


# A fallback, not a discovered provider limit. Configure a larger budget explicitly
# for reasoning models when supported by the service. Keep the desktop default in sync.
DEFAULT_OUTPUT = 16384

