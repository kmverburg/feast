// Feedback numbers for scripts/observe.mjs, worked out from the "proposals" KV key (counts only, no recipe content is shown).
// The key keeps at most 40 proposals, finished ones for 30 days, so long periods are capped by that.
export function feedbackStats(proposals, since) {
  const list = (Array.isArray(proposals) ? proposals : []).filter((p) => p && p.createdAt >= since);
  const count = (status) => list.filter((p) => p.status === status).length;
  const approved = count('approved');
  const declined = count('declined');
  const decided = approved + declined;
  const made = list.filter((p) => p.proposal);
  const rounds = list.map((p) => (Array.isArray(p.comments) ? p.comments.length : 0) + 1);
  return {
    proposals: list.length,
    approved,
    declined,
    approvalRate: decided ? approved / decided : null,
    declineRate: decided ? declined / decided : null,
    avgRounds: rounds.length ? rounds.reduce((a, b) => a + b, 0) / rounds.length : null,
    noChange: made.filter((p) => !p.proposal.fields || Object.keys(p.proposal.fields).length === 0).length,
    failed: count('failed'),
  };
}
