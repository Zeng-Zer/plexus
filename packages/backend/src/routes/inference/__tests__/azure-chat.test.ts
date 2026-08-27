import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { setConfigForTesting } from '../../../config';
import { registerInferenceRoutes } from '../index';
import { Dispatcher } from '../../../services/dispatch/dispatcher';
import { UsageStorageService } from '../../../services/observability/usage-storage';
import { DebugManager } from '../../../services/observability/debug-manager';
import { SelectorFactory } from '../../../services/routing/selectors/factory';

const AZURE_CHAT_TEST_CONFIG = {
  providers: {},
  models: {
    'grok-4.6': {
      priority: 'selector' as const,
      sticky_session: false,
      targets: [{ provider: 'openai', model: 'grok-4.6' }],
    },
  },
  keys: {
    'test-key-1': { secret: 'sk-valid-key', comment: 'Test Key' },
  },
  failover: {
    enabled: false,
    retryableStatusCodes: [429, 500, 502, 503, 504],
    retryableErrors: ['ECONNREFUSED', 'ETIMEDOUT'],
  },
  quotas: [],
};

describe('Azure OpenAI inbound chat', () => {
  let fastify: FastifyInstance;
  let capturedRequest: any;

  beforeEach(async () => {
    setConfigForTesting(AZURE_CHAT_TEST_CONFIG);
    capturedRequest = null;

    fastify = Fastify();

    const mockDispatcher = {
      dispatch: vi.fn(async (request: any) => {
        capturedRequest = request;
        return {
          id: 'chat-test',
          model: 'grok-4.6',
          created: 1700000000,
          content: 'hello',
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
          plexus: {
            provider: 'openai',
            model: 'grok-4.6',
            apiType: 'chat',
            canonicalModel: 'grok-4.6',
          },
        };
      }),
    } as unknown as Dispatcher;

    const mockUsageStorage = {
      saveRequest: vi.fn(),
      saveError: vi.fn(),
      saveDebugLog: vi.fn(),
      updatePerformanceMetrics: vi.fn(),
      emitStartedAsync: vi.fn(),
      emitUpdatedAsync: vi.fn(),
    } as unknown as UsageStorageService;

    DebugManager.getInstance().setStorage(mockUsageStorage);
    SelectorFactory.setUsageStorage(mockUsageStorage);

    await registerInferenceRoutes(fastify, mockDispatcher, mockUsageStorage);
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('accepts /v1/openai/deployments/:deployment/chat/completions with api-version', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/v1/openai/deployments/grok-4.6/chat/completions?api-version=2025-01-01-preview',
      headers: {
        'api-key': 'sk-valid-key',
        'content-type': 'application/json',
      },
      payload: {
        messages: [{ role: 'user', content: 'Hello!' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(capturedRequest.model).toBe('grok-4.6');
    expect(capturedRequest.incomingApiType).toBe('chat');
    const body = JSON.parse(response.body);
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('hello');
  });

  it('accepts classic /openai/deployments/:deployment/chat/completions', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/openai/deployments/grok-4.6/chat/completions?api-version=2024-10-21',
      headers: {
        authorization: 'Bearer sk-valid-key',
        'content-type': 'application/json',
      },
      payload: {
        model: 'ignored-body-model',
        messages: [{ role: 'user', content: 'Hello!' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(capturedRequest.model).toBe('grok-4.6');
  });
});
