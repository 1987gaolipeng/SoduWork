// Keep diagnostic revisions out of the everyday service status summary.
export function healthReleaseLabel(value) {
  const raw = String(value || '').trim().replace(/^v/i, '')
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(raw) ? 'v' + raw : ''
}

export function healthVersionLabel(value, commit, buildLabel) {
  const raw = String(value || '').trim().replace(/^v/i, '')
  if (!raw) return ''
  const semver = raw.match(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
  if (!semver) return buildLabel(raw.slice(0, 8))
  const revision = String(commit || '').trim()
  return `v${semver[0]}${revision ? ` · ${buildLabel(revision.slice(0, 8))}` : ''}`
}
