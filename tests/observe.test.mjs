import test from 'node:test';
import assert from 'node:assert/strict';
import { feedbackStats } from '../scripts/feedbackStats.mjs';

test('feedback stats: rates, rounds and no-change count within the period', () => {
  const now = Date.now();
  const stats = feedbackStats([
    { createdAt: now, status: 'approved', comments: [], proposal: { fields: { title: 'x' } } },
    { createdAt: now, status: 'declined', comments: [{}, {}], proposal: { fields: {} } },
    { createdAt: now, status: 'ready', comments: [], proposal: { fields: {} } },
    { createdAt: now, status: 'failed', comments: [] },
    { createdAt: now - 10 * 86400000, status: 'approved', comments: [], proposal: { fields: { title: 'y' } } },
  ], now - 86400000);
  assert.equal(stats.proposals, 4);
  assert.equal(stats.approvalRate, 0.5);
  assert.equal(stats.declineRate, 0.5);
  assert.equal(stats.avgRounds, 1.5);
  assert.equal(stats.noChange, 2);
  assert.equal(stats.failed, 1);
  assert.equal(feedbackStats([], 0).approvalRate, null);
});
