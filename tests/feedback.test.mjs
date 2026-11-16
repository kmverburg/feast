import test from 'node:test';
import assert from 'node:assert/strict';
import { processWork, readWork, enqueueFeedback } from '../worker/work.js';
import { createFeedback, addComment, decide, readProposals } from '../worker/feedback.js';
import { addSubscription, b64url } from '../worker/push.js';
import { applyProposal, baseOf, baseHash, parseFeedbackResponse, hasChanges } from '../src/shared/feedbackTask.ts';

const fakeKv = () => {
  const store = new Map();
  return {
    store,
    async get(k) { const v = store.get(k); return v ? v.value : null; },
    async getWithMetadata(k, type) { const v = store.get(k); if (!v) return { value: null, metadata: null }; return type === 'stream' ? { value: { cancel: async () => {} }, metadata: v.metadata ?? null } : { value: v.value, metadata: v.metadata ?? null }; },
    async put(k, v, o) { store.set(k, { value: v, metadata: o?.metadata }); },
  };
};

const recipe = {
  id: 'r1', title: 'Tomatensoep', description: 'Lekker', category: 'Main', servings: 4, prepTime: 10, cookTime: 20, image: '', tags: [], isFavorite: false, createdAt: '',
  ingredientSections: [{ id: 's', title: 'Basis', items: [{ id: 'a', amount: 2, unit: 'tl', name: 'zout' }, { id: 'b', amount: 800, unit: 'g', name: 'tomaten' }] }],
  instructions: [{ id: 't1', stepNumber: 1, text: 'Voeg 2 tl zout toe.' }, { id: 't2', stepNumber: 2, text: 'Kook 20 minuten.', timerMinutes: 20 }],
  titleEn: 'Tomato soup', ingredientSectionsEn: [], instructionsEn: [],
};

const answer = (obj) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const proposalAnswer = answer({
  summary: 'Minder zout: 1 tl in plaats van 2 tl.',
  changes: ['Zout: 2 tl naar 1 tl'],
  ingredientSections: [{ title: 'Basis', items: [{ amount: 1, unit: 'tl', name: 'zout' }, { amount: 800, unit: 'g', name: 'tomaten' }] }],
  instructions: [{ text: 'Voeg 1 tl zout toe.' }, { text: 'Kook 20 minuten.', timerMinutes: 20 }],
});

const setup = async (answers) => {
  const env = { FEAST: fakeKv(), GEMINI_API_KEY: 'k', WORK_GAP_MS: '0' };
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init.body });
    if (String(url).includes('push.example.test')) return new Response('', { status: 201 });
    const a = answers.shift();
    return typeof a === 'number' ? new Response(JSON.stringify({ error: { message: 'busy' } }), { status: a }) : new Response(JSON.stringify(a));
  };
  return { env, calls };
};

const send = async (env, feedback = 'te zout') => {
  const p = await createFeedback(env, { recipeId: 'r1', recipeTitle: recipe.title, base: baseOf(recipe), hash: baseHash(recipe), feedback });
  await enqueueFeedback(env, p.id);
  return p;
};

test('feedback becomes a proposal the cook can check', async () => {
  const { env, calls } = await setup([proposalAnswer]);
  const p = await send(env);
  assert.equal((await readProposals(env))[0].status, 'working');
  await processWork(env);
  const [saved] = await readProposals(env);
  assert.equal(saved.status, 'ready');
  assert.equal(saved.proposal.fields.ingredientSections[0].items[0].amount, 1);
  assert.equal(saved.proposal.fields.title, undefined); // untouched fields are not in the proposal
  assert.equal((await readWork(env)).feedbackQueue.length, 0);
  assert.match(calls[0].body, /te zout/); // the AI saw the feedback
  assert.ok(saved.id === p.id);
});

