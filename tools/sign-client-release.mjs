#!/usr/bin/env node
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import {
  createReadStream,
  existsSync,
  openAsBlob,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import compatibility from "../client/scripts/installer-compatibility-report.cjs";

// Stable releases use canonical x.y.z; staging candidates carry a semver
// prerelease suffix x.y.z-beta.N so iterating betas never consumes the stable number.
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(1|[1-9]\d*))?$/;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function fail(message) {
  throw new Error(message);
}

function env(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function privateKey(rawBase64) {
  const raw = Buffer.from(rawBase64, "base64");
  if (raw.length !== 32 || raw.toString("base64") !== rawBase64) {
    fail("SODUWORK_CLIENT_SIGNING_KEY_FILE must contain one canonical Base64 Ed25519 seed");
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

function publicKeyRaw(key) {
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  return Buffer.from(der).subarray(-32).toString("base64");
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function parseBundle(path, installer, version, digest, size, key, expected) {
  const bundle = JSON.parse(readFileSync(path, "utf8"));
  const signature = String(bundle.signature || "");
  const payload = { ...bundle };
  delete payload.signature;
  if (bundle.schema !== 1 || bundle.version !== version || !/^[0-9a-f-]{36}$/i.test(bundle.releaseId || '') ||
      bundle.artifact?.url !== `/api/v1/client-updates/artifacts/${bundle.releaseId}` ||
      bundle.artifact?.name !== basename(installer) ||
      bundle.artifact?.size !== size || bundle.artifact?.sha256 !== digest ||
      bundle.keyId !== expected.keyId || bundle.channel !== expected.channel ||
      bundle.platform !== expected.platform || bundle.arch !== expected.arch || bundle.minVersion !== expected.minimum ||
      bundle.mandatory !== expected.mandatory || bundle.notes !== expected.notes ||
      !verifyBytes(null, Buffer.from(canonical(payload)), createPublicKey(key),
        Buffer.from(signature, "base64"))) {
    fail("existing signed release bundle does not match this installer");
  }
  return bundle;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((value) => value !== "--dry-run");
  if (positional.length !== 1) fail("usage: sign-client-release.mjs <installer> [--dry-run]");

  const installer = resolve(positional[0]);
  if (!existsSync(installer)) fail("installer does not exist");
  const name = basename(installer);
  const platform = env("SODUWORK_CLIENT_PLATFORM", "win32");
  if (!["win32", "darwin", "linux"].includes(platform)) fail("SODUWORK_CLIENT_PLATFORM must be win32, darwin or linux");
  /* Accept the SoduWork- prefix and existing SoduWork-/SoduWork- artifact names for compatibility. */
  const stem = '(?:SoduWork|SoduWork|SoduWork)';
  const patterns = {
    win32: new RegExp(`^${stem}-(${stemVersion})-Setup\\.exe$`),
    darwin: new RegExp(`^${stem}-(${stemVersion})-mac(?:-(x64|arm64))?\\.(dmg|zip)$`),
    linux: new RegExp(`^${stem}-(${stemVersion})-linux(?:-(x64|arm64))?\\.(AppImage|deb|rpm|tar\\.gz)$`),
  };
  const match = patterns[platform].exec(name);
  if (!match || !VERSION_RE.test(match[1])) fail(`installer filename does not match the ${platform} convention (SoduWork-x.y.z-...)`);
  const version = match[1];
  const size = statSync(installer).size;
  if (size < 1024 * 1024) fail("installer is too small");
  const digest = await sha256(installer);
  if (!dryRun) {
    const receiptPath = resolve(env("SODUWORK_CLIENT_COMPATIBILITY_REPORT", installer + ".compatibility.json"));
    if (existsSync(receiptPath)) {
      compatibility.validateReport(JSON.parse(readFileSync(receiptPath, "utf8")), {
        version, size, sha256: digest, platform, arch: env("SODUWORK_CLIENT_ARCH", "x64"),
      }, compatibility.readBuildInputs(join(dirname(fileURLToPath(import.meta.url)), "..", "client")));
    } else if (platform === "win32") {
      fail("installer compatibility receipt is required before upload");
    } else {
      process.stdout.write(`no compatibility receipt for ${platform}; skipping gate (manual build)\n`);
    }
  }

  const keyFile = resolve(env("SODUWORK_CLIENT_SIGNING_KEY_FILE"));
  if (!env("SODUWORK_CLIENT_SIGNING_KEY_FILE") || !existsSync(keyFile)) {
    fail("SODUWORK_CLIENT_SIGNING_KEY_FILE is required");
  }
  const keyId = env("SODUWORK_CLIENT_SIGNING_KEY_ID", "");
  if (!KEY_ID_RE.test(keyId)) fail("SODUWORK_CLIENT_SIGNING_KEY_ID is invalid");
  const key = privateKey(readFileSync(keyFile, "ascii").trim());

  const here = dirname(fileURLToPath(import.meta.url));
  const trustFile = resolve(env("SODUWORK_CLIENT_TRUST_FILE", join(here, "..", "client", "update-trust.json")));
  const trust = JSON.parse(readFileSync(trustFile, "utf8"));
  if (String(trust?.keys?.[keyId] || "") !== publicKeyRaw(key)) {
    fail(`signing key ${keyId} is not trusted by this client source tree`);
  }

  const channel = env("SODUWORK_CLIENT_CHANNEL", "beta");
  if (!["stable", "beta"].includes(channel)) fail("SODUWORK_CLIENT_CHANNEL must be stable or beta");
  const minimum = env("SODUWORK_CLIENT_MINIMUM_VERSION");
  if (minimum && !VERSION_RE.test(minimum)) fail("SODUWORK_CLIENT_MINIMUM_VERSION must be x.y.z");
  const mandatory = /^(1|true|yes)$/i.test(env("SODUWORK_CLIENT_MANDATORY"));
  const arch = env("SODUWORK_CLIENT_ARCH", "x64");
  if (!["x64", "arm64"].includes(arch)) fail("SODUWORK_CLIENT_ARCH must be x64 or arm64");
  const notes = env("SODUWORK_CLIENT_RELEASE_NOTES");
  const bundlePath = resolve(env(
    "SODUWORK_CLIENT_RELEASE_BUNDLE",
    `${installer}.${channel}.release.json`,
  ));

  let bundle;
  if (existsSync(bundlePath)) {
    bundle = parseBundle(bundlePath, installer, version, digest, size, key, {
      keyId, channel, arch, minimum, mandatory, notes, platform,
    });
  } else {
    const timestamp = env("SODUWORK_CLIENT_PUBLISHED_AT");
    if (timestamp && (!/^\d{4}-\d{2}-\d{2}T/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)))) {
      fail("SODUWORK_CLIENT_PUBLISHED_AT must be an ISO timestamp");
    }
    const payload = {
      schema: 1,
      releaseId: randomUUID(),
      version,
      channel,
      platform,
      arch,
      artifact: {
        name,
        size,
        sha256: digest,
        url: `/api/v1/client-updates/artifacts/__RELEASE_ID__`,
      },
      mandatory,
      minVersion: minimum,
      notes,
      publishedAt: new Date(timestamp || Date.now()).toISOString().replace(/\.\d{3}Z$/, "Z"),
      keyId,
    };
    if (timestamp) {
      // A fixed CI timestamp makes a clean-workspace retry byte-identical.
      // UUIDv8 is derived from all signed content except the random id/URL.
      const identity = { ...payload, releaseId: null };
      const bytes = createHash('sha256').update(canonical(identity)).digest().subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x80;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = bytes.toString('hex');
      payload.releaseId = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }
    if (!["x64", "arm64"].includes(payload.arch)) fail("SODUWORK_CLIENT_ARCH must be x64 or arm64");
    payload.artifact.url = `/api/v1/client-updates/artifacts/${payload.releaseId}`;
    bundle = {
      ...payload,
      signature: signBytes(null, Buffer.from(canonical(payload)), key).toString("base64"),
    };
    writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }

  process.stdout.write(`signed client ${version} release=${bundle.releaseId} sha256=${digest}\n`);
  process.stdout.write(`bundle ${bundlePath}\n`);
  if (dryRun) return;

  const url = env("SODUWORK_CLIENT_RELEASE_UPLOAD_URL");
  const token = env("SODUWORK_CLIENT_RELEASE_UPLOAD_TOKEN");
  if (!url || !token) fail("deployment upload URL and token are required");
  const destination = new URL(url);
  if (!['https:', 'http:'].includes(destination.protocol) || destination.username || destination.password) {
    fail('upload URL must be HTTP(S) without embedded credentials');
  }
  const form = new FormData();
  form.append("bundle", new Blob([JSON.stringify(bundle)], { type: "application/json" }), "release.json");
  form.append("installer", await openAsBlob(installer, { type: "application/octet-stream" }), name);
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    redirect: 'error',
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  const text = await response.text();
  if (!response.ok) fail(`client release upload failed (${response.status}): ${text.slice(0, 800)}`);
  const result = JSON.parse(text);
  if (!result?.ok || result?.release?.id !== bundle.releaseId || result?.release?.sha256 !== digest) {
    fail("client release upload response does not match the signed installer");
  }
  const receipt = env('SODUWORK_CLIENT_UPLOAD_RECEIPT');
  if (receipt) writeFileSync(resolve(receipt), JSON.stringify({ schema: 1, ok: true,
    uploadUrl: url, release: result.release, bundle: bundlePath,
    sha256: digest, uploadedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  process.stdout.write(`${result.release.enabled ? 'already enabled' : 'staged'} client ${version} on SoduWork Hub\n`);
}

main().catch((error) => {
  process.stderr.write(`client release failed: ${error?.message || error}\n`);
  process.exitCode = 1;
});
