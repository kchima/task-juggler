export function buildJugglerPrompt(task, canonicalContext) {
  return [
    'You are updating the tracked status of a single task based on its latest raw context.',
    'Respond with STRICT JSON ONLY — no prose, no markdown code fences — matching exactly this shape:',
    '{"status":"not_started|in_progress|waiting_other|waiting_ai|completed","summary":"string","nextAction":"string","waitingOn":"user|<name>|null","ballInUsersCourt":true,"estRemaining":"small|medium|large","done":false}',
    `Task title: ${task.title}`,
    `Raw context:\n${canonicalContext}`,
  ].join('\n');
}

const VALID_STATUS = new Set(['not_started', 'in_progress', 'waiting_other', 'waiting_ai', 'completed']);
const VALID_EST = new Set(['small', 'medium', 'large']);

function stripCodeFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}

export function parseJugglerResponse(rawText) {
  try {
    const parsed = JSON.parse(stripCodeFences(rawText));
    if (!VALID_STATUS.has(parsed.status)) return null;
    if (!VALID_EST.has(parsed.estRemaining)) return null;
    if (typeof parsed.summary !== 'string' || typeof parsed.nextAction !== 'string') return null;
    return {
      status: parsed.status,
      summary: parsed.summary,
      nextAction: parsed.nextAction,
      waitingOn: parsed.waitingOn ?? null,
      ballInUsersCourt: Boolean(parsed.ballInUsersCourt),
      estRemaining: parsed.estRemaining,
      done: Boolean(parsed.done),
    };
  } catch {
    return null;
  }
}

export async function refreshTaskViaAi(task, canonicalContext, askClaude) {
  const raw = await askClaude(buildJugglerPrompt(task, canonicalContext), []);
  return parseJugglerResponse(raw);
}
