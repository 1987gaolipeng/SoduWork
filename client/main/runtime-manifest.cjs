'use strict';

// This validates declarations only. The packaging verifier checks the actual
// executable payload; a valid manifest alone is never installation evidence.
const PLATFORM_PATHS = Object.freeze({
  win32: 'resources/runner/soduwork-runner.exe',
  darwin: 'resources/runner/soduwork-runner',
  linux: 'resources/runner/soduwork-runner',
});

function validateRuntimeManifest(manifest) {
  const errors = [];
  const object = (value, location, required) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${location} must be an object`);
      return false;
    }
    for (const key of required) {
      if (!Object.hasOwn(value, key)) errors.push(`${location}.${key} is required`);
    }
    for (const key of Object.keys(value)) {
      if (!required.includes(key)) errors.push(`${location}.${key} is unsupported`);
    }
    return true;
  };
  const equal = (value, expected, location) => {
    if (value !== expected) errors.push(`${location} must be ${JSON.stringify(expected)}`);
  };
  const platforms = (value, location) => {
    if (!Array.isArray(value) || !value.length) {
      errors.push(`${location} must be a non-empty array`);
      return [];
    }
    if (new Set(value).size !== value.length) errors.push(`${location} must not contain duplicates`);
    for (const platform of value) {
      if (typeof platform !== 'string' || !Object.hasOwn(PLATFORM_PATHS, platform)) {
        errors.push(`${location} contains an unsupported platform`);
      }
    }
    return value.filter((platform) => typeof platform === 'string' && Object.hasOwn(PLATFORM_PATHS, platform));
  };
  if (!object(manifest, 'manifest', ['schema', 'product', 'supportedPlatforms',
    'zeroPrerequisitePlatforms', 'bundled', 'hostPrerequisites', 'networkInstall', 'optionalDownloads'])) return errors;
  equal(manifest.schema, 'soduwork.client-runtime/v1', 'schema');
  equal(manifest.product, 'SoduWork', 'product');
  const supported = platforms(manifest.supportedPlatforms, 'supportedPlatforms');
  const zeroPrerequisites = platforms(manifest.zeroPrerequisitePlatforms, 'zeroPrerequisitePlatforms');
  for (const platform of zeroPrerequisites) {
    if (!supported.includes(platform)) errors.push(`zeroPrerequisitePlatforms.${platform} must be supported`);
  }
  if (!Array.isArray(manifest.hostPrerequisites) || manifest.hostPrerequisites.length) {
    errors.push('hostPrerequisites must be an empty array');
  }
  equal(manifest.networkInstall, false, 'networkInstall');
  if (typeof manifest.optionalDownloads !== 'boolean') errors.push('optionalDownloads must be a boolean');
  if (object(manifest.bundled, 'bundled', ['electron', 'node', 'python', 'runner'])) {
    for (const runtime of ['electron', 'node', 'python']) equal(manifest.bundled[runtime], true, `bundled.${runtime}`);
    const runner = manifest.bundled.runner;
    if (object(runner, 'bundled.runner', ['required', 'kind', 'relativePaths'])) {
      equal(runner.required, true, 'bundled.runner.required');
      equal(runner.kind, 'frozen-executable', 'bundled.runner.kind');
      if (object(runner.relativePaths, 'bundled.runner.relativePaths', supported)) {
        for (const platform of supported) {
          equal(runner.relativePaths[platform], PLATFORM_PATHS[platform], `bundled.runner.relativePaths.${platform}`);
        }
      }
    }
  }
  return errors;
}

module.exports = { PLATFORM_PATHS, validateRuntimeManifest };
