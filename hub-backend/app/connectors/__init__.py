"""Connector registry used by the scheduler to resolve platform adapters by type."""
from .base import Connector
from .example import ExampleConnector
from .gitlab import GitLabConnector
from .github import GitHubConnector
from .ppm import PpmConnector
from .testplat import TestPlatConnector

REGISTRY: dict[str, Connector] = {
    ExampleConnector.type: ExampleConnector(),
    GitLabConnector.type: GitLabConnector(),
    GitHubConnector.type: GitHubConnector(),
    TestPlatConnector.type: TestPlatConnector(),   # Push-only testing-platform issue adapter.
    PpmConnector.type: PpmConnector(),             # PPM MCP polling adapters.
}


def get_connector(type_: str) -> Connector | None:
    return REGISTRY.get(type_)


__all__ = ["Connector", "REGISTRY", "get_connector"]