test('a notification goes out when it is ready', async () => {
  const { env, calls } = await setup([proposalAnswer]);
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  await addSubscription(env, { endpoint: 'https://push.example.test/send/aaaaaaaaaa', keys: { p256dh: b64url(await crypto.subtle.exportKey('raw', pair.publicKey)), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) } });
  await send(env);
  await processWork(env);
  assert.equal(calls.filter((c) => c.url.includes('push.example.test')).length, 1);
});

test('a comment runs the flow again, with the earlier proposal and the remark', async () => {
  const second = answer({ summary: 'Zout weggelaten.', changes: ['Zout: weg'], ingredientSections: [{ title: 'Basis', items: [{ amount: 800, unit: 'g', name: 'tomaten' }] }], instructions: [{ text: 'Kook 20 minuten.', timerMinutes: 20 }] });
  const { env, calls } = await setup([proposalAnswer, second]);
  const p = await send(env);
  await processWork(env);
  assert.equal(await addComment(env, 'nope', 'x'), null);
  assert.ok(await addComment(env, p.id, 'Liever helemaal geen zout'));
  assert.equal((await readProposals(env))[0].status, 'working');
  await enqueueFeedback(env, p.id);
  await processWork(env);
  const [saved] = await readProposals(env);
  assert.equal(saved.status, 'ready');
  assert.equal(saved.proposal.summary, 'Zout weggelaten.');
  assert.equal(saved.comments.length, 1);
  assert.match(calls[1].body, /Liever helemaal geen zout/);
  assert.match(calls[1].body, /Minder zout/); // it knows what it proposed before
});

test('approve and decline are recorded; a proposal that is still being made cannot be decided', async () => {
  const { env } = await setup([proposalAnswer]);
  const p = await send(env);
  assert.equal(await decide(env, p.id, 'approve'), null); // still working
  await processWork(env);
  assert.equal(await decide(env, p.id, 'maybe'), null);
  assert.ok(await decide(env, p.id, 'decline'));
  assert.equal((await readProposals(env))[0].status, 'declined');
});

test('feedback that needs no change comes back without changes', async () => {
  const { env } = await setup([answer({ summary: 'Dit is een compliment, er verandert niets.', changes: [] })]);
  await send(env, 'Heerlijk!');
  await processWork(env);
  const [saved] = await readProposals(env);
  assert.equal(saved.status, 'ready');
  assert.equal(hasChanges(saved.proposal), false);
});

test('a busy model keeps the proposal queued; unreadable answers end as failed after 3 tries', async () => {
  let { env } = await setup([503]);
  await send(env);
  assert.equal(await processWork(env), 'rate_limited');
  assert.equal((await readProposals(env))[0].status, 'working');
  assert.equal((await readWork(env)).feedbackQueue.length, 1);

  const bad = { candidates: [{ content: { parts: [{ text: 'sorry, geen JSON' }] } }] };
  ({ env } = await setup([bad, bad, bad]));
  await send(env);
  for (let i = 0; i < 3; i++) await processWork(env);
  const [saved] = await readProposals(env);
  assert.equal(saved.status, 'failed');
  assert.match(saved.error, /gave up after 3 attempts/);
  assert.equal((await readWork(env)).feedbackQueue.length, 0);
  // and a comment on a failed one tries again
  assert.ok(await addComment(env, saved.id, 'probeer het nog eens'));
});

test('bad requests are refused', async () => {
  const { env } = await setup([]);
  assert.equal(await createFeedback(env, { recipeId: 'r1', base: baseOf(recipe), feedback: '   ' }), null);
  assert.equal(await createFeedback(env, { recipeId: '', base: baseOf(recipe), feedback: 'x' }), null);
  assert.equal(await createFeedback(env, { recipeId: 'r1', base: {}, feedback: 'x' }), null);
});

test('approving applies the fields and queues a fresh translation', () => {
  const content = parseFeedbackResponse(proposalAnswer, baseOf(recipe));
  const updated = applyProposal(recipe, content);
  assert.equal(updated.ingredientSections[0].items[0].amount, 1);
  assert.equal(updated.instructions[0].text, 'Voeg 1 tl zout toe.');
  assert.equal(updated.title, 'Tomatensoep');
  assert.equal(updated.titleEn, undefined);
  assert.equal(updated.translationPending, true);
  assert.equal(updated.liveWork, true);
});

