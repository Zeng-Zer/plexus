import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CURSOR_SDK_TRANSPORT_URL,
  buildCursorPrompt,
  executeCursorSdkRequest,
} from '../cursor-sdk-executor';

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  storeRoots: [] as string[],
}));

vi.mock('@cursor/sdk', () => ({
  Agent: { create: sdk.create },
  JsonlLocalAgentStore: class {
    constructor(root: string) {
      sdk.storeRoots.push(root);
    }
  },
}));

function mockAgent(events: any[], result: any = { status: 'finished' }) {
  const run = {
    id: 'run-1',
    async *stream() {
      for (const event of events) yield event;
    },
    wait: vi.fn(async () => result),
    cancel: vi.fn(async () => undefined),
  };
  const agent = {
    send: vi.fn(async () => run),
    close: vi.fn(),
    [Symbol.asyncDispose]: vi.fn(async () => undefined),
  };
  sdk.create.mockResolvedValue(agent);
  return { agent, run };
}

const payload = {
  model: 'cursor-model',
  messages: [
    { role: 'system', content: 'Be concise.' },
    { role: 'developer', content: 'Use plain text.' },
    { role: 'user', content: 'Hello' },
  ],
};

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  );

async function waitUntil(check: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(check()).toBe(true));
}

describe('Cursor SDK executor', () => {
  beforeEach(() => {
    sdk.create.mockReset();
    sdk.storeRoots.length = 0;
    process.env.DATA_DIR = '/tmp';
  });

  it('serializes text history while documenting flattened role hierarchy', () => {
    const prompt = buildCursorPrompt(payload);
    expect(prompt).toContain('Role hierarchy is flattened');
    expect(prompt).toContain(
      JSON.stringify([
        { role: 'system', content: 'Be concise.' },
        { role: 'developer', content: 'Use plain text.' },
        { role: 'user', content: 'Hello' },
      ])
    );
  });

  it('synthesizes unary output, maps cache usage, and removes isolated store/workspace', async () => {
    const { agent } = mockAgent([
      { type: 'thinking', text: 'reasoning' },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'answer' }] },
      },
      {
        type: 'usage',
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 10,
          cacheReadTokens: 4,
          cacheWriteTokens: 1,
        },
      },
    ]);

    const response = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      payload
    );
    const body = await response!.json();

    expect(body.choices[0].message).toMatchObject({
      content: 'answer',
      reasoning_content: 'reasoning',
    });
    expect(body.usage).toMatchObject({
      prompt_tokens: 8,
      completion_tokens: 2,
      total_tokens: 10,
      prompt_tokens_details: {
        cached_tokens: 4,
        cache_read_tokens: 4,
        cache_write_tokens: 1,
      },
    });
    expect(sdk.create).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'key',
        model: { id: 'cursor-model' },
        tools: [],
        local: expect.objectContaining({
          settingSources: [],
          store: expect.anything(),
          cwd: expect.any(String),
        }),
      })
    );
    expect(sdk.create.mock.calls[0]![0].local.cwd.startsWith(join(tmpdir(), 'cursor-sdk-'))).toBe(
      true
    );
    expect(agent[Symbol.asyncDispose]).toHaveBeenCalledOnce();
    expect(await exists(sdk.storeRoots[0]!.replace(/\/store$/, ''))).toBe(false);
  });

  it('emits no stream bytes before official SDK delta and puts role on first real delta', async () => {
    let onDelta: ((event: any) => void) | undefined;
    let finish!: () => void;
    const terminal = new Promise<void>((resolve) => (finish = resolve));
    const run = {
      id: 'run-stream',
      async *stream() {
        await terminal;
      },
      wait: vi.fn(async () => ({ status: 'finished' })),
      cancel: vi.fn(async () => finish()),
    };
    const agent = {
      send: vi.fn(async (_prompt: string, options: any) => {
        onDelta = options.onDelta;
        return run;
      }),
      [Symbol.asyncDispose]: vi.fn(async () => undefined),
    };
    sdk.create.mockResolvedValue(agent);

    const response = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      { ...payload, stream: true }
    );
    const reader = response!.body!.getReader();
    let readSettled = false;
    const firstRead = reader.read().then((value) => {
      readSettled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readSettled).toBe(false);

    onDelta!({ update: { type: 'thinking-delta', text: 'think' } });
    const first = new TextDecoder().decode((await firstRead).value);
    expect(first).toContain('"role":"assistant"');
    expect(first).toContain('"reasoning_content":"think"');

    onDelta!({ update: { type: 'text-delta', text: 'hello' } });
    const second = new TextDecoder().decode((await reader.read()).value);
    expect(second).toContain('"content":"hello"');
    expect(second).not.toContain('"role":"assistant"');
    finish();
    await reader.cancel();
  });

  it('emits the finish chunk before the optional usage chunk and done marker', async () => {
    mockAgent(
      [
        {
          type: 'usage',
          usage: {
            inputTokens: 3,
            outputTokens: 2,
            cacheReadTokens: 4,
            cacheWriteTokens: 1,
            totalTokens: 10,
          },
        },
      ],
      { status: 'finished', result: 'answer' }
    );

    const response = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      { ...payload, stream: true }
    );
    const body = await response!.text();
    const finishIndex = body.indexOf('"finish_reason":"stop"');
    const usageIndex = body.indexOf('"prompt_tokens":8');
    const doneIndex = body.indexOf('data: [DONE]');

    expect(finishIndex).toBeGreaterThan(-1);
    expect(usageIndex).toBeGreaterThan(finishIndex);
    expect(doneIndex).toBeGreaterThan(usageIndex);
  });

  it('bridges SDK custom tools through OpenAI tool calls and resumes the same run', async () => {
    let toolResult: Promise<unknown>;
    let sendOptions: any;
    const run = {
      id: 'run-tools',
      async *stream() {
        const result = await toolResult;
        sendOptions.onDelta({
          update: { type: 'text-delta', text: `result: ${result}` },
        });
      },
      wait: vi.fn(async () => ({ status: 'finished' })),
      cancel: vi.fn(async () => undefined),
    };
    const agent = {
      send: vi.fn(async (_prompt: string, options: any) => {
        sendOptions = options;
        const createOptions = sdk.create.mock.calls.at(-1)![0];
        toolResult = createOptions.local.customTools.lookup.execute(
          { query: 'status' },
          { toolCallId: 'sdk-call' }
        );
        return run;
      }),
      [Symbol.asyncDispose]: vi.fn(async () => undefined),
    };
    sdk.create.mockResolvedValue(agent);

    const tools = [
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look up a value',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      },
    ];
    const first = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      { ...payload, stream: true, tools }
    );
    const firstBody = await first!.text();
    const toolCall = JSON.parse(
      firstBody
        .split('\n')
        .find((line) => line.startsWith('data: {') && line.includes('tool_calls'))!
        .slice(6)
    ).choices[0].delta.tool_calls[0];

    expect(toolCall).toMatchObject({
      type: 'function',
      function: { name: 'lookup', arguments: '{"query":"status"}' },
    });
    expect(firstBody).toContain('"finish_reason":"tool_calls"');
    expect(sdk.create.mock.calls.at(-1)![0]).toMatchObject({
      tools: ['mcp'],
      local: {
        customTools: {
          lookup: {
            description: 'Look up a value',
            inputSchema: tools[0]!.function.parameters,
          },
        },
      },
    });

    const second = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      {
        ...payload,
        stream: true,
        tools,
        messages: [
          ...payload.messages,
          {
            role: 'assistant',
            content: null,
            tool_calls: [toolCall],
          },
          { role: 'tool', tool_call_id: toolCall.id, content: 'healthy' },
        ],
      }
    );
    const secondBody = await second!.text();

    expect(secondBody).toContain('"content":"result: healthy"');
    expect(secondBody).toContain('"finish_reason":"stop"');
    expect(agent.send).toHaveBeenCalledOnce();
    expect(agent[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  });

  it('bridges non-streaming tool calls and continuation results', async () => {
    let toolResult: Promise<unknown>;
    let sendOptions: any;
    const run = {
      id: 'run-tools-json',
      async *stream() {
        const result = await toolResult;
        sendOptions.onDelta({
          update: { type: 'text-delta', text: `json: ${result}` },
        });
      },
      wait: vi.fn(async () => ({ status: 'finished' })),
      cancel: vi.fn(async () => undefined),
    };
    const agent = {
      send: vi.fn(async (_prompt: string, options: any) => {
        sendOptions = options;
        toolResult = sdk.create.mock.calls
          .at(-1)![0]
          .local.customTools.lookup.execute({ query: 'status' }, { toolCallId: 'sdk-json-call' });
        return run;
      }),
      [Symbol.asyncDispose]: vi.fn(async () => undefined),
    };
    sdk.create.mockResolvedValue(agent);
    const tools = [
      {
        type: 'function',
        function: {
          name: 'lookup',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
      },
    ];

    const first = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      { ...payload, tools }
    );
    const firstBody = await first!.json();
    const toolCall = firstBody.choices[0].message.tool_calls[0];
    expect(firstBody.choices[0].finish_reason).toBe('tool_calls');

    const second = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      {
        ...payload,
        tools,
        messages: [
          ...payload.messages,
          { role: 'assistant', content: null, tool_calls: [toolCall] },
          { role: 'tool', tool_call_id: toolCall.id, content: 'healthy' },
        ],
      }
    );
    const secondBody = await second!.json();

    expect(secondBody.choices[0]).toMatchObject({
      message: { content: 'json: healthy' },
      finish_reason: 'stop',
    });
    expect(agent.send).toHaveBeenCalledOnce();
    expect(agent[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  });

  it('cancels active run and cleans workspace when response stream is cancelled', async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => (unblock = resolve));
    const run = {
      id: 'run-cancel',
      async *stream() {
        await blocked;
      },
      wait: vi.fn(),
      cancel: vi.fn(async () => unblock()),
    };
    const agent = {
      send: vi.fn(async () => run),
      [Symbol.asyncDispose]: vi.fn(async () => undefined),
    };
    sdk.create.mockResolvedValue(agent);

    const response = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      { ...payload, stream: true }
    );
    await response!.body!.cancel();

    expect(run.cancel).toHaveBeenCalledOnce();
    expect(agent[Symbol.asyncDispose]).toHaveBeenCalledOnce();
    expect(await exists(sdk.storeRoots[0]!.replace(/\/store$/, ''))).toBe(false);
  });

  it('aborts promptly during pending Agent.create and disposes late agent', async () => {
    let resolveCreate!: (agent: any) => void;
    sdk.create.mockReturnValue(new Promise((resolve) => (resolveCreate = resolve)));
    const controller = new AbortController();
    const execution = executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      payload,
      controller.signal
    );
    await waitUntil(() => sdk.create.mock.calls.length === 1);
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });

    const lateAgent = { [Symbol.asyncDispose]: vi.fn(async () => undefined) };
    resolveCreate(lateAgent);
    await waitUntil(() => lateAgent[Symbol.asyncDispose].mock.calls.length === 1);
    expect(await exists(sdk.storeRoots[0]!.replace(/\/store$/, ''))).toBe(false);
  });

  it('maps pre-stream SDK status and code into provider JSON response', async () => {
    sdk.create.mockRejectedValue(
      Object.assign(new Error('revoked Cursor key'), {
        status: 401,
        code: 'authentication_failed',
      })
    );

    const response = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      payload
    );

    expect(response!.status).toBe(401);
    expect(await response!.json()).toEqual({
      error: {
        message: 'revoked Cursor key',
        type: 'cursor_sdk_error',
        code: 'authentication_failed',
      },
    });
  });

  it('rejects forced tool choice because Cursor cannot guarantee it', async () => {
    const response = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      {
        ...payload,
        tools: [{ type: 'function', function: { name: 'lookup' } }],
        tool_choice: 'required',
      }
    );

    expect(response!.status).toBe(400);
    expect(await response!.text()).toContain('cannot guarantee forced tool choice');
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it('rejects image content with 400', async () => {
    const request = {
      ...payload,
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://x' } }],
        },
      ],
    };
    const response = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      request
    );

    expect(response!.status).toBe(400);
    expect(await response!.text()).toContain('image or non-text');
    expect(sdk.create).not.toHaveBeenCalled();
  });
});
