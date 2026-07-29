import { describe, it, expect, vi } from 'vitest';
import { buildJugglerPrompt, parseJugglerResponse, refreshTaskViaAi } from '../src/aiClient.js';

const VALID = {
  status: 'waiting_other',
  summary: 'Waiting on Devin to confirm the release is safe to merge.',
  nextAction: 'Wait for mergers to reply in #pull-requests',
  waitingOn: 'Devin',
  ballInUsersCourt: false,
  estRemaining: 'small',
  done: false,
};

describe('buildJugglerPrompt', () => {
  it('embeds the task title and raw context and demands strict JSON', () => {
    const prompt = buildJugglerPrompt({ title: 'Ship release PR' }, 'some raw context');
    expect(prompt).toContain('Ship release PR');
    expect(prompt).toContain('some raw context');
    expect(prompt.toLowerCase()).toContain('json');
  });
});

describe('parseJugglerResponse', () => {
  it('parses a clean JSON response', () => {
    expect(parseJugglerResponse(JSON.stringify(VALID))).toEqual(VALID);
  });

  it('strips a ```json code fence', () => {
    const fenced = '```json\n' + JSON.stringify(VALID) + '\n```';
    expect(parseJugglerResponse(fenced)).toEqual(VALID);
  });

  it('strips a bare ``` code fence', () => {
    const fenced = '```\n' + JSON.stringify(VALID) + '\n```';
    expect(parseJugglerResponse(fenced)).toEqual(VALID);
  });

  it('returns null for malformed JSON', () => {
    expect(parseJugglerResponse('{not valid json')).toBeNull();
  });

  it('returns null for an invalid status value', () => {
    expect(parseJugglerResponse(JSON.stringify({ ...VALID, status: 'bogus' }))).toBeNull();
  });

  it('returns null for an invalid estRemaining value', () => {
    expect(parseJugglerResponse(JSON.stringify({ ...VALID, estRemaining: 'huge' }))).toBeNull();
  });

  it('returns null when required string fields are missing', () => {
    const { summary, ...rest } = VALID;
    expect(parseJugglerResponse(JSON.stringify(rest))).toBeNull();
  });

  it('defaults waitingOn to null when absent', () => {
    const { waitingOn, ...rest } = VALID;
    expect(parseJugglerResponse(JSON.stringify(rest)).waitingOn).toBeNull();
  });
});

describe('refreshTaskViaAi', () => {
  it('calls askClaude once with a built prompt and returns the parsed result', async () => {
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify(VALID));
    const result = await refreshTaskViaAi({ title: 'x' }, 'raw context', askClaude);
    expect(askClaude).toHaveBeenCalledTimes(1);
    expect(result).toEqual(VALID);
  });

  it('returns null when askClaude returns unparsable text, without throwing', async () => {
    const askClaude = vi.fn().mockResolvedValue('not json at all');
    const result = await refreshTaskViaAi({ title: 'x' }, 'raw context', askClaude);
    expect(result).toBeNull();
  });
});
