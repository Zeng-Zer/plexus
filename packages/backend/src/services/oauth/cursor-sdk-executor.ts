import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SDKJsonValue } from '@cursor/sdk';

const CURSOR_TRANSPORT = 'cursor-sdk://';
const TOOL_WAIT_MS = 5 * 60 * 1000;

interface CursorUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

function unsupported(message: string): Response {
  return Response.json(
    {
      error: {
        message,
        type: 'invalid_request_error',
        code: 'cursor_unsupported',
      },
    },
    { status: 400 }
  );
}

function sdkErrorResponse(error: unknown): Response | null {
  if (!error || typeof error !== 'object') return null;
  const { status, code, message } = error as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (typeof status !== 'number' || status < 400 || status > 599) return null;
  return Response.json(
    {
      error: {
        message: typeof message === 'string' ? message : 'Cursor SDK request failed',
        type: 'cursor_sdk_error',
        ...(typeof code === 'string' ? { code } : {}),
      },
    },
    { status }
  );
}

function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') return null;
    if ((part as any).type === 'text' && typeof (part as any).text === 'string') {
      parts.push((part as any).text);
      continue;
    }
    return null;
  }
  return parts.join('');
}

export function buildCursorPrompt(payload: any): string {
  if (!Array.isArray(payload?.messages) || payload.messages.length === 0) {
    throw new Error('Cursor Agent requires at least one chat message.');
  }

  const turns: Array<{ role: string; content: string }> = [];
  for (const message of payload.messages) {
    const text = contentText(message?.content);
    if (text === null) {
      throw new Error('Cursor Agent does not support image or non-text message content.');
    }
    turns.push({
      role: typeof message?.role === 'string' ? message.role : 'unknown',
      content:
        message?.tool_calls || message?.function_call || message?.tool_call_id
          ? JSON.stringify({
              content: text,
              ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
              ...(message.function_call ? { function_call: message.function_call } : {}),
              ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
            })
          : text,
    });
  }

  const hasTools =
    payload?.tool_choice !== 'none' &&
    payload?.function_call !== 'none' &&
    ((Array.isArray(payload?.tools) && payload.tools.length > 0) ||
      (Array.isArray(payload?.functions) && payload.functions.length > 0));

  return [
    'Follow the complete JSON-encoded conversation below. Role hierarchy is flattened into this user prompt and is not a security boundary.',
    hasTools
      ? 'Respond only to the final user request. Use only the declared client tools; do not access files, shell, web, or subagents.'
      : 'Respond only to the final user request. Do not use tools or access files.',
    JSON.stringify(turns),
  ].join('\n');
}

function openAiUsage(usage: CursorUsage | undefined) {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: {
      cached_tokens: usage.cacheReadTokens,
      cache_read_tokens: usage.cacheReadTokens,
      cache_write_tokens: usage.cacheWriteTokens,
    },
    ...(usage.reasoningTokens == null
      ? {}
      : {
          completion_tokens_details: {
            reasoning_tokens: usage.reasoningTokens,
          },
        }),
  };
}

function sse(data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
  );
}

function abortPromise(signal: AbortSignal | undefined): Promise<never> | null {
  if (!signal) return null;
  return new Promise((_, reject) => {
    const rejectAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener('abort', rejectAbort, { once: true });
  });
}

async function disposeAgent(agent: any): Promise<void> {
  if (!agent) return;
  if (typeof agent[Symbol.asyncDispose] === 'function') {
    await agent[Symbol.asyncDispose]();
  } else {
    await agent.close?.();
  }
}

interface CursorClientTool {
  name: string;
  description?: string;
  inputSchema: Record<string, SDKJsonValue>;
}

interface CursorToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type CursorToolRunEvent =
  | { type: 'delta'; delta: Record<string, string> }
  | { type: 'tool'; call: CursorToolCall }
  | { type: 'terminal'; result: any; usage?: CursorUsage }
  | { type: 'error'; error: unknown };

interface PendingCursorTool {
  resolve: (result: string) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CursorToolSession {
  apiKey: string;
  model: string;
  id: string;
  created: number;
  workspace: string;
  agent?: any;
  run?: any;
  events: CursorToolRunEvent[];
  cursor: number;
  wake?: () => void;
  pending: Map<string, PendingCursorTool>;
  cleaned: boolean;
}

const cursorToolSessions = new Map<string, CursorToolSession>();

async function createCursorWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cursor-sdk-'));
}

