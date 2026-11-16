// Recipe feedback: the cook sends a remark about a recipe, the AI proposes a change, the cook checks it.
// Proposals are kept in KV key "proposals" (newest first); the ones still being made are queued in the work document
// (see work.js) so they are made also when the app is closed. When a proposal is ready, a push notification goes out.
import { generateContent } from './gemini.js';
import { sendPush } from './push.js';
import { buildFeedbackRequest, parseFeedbackResponse, hasChanges } from '../src/shared/feedbackTask.ts';

const KEY = 'proposals';
const MAX_PROPOSALS = 40;
const MAX_TEXT = 2000;
const MAX_ATTEMPTS = 3;
const KEEP_FINISHED_MS = 30 * 86400000;
const MAX_LOGGED_TEXT = 300;

export async function readProposals(env) {
  try {
    const raw = await env.FEAST.get(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeProposals(env, list) {
  const cutoff = Date.now() - KEEP_FINISHED_MS;
  const kept = list.filter((p) => ['working', 'ready', 'failed'].includes(p.status) || p.updatedAt > cutoff);
  await env.FEAST.put(KEY, JSON.stringify(kept.slice(0, MAX_PROPOSALS)));
}

const clip = (text) => String(text || '').trim().slice(0, MAX_TEXT);

/** A new piece of feedback. `base` is the recipe as the app has it (what the AI sees and what is checked at approval). */
export async function createFeedback(env, { recipeId, recipeTitle, base, hash, feedback }) {
  const text = clip(feedback);
  if (!text || typeof recipeId !== 'string' || !recipeId || !base || !Array.isArray(base.ingredientSections) || !Array.isArray(base.instructions)) return null;
  const proposal = {
    id: `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    recipeId: recipeId.slice(0, 80),
    recipeTitle: String(recipeTitle || base.title || '').slice(0, 160),
    base,
    baseHash: String(hash || ''),
    feedback: text,
    comments: [],
    status: 'working',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const list = await readProposals(env);
  await writeProposals(env, [proposal, ...list]);
  return proposal;
}

/** The cook reacts to a proposal: the AI starts again with the remark. Returns the proposal, or null. */
export async function addComment(env, id, comment, { log = () => {} } = {}) {
  const text = clip(comment);
  const list = await readProposals(env);
  const p = list.find((x) => x.id === id);
  if (!p || !text || !['ready', 'failed'].includes(p.status)) return null;
  const round = p.comments.length + 1; // the proposal being commented on
  p.comments.push({ text, at: Date.now() });
  p.status = 'working';
  p.attempts = 0;
  p.error = undefined;
  p.updatedAt = Date.now();
  await writeProposals(env, list);
  log('info', { event: 'feedback_commented', proposalId: p.id, round });
  return p;
}

/** approve / decline: the app applies the change itself, this only records the decision. */
export async function decide(env, id, decision, { log = () => {} } = {}) {
  if (!['approve', 'decline'].includes(decision)) return null;
  const list = await readProposals(env);
  const p = list.find((x) => x.id === id);
  if (!p || p.status === 'working') return null;
  p.status = decision === 'approve' ? 'approved' : 'declined';
  p.updatedAt = Date.now();
  await writeProposals(env, list);
  log('info', { event: 'feedback_decided', proposalId: p.id, decision: p.status, rounds: p.comments.length + 1 });
  return p;
}

/**
 * Make the proposal for one queued item. Returns 'done' (ready or failed for good, leave the queue), 'retry' (bad answer,
 * stays queued) or throws the model error (rate limit etc.) for the caller's back-off logic.
 */
export async function runProposal(env, id, { log = () => {}, subject } = {}) {
  const list = await readProposals(env);
  const p = list.find((x) => x.id === id);
  if (!p || p.status !== 'working') return 'done';
  const startedAt = Date.now();
  let model;
  const callLog = (level, fields) => {
    if (fields && fields.model && fields.status === 200) model = fields.model;
    log(level, fields);
  };
  try {
    const previous = p.proposal && p.comments.length ? p.proposal : undefined;
    const request = buildFeedbackRequest(p.base, p.feedback, p.comments.map((c) => c.text), previous);
    const content = parseFeedbackResponse(await generateContent(env, request, 'default', callLog), p.base);
    p.proposal = content;
    p.status = 'ready';
    p.updatedAt = Date.now();
    await writeProposals(env, list);
    const noChange = !hasChanges(content);
    log('info', {
      event: 'feedback_proposed',
      proposalId: p.id,
      changes: content.changes.length,
      ms: Date.now() - startedAt,
      model,
      round: p.comments.length + 1,
      // only a no-change answer shows the words, so "not supported" requests become visible; nothing else about the recipe is logged
      ...(noChange ? { noChange: true, feedback: p.feedback.slice(0, MAX_LOGGED_TEXT), summary: String(content.summary || '').slice(0, MAX_LOGGED_TEXT) } : {}),
    });
    const what = Object.keys(content.fields).length > 0 ? content.summary : `No change proposed. ${content.summary}`;
    await sendPush(env, { title: `Recept om te checken: ${p.recipeTitle}`.slice(0, 80), body: what.slice(0, 160), url: '/#/settings/review', tag: `proposal-${p.id}` }, { subject, log });
    return 'done';
  } catch (e) {
    const isBadOutput = !(e && typeof e === 'object' && 'status' in e); // model errors carry an HTTP status: the caller handles those
    if (!isBadOutput) throw e;
    log('warn', { event: 'feedback_failed', proposalId: p.id, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200), attempts: (p.attempts || 0) + 1 });
    p.attempts = (p.attempts || 0) + 1;
    if (p.attempts >= MAX_ATTEMPTS) {
      p.status = 'failed';
      p.error = `${e instanceof Error ? e.message : String(e)} (gave up after ${p.attempts} attempts)`;
      p.updatedAt = Date.now();
      await writeProposals(env, list);
      return 'done';
    }
    await writeProposals(env, list);
    return 'retry';
  }
}
