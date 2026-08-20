import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setConfigForTesting } from '../../../config';
import type { Dispatcher } from '../../../services/dispatch/dispatcher';
import type { UsageStorageService } from '../../../services/observability/usage-storage';
import { registerClientErrorPolicy } from '../client-error-policy';
import { registerInferenceRoutes } from '../index';

describe('client error policy', () => {
  beforeEach(() => {
    setConfigForTesting({
      providers: {},
      models: {
        high: {
          priority: 'selector',
          sticky_session: false,
          target_groups: [{ name: 'default', selector: 'random', targets: [] }],
          additional_aliases: ['high-alt'],
          advanced: [{ type: 'sanitize_client_errors', enabled: true }],
        },
        normal: {
          priority: 'selector',
          sticky_session: false,
          target_groups: [{ name: 'default', selector: 'random', targets: [] }],
        },
      },
      keys: {},
      quotas: [],
      failover: {
        enabled: false,
        retryableStatusCodes: [],
        retryableErrors: [],
      },
    });
  });

  async function request(model: string, statusCode: number) {
    const fastify = Fastify();
    registerClientErrorPolicy(fastify);
    fastify.post('/test', (request, reply) => {
      reply.header('x-request-id', 'internal-request-id');
      reply.header('x-plexus-request-id', 'internal-plexus-request-id');
      return reply.code(statusCode).send({
        error: {
          message: 'All targets failed: openai/gpt-5.6-sol',
          type: statusCode >= 500 ? 'server_error' : 'invalid_request_error',
          routing_context: { provider: 'openai', target_model: 'gpt-5.6-sol' },
        },
      });
    });
    await fastify.ready();

    const response = await fastify.inject({
      method: 'POST',
      url: '/test',
      payload: { model },
    });
    await fastify.close();
    return response;
  }

  it.each(['high', 'high-alt', 'direct/high/default', 'direct/high-alt/default'])(
    'sanitizes 5xx errors for %s and removes routing request IDs',
    async (model) => {
      const response = await request(model, 503);

      expect(response.headers['x-request-id']).toBeUndefined();
      expect(response.headers['x-plexus-request-id']).toBeUndefined();
      expect(response.json()).toEqual({
        error: { message: 'Upstream service unavailable', type: 'server_error' },
      });
    }
  );

  it('preserves useful 4xx details but removes routing request IDs', async () => {
    const response = await request('high', 400);

    expect(response.headers['x-request-id']).toBeUndefined();
    expect(response.json().error.message).toBe('All targets failed: openai/gpt-5.6-sol');
  });

  it('does not alter errors for aliases without the behavior', async () => {
    const response = await request('normal', 503);

    expect(response.headers['x-request-id']).toBe('internal-request-id');
    expect(response.headers['x-plexus-request-id']).toBe('internal-plexus-request-id');
    expect(response.json().error.routing_context).toEqual({
      provider: 'openai',
      target_model: 'gpt-5.6-sol',
    });
  });

  it('sanitizes invalid direct groups that still resolve to the protected alias', async () => {
    const response = await request('direct/high/unknown-group', 503);

    expect(response.headers['x-request-id']).toBeUndefined();
    expect(response.json().error.message).toBe('Upstream service unavailable');
  });

  it('does not treat direct provider routing as an alias policy', async () => {
    const response = await request('direct/openai/gpt-5.6-sol', 503);

    expect(response.headers['x-request-id']).toBe('internal-request-id');
    expect(response.headers['x-plexus-request-id']).toBe('internal-plexus-request-id');
    expect(response.json().error.message).toContain('openai/gpt-5.6-sol');
  });

  it('keeps full error details in internal storage', async () => {
    const error = Object.assign(new Error('All targets failed: openai/gpt-5.6-sol'), {
      routingContext: { statusCode: 503, provider: 'openai', targetModel: 'gpt-5.6-sol' },
    });
    const dispatcher = {
      dispatch: vi.fn(async () => {
        throw error;
      }),
    } as unknown as Dispatcher;
    const usageStorage = {
      emitStartedAsync: vi.fn(),
      emitUpdatedAsync: vi.fn(),
      saveRequest: vi.fn(),
      saveError: vi.fn(),
    } as unknown as UsageStorageService;
    setConfigForTesting({
      providers: {},
      models: {
        high: {
          priority: 'selector',
          sticky_session: false,
          target_groups: [{ name: 'default', selector: 'random', targets: [] }],
          advanced: [{ type: 'sanitize_client_errors', enabled: true }],
        },
      },
      keys: { test: { secret: 'secret' } },
      quotas: [],
      failover: { enabled: false, retryableStatusCodes: [], retryableErrors: [] },
    });
    const fastify = Fastify();
    await registerInferenceRoutes(fastify, dispatcher, usageStorage);
    await fastify.ready();

    const response = await fastify.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer secret' },
      payload: { model: 'high', messages: [] },
    });
    await fastify.close();

    expect(response.statusCode).toBe(503);
    expect(response.headers['x-request-id']).toBeUndefined();
    expect(response.json().error.message).toBe('Upstream service unavailable');
    expect(usageStorage.saveError).toHaveBeenCalledWith(
      expect.any(String),
      error,
      expect.objectContaining({ provider: 'openai', targetModel: 'gpt-5.6-sol' })
    );
  });

  it('does not expose request IDs on authentication errors before body parsing', async () => {
    const dispatcher = { dispatch: vi.fn() } as unknown as Dispatcher;
    const usageStorage = {
      emitStartedAsync: vi.fn(),
      emitUpdatedAsync: vi.fn(),
    } as unknown as UsageStorageService;
    const fastify = Fastify();
    await registerInferenceRoutes(fastify, dispatcher, usageStorage);
    await fastify.ready();

    const response = await fastify.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer invalid' },
      payload: { model: 'high', messages: [] },
    });
    await fastify.close();

    expect(response.statusCode).toBe(401);
    expect(response.headers['x-request-id']).toBeUndefined();
    expect(response.headers['x-plexus-request-id']).toBeUndefined();
  });
});
