import { describe, it, expect } from 'vitest';
import { parseLink } from '../src/urlParser.js';

describe('parseLink', () => {
  it('recognizes a real Slack permalink and reconstructs the exact thread_ts', () => {
    // Captured live: this URL's thread_ts is 1784829904.373009
    const url = 'https://acme.slack.com/archives/C01EXAMPLE1/p1784829904373009?thread_ts=1784829904.373009&cid=C01EXAMPLE1';
    const result = parseLink(url);
    expect(result.source).toBe('slack');
    expect(result.sourceRef.channelId).toBe('C01EXAMPLE1');
    expect(result.sourceRef.threadTs).toBe('1784829904.373009');
  });

  it('recognizes a real Linear issue URL', () => {
    const url = 'https://linear.app/acme/issue/ACME-3869/remove-creator-account-from-discovery-search';
    const result = parseLink(url);
    expect(result.source).toBe('linear');
    expect(result.sourceRef.workspaceLabel).toBe('acme');
    expect(result.sourceRef.issueId).toBe('ACME-3869');
  });

  it('recognizes a Linear issue URL from a different workspace', () => {
    const url = 'https://linear.app/globex/issue/GLBX-47/epic-4-github-projects-migration-and-contribution-pipeline';
    const result = parseLink(url);
    expect(result.sourceRef.workspaceLabel).toBe('globex');
    expect(result.sourceRef.issueId).toBe('GLBX-47');
  });

  it('recognizes a real Devin session URL', () => {
    const url = 'https://app.devin.ai/sessions/8b8639e144ab4aba9210480801c9af5f';
    const result = parseLink(url);
    expect(result.source).toBe('devin');
    expect(result.sourceRef.url).toBe(url);
  });

  it('falls back to a generic url task for an arbitrary link', () => {
    const url = 'https://example.com/some/random/page';
    const result = parseLink(url);
    expect(result.source).toBe('url');
    expect(result.sourceRef.url).toBe(url);
  });

  it('falls back to a generic url task for a non-matching Slack-like domain', () => {
    const url = 'https://example.com/archives/C123/p123';
    expect(parseLink(url).source).toBe('url');
  });
});
