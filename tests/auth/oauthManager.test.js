// Tests for the OAuth token-exchange parser — especially Slack's quirks.
import { describe, it, expect } from 'vitest';
import { parseTokenExchange } from '../../app/auth/oauthManager.js';

const SLACK_CONFIG = { defaultScope: 'search:read,channels:read' };

describe('parseTokenExchange', () => {
  it('reads a user token from authed_user when the app requested only user scopes', () => {
    // Slack returns HTTP 200 with the user token nested under authed_user when
    // there are no bot scopes (the exact case that produced the user's
    // "Token exchange did not return an access_token" error).
    const body = JSON.stringify({
      ok: true,
      app_id: 'A123',
      team: { id: 'T123', name: 'winible' },
      authed_user: {
        id: 'U123',
        scope: 'search:read,channels:read',
        access_token: 'xoxp-1234',
        token_type: 'user',
      },
    });
    const { grant } = parseTokenExchange(body, SLACK_CONFIG, 'slack');
    expect(grant.accessToken).toBe('xoxp-1234');
    expect(grant.tokenType).toBe('user');
    expect(grant.scope).toBe('search:read,channels:read');
    expect(grant.accountInfo).toEqual({ teamId: 'T123', teamName: 'winible' });
    expect(grant.authedUserId).toBe('U123');
  });

  it('captures expires_in and refresh_token from authed_user when rotation is enabled', () => {
    const body = JSON.stringify({
      ok: true,
      authed_user: {
        id: 'U123',
        scope: 'search:read',
        access_token: 'xoxe.xoxp-1-1234',
        expires_in: 43200,
        refresh_token: 'xoxe-1-1234',
        token_type: 'user',
      },
    });
    const { grant } = parseTokenExchange(body, SLACK_CONFIG, 'slack');
    expect(grant.expiresIn).toBe(43200);
    expect(grant.refreshToken).toBe('xoxe-1-1234');
  });

  it('surfaces a Slack OAuth error instead of a misleading generic message', () => {
    // Slack returns HTTP 200 with {ok:false, error} for many OAuth failures.
    const body = JSON.stringify({ ok: false, error: 'invalid_scope' });
    expect(() => parseTokenExchange(body, SLACK_CONFIG, 'slack')).toThrow(/invalid_scope/);
  });

  it('still supports a top-level access token (bot or hybrid flows)', () => {
    const body = JSON.stringify({
      ok: true,
      access_token: 'xoxb-1234',
      token_type: 'bot',
      scope: 'channels:read',
      authed_user: { id: 'U123', access_token: 'xoxp-99', token_type: 'user' },
    });
    const { grant } = parseTokenExchange(body, SLACK_CONFIG, 'slack');
    expect(grant.accessToken).toBe('xoxb-1234'); // top-level wins when present
  });

  it('rejects an unreadable response', () => {
    expect(() => parseTokenExchange('not json', SLACK_CONFIG, 'slack')).toThrow(/unreadable/);
  });
});
