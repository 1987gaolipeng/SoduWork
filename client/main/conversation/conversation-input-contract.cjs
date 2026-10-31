'use strict';

const ROLES = new Set(['steps', 'object', 'template', 'example', 'reference', 'excluded']);
const STATUSES = new Set(['bypass', 'ready', 'needs_input', 'unreadable', 'error']);
const MATERIAL_FIELDS = new Set(['attachmentId', 'hash', 'readStatus', 'status', 'roles', 'coverage', 'source', 'evidence', 'warnings', 'name', 'mimeType']);

function hasCapability(capabilities) {
  const c = capabilities && (capabilities.conversationInputPreparation || capabilities);
  return c === true || !!(c && c.available !== false && (c.available === true || c.schemaVersion === 1));
}

function materialRefs(snapshot) {
  return [].concat(snapshot && snapshot.attachments || [], snapshot && snapshot.materials || [], snapshot && snapshot.materialReferences || snapshot && snapshot.references || [])
    .filter(Boolean);
}

function eligible(snapshot, capabilities) {
  if (!hasCapability(capabilities) || !snapshot || snapshot.inputPreparation === false) return false;
  const refs = materialRefs(snapshot);
  if (!refs.length) return false;
  // A folded long-text card is still the user's text, not an external material.
  const external = refs.some((m) => m.attachmentId || m.materialId || m.hash || m.source && m.source.type !== 'folded-text');
  return external;
}

