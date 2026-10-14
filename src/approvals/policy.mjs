export function ttlFor(kind, config) {
  return kind === 'owner_mention' ? config.approvals.ttl_owner_mention_ms : config.approvals.ttl_bot_mention_ms;
}

export function rateLimited(store, requester, config) {
  return store.rateHit(requester) > config.limits.per_user_per_hour;
}

export function ownerOverloaded(store, owner, config) {
  return store.countPendingForOwner(owner) >= config.limits.pending_per_owner;
}

export const fmtTime = (ms = Date.now()) => new Date(ms).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
