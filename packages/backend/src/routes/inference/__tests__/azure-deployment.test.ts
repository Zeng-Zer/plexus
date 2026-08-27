import { describe, expect, it } from 'vitest';
import { applyAzureDeploymentModel } from '../azure-deployment';

describe('applyAzureDeploymentModel', () => {
  it('uses the URL deployment as the model when the body omits it', () => {
    const request = {
      body: { model: undefined as string | undefined, messages: [{ role: 'user', content: 'hi' }] },
      params: { deployment: 'grok-4.6' },
    };

    expect(applyAzureDeploymentModel(request).model).toBe('grok-4.6');
    expect(request.body.model).toBe('grok-4.6');
  });

  it('lets the URL deployment win over a body model', () => {
    const request = {
      body: { model: 'gpt-4', messages: [] },
      params: { deployment: 'grok-4.6' },
    };

    expect(applyAzureDeploymentModel(request).model).toBe('grok-4.6');
  });

  it('leaves ordinary chat requests unchanged', () => {
    const request = {
      body: { model: 'gpt-4', messages: [] },
      params: {},
    };

    expect(applyAzureDeploymentModel(request).model).toBe('gpt-4');
  });

  it('creates a body when Azure clients send only a deployment', () => {
    const request: { body?: unknown; params: { deployment: string } } = {
      params: { deployment: 'grok-4.6' },
    };

    const body = applyAzureDeploymentModel(request);
    expect(body.model).toBe('grok-4.6');
    expect(request.body).toBe(body);
  });
});
