/**
 * Azure OpenAI clients put the deployment name in the URL and often omit
 * `model` from the JSON body. When a `:deployment` route param is present,
 * it becomes the Plexus alias — Azure uses the URL as the source of truth.
 */
export function applyAzureDeploymentModel<T extends { body?: unknown; params?: unknown }>(
  request: T
): Record<string, any> {
  const params = request.params as { deployment?: unknown } | undefined;
  const deployment = typeof params?.deployment === 'string' ? params.deployment.trim() : '';
  const body =
    request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? (request.body as Record<string, any>)
      : {};

  if (request.body !== body) {
    (request as { body: unknown }).body = body;
  }

  if (deployment) {
    body.model = deployment;
  }

  return body;
}
