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
    expect(xaiWireApiType('grok-4.3')).toBe('responses');
    expect(xaiWireApiType('grok-4.6')).toBe('responses');
    expect(xaiWireApiType('grok-4.5')).toBe('responses');
    expect(xaiWireApiType(undefined)).toBe('responses');
    expect(nativeOAuthApiType('xai', 'grok-4.6')).toBe('responses');
    expect(nativeOAuthApiType('xai', 'grok-4.5')).toBe('responses');
  });

  it('posts chat completions to the Grok CLI proxy with session headers', () => {
    const prepared = prepareOAuthNativeRequest(
      'xai',
      'grok-4.6',
      AUTH,
      { model: 'grok-4.6', messages: [{ role: 'user', content: 'hi' }] },
      true,
      { apiType: 'chat', convId: 'conv_abc123' }
    );

    expect(prepared.url).toBe('https://cli-chat-proxy.grok.com/v1/chat/completions');
    expect(prepared.headers.Authorization).toBe('Bearer xai-oauth-token');
    expect(prepared.headers['x-xai-token-auth']).toBe('xai-grok-cli');
    expect(prepared.headers['x-grok-client-identifier']).toBe('grok-shell');
    expect(prepared.headers['x-grok-client-version']).toBe('1.0.6');
    expect(prepared.headers['x-authenticateresponse']).toBe('authenticate-response');
    expect(prepared.headers['x-grok-client-mode']).toBe('interactive');
    expect(prepared.headers['x-grok-session-id']).toBe('conv_abc123');
    expect(prepared.headers['User-Agent']).toMatch(/^grok-shell\/1\.0\.6 \(/);
    expect(prepared.headers['x-grok-model-override']).toBe('grok-4.6');
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

    expect(prepared.url).toBe('https://cli-chat-proxy.grok.com/v1/responses');
    expect(prepared.body.stream_options).toBeUndefined();
    expect(prepared.body.stream).toBeUndefined();
    expect(prepared.body.store).toBe(false);
    expect(prepared.body.include).toEqual(['reasoning.encrypted_content']);
    expect(prepared.body.prompt_cache_key).toBe('conv_abc123');
    expect(prepared.headers['x-grok-conv-id']).toBe('conv_abc123');
    expect(prepared.headers['x-grok-session-id']).toBe('conv_abc123');
    expect(prepared.headers['x-authenticateresponse']).toBe('authenticate-response');
    expect(prepared.headers['x-grok-model-override']).toBe('grok-4.5');
  });

  it('defaults grok-4.6 SuperGrok OAuth to /responses', () => {
    const prepared = prepareOAuthNativeRequest(
      'xai',
      'grok-4.6',
      AUTH,
      { model: 'grok-4.6', input: 'hi' },
      true,
      { convId: 'conv_abc123' }
    );

    expect(prepared.url).toBe('https://cli-chat-proxy.grok.com/v1/responses');
    expect(prepared.body.prompt_cache_key).toBe('conv_abc123');
    expect(prepared.body.stream).toBe(true);
    expect(prepared.body.store).toBe(false);
    expect(prepared.body.include).toEqual(['reasoning.encrypted_content']);
    expect(prepared.body.stream_options).toBeUndefined();
  });

  it('forwards reasoning.effort xhigh and does not rewrite summary', () => {
    const prepared = prepareOAuthNativeRequest(
      'xai',
      'grok-4.6',
      AUTH,
      {
        model: 'grok-4.6',
        input: 'hi',
        reasoning: { effort: 'xhigh', summary: 'auto' },
        include: ['reasoning.encrypted_content'],
        store: false,
        stream: true,
      },
      true,
      { convId: 'conv_abc123' }
    );

    expect(prepared.body.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
    expect(prepared.body.include).toEqual(['reasoning.encrypted_content']);
    expect(prepared.body.store).toBe(false);
    expect(prepared.body.stream).toBe(true);
  });

  it('posts Imagine generation to api.x.ai with the SuperGrok bearer', () => {
    const prepared = prepareOAuthNativeRequest(
      'xai',
      'grok-imagine-image-quality',
      AUTH,
      {
        model: 'grok-imagine-image-quality',
        prompt: 'a golden sunset',
        n: 1,
        aspect_ratio: '16:9',
        resolution: '1k',
        response_format: 'b64_json',
      },
      false,
      { apiType: 'images' }
    );

    expect(prepared.url).toBe('https://api.x.ai/v1/images/generations');
    expect(prepared.headers.Authorization).toBe('Bearer xai-oauth-token');
    expect(prepared.headers['x-xai-token-auth']).toBeUndefined();
    expect(prepared.headers['x-authenticateresponse']).toBeUndefined();
    expect(prepared.headers['x-grok-client-mode']).toBeUndefined();
    expect(prepared.headers['User-Agent']).toBeUndefined();
    expect(prepared.headers['x-grok-model-override']).toBeUndefined();
    expect(prepared.body.prompt).toBe('a golden sunset');
    expect(prepared.body.aspect_ratio).toBe('16:9');
  });

  it('posts Imagine edits to api.x.ai/images/edits', () => {
    const prepared = prepareOAuthNativeRequest(
      'xai',
      'grok-imagine-image-quality',
      AUTH,
      {
        model: 'grok-imagine-image-quality',
        prompt: 'make it night',
        image: { url: 'data:image/png;base64,aaa' },
      },
      false,
      { apiType: 'images-edits' }
    );

    expect(prepared.url).toBe('https://api.x.ai/v1/images/edits');
    expect(prepared.headers.Authorization).toBe('Bearer xai-oauth-token');
    expect(prepared.body.image).toEqual({ url: 'data:image/png;base64,aaa' });
  });
});
