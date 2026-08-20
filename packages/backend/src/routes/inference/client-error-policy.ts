import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getConfig } from '../../config';
import { findRequestedAlias } from '../../services/routing/router';

const GENERIC_ERROR_MESSAGE = 'Upstream service unavailable';

function requestedModel(request: FastifyRequest): string | undefined {
  const body = request.body as { model?: unknown } | undefined;
  if (typeof body?.model === 'string') return body.model;

  const params = request.params as { modelWithAction?: unknown } | undefined;
  if (typeof params?.modelWithAction === 'string') return params.modelWithAction.split(':')[0];

  return undefined;
}

function sanitizesClientErrors(request: FastifyRequest): boolean {
  const model = requestedModel(request);
  if (!model) return false;

  const { alias } = findRequestedAlias(getConfig(), model);
  return (
    alias?.advanced?.some(
      (behavior) => behavior.type === 'sanitize_client_errors' && behavior.enabled !== false
    ) ?? false
  );
}

function genericErrorPayload(request: FastifyRequest, statusCode: number): string {
  if (request.url.startsWith('/v1/messages')) {
    return JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: GENERIC_ERROR_MESSAGE },
    });
  }

  if (request.url.startsWith('/v1beta/')) {
    return JSON.stringify({
      error: { code: statusCode, status: 'UNAVAILABLE', message: GENERIC_ERROR_MESSAGE },
    });
  }

  return JSON.stringify({
    error: { message: GENERIC_ERROR_MESSAGE, type: 'server_error' },
  });
}

export function registerClientErrorPolicy(fastify: FastifyInstance): void {
  fastify.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode < 400 || !sanitizesClientErrors(request)) return payload;

    reply.removeHeader('x-request-id');
    reply.removeHeader('x-plexus-request-id');

    return reply.statusCode >= 500 ? genericErrorPayload(request, reply.statusCode) : payload;
  });
}