function clientTools(payload: any): CursorClientTool[] {
  if (payload?.tool_choice === 'none' || payload?.function_call === 'none') return [];
  const tools: CursorClientTool[] = [];
  for (const tool of Array.isArray(payload?.tools) ? payload.tools : []) {
    if (tool?.type !== 'function' || typeof tool?.function?.name !== 'string') continue;
    tools.push({
      name: tool.function.name,
      description: tool.function.description,
      inputSchema:
        tool.function.parameters && typeof tool.function.parameters === 'object'
          ? (tool.function.parameters as Record<string, SDKJsonValue>)
          : { type: 'object', properties: {} },
    });
  }
  for (const fn of Array.isArray(payload?.functions) ? payload.functions : []) {
    if (typeof fn?.name !== 'string') continue;
    tools.push({
      name: fn.name,
      description: fn.description,
      inputSchema:
        fn.parameters && typeof fn.parameters === 'object'
          ? (fn.parameters as Record<string, SDKJsonValue>)
          : { type: 'object', properties: {} },
    });
  }
  return [...new Map(tools.map((tool) => [tool.name, tool])).values()];
}

function forcedToolChoice(payload: any): boolean {
  const choice = payload?.tool_choice;
  const functionCall = payload?.function_call;
  return (
    (choice != null && choice !== 'auto' && choice !== 'none') ||
    (functionCall != null && functionCall !== 'auto' && functionCall !== 'none')
  );
}

function pushToolEvent(session: CursorToolSession, event: CursorToolRunEvent): void {
  session.events.push(event);
  session.wake?.();
  session.wake = undefined;
}

async function nextToolEvent(
  session: CursorToolSession,
  signal?: AbortSignal
): Promise<CursorToolRunEvent> {
  while (session.cursor >= session.events.length) {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      session.wake = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  return session.events[session.cursor++]!;
}

async function cleanupToolSession(session: CursorToolSession): Promise<void> {
  if (session.cleaned) return;
  session.cleaned = true;
  rejectPendingTools(session, new Error('Cursor tool run ended before receiving a result.'));
  await disposeAgent(session.agent).catch(() => undefined);
  await rm(session.workspace, { recursive: true, force: true });
}

function rejectPendingTools(session: CursorToolSession, error: unknown): void {
  for (const [id, pending] of session.pending) {
    clearTimeout(pending.timer);
    cursorToolSessions.delete(id);
    pending.reject(error);
  }
  session.pending.clear();
}

async function cancelToolSession(session: CursorToolSession, error: unknown): Promise<void> {
  pushToolEvent(session, { type: 'error', error });
  rejectPendingTools(session, error);
  await session.run?.cancel?.().catch(() => undefined);
  await cleanupToolSession(session);
}

function toolCallChunk(session: CursorToolSession, call: CursorToolCall) {
  return {
    id: session.id,
    object: 'chat.completion.chunk',
    created: session.created,
    model: session.model,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] },
        finish_reason: null,
      },
    ],
  };
}

function finishChunk(session: CursorToolSession, reason: 'stop' | 'tool_calls') {
  return {
    id: session.id,
    object: 'chat.completion.chunk',
    created: session.created,
    model: session.model,
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  };
}

function renderToolStream(session: CursorToolSession, signal?: AbortSignal): Response {
  let emittedDelta = false;
  const onAbort = () =>
    void cancelToolSession(session, signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          while (true) {
            const event = await nextToolEvent(session, signal);
            if (event.type === 'delta') {
              controller.enqueue(
                sse({
                  id: session.id,
                  object: 'chat.completion.chunk',
                  created: session.created,
                  model: session.model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        ...(!emittedDelta ? { role: 'assistant' } : {}),
                        ...event.delta,
                      },
                      finish_reason: null,
                    },
                  ],
                })
              );
              emittedDelta = true;
            } else if (event.type === 'tool') {
              controller.enqueue(sse(toolCallChunk(session, event.call)));
              controller.enqueue(sse(finishChunk(session, 'tool_calls')));
              controller.enqueue(sse('[DONE]'));
              controller.close();
              return;
            } else if (event.type === 'terminal') {
              if (!emittedDelta && event.result?.result) {
                controller.enqueue(
                  sse({
                    id: session.id,
                    object: 'chat.completion.chunk',
                    created: session.created,
                    model: session.model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          role: 'assistant',
                          content: event.result.result,
                        },
                        finish_reason: null,
                      },
                    ],
                  })
                );
              }
              controller.enqueue(sse(finishChunk(session, 'stop')));
              if (event.usage || event.result?.usage) {
                controller.enqueue(
                  sse({
                    id: session.id,
                    object: 'chat.completion.chunk',
                    created: session.created,
                    model: session.model,
                    choices: [],
                    usage: openAiUsage(event.usage || event.result.usage),
                  })
                );
              }
              controller.enqueue(sse('[DONE]'));
              controller.close();
              return;
            } else {
              throw event.error;
            }
          }
        } catch (error) {
          controller.error(error);
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      })();
    },
    async cancel(reason) {
      signal?.removeEventListener('abort', onAbort);
      await cancelToolSession(session, reason ?? new DOMException('Cancelled', 'AbortError'));
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
}

