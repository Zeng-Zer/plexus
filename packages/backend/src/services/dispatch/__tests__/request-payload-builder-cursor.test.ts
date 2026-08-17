import { beforeEach, describe, expect, it } from 'vitest';
import { setConfigForTesting } from '../../../config';
import { registerSpy } from '../../../../test/test-utils';
import { OAuthAuthManager } from '../../oauth/oauth-auth-manager';
import { ConfigService } from '../../configuration/config-service';
import { buildRequestPayload } from '../request-payload-builder';

const route = {
  provider: 'cursor-provider',
  model: 'cursor-model',
  config: {
    api_base_url: 'oauth://cursor',
    oauth_provider: 'cursor',
    oauth_account: 'work',
  },
} as any;

describe('Cursor request payload bypass', () => {
  beforeEach(() => {
    OAuthAuthManager.resetForTesting();
    setConfigForTesting({ providers: {}, models: {}, keys: {} } as any);
    registerSpy(ConfigService, 'getInstance').mockReturnValue({
      getAllOAuthProviders: async () => [],
    });
    registerSpy(OAuthAuthManager.getInstance(), 'getApiKey').mockResolvedValue('cursor-key');
  });

  it('keeps same-format OpenAI chat on pass-through', async () => {
    const originalBody = {
      model: 'alias',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    };
    const transformer = { transformRequest: () => Promise.reject(new Error('must not transform')) };

    const result = await buildRequestPayload(
      {
        model: 'alias',
        messages: originalBody.messages,
        stream: true,
        incomingApiType: 'chat',
        originalBody,
        metadata: { plexus_metadata: { cursorFast: false } },
      } as any,
      route,
      transformer,
      'chat'
    );

    expect(result.bypassTransformation).toBe(true);
    expect(result.payload).toMatchObject({
      model: 'cursor-model',
      messages: originalBody.messages,
      plexus_cursor_fast: false,
    });
  });

  it.each(['messages', 'responses'])(
    'translates %s clients to chat and translates response back',
    async (incomingApiType) => {
      const transformer = {
        transformRequest: async () => ({
          model: 'cursor-model',
          messages: [{ role: 'user', content: `from-${incomingApiType}` }],
        }),
      };

      const result = await buildRequestPayload(
        {
          model: 'alias',
          messages: [{ role: 'user', content: 'hello' }],
          incomingApiType,
          originalBody: { model: 'alias' },
          metadata: { plexus_metadata: { cursorFast: true } },
        } as any,
        route,
        transformer,
        'chat'
      );

      expect(result.bypassTransformation).toBe(false);
      expect(result.payload.messages[0].content).toBe(`from-${incomingApiType}`);
      expect(result.payload.plexus_cursor_fast).toBe(true);
    }
  );

  it('does not forward the Cursor flag to another provider', async () => {
    const result = await buildRequestPayload(
      {
        model: 'alias',
        messages: [{ role: 'user', content: 'hello' }],
        incomingApiType: 'chat',
        originalBody: {
          model: 'alias',
          messages: [{ role: 'user', content: 'hello' }],
        },
        metadata: { plexus_metadata: { cursorFast: true } },
      } as any,
      {
        provider: 'other-provider',
        model: 'other-model',
        config: { api_base_url: 'https://example.com/v1/chat/completions' },
      } as any,
      { transformRequest: async () => ({}) },
      'chat'
    );

    expect(result.payload).not.toHaveProperty('plexus_cursor_fast');
  });
});
