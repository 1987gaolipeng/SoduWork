"""Private single-host Docker Compose launcher. Never manages existing clusters."""
from __future__ import annotations

import argparse
import base64
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

from .local_environment import ROOT, StartupError
from .start_local import secure_directory, exclusive

COMPOSE = ROOT / "ops/self-host/compose.yaml"
SCHEMA = 1
SECRET_KEYS = ("databasePassword", "adminPassword", "authSecret", "oauthKey")


def default_state() -> Path:
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "SoduWork/self-host"
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/SoduWork/self-host"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "soduwork/self-host"


def public_url(value: str, port: int) -> str:
    value = value.rstrip("/") or f"http://127.0.0.1:{port}"
    parsed = urlsplit(value)
    try:
        local = parsed.hostname == "localhost" or ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        local = False
    if (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment or parsed.path
            or (not local and parsed.scheme != "https")):
        raise StartupError("--public-url must be an HTTPS origin (or loopback HTTP), without credentials or a path.")
    try:
        parsed.port
    except ValueError as exc:
        raise StartupError("--public-url has an invalid port.") from exc
    return value


def state_path(value: Path) -> Path:
    state = value.expanduser().resolve()
    if state.is_relative_to(ROOT) or state in ROOT.parents or state == Path.home():
        raise StartupError("Use a dedicated private --data-dir outside the source checkout.")
    return state


def initialize(state: Path, *, create: bool, port: int | None, origin: str | None) -> dict:
    file = state / "deployment.json"
    if file.is_file():
        try:
            config = json.loads(file.read_text(encoding="utf-8"))
            if (not isinstance(config, dict) or config.get("schema") != SCHEMA or not re.fullmatch(r"soduwork-[a-f0-9]{12}", config.get("project", ""))
                    or not 1024 <= config["port"] <= 65535
                    or any(not re.fullmatch(r"[A-Za-z0-9_=-]{32,}", config.get(key, "")) for key in SECRET_KEYS)):
                raise ValueError("Invalid deployment settings")
            if public_url(config["publicUrl"], config["port"]) != config["publicUrl"]:
                raise ValueError("Invalid public URL")
        except (ValueError, KeyError, TypeError) as exc:
            raise StartupError("Cannot read deployment.json; restore its private backup. No credentials were reset.") from exc
        if ((port is not None and port != config["port"])
                or (origin is not None and public_url(origin, config["port"]) != config["publicUrl"])):
            raise StartupError("This instance already exists. Edit its private deployment.json to change its port or publicUrl.")
        return config
    if not create:
        raise StartupError("No self-host instance here. Run python ops/self-host/deploy.py up first (or select its --data-dir).")
    if state.exists() and any(state.iterdir()):
        raise StartupError("The directory is not empty and is not a SoduWork self-host instance.")
    chosen_port = 18989 if port is None else port
    config = {"schema": SCHEMA, "project": "soduwork-" + secrets.token_hex(6), "port": chosen_port,
              "publicUrl": public_url(origin or "", chosen_port),
              "databasePassword": secrets.token_urlsafe(36), "adminPassword": secrets.token_urlsafe(24),
              "authSecret": secrets.token_urlsafe(48), "oauthKey": base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()}
    secure_directory(state)
    with file.open("x", encoding="utf-8") as output:
        json.dump(config, output, indent=2)
    if os.name != "nt":
        file.chmod(0o600)
    return config


def environment(config: dict) -> dict:
    # Docker client configuration and ordinary network proxy settings are retained.
    # Compose variables, inherited production DBs and credentials are not accepted.
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith(("COMPOSE_", "SODUWORK_", "DATABASE_", "AUTH_", "ADMIN_"))}
    env.update({"SODUWORK_DB_PASSWORD": config["databasePassword"],
                "SODUWORK_ADMIN_PASSWORD": config["adminPassword"],
                "SODUWORK_AUTH_SECRET": config["authSecret"], "SODUWORK_OAUTH_KEY": config["oauthKey"],
                "SODUWORK_HTTP_PORT": str(config["port"]), "SODUWORK_PUBLIC_URL": config["publicUrl"]})
    return env