async function renderToolJson(session: CursorToolSession, signal?: AbortSignal): Promise<Response> {
  let content = '';
  let reasoning = '';
  const onAbort = () =>
    void cancelToolSession(session, signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      const event = await nextToolEvent(session, signal);
      if (event.type === 'delta') {
        content += event.delta.content ?? '';
        reasoning += event.delta.reasoning_content ?? '';
      } else if (event.type === 'tool') {
        return Response.json({
          id: session.id,
          object: 'chat.completion',
          created: session.created,
          model: session.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: content || null,
                reasoning_content: reasoning || null,
                tool_calls: [event.call],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });
      } else if (event.type === 'terminal') {
        return Response.json({
          id: session.id,
          object: 'chat.completion',
          created: session.created,
          model: session.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: content || event.result?.result || '',
                reasoning_content: reasoning || null,
              },
              finish_reason: 'stop',
            },
          ],
          usage: openAiUsage(event.usage || event.result?.usage),
        });
      } else {
        throw event.error;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function renderToolSegment(
  session: CursorToolSession,
  stream: boolean,
  signal?: AbortSignal
): Response | Promise<Response> {
  return stream ? renderToolStream(session, signal) : renderToolJson(session, signal);
}

function trailingToolResults(payload: any): Array<{ id: string; content: string }> {
  if (!Array.isArray(payload?.messages)) return [];
  const results: Array<{ id: string; content: string }> = [];
  for (let index = payload.messages.length - 1; index >= 0; index -= 1) {
    const message = payload.messages[index];
    if (message?.role !== 'tool') break;
    if (typeof message.tool_call_id !== 'string') continue;
    const text = contentText(message.content);
    results.push({
      id: message.tool_call_id,
      content: text === null ? JSON.stringify(message.content) : text,
    });
  }
  return results.reverse();
}

async function resumeCursorToolRequest(
  apiKey: string,
  payload: any,
  results: Array<{ id: string; content: string }>,
  signal?: AbortSignal
): Promise<Response> {
  const sessions = new Set(
    results.map((result) => cursorToolSessions.get(result.id)).filter(Boolean)
  );
  if (sessions.size !== 1) {
    return unsupported(
      'Cursor tool continuation is missing or expired. Retry the user request to start a new run.'
    );
  }
  const session = [...sessions][0]!;
  if (session.apiKey !== apiKey || session.model !== payload.model) {
    return unsupported('Cursor tool continuation does not match this account or model.');
  }
  for (const result of results) {
    const pending = session.pending.get(result.id);
    if (!pending) {
      return unsupported(`Cursor tool continuation '${result.id}' is missing or expired.`);
    }
    clearTimeout(pending.timer);
    session.pending.delete(result.id);
    cursorToolSessions.delete(result.id);
    pending.resolve(result.content);
  }
  return renderToolSegment(session, payload.stream === true, signal);
}

async function startCursorToolRequest(
  apiKey: string,
  payload: any,
  prompt: string,
  tools: CursorClientTool[],
  signal?: AbortSignal
): Promise<Response> {
  const { Agent, JsonlLocalAgentStore } = await import('@cursor/sdk');
  const workspace = await createCursorWorkspace();
  const store = new JsonlLocalAgentStore(join(workspace, 'store'));
  const session: CursorToolSession = {
    apiKey,
    model: payload.model,
    id: `chatcmpl_${crypto.randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    workspace,
    events: [],
    cursor: 0,
    pending: new Map(),
    cleaned: false,
  };

  const customTools = Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: (args: Record<string, SDKJsonValue>, context: { toolCallId?: string }) =>
          new Promise<string>((resolve, reject) => {
            let id = context.toolCallId || `call_${crypto.randomUUID()}`;
            if (session.pending.has(id) || cursorToolSessions.has(id)) {
              id = `call_${crypto.randomUUID()}`;
            }
            const timer = setTimeout(() => {
              void cancelToolSession(
                session,
                new Error(`Cursor tool continuation '${id}' timed out.`)
              );
            }, TOOL_WAIT_MS);
            timer.unref?.();
            session.pending.set(id, { resolve, reject, timer });
            cursorToolSessions.set(id, session);
            pushToolEvent(session, {
              type: 'tool',
              call: {
                id,
                type: 'function',
                function: { name: tool.name, arguments: JSON.stringify(args) },
              },
            });
          }),
      },
    ])
  );

  const createPromise = Agent.create({
    apiKey,
    model: { id: payload.model },
    tools: ['mcp'],
    local: { cwd: workspace, settingSources: [], store, customTools },
  });
  const abort = abortPromise(signal);
  try {
    session.agent = await (abort ? Promise.race([createPromise, abort]) : createPromise);
  } catch (error) {
    if (signal?.aborted) {
      session.cleaned = true;
      void createPromise
        .then(disposeAgent, () => undefined)
        .finally(() => rm(workspace, { recursive: true, force: true }));
      throw error;
    }
    await cleanupToolSession(session);
    return sdkErrorResponse(error) ?? Promise.reject(error);
  }

  void (async () => {
    try {
      const run = await session.agent.send(prompt, {
        onDelta: ({ update }: any) => {
          if (update.type === 'text-delta' && update.text) {
            pushToolEvent(session, {
              type: 'delta',
              delta: { content: update.text },
            });
          } else if (update.type === 'thinking-delta' && update.text) {
            pushToolEvent(session, {
              type: 'delta',
              delta: { reasoning_content: update.text },
            });
          }
        },
      });
      session.run = run;
      if (session.cleaned) {
        await run.cancel?.().catch(() => undefined);
        return;
      }
      let usage: CursorUsage | undefined;
      for await (const event of run.stream()) {
        if (event.type === 'usage') usage = event.usage;
      }
      const result = await run.wait();
      if (result.status !== 'finished') {
        throw new Error(result.error?.message || `Cursor Agent run ${result.status}`);
      }
      pushToolEvent(session, { type: 'terminal', result, usage });
      await cleanupToolSession(session);
    } catch (error) {
      if (!session.cleaned) {
        pushToolEvent(session, { type: 'error', error });
        await cleanupToolSession(session);
      }
    }
  })();

  return renderToolSegment(session, payload.stream === true, signal);
}

export async function executeCursorSdkRequest(
  url: string,
  headers: Record<string, string>,
  payload: any,
  signal?: AbortSignal
): Promise<Response | null> {
  if (!url.startsWith(CURSOR_TRANSPORT)) return null;

  if (forcedToolChoice(payload)) {
    return unsupported(
      'Cursor Agent cannot guarantee forced tool choice. Use tool_choice auto or none.'
    );
  }

  let prompt: string;
  try {
    prompt = buildCursorPrompt(payload);
  } catch (error) {
    return unsupported(error instanceof Error ? error.message : String(error));
  }

  const apiKey = headers.Authorization?.replace(/^Bearer\s+/i, '');
  if (!apiKey) return new Response('Cursor OAuth API key is missing.', { status: 401 });

  const results = trailingToolResults(payload);
  if (results.length > 0) {
    return resumeCursorToolRequest(apiKey, payload, results, signal);
  }
  const tools = clientTools(payload);
  if (tools.length > 0) {
    return startCursorToolRequest(apiKey, payload, prompt, tools, signal);
  }

  const { Agent, JsonlLocalAgentStore } = await import('@cursor/sdk');
  const workspace = await createCursorWorkspace();
  const store = new JsonlLocalAgentStore(join(workspace, 'store'));
  let agent: any;
  let run: any;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await disposeAgent(agent).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  };
  const cancel = async () => {
    await run?.cancel?.().catch(() => undefined);
    await cleanup();
  };
  const onAbort = () => void cancel();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const createPromise = Agent.create({
      apiKey,
      model: { id: payload.model },
      tools: [],
      local: { cwd: workspace, settingSources: [], store },
    });
    const abort = abortPromise(signal);
    try {
      agent = await (abort ? Promise.race([createPromise, abort]) : createPromise);
    } catch (error) {
      if (signal?.aborted) {
        void createPromise
          .then(disposeAgent, () => undefined)
          .finally(() => rm(workspace, { recursive: true, force: true }));
        throw error;
      }
      return sdkErrorResponse(error) ?? Promise.reject(error);
    }

    const id = `chatcmpl_${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const pendingDeltas: Uint8Array[] = [];
    let emittedDelta = false;
    let acceptingDeltas = true;
    const emitDelta = (delta: Record<string, string>) => {
      if (!acceptingDeltas) return;
      const firstDelta = !emittedDelta;
      emittedDelta = true;
      const chunk = sse({
        id,
        object: 'chat.completion.chunk',
        created,
        model: payload.model,
        choices: [
          {
            index: 0,
            delta: { ...(firstDelta ? { role: 'assistant' } : {}), ...delta },
            finish_reason: null,
          },
        ],
      });
      if (streamController) streamController.enqueue(chunk);
      else pendingDeltas.push(chunk);
    };
    const sendPromise = agent.send(prompt, {
      ...(payload.stream === true
        ? {
            onDelta: ({ update }: any) => {
              if (update.type === 'text-delta' && update.text) emitDelta({ content: update.text });
              if (update.type === 'thinking-delta' && update.text) {
                emitDelta({ reasoning_content: update.text });
              }
            },
          }
        : {}),
    });
    try {
      run = await (abort ? Promise.race([sendPromise, abort]) : sendPromise);
    } catch (error) {
      if (signal?.aborted) {
        void sendPromise
          .then(
            (lateRun: any) => lateRun.cancel?.(),
            () => undefined
          )
          .finally(cleanup);
        throw error;
      }
      return sdkErrorResponse(error) ?? Promise.reject(error);
    }

    if (payload.stream !== true) {
      let content = '';
      let reasoning = '';
      let usage: CursorUsage | undefined;
      for await (const event of run.stream()) {
        if (event.type === 'assistant') {
          content += event.message.content
            .filter((part: any) => part.type === 'text')
            .map((part: any) => part.text)
            .join('');
        } else if (event.type === 'thinking') reasoning += event.text;
        else if (event.type === 'usage') usage = event.usage;
      }
      const result = await run.wait();
      if (result.status !== 'finished') {
        throw new Error(result.error?.message || `Cursor Agent run ${result.status}`);
      }
      return Response.json({
        id,
        object: 'chat.completion',
        created,
        model: payload.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: content || result.result || '',
              reasoning_content: reasoning || null,
            },
            finish_reason: 'stop',
          },
        ],
        usage: openAiUsage(usage || result.usage),
      });
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        for (const delta of pendingDeltas) controller.enqueue(delta);
        pendingDeltas.length = 0;
        void (async () => {
          try {
            let usage: CursorUsage | undefined;
            for await (const event of run.stream()) {
              if (event.type === 'usage') usage = event.usage;
            }
            const result = await run.wait();
            if (result.status !== 'finished') {
              throw new Error(result.error?.message || `Cursor Agent run ${result.status}`);
            }
            if (!emittedDelta) {
              controller.enqueue(
                sse({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model: payload.model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        role: 'assistant',
                        ...(result.result ? { content: result.result } : {}),
                      },
                      finish_reason: null,
                    },
                  ],
                })
              );
            }
            controller.enqueue(
              sse({
                id,
                object: 'chat.completion.chunk',
                created,
                model: payload.model,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              })
            );
            if (usage || result.usage) {
              controller.enqueue(
                sse({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model: payload.model,
                  choices: [],
                  usage: openAiUsage(usage || result.usage),
                })
              );
            }
            controller.enqueue(sse('[DONE]'));
            controller.close();
          } catch (error) {
            controller.error(error);
          } finally {
            acceptingDeltas = false;
            streamController = undefined;
            signal?.removeEventListener('abort', onAbort);
            await cleanup();
          }
        })();
      },
      async cancel() {
        acceptingDeltas = false;
        streamController = undefined;
        signal?.removeEventListener('abort', onAbort);
        await cancel();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    await cancel();
    throw error;
  } finally {
    if (payload.stream !== true || !run) {
      signal?.removeEventListener('abort', onAbort);
      await cleanup();
    }
  }
}

export const CURSOR_SDK_TRANSPORT_URL = `${CURSOR_TRANSPORT}agent`;