test('a proposal without ingredients or steps is rejected', () => {
  assert.throws(() => parseFeedbackResponse(answer({ summary: 'x', ingredientSections: [] }), baseOf(recipe)), /no ingredients/);
  assert.throws(() => parseFeedbackResponse(answer({ summary: 'x', instructions: [{ text: '' }] }), baseOf(recipe)), /no steps/);
  assert.throws(() => parseFeedbackResponse(answer({ changes: [] }), baseOf(recipe)), /explanation/);
});

const events = (lines, name) => lines.filter((l) => l.event === name);
const collect = () => { const lines = []; return { lines, log: (level, f) => lines.push({ level, ...f }) }; };

test('every step of the flow is logged; feedback text only for no-change proposals', async () => {
  const second = answer({ summary: 'Zout weggelaten.', changes: ['Zout: weg', 'Stap 1 aangepast'], ingredientSections: [{ title: 'Basis', items: [{ amount: 800, unit: 'g', name: 'tomaten' }] }], instructions: [{ text: 'Kook 20 minuten.', timerMinutes: 20 }] });
  const { env } = await setup([proposalAnswer, second]);
  const { lines, log } = collect();
  const p = await send(env, 'te zout');
  await processWork(env, { log });
  const [first] = events(lines, 'feedback_proposed');
  assert.equal(first.proposalId, p.id);
  assert.equal(first.changes, 1);
  assert.equal(first.round, 1);
  assert.equal(first.model, 'gemini-flash-latest');
  assert.equal(typeof first.ms, 'number');
  assert.equal(first.noChange, undefined);
  assert.equal(first.feedback, undefined);
  assert.equal(first.summary, undefined);

  await addComment(env, p.id, 'geen zout', { log });
  assert.deepEqual(events(lines, 'feedback_commented').map(({ proposalId, round }) => ({ proposalId, round })), [{ proposalId: p.id, round: 1 }]);
  await enqueueFeedback(env, p.id);
  await processWork(env, { log });
  const second1 = events(lines, 'feedback_proposed')[1];
  assert.equal(second1.round, 2);
  assert.equal(second1.changes, 2);

  await decide(env, p.id, 'approve', { log });
  const [decided] = events(lines, 'feedback_decided');
  assert.equal(decided.proposalId, p.id);
  assert.equal(decided.decision, 'approved');
  assert.equal(decided.rounds, 2);
  assert.ok(!JSON.stringify(lines.filter((l) => l.event?.startsWith('feedback_'))).includes('tomaten'));
});

test('a declined proposal is logged as declined; a no-change proposal logs the cut-down texts', async () => {
  const long = 'x'.repeat(500);
  const { env } = await setup([answer({ summary: long, changes: [] })]);
  const { lines, log } = collect();
  const p = await send(env, long);
  await processWork(env, { log });
  const [proposed] = events(lines, 'feedback_proposed');
  assert.equal(proposed.noChange, true);
  assert.equal(proposed.changes, 0);
  assert.equal(proposed.feedback.length, 300);
  assert.equal(proposed.summary.length, 300);
  await decide(env, p.id, 'decline', { log });
  assert.equal(events(lines, 'feedback_decided')[0].decision, 'declined');
  assert.equal(events(lines, 'feedback_decided')[0].rounds, 1);
});

test('unreadable answers are logged as feedback_failed', async () => {
  const bad = { candidates: [{ content: { parts: [{ text: 'sorry, geen JSON' }] } }] };
  const { env } = await setup([bad]);
  const { lines, log } = collect();
  const p = await send(env);
  await processWork(env, { log });
  const [failed] = events(lines, 'feedback_failed');
  assert.equal(failed.proposalId, p.id);
  assert.ok(failed.reason);
  assert.equal(events(lines, 'feedback_proposed').length, 0);
});
