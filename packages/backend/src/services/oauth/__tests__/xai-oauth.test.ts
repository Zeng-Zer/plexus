import { describe, expect, it } from 'vitest';
import { ProviderConfigSchema } from '../../../config';
import { oauthProviderTypeEnum } from '../../../../drizzle/schema/postgres/enums';
import {
  isNativeOAuthProvider,
  nativeOAuthApiType,
  prepareOAuthNativeRequest,
  xaiWireApiType,
} from '../oauth-native-request';

const AUTH = { mode: 'oauth' as const, token: 'xai-oauth-token' };

describe('xAI OAuth provider', () => {
  it('is accepted in config and the Postgres oauth enum', () => {
    expect(oauthProviderTypeEnum.enumValues).toContain('xai');
    expect(
      ProviderConfigSchema.safeParse({
        api_base_url: 'oauth://',
        api_key: 'oauth',
        oauth_provider: 'xai',
        oauth_account: 'personal',
      }).success
    ).toBe(true);
  });

  it('is a native OAuth provider with per-model wire types', () => {
    expect(isNativeOAuthProvider('xai')).toBe(true);
    expect(xaiWireApiType('grok-4.3')).toBe('chat');
    expect(xaiWireApiType('grok-4.6')).toBe('chat');
    expect(xaiWireApiType('grok-4.5')).toBe('responses');
    expect(xaiWireApiType(undefined)).toBe('chat');
    expect(nativeOAuthApiType('xai', 'grok-4.5')).toBe('responses');
  });

  it('posts chat completions to api.x.ai with the OAuth bearer token', () => {
    const prepared = prepareOAuthNativeRequest(
      'xai',
      'grok-4.6',
      AUTH,
      { model: 'grok-4.6', messages: [{ role: 'user', content: 'hi' }] },
      true,
      { apiType: 'chat', convId: 'conv_abc123' }
    );

    expect(prepared.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(prepared.headers.Authorization).toBe('Bearer xai-oauth-token');
    expect(prepared.headers['x-grok-conv-id']).toBe('conv_abc123');
    expect(prepared.body.stream_options).toEqual({ include_usage: true });
  });

  it('posts Responses models to /responses and fills prompt_cache_key from conv id', () => {
    const prepared = prepareOAuthNativeRequest(
      'xai',
      'grok-4.5',
      AUTH,
      { model: 'grok-4.5', input: 'hi' },
      false,
      { apiType: 'responses', convId: 'conv_abc123' }
    );

    expect(prepared.url).toBe('https://api.x.ai/v1/responses');
    expect(prepared.body.stream_options).toBeUndefined();
    expect(prepared.body.prompt_cache_key).toBe('conv_abc123');
    expect(prepared.headers['x-grok-conv-id']).toBe('conv_abc123');
  });
});
