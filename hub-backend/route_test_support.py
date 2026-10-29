"""Effective API route inventory across eager and lazy FastAPI inclusion layouts."""
from fastapi.routing import APIRoute


def api_routes(app):
    for route in app.routes:
        if isinstance(route, APIRoute):
            yield route
        elif callable(getattr(route, "effective_route_contexts", None)):
            for context in route.effective_route_contexts():
                if isinstance(context.original_route, APIRoute):
                    yield context