function fail(message) { throw new TypeError(`conversation input contract: ${message}`); }
function object(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`); return value; }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function normalizeMaterial(material, known) {
  object(material, 'material');
  for (const key of Object.keys(material)) if (!MATERIAL_FIELDS.has(key)) fail(`unknown material field ${key}`);
  const id = material.attachmentId || material.materialId;
  if (!id || !known.has(id)) fail(`unknown material ${id || '<missing>'}`);
  const roles = material.roles == null ? [] : material.roles;
  if (!Array.isArray(roles) || roles.some((r) => typeof r !== 'string' || !ROLES.has(r))) fail(`invalid material role for ${id}`);
  const out = clone(material); out.attachmentId = id; out.roles = [...roles];
  if (out.readStatus && !['read', 'partial', 'unreadable', 'excluded'].includes(out.readStatus)) fail(`invalid readStatus for ${id}`);
  return out;
}

function schemaFields(plugin) {
  const schema = plugin.inputSchema || plugin.schema || {};
  return schema.properties || schema;
}
function explicitValues(snapshot, pluginId) {
  const all = snapshot.inputValues || snapshot.explicitValues || {};
  return all[pluginId] && typeof all[pluginId] === 'object' ? all[pluginId] : all;
}
function inferValues(raw, pluginId) {
  const all = raw.inferredInputsByPlugin || raw.inputsByPlugin || {};
  return all[pluginId] && typeof all[pluginId] === 'object' ? all[pluginId] : {};
}
function descriptor(value, source, evidence) {
  const out = { value: clone(value), source };
  if (evidence != null) out.evidence = clone(evidence);
  return out;
}
function rawValue(value) {
  return value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value') ? value.value : value;
}
function validateValue(name, value, spec) {
  if (!spec || typeof spec !== 'object') fail(`invalid schema for ${name}`);
  const type = spec.type || (spec.enum || spec.values ? 'enum' : undefined);
  if (type === 'enum') {
    const values = spec.values || spec.enum;
    if (!Array.isArray(values) || !values.includes(value)) fail(`invalid enum value for ${name}`);
  } else if (type === 'string' && typeof value !== 'string') fail(`invalid value for ${name}`);
  else if (type === 'number' && typeof value !== 'number') fail(`invalid value for ${name}`);
  else if (type === 'boolean' && typeof value !== 'boolean') fail(`invalid value for ${name}`);
}

function normalize(snapshot, materials, rawAnalysis) {
  object(snapshot || {}, 'snapshot'); object(rawAnalysis || {}, 'rawAnalysis');
  const sourceMaterials = Array.isArray(materials) ? materials : [];
  const known = new Set(sourceMaterials.map((m) => m && (m.attachmentId || m.materialId)).filter(Boolean));
  const analysisMaterials = rawAnalysis.materials == null ? sourceMaterials : rawAnalysis.materials;
  if (!Array.isArray(analysisMaterials)) fail('materials must be an array');
  const normalizedMaterials = analysisMaterials.map((m) => normalizeMaterial(m, known));
  const plugins = Array.isArray(snapshot.plugins) ? snapshot.plugins : [];
  const pluginIds = new Set(plugins.map((p) => p && p.id).filter(Boolean));
  const inputsByPlugin = {};
  const questions = Array.isArray(rawAnalysis.questions) ? clone(rawAnalysis.questions) : [];
  const inferredByPlugin = rawAnalysis.inferredInputsByPlugin || rawAnalysis.inputsByPlugin || {};
  for (const id of Object.keys(inferredByPlugin)) if (!pluginIds.has(id)) fail(`unknown plugin ${id}`);
  for (const plugin of plugins) {
    object(plugin, 'plugin');
    const id = plugin.id; if (!id) fail('plugin id is required');
    const fields = schemaFields(plugin); const explicit = explicitValues(snapshot, id); const inferred = inferValues(rawAnalysis, id);
    for (const key of Object.keys(explicit)) if (!Object.prototype.hasOwnProperty.call(fields, key)) fail(`unknown input field ${key}`);
    for (const key of Object.keys(inferred)) if (!Object.prototype.hasOwnProperty.call(fields, key)) fail(`unknown input field ${key}`);
    const result = {};
    for (const key of Object.keys(fields)) {
      const spec = fields[key] || {};
      const hasExplicit = Object.prototype.hasOwnProperty.call(explicit, key);
      const hasInferred = Object.prototype.hasOwnProperty.call(inferred, key);
      if (hasExplicit) {
        const explicitValue = rawValue(explicit[key]); const inferredValue = rawValue(inferred[key]);
        validateValue(key, explicitValue, spec); result[key] = descriptor(explicitValue, 'explicit', inferred[key]);
        if (hasInferred && JSON.stringify(explicitValue) !== JSON.stringify(inferredValue)) questions.push({ id: `conflict:${id}:${key}`, question: `确认 ${key} 的显式值与材料推断冲突`, pluginId: id, field: key, kind: 'conflict' });
      } else if (hasInferred) { const inferredValue = rawValue(inferred[key]); validateValue(key, inferredValue, spec); result[key] = descriptor(inferredValue, 'inferred', rawAnalysis.evidence && rawAnalysis.evidence[id] && rawAnalysis.evidence[id][key]); }
      else if (Object.prototype.hasOwnProperty.call(spec, 'default')) { result[key] = descriptor(spec.default, 'default'); }
      else if (spec.required) questions.push({ id: `missing:${id}:${key}`, question: `请提供 ${key}`, pluginId: id, field: key, kind: 'missing' });
    }
    inputsByPlugin[id] = result;
  }
  const status = rawAnalysis.status && !STATUSES.has(rawAnalysis.status) ? fail('invalid status') : (questions.length ? 'needs_input' : (rawAnalysis.status || (normalizedMaterials.some((m) => m.readStatus === 'unreadable') ? 'unreadable' : 'ready')));
  return { schemaVersion: 1, status, binding: clone(snapshot.binding || { ownerScope: snapshot.ownerScope, sessionId: snapshot.sessionId, submissionId: snapshot.submissionId, draftRevision: snapshot.draftRevision, plugins: plugins.map((p) => ({ id: p.id, version: p.version })) }), userText: Object.prototype.hasOwnProperty.call(snapshot, 'userText') ? snapshot.userText : null, goal: clone(rawAnalysis.goal), constraints: clone(rawAnalysis.constraints || []), expectedOutputs: clone(rawAnalysis.expectedOutputs || []), materials: normalizedMaterials, inputsByPlugin, questions, summary: rawAnalysis.summary == null ? undefined : String(rawAnalysis.summary) };
}

module.exports = { eligible, normalize, ROLES, hasCapability };