def docker_ready(docker: str) -> None:
    # Do not accidentally operate a remote Docker daemon selected by a developer.
    endpoint = "" if os.environ.get("DOCKER_CONTEXT") else os.environ.get("DOCKER_HOST", "")
    if not endpoint:
        result = subprocess.run([docker, "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
                                text=True, capture_output=True, timeout=20, check=True)
        endpoint = result.stdout.strip()
    if not endpoint.startswith(("unix://", "npipe://")):
        raise StartupError("Select a local Docker Engine/Desktop context; this launcher does not deploy to remote Docker hosts.")
    subprocess.run([docker, "compose", "version"], check=True, timeout=20)
    result = subprocess.run([docker, "info", "--format", "{{.OSType}}"],
                            check=True, timeout=30, text=True, capture_output=True)
    if result.stdout.strip() != "linux":
        raise StartupError("Switch Docker Desktop to Linux containers before starting SoduWork.")


def compose_command(docker: str, state: Path, config: dict) -> list[str]:
    # An explicit empty env file prevents the checkout's private .env being read.
    empty = state / "compose.empty.env"
    if not empty.exists():
        empty.write_text("# Values come from this instance's private deployment.json.\n", encoding="utf-8")
    return [docker, "compose", "--project-name", config["project"], "--env-file", str(empty), "--project-directory", str(COMPOSE.parent), "-f", "-"]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", default="up", choices=("up", "status", "logs", "stop", "credentials"))
    parser.add_argument("--data-dir", type=Path, default=default_state())
    parser.add_argument("--port", type=int, help="First initialization only; default 18989")
    parser.add_argument("--public-url", help="HTTPS origin of your reverse proxy; default loopback HTTP")
    parser.add_argument("--no-build", action="store_true", help="Use the existing locally built image (up only)")
    args = parser.parse_args(argv)
    if args.port is not None and not 1024 <= args.port <= 65535:
        parser.error("--port must be between 1024 and 65535")
    try:
        state = state_path(args.data_dir)
        config = initialize(state, create=args.command == "up", port=args.port, origin=args.public_url)
        if args.command == "credentials":
            print("Administrator: admin\nInitial password: " + config["adminPassword"])
            print("Only used when the account database is first created; later password changes are authoritative.")
            return 0
        docker = shutil.which("docker")
        if not docker:
            raise StartupError("Install Docker Engine/Desktop with Compose v2 first. See ops/self-host/README.md.")
        docker_ready(docker)
        with exclusive(state):
            base = compose_command(docker, state, config)
            options = {"env": environment(config), "cwd": ROOT, "check": True,
                       "input": COMPOSE.read_text(encoding="utf-8"), "text": True}
            if args.command == "up":
                # Compose waits for both database and application readiness. Failed
                # setup is retained for diagnosis, never reported as a healthy service.
                extra = ["--no-build"] if args.no_build else ["--build"]
                subprocess.run(base + ["up", "--detach", "--wait", "--wait-timeout", "240"] + extra, **options)
                print(f"SoduWork is ready: {config['publicUrl']}")
                print(f"Private instance configuration: {state / 'deployment.json'}")
                print("Use python ops/self-host/deploy.py credentials (with the same --data-dir) for the initial admin password.")
            elif args.command == "stop":
                subprocess.run(base + ["stop", "--timeout", "45"], **options)
                print("This instance is stopped. Database, files and credentials are retained.")
            elif args.command == "status":
                subprocess.run(base + ["ps"], **options)
            else:
                subprocess.run(base + ["logs", "--tail", "150"], **options)
        return 0
    except KeyboardInterrupt:
        print("Operation interrupted. Inspect this instance with python ops/self-host/deploy.py status; data was not removed.")
        return 130
    except (StartupError, OSError, subprocess.SubprocessError) as exc:
        # CalledProcessError includes argv only; no secrets are supplied there.
        print(f"SoduWork deployment failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
