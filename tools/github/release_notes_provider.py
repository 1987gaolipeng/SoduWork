"""Safe release-note provider diagnostics and OpenRouter free-model checks."""
from __future__ import annotations

from decimal import Decimal, InvalidOperation
import json
import os
from pathlib import Path
import re
import urllib.error
from urllib.parse import urlsplit
import urllib.request


class ModelUnavailable(ValueError):
    def __init__(self, reason, http_status=None):
        super().__init__(reason)
        self.reason = reason
        self.http_status = http_status


def is_openrouter(endpoint):
    try:
        return urlsplit(endpoint).hostname in {"openrouter.ai", "eu.openrouter.ai", "us.openrouter.ai"}
    except ValueError:
        return False


def safe_model():
    value = os.environ.get("RELEASE_NOTES_MODEL", "")
    if "://" in value or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}", value):
        return "unconfigured-or-invalid"
    for name, secret in os.environ.items():
        if re.search("KEY|TOKEN|SECRET|PASSWORD", name) and len(secret) >= 4 and secret in value:
            return "redacted"
    return value


def log_event(event, **fields):
    print(json.dumps({"event": "release_notes_" + event, "model": safe_model(), **fields}), flush=True)


def classify_http(error):
    reason = {401: "credentials_rejected", 403: "access_denied", 404: "model_unavailable",
              429: "rate_limited"}.get(error.code, "provider_error")
    if error.code == 429:
        # Inspect only known markers; never retain or print the provider response.
        try:
            body = error.read(8192).decode("utf-8", errors="replace").lower()
            if "upstream" in body:
                reason = "upstream_rate_limited"
            elif "free-models-per-day" in body:
                reason = "daily_rate_limited"
        except (OSError, ValueError):
            pass
    return ModelUnavailable(reason, error.code)


def ensure_free_openrouter(model, endpoint, opener):
    if not is_openrouter(endpoint):
        return
    if model != "openrouter/free" and not model.endswith(":free"):
        raise ModelUnavailable("model_not_free")
    # This public lookup deliberately carries no Authorization header.
    catalog_url = "https://" + urlsplit(endpoint).hostname + "/api/v1/models"
    try:
        with opener.open(urllib.request.Request(catalog_url), timeout=30) as response:
            raw = response.read(8000001)
        if len(raw) > 8000000:
            raise ValueError("Catalog too large")
        rows = json.loads(raw)["data"]
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
            raise ValueError("Invalid catalog")
        matches = [row for row in rows if row.get("id") == model]
        if not matches and model.endswith(":free"):
            matches = [row for row in rows if str(row.get("id", "")).endswith(":free")
                       and row.get("canonical_slug", "") + ":free" == model]
        if not matches:
            raise ModelUnavailable("model_unavailable")
        pricing = matches[0]["pricing"]
        if not isinstance(pricing, dict) or not {"prompt", "completion"} <= pricing.keys():
            raise ValueError("Missing prices")
        overrides = pricing.get("overrides", [])
        if not isinstance(overrides, list) or overrides:
            raise ValueError("Conditional prices cannot be verified")
        for name, value in pricing.items():
            if name == "overrides":
                continue
            price = Decimal(str(value))
            if not price.is_finite() or price < 0:
                raise ValueError("Invalid price")
            if price != 0:
                raise ModelUnavailable("model_not_free")
    except ModelUnavailable:
        raise
    except urllib.error.HTTPError as error:
        raise ModelUnavailable("catalog_unavailable", error.code) from None
    except (OSError, ValueError, KeyError, TypeError, InvalidOperation):
        raise ModelUnavailable("catalog_unavailable") from None
    log_event("free_model_verified", provider="openrouter")


def report_result(record, elapsed, failure=None):
    unavailable = record.get("status") == "unavailable"
    reason = getattr(failure, "reason", "invalid_output") if unavailable else "generated"
    status = getattr(failure, "http_status", None)
    log_event("completed", status="unavailable" if unavailable else "generated",
              seconds=round(elapsed, 2), reason=reason, http_status=status)
    descriptions = {
        "configuration": "Model configuration is missing or invalid.",
        "model_unavailable": "The configured model is unavailable or is no longer listed.",
        "model_not_free": "The configured model is not verified as free; no inference request was sent.",
        "catalog_unavailable": "The model catalog or pricing could not be verified; no inference request was sent.",
        "credentials_rejected": "The provider rejected the selected API key.",
        "access_denied": "The provider denied access; check model and provider access rules.",
        "rate_limited": "The model request was rate limited.",
        "upstream_rate_limited": "The upstream provider temporarily rate limited this model.",
        "daily_rate_limited": "The account's daily free-model request limit was reached.",
        "provider_error": "The model provider returned an error.",
        "transport_error": "The model service could not be reached or the request timed out.",
        "invalid_output": "The model response failed release-note validation.",
    }
    if unavailable:
        message = descriptions.get(reason, descriptions["invalid_output"])
        if status is not None:
            message += f" HTTP {status}."
        message += " Release notes were left empty; packaging can continue."
        if is_openrouter(os.environ.get("RELEASE_NOTES_API_URL", "")):
            message += (" Check the OpenRouter model/provider allowlist. If this model is unavailable or paid,"
                        " allow a replacement free model in OpenRouter and update the GitHub repository variable"
                        " RELEASE_NOTES_MODEL. Keep RELEASE_NOTES_API_URL and RELEASE_NOTES_API_KEY_SECRET matched.")
        else:
            message += " Check the RELEASE_NOTES_* repository variables and the selected API key Secret."
        escaped = message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print("::warning title=Release notes unavailable::" + escaped, flush=True)
    else:
        message = "Generated and validated release notes in all four languages."
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        try:
            with Path(summary).open("a", encoding="utf-8") as stream:
                stream.write(f"\n### Release notes\n\nModel: `{safe_model()}` · {elapsed:.2f} seconds\n\n{message}\n")
        except OSError:
            print("::warning title=Release notes summary unavailable::Could not append the job summary.", flush=True)
