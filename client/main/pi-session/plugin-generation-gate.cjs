'use strict';
const deliveryWorkspaces = require('../conversation/delivery-workspace.cjs');
const outputRoot = handle => deliveryWorkspaces.root(handle.cwd, handle.deliveryWorkspace);

// Only execution calls begin/finish. Snapshot readers can copy receipts but never
// request a repair, submit a turn, install a package or execute bundled code.
const path = require('node:path');
const candidates = require('./plugin-draft-candidates');
const receipts = new WeakMap(), activeGates = new WeakMap(), receiptScopes = new WeakMap(), inspections = new WeakMap(), logicalTurns = new WeakMap();
const completed = result => result?.ok === true && require('./task-turn').resultState(result) === 'completed';
function completedReceipt(row) {
  // Older snapshots identify interrupted checks only through their diagnostic.
  return ['ready','invalid'].includes(row?.state) && row.interrupted !== true &&
    row.diagnostic?.message !== 'Validation interrupted';
}
function records(handle) {
  if (receiptScopes.has(handle) && !receiptScopes.get(handle)()) return [];
  return [...(receipts.get(handle)?.values() || [])].map(row => structuredClone(row));
}
function diagnostic(file, error) {
  const provided = error?.diagnostic;
  const field = String(provided?.field || '').replace(/[^\w.[\]-]/g, '').slice(0, 100);
  const text = String(provided?.message || error?.message || error?.reason || 'Static package validation failed')
    .replace(/(?:[a-z]:[\\/]|\/)[^\s,;\uFF0C\uFF1B]+/gi, '[path]')
    .replace(/https?:\S+/gi, '[address]').replace(/["'`][^"'`]*["'`]/g, '[value]')
    .replace(/(?:token|password|api[_-]?key)\s*[:=]\s*\S+/gi, '[credential]')
    .replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 220);
  return {file: String(file.relative || path.basename(file.path || '')).slice(0, 240),
    ...(field ? {field} : {}), ...(provided?.line ? {line:provided.line,column:provided.column || 1} : {}), message:text};
}
function repairPrompt(failed, attempt) {
  return '<soduwork-internal-plugin-repair>\n' +
    'The host static installation check rejected the final on-disk plugin draft. Repair attempt ' + attempt + '/2 in this same logical turn.\n' +
    failed.map(row => JSON.stringify(row.diagnostic)).join('\n') + '\n' +
    (failed.some(row => row.file?.requiredAuthoringDraft)
      ? 'The selected Plugin Developer attempted to complete authoring without producing a plugin package. Create soduwork-plugin-draft.json and its resources for the requested reusable method; a one-off business report is not the plugin. Preserve existing HTML previews and include reusable templates as package resources where appropriate. '
      : 'Read the named draft and referenced resources, then correct only these generation defects. ') +
    'Serialize JSON with JSON.stringify/json.dump; do not blindly replace quotes. ' +
    'Public user inputs belong in root inputs; node inputs require key/fromNode/outputKey and a direct dependsOn edge. ' +
    'Keep the existing request, selected runtime, tools, permissions, account and conversation. Do not install, publish, run bundled scripts, request wider permissions, or claim readiness. ' +
    'The host will reread the exact files and repeat static preflight after this repair.\n</soduwork-internal-plugin-repair>';
}

function missingDrafts(previous, latest) {
  const existing = new Set(previous.map(file => file.path));
  const replacements = latest.filter(file => !existing.has(file.path));
  return previous.filter(original => {
    if (original.requiredAuthoringDraft && latest.some(file => !file.skillPackage && !file.requiredAuthoringDraft)) return false;
    if (latest.some(file => file.path === original.path)) return false;
    const match = replacements.findIndex(file => original.pluginKey
      ? original.pluginKey === file.pluginKey && original.skillPackage === file.skillPackage
      : Boolean(original.fileIdentity && original.fileIdentity === file.fileIdentity));
    if (match < 0) return true;
    replacements.splice(match, 1);
    return false;
  });
}
async function validateFile(handle, file, app, preflight) {
  if (file.requiredAuthoringDraft) throw Error('Final authoring delivery has no installable plugin draft');
  let draft;
  try {
    const skillRuntimeEntry = require('../conversation/skill-frontmatter').runtimeEntry(app, true);
    draft = await require('../app-resource-cache.cjs').request({ action: 'draft-check', cwd: outputRoot(handle),
      file, profile: app?.getPath?.('userData'), skillRuntimeEntry, readOnly: Boolean(preflight) });
  } catch (error) { throw Object.assign(error, { retryable: true }); }
  if (!draft.ok) throw draft;
  if (preflight && draft.kind !== 'skill') {
    const checked = await preflight(draft.body);
    const failures=(checked?.checks || []).filter(row=>row.ok===false);
    if(!checked?.ok || failures.length)throw Error(failures.map(row=>row.label || row.key).join('; ') || 'Static package validation failed');
  }
  const [fresh] = await candidates.collectAsync(outputRoot(handle), { files: [{ path: file.path }] });
  if(!fresh || fresh.pluginRevision!==file.pluginRevision)throw Error('Draft or resource bytes changed during validation');
}
// Restored drafts have no in-memory generation receipt. This read-only path can
// validate bytes for review, but never owns a model callback or launches repair.
async function inspect({handle, snapshot, files: indexedFiles, app, preflight} = {}) {
  if(!handle?.cwd)return [];
  const remote=Array.isArray(snapshot?.pluginValidation)?snapshot.pluginValidation:[];
  if(activeGates.has(handle))return records(handle);
  if(handle.inFlight?.())return remote;
  const cwd=outputRoot(handle),sessionId=handle.sessionId,owner=JSON.stringify(handle.deliveryOwner);
  const current=()=>outputRoot(handle)===cwd && handle.sessionId===sessionId && JSON.stringify(handle.deliveryOwner)===owner;
  const files = indexedFiles || await candidates.collectAsync(cwd, snapshot || {});
  const signature=JSON.stringify([cwd,sessionId,owner,files.map(file=>[file.relative,file.pluginRevision])]);
  const pending=inspections.get(handle);
  if(pending?.signature===signature)return pending.promise;
  const promise=(async()=>{
    const stored=new Map(records(handle).map(row=>[row.relative,row]));
    const rows=[];
    for(const file of files.filter(file=>!file.pluginSuperseded)) {
      const known=[...remote,stored.get(file.relative)].find(row=>row?.relative===file.relative &&
        row.revision===file.pluginRevision && completedReceipt(row));
      if(known){rows.push(known);continue;}
      if(!current() || activeGates.has(handle) || handle.inFlight?.())return remote;
      let issue, retryable;
      try { await validateFile(handle, file, app, preflight); }
      catch (error) { issue = diagnostic(file,error); retryable = error.retryable; }
      if(!current() || activeGates.has(handle) || handle.inFlight?.())return remote;
      const row={relative:file.relative,revision:file.pluginRevision,state:retryable?'pending':issue?'invalid':'ready',attempt:0,
        ...(issue?{diagnostic:issue}:{})};
      stored.set(file.relative,row);rows.push(row);
      while(stored.size>64)stored.delete(stored.keys().next().value);
    }
    if(current() && !activeGates.has(handle)){
      receipts.set(handle,stored);receiptScopes.set(handle,current);
    }
    return rows;
  })();
  inspections.set(handle,{signature,promise});
  try{return await promise;}finally{if(inspections.get(handle)?.promise===promise)inspections.delete(handle);}
}
// Preview reads never call finish. At successful authoring completion, even
// inferred HTML is a preview of the method, not its installable plugin package.
function finalDeliveryRevision(snapshot) {
  const delivery = snapshot?.delivery;
  if (!delivery || delivery.presentation === 'summary') return '';
  const files = ['manifest', 'conversation'].includes(delivery.source) ? delivery.items || []
    : delivery.source === 'inferred' ? (snapshot.files || []).filter(file => /\.html?$/i.test(file.relative || file.name || '')) : [];
  if (!files.length) return '';
  return JSON.stringify([delivery.source, delivery.summary, files.map(file =>
    [file.relative, file.size, file.at, file.primary, file.kind]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
}
async function begin({handle, app, identity, logicalOwner, outputSnapshot, selectedPluginIds = [], cancelled = () => false, pauseConfirmed = () => false, repair, changed = () => {}, preflight} = {}) {
  if (!handle?.cwd) return { canStart: () => !cancelled(), finish: async result => result, dispose() {} };
  const cwd=outputRoot(handle), sessionId=handle.sessionId, owner=handle.deliveryOwner;
  const scope = () => JSON.stringify([handle.deliveryOwner, identity?.hub, identity?.clientId,
    identity ? require('../device-auth-request').accountScopeKey(identity) : '']);
  const logicalToken=logicalOwner && typeof logicalOwner==='object' ? logicalOwner : {};
  const readSnapshot = outputSnapshot || (() => handle.outputSnapshotAsync?.() ?? handle.outputSnapshot?.() ?? {});
  const scan = async () => {
    const snapshot = await readSnapshot();
    return { snapshot, files: await candidates.collectAsync(cwd, snapshot) };
  };
  let logical=logicalTurns.get(logicalToken);
  if(!logical){
    const initial = await scan();
    logical={handle,scope:scope(),baseline:new Map(initial.files
      .map(file=>[file.path,file.pluginRevision])),touched:new Set(),repairs:0,
      authoring: selectedPluginIds.includes('local:plugin-builder') && !initial.files.some(file => !file.skillPackage),
      deliveryRevision: finalDeliveryRevision(initial.snapshot), requiresDraft: false};
    logicalTurns.set(logicalToken,logical);
  }
  const originalScope = logical.scope;
  let disposed=false;
  const owned=()=>!disposed && logical.handle===handle && outputRoot(handle) === cwd && handle.sessionId === sessionId && handle.deliveryOwner === owner && scope() === originalScope;
  const current=()=>owned() && !cancelled();
  const baseline=logical.baseline, touched=logical.touched;
  const collectTargets=async()=>{
    const latest = await scan();
    const files=latest.files.filter(file=>!file.pluginSuperseded &&
      (baseline.get(file.path)!==file.pluginRevision || touched.has(file.path)));
    const deliveryRevision = finalDeliveryRevision(latest.snapshot);
    if (logical.authoring && deliveryRevision && deliveryRevision !== logical.deliveryRevision) logical.requiresDraft = true;
    // Latch this obligation: deleting the manifest or HTML during repair cannot
    // turn a failed authoring completion into success. Existing drafts keep their
    // stricter identity/resource checks in missingDrafts.
    if (logical.requiresDraft && !latest.files.some(file => !file.pluginSuperseded && !file.skillPackage)) files.push({
      path: path.join(cwd, candidates.DRAFT_NAME), relative: candidates.DRAFT_NAME,
      pluginRevision: 'missing-authoring-draft', requiredAuthoringDraft: true,
    });
    files.forEach(file=>touched.add(file.path));
    return files;
  };
  const store=new Map(records(handle).map(row=>[row.relative,row]));receipts.set(handle,store);
  const sameScope=()=>outputRoot(handle) === cwd && handle.sessionId === sessionId && scope() === originalScope;
  receiptScopes.set(handle,sameScope);
  const gateToken={};activeGates.set(handle,gateToken);
  const put=(file,state,attempt,issue)=>{
    store.set(file.relative,{relative:file.relative,revision:file.pluginRevision,state,attempt,
      ...(issue ? {diagnostic:issue} : {})});
    while(store.size>64)store.delete(store.keys().next().value);
    changed();
  };
  const interrupt=()=>{
    for(const [key,row] of store)if(['checking','repairing'].includes(row.state))store.set(key,{...row,state:'invalid',interrupted:true,
      diagnostic:{file:row.relative,message:'Validation interrupted'}});
  };
  const dispose=()=>{
    if(disposed)return;
    disposed=true;interrupt();
    if(activeGates.get(handle)===gateToken)activeGates.delete(handle);
    changed();
  };
  const stopped=()=>{interrupt();changed();return {ok:true,cancelled:true,manualStop:true};};
  let finished;
  return {canStart: current, dispose, finish(result) {
    if (finished) return finished;
    finished=(async()=>{
      if (!completed(result)) return result;
      if(!current())return stopped();
      let targets=await collectTargets();
      if(!current())return stopped();
      if(!targets.length)return result;
      for(let attempt=logical.repairs;attempt<=2;attempt++) {
        let failed=[];
        const checked=new Map();
        let checks=0;
        // Recollect after every batch. A repair or concurrent file write can
        // replace a candidate, introduce another draft, or supersede its path.
        while(true) {
          for(const file of targets.filter(file=>checked.get(file.path)!==file.pluginRevision)) {
            if(!current())return stopped();
            put(file,'checking',attempt);checks++;
            try {
              await validateFile(handle,file,app,preflight);
              if(!current())return stopped();
              put(file,'ready',attempt);
            } catch(error) {
              if(!current())return stopped();
              if (error.retryable) {
                const issue = diagnostic(file,error);
                put(file,'pending',attempt,issue);
                return { ...result, ok:false, retrySafe:false, failureKind:'plugin-validation', reason:issue.message };
              }
              put(file,'invalid',attempt,diagnostic(file,error));
            }
            checked.set(file.path,file.pluginRevision);
          }
          if(!current())return stopped();
          const latest=await collectTargets();
          if(!current())return stopped();
          const missing = missingDrafts(targets, latest);
          if (missing.length) {
            failed = missing.map(file => {
              const issue = diagnostic(file, {message:'Generated plugin draft is missing'});
              put(file, 'invalid', attempt, issue);
              return {file, diagnostic:issue};
            });
            break;
          }
          const pending=latest.filter(file=>checked.get(file.path)!==file.pluginRevision);
          if(pending.length && checks<64){targets=latest;continue;}
          for(const file of pending)put(file,'invalid',attempt,diagnostic(file,{message:'Draft set changed repeatedly during validation'}));
          failed=latest.flatMap(file=>{
            const receipt=store.get(file.relative);
            return receipt?.state==='ready' && receipt.revision===file.pluginRevision ? []
              : [{file,diagnostic:receipt?.diagnostic || diagnostic(file,{message:'Static package validation failed'})}];
          });
          targets=latest;break;
        }
        if(!current())return stopped();
        if(!failed.length)return {...result,pluginValidation:{state:'ready'}};
        if(attempt===2 || typeof repair!=='function')return {...result,ok:false,retrySafe:false,failureKind:'plugin-validation',
          reason:failed[0].diagnostic.file + ': ' + failed[0].diagnostic.message,pluginValidation:{state:'invalid',attempts:attempt}};
        logical.repairs=attempt+1;
        for(const row of failed)put(row.file,'repairing',logical.repairs,row.diagnostic);
        let repaired;
        try {repaired=await repair(repairPrompt(failed,attempt+1),{attempt:attempt+1,recordUser:false});}
        catch(error) {
          // Exceptions can contain provider payloads. Only the model classifier's
          // safe public diagnostic may enter the turn receipt or queue banner.
          const issue = require('./model-errors').describe(error);
          repaired = {ok:false, retrySafe:issue.retryable,
            reason:issue.publicText || 'Plugin repair failed'};
        }
        if(!current()) {
          // Native pause also stops validation. Retain that confirmed waiting
          // receipt while still fencing cancellation and a changed owner.
          if(owned() && repaired?.ok===true && repaired.paused && !repaired.cancelled && pauseConfirmed())return {...result,...repaired};
          return stopped();
        }
        if(!completed(repaired)) {
          for(const row of failed)put(row.file,'invalid',attempt+1,row.diagnostic);
          if(repaired?.cancelled)return {...result,...repaired};
          // A runtime rejection is not a new static package defect. Preserve
          // native failure/control receipts, including Runner-specific fields.
          if(repaired?.paused || repaired?.recovering)return {...result,...repaired};
          return {...result,...repaired,ok:false,retrySafe:repaired?.retrySafe===true,
            failureKind:repaired?.failureKind || 'plugin-repair',
            reason:repaired?.reason || repaired?.snapshot?.completion?.error ||
              failed[0].diagnostic.file + ': repair did not complete'};
        }
        // A sibling cannot satisfy a missing draft's validation obligation.
        const latest=await collectTargets();
        const [missing] = missingDrafts(targets, latest);
        if (missing) {
          const issue = diagnostic(missing, { message:'Generated plugin draft is missing' });
          put(missing,'invalid',attempt+1,issue);
          return { ...result, ok:false, retrySafe:false, failureKind:'plugin-validation',
            reason:issue.file + ': ' + issue.message };
        }
        for (const file of targets) if (!latest.some(row => row.path === file.path)) store.delete(file.relative);
        targets = latest;
      }
    })().finally(dispose);return finished;
  }};
}
module.exports={begin,records,inspect,diagnostic,repairPrompt};
