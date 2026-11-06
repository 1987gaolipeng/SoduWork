'use strict';

// A synchronized transcript is a projection, not a second local conversation.
// Only the authenticated source device may resolve it to a native archive.
async function resolve({ app, session, item, identity }) {
  if (!item?.sourceSessionId || !identity?.clientId ||
      item.sourceClientId !== identity.clientId || item.deleted) return null;
  const access = require('./history-access');
  const segments = require('./runtime-segments');
  let id = String(item.sourceSessionId);
  const record = segments.list(app).find(row => row.id === id || row.active?.sessionId === id ||
    row.segments.some(part => part.sessionId === id));
  if (record) { segments.assertOwner(app, record, identity); id = record.id; }
  if (session.isArchived?.(app, id)) return null;
  const live = session.findBySessionId?.(id);
  const row = live ? live.historyRow?.() || { id, adapterId: live.adapterId }
    : await session.archivedConversation?.(app, id, { nativeOnly: true });
  if (!row || row.accountConversation || row.archived || row.cloud || live?.passiveCloudView) return null;
  access.assertOwner(app, id, access.actor(app, identity), row);
  return { ...row, id, historyAliasIds: [...new Set([...(row.historyAliasIds || []), item.id])].filter(Boolean) };
}

module.exports = { resolve };
