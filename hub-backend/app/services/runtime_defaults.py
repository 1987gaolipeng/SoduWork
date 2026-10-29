"""Dependency-free defaults shared by the desktop Runner and Hub services.

Keep values that are needed while the standalone Runner is starting out of
database-backed service modules.  The Runner intentionally ships without the
Hub's SQLAlchemy dependencies, so importing a convenience constant from a Hub
model service makes every non-Pi runtime fail before it can accept a job.
"""

from __future__ import annotations


# Leave enough room for reasoning-capable coding models to reach a tool call or
# final answer.  An administrator supplied maxOutputTokens remains authoritative.
DEFAULT_OUTPUT = 32768

