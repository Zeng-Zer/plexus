import { create, fromBinary, toBinary, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  ConversationTokenDetailsSchema,
  ConversationTurnStructureSchema,
  InteractionUpdateSchema,
  TextDeltaUpdateSchema,
  UserMessageSchema,
} from '../generated/cursor-agent_pb';
import { resetCursorConversationStore } from '../cursor-conversation-store';
import {
  buildCursorRequest,
  CURSOR_SDK_TRANSPORT_URL,
  executeCursorSdkRequest,
  normalizeCursorMessages,
} from '../cursor-sdk-executor';

const transport = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock('node:http2', () => ({ default: { connect: transport.connect } }));

const payload = {
  model: 'cursor-model',
  messages: [
    { role: 'system', content: 'Be concise.' },
    { role: 'developer', content: 'Use plain text.' },
    { role: 'user', content: 'Hello' },
  ],
};

function decodeRun(request: Uint8Array) {
  const client = fromBinary(AgentClientMessageSchema, request);
  if (client.message.case !== 'runRequest') throw new Error('Expected a run request');
  return client.message.value;
}

function decodeWrittenRun(write: { mock: { calls: unknown[][] } }) {
  const framed = write.mock.calls[0]![0] as Buffer;
  return decodeRun(framed.subarray(5));
}

describe('Cursor protocol executor', () => {
  beforeEach(() => {
    resetCursorConversationStore();
    transport.connect.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ accessToken: 'cursor-access-token' }))
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('maps developer messages to system without injecting text', () => {
    expect(normalizeCursorMessages(payload)).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'system', content: 'Use plain text.' },
      { role: 'user', content: 'Hello' },
    ]);

    const built = buildCursorRequest(payload);
    const run = decodeRun(built.request);
    const roots = run.conversationState!.rootPromptMessagesJson.map((id) =>
      JSON.parse(new TextDecoder().decode(built.blobs.get(Buffer.from(id).toString('hex'))))
    );

    expect(roots).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'system', content: 'Use plain text.' },
    ]);
    expect(JSON.stringify(roots)).not.toContain('Respond only');
    expect(run.action!.action).toMatchObject({
      case: 'userMessageAction',
      value: { userMessage: { text: 'Hello' } },
    });

    const noSystem = decodeRun(
      buildCursorRequest({
        model: 'cursor-model',
        messages: [{ role: 'user', content: 'Hello' }],
      }).request
    );
    expect(noSystem.conversationState!.rootPromptMessagesJson).toEqual([]);
  });

  it('attaches Hindsight user injections to the current turn instead of history roots', () => {
    const built = buildCursorRequest({
      model: 'cursor-model',
      messages: [
        { role: 'system', content: 'Be concise.' },
        {
          role: 'user',
          content: '<hindsight-mental-models>\nPrior design notes\n</hindsight-mental-models>',
        },
        { role: 'user', content: '<hindsight-memory>\nTurn 1 recall\n</hindsight-memory>' },
        { role: 'user', content: 'Hello' },
      ],
    });
    const run = decodeRun(built.request);
    const roots = run.conversationState!.rootPromptMessagesJson.map((id) =>
      JSON.parse(new TextDecoder().decode(built.blobs.get(Buffer.from(id).toString('hex'))))
    );

    expect(roots).toEqual([{ role: 'system', content: 'Be concise.' }]);
    expect(run.action!.action).toMatchObject({
      case: 'userMessageAction',
      value: {
        userMessage: {
          text: [
            '<hindsight-mental-models>\nPrior design notes\n</hindsight-mental-models>',
            '<hindsight-memory>\nTurn 1 recall\n</hindsight-memory>',
            'Hello',
          ].join('\n\n'),
        },
      },
    });
  });

  it.each([true, false])('encodes Cursor fast mode %s', (fast) => {
    const run = decodeRun(buildCursorRequest({ ...payload, plexus_cursor_fast: fast }).request);

    expect(run.requestedModel?.parameters).toEqual([
      expect.objectContaining({ id: 'fast', value: String(fast) }),
    ]);
  });

  it('rejects an invalid Cursor fast mode', () => {
    expect(() => buildCursorRequest({ ...payload, plexus_cursor_fast: 'false' })).toThrow(
      'plexus_cursor_fast must be a boolean.'
    );
  });

  it('encodes prior user and assistant turns as structured history', () => {
    const built = buildCursorRequest({
      model: 'cursor-model',
      messages: [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Answer' },
        { role: 'user', content: 'Second' },
      ],
    });
    const run = decodeRun(built.request);
    expect(run.conversationState!.turns).toHaveLength(1);

    const turnId = run.conversationState!.turns[0]!;
    const turn = fromBinary(
      ConversationTurnStructureSchema,
      built.blobs.get(Buffer.from(turnId).toString('hex'))!
    ).turn.value!;
    const user = fromBinary(
      UserMessageSchema,
      built.blobs.get(Buffer.from(turn.userMessage).toString('hex'))!
    );
    const step = fromBinary(
      ConversationStepSchema,
      built.blobs.get(Buffer.from(turn.steps[0]!).toString('hex'))!
    );

    expect(user.text).toBe('First');
    expect(step.message).toMatchObject({
      case: 'assistantMessage',
      value: { text: 'Answer' },
    });
    expect(run.action!.action).toMatchObject({
      case: 'userMessageAction',
      value: { userMessage: { text: 'Second' } },
    });
  });

  it('encodes Pi tool-result images in Cursor selected context', () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2NDNwAAAABJRU5ErkJggg==';
    const imagePayload = {
      model: 'cursor-model',
      messages: [
        { role: 'user', content: 'Inspect an image.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-image',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"image.png"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call-image', content: '(see attached image)' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Attached image(s) from tool result:' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
          ],
        },
      ],
    };

    expect(normalizeCursorMessages(imagePayload)[3]).toMatchObject({
      role: 'user',
      content: 'Attached image(s) from tool result:',
      images: [{ mimeType: 'image/png' }],
    });

    const run = decodeRun(buildCursorRequest(imagePayload).request);
    const action = run.action?.action;
    if (action?.case !== 'userMessageAction') {
      throw new Error('Expected a user message action');
    }
    const selectedImages = action.value.userMessage!.selectedContext?.selectedImages;
    expect(selectedImages).toHaveLength(1);
    const image = selectedImages?.[0];
    if (!image || image.dataOrBlobId.case !== 'data') {
      throw new Error('Expected inline image data');
    }
    expect(image).toMatchObject({
      mimeType: 'image/png',
      dataOrBlobId: { case: 'data' },
    });
    expect(Buffer.from(image.dataOrBlobId.value).toString('base64')).toBe(png);
  });

  it('exposes only caller-provided tools', () => {
    const built = buildCursorRequest({
      ...payload,
      tools: [
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
      ],
    });
    const run = decodeRun(built.request);
    const tools = run.mcpTools!.mcpTools;

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'lookup',
      description: 'Look up a value',
      providerIdentifier: 'client',
      toolName: 'lookup',
    });
    expect(toJson(ValueSchema, tools[0]!.inputSchema!)).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
  });

  it('reconstructs tool results without requiring an in-memory bridge', () => {
    const built = buildCursorRequest({
      model: 'cursor-model',
      messages: [
        { role: 'user', content: 'Check status' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"query":"status"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'healthy' },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'lookup', parameters: { type: 'object' } },
        },
      ],
    });
    const run = decodeRun(built.request);
    expect(run.action!.action.case).toBe('resumeAction');
    const roots = run.conversationState!.rootPromptMessagesJson.map((id) =>
      JSON.parse(new TextDecoder().decode(built.blobs.get(Buffer.from(id).toString('hex'))))
    );
    expect(roots.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'healthy' }],
      tool_call_id: 'call-1',
    });

    const turnId = run.conversationState!.turns[0]!;
    const turn = fromBinary(
      ConversationTurnStructureSchema,
      built.blobs.get(Buffer.from(turnId).toString('hex'))!
    ).turn.value!;
    const step = fromBinary(
      ConversationStepSchema,
      built.blobs.get(Buffer.from(turn.steps[0]!).toString('hex'))!
    );
    if (step.message.case !== 'toolCall' || step.message.value.tool.case !== 'mcpToolCall') {
      throw new Error('Expected an MCP tool call step');
    }
    const call = step.message.value.tool.value;

    expect(call.args).toMatchObject({ toolCallId: 'call-1', toolName: 'lookup' });
    expect(call.result!.result).toMatchObject({
      case: 'success',
      value: { content: [{ content: { case: 'text', value: { text: 'healthy' } } }] },
    });
  });

  it('rejects forced tool choice before opening a transport', async () => {
    const response = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      { ...payload, tools: [], tool_choice: 'required' }
    );

    expect(response!.status).toBe(400);
    expect(await response!.text()).toContain('cannot guarantee forced tool choice');
  });

  it('maps Cursor protocol deltas to OpenAI SSE', async () => {
    const request = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      close: vi.fn(),
    });
    const client = Object.assign(new EventEmitter(), {
      request: vi.fn(() => request),
      close: vi.fn(),
    });
    transport.connect.mockReturnValue(client);

    const response = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      { ...payload, stream: true }
    );
    const body = response!.text();

    expect(fetch).toHaveBeenCalledWith(
      'https://api2.cursor.sh/auth/exchange_user_api_key',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer key' }),
      })
    );
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({ authorization: 'Bearer cursor-access-token' })
    );

    request.emit('response', { ':status': 200 });
    request.emit(
      'data',
      connectFrame(
        toBinary(
          AgentServerMessageSchema,
          create(AgentServerMessageSchema, {
            message: {
              case: 'interactionUpdate',
              value: create(InteractionUpdateSchema, {
                message: {
                  case: 'textDelta',
                  value: create(TextDeltaUpdateSchema, { text: 'answer' }),
                },
              }),
            },
          })
        )
      )
    );
    request.emit('end');

    const text = await body;
    expect(text).toContain('"role":"assistant"');
    expect(text).toContain('"content":"answer"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('data: [DONE]');
    expect(request.write).toHaveBeenCalledOnce();
    expect(request.close).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('reuses a provided conversation id and checkpoint instead of replaying history', () => {
    const checkpoint = toBinary(
      ConversationStateStructureSchema,
      create(ConversationStateStructureSchema, { clientName: 'cached-turn' })
    );
    const built = buildCursorRequest(
      {
        model: 'cursor-model',
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Answer' },
          { role: 'user', content: 'Second' },
        ],
      },
      { conversationId: 'conv-stable', checkpoint }
    );
    const run = decodeRun(built.request);

    expect(built.reusedCheckpoint).toBe(true);
    expect(run.conversationId).toBe('conv-stable');
    expect(run.conversationState?.clientName).toBe('cached-turn');
    expect(run.conversationState?.turns).toEqual([]);
    expect(run.action?.action.case).toBe('userMessageAction');
    expect(run.action?.action.value).toMatchObject({ userMessage: { text: 'Second' } });
  });

  it('rebuilds tool-result resumes even when a checkpoint is present', () => {
    const checkpoint = toBinary(
      ConversationStateStructureSchema,
      create(ConversationStateStructureSchema, { clientName: 'cached-turn' })
    );
    const built = buildCursorRequest(
      {
        model: 'cursor-model',
        messages: [
          { role: 'user', content: 'Check status' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'lookup', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call-1', content: 'healthy' },
        ],
      },
      { conversationId: 'conv-stable', checkpoint }
    );
    const run = decodeRun(built.request);

    expect(built.reusedCheckpoint).toBe(false);
    expect(run.action?.action.case).toBe('resumeAction');
    expect(run.conversationState?.turns).toHaveLength(1);
  });

  it('reuses the Cursor conversation id and checkpoint across user turns', async () => {
    const firstRequest = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      close: vi.fn(),
    });
    const secondRequest = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      close: vi.fn(),
    });
    const firstClient = Object.assign(new EventEmitter(), {
      request: vi.fn(() => firstRequest),
      close: vi.fn(),
    });
    const secondClient = Object.assign(new EventEmitter(), {
      request: vi.fn(() => secondRequest),
      close: vi.fn(),
    });
    transport.connect.mockReturnValueOnce(firstClient).mockReturnValueOnce(secondClient);

    const first = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      { ...payload, prompt_cache_key: 'pi-session-1', stream: true }
    );
    const firstBody = first!.text();
    firstRequest.emit('response', { ':status': 200 });
    firstRequest.emit(
      'data',
      connectFrame(
        toBinary(
          AgentServerMessageSchema,
          create(AgentServerMessageSchema, {
            message: {
              case: 'conversationCheckpointUpdate',
              value: create(ConversationStateStructureSchema, {
                clientName: 'cached-turn',
                tokenDetails: create(ConversationTokenDetailsSchema, {
                  usedTokens: 42,
                  maxTokens: 128000,
                }),
              }),
            },
          })
        )
      )
    );
    firstRequest.emit(
      'data',
      connectFrame(
        toBinary(
          AgentServerMessageSchema,
          create(AgentServerMessageSchema, {
            message: {
              case: 'interactionUpdate',
              value: create(InteractionUpdateSchema, {
                message: {
                  case: 'textDelta',
                  value: create(TextDeltaUpdateSchema, { text: 'Answer' }),
                },
              }),
            },
          })
        )
      )
    );
    firstRequest.emit('end');
    await firstBody;

    const firstRun = decodeWrittenRun(firstRequest.write);
    const second = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      {
        model: 'cursor-model',
        prompt_cache_key: 'pi-session-1',
        stream: true,
        messages: [
          ...payload.messages,
          { role: 'assistant', content: 'Answer' },
          { role: 'user', content: 'Follow up' },
        ],
      }
    );
    const secondBody = second!.text();
    secondRequest.emit('response', { ':status': 200 });
    secondRequest.emit('end');
    await secondBody;

    const secondRun = decodeWrittenRun(secondRequest.write);
    expect(secondRun.conversationId).toBe(firstRun.conversationId);
    expect(secondRun.conversationState?.clientName).toBe('cached-turn');
    expect(secondRun.conversationState?.turns).toEqual([]);
    expect(secondRun.action?.action).toMatchObject({
      case: 'userMessageAction',
      value: { userMessage: { text: 'Follow up' } },
    });
  });

  it('reuses the Cursor checkpoint when only system text changes', async () => {
    const firstRequest = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      close: vi.fn(),
    });
    const secondRequest = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      close: vi.fn(),
    });
    transport.connect
      .mockReturnValueOnce(
        Object.assign(new EventEmitter(), {
          request: vi.fn(() => firstRequest),
          close: vi.fn(),
        })
      )
      .mockReturnValueOnce(
        Object.assign(new EventEmitter(), {
          request: vi.fn(() => secondRequest),
          close: vi.fn(),
        })
      );

    const first = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      { ...payload, prompt_cache_key: 'pi-session-1', stream: true }
    );
    const firstBody = first!.text();
    firstRequest.emit('response', { ':status': 200 });
    firstRequest.emit(
      'data',
      connectFrame(
        toBinary(
          AgentServerMessageSchema,
          create(AgentServerMessageSchema, {
            message: {
              case: 'conversationCheckpointUpdate',
              value: create(ConversationStateStructureSchema, {
                clientName: 'cached-turn',
                tokenDetails: create(ConversationTokenDetailsSchema, {
                  usedTokens: 42,
                  maxTokens: 200000,
                }),
              }),
            },
          })
        )
      )
    );
    firstRequest.emit(
      'data',
      connectFrame(
        toBinary(
          AgentServerMessageSchema,
          create(AgentServerMessageSchema, {
            message: {
              case: 'interactionUpdate',
              value: create(InteractionUpdateSchema, {
                message: {
                  case: 'textDelta',
                  value: create(TextDeltaUpdateSchema, { text: 'Answer' }),
                },
              }),
            },
          })
        )
      )
    );
    firstRequest.emit('end');
    await firstBody;

    const firstRun = decodeWrittenRun(firstRequest.write);
    const second = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      {
        model: 'cursor-model',
        prompt_cache_key: 'pi-session-1',
        stream: true,
        messages: [
          { role: 'system', content: 'Hindsight recall changed' },
          { role: 'developer', content: 'Use plain text.' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Answer' },
          { role: 'user', content: 'Follow up' },
        ],
      }
    );
    const secondBody = second!.text();
    secondRequest.emit('response', { ':status': 200 });
    secondRequest.emit('end');
    await secondBody;

    const secondRun = decodeWrittenRun(secondRequest.write);
    expect(secondRun.conversationId).toBe(firstRun.conversationId);
    expect(secondRun.conversationState?.clientName).toBe('cached-turn');
    expect(secondRun.action?.action).toMatchObject({
      case: 'userMessageAction',
      value: { userMessage: { text: 'Follow up' } },
    });
  });

  it('reuses the Cursor checkpoint and attaches Hindsight user injections', async () => {
    const firstRequest = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      close: vi.fn(),
    });
    const secondRequest = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      close: vi.fn(),
    });
    transport.connect
      .mockReturnValueOnce(
        Object.assign(new EventEmitter(), {
          request: vi.fn(() => firstRequest),
          close: vi.fn(),
        })
      )
      .mockReturnValueOnce(
        Object.assign(new EventEmitter(), {
          request: vi.fn(() => secondRequest),
          close: vi.fn(),
        })
      );

    const first = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      { ...payload, prompt_cache_key: 'pi-session-1', stream: true }
    );
    const firstBody = first!.text();
    firstRequest.emit('response', { ':status': 200 });
    firstRequest.emit(
      'data',
      connectFrame(
        toBinary(
          AgentServerMessageSchema,
          create(AgentServerMessageSchema, {
            message: {
              case: 'conversationCheckpointUpdate',
              value: create(ConversationStateStructureSchema, {
                clientName: 'cached-turn',
                tokenDetails: create(ConversationTokenDetailsSchema, {
                  usedTokens: 42,
                  maxTokens: 200000,
                }),
              }),
            },
          })
        )
      )
    );
    firstRequest.emit(
      'data',
      connectFrame(
        toBinary(
          AgentServerMessageSchema,
          create(AgentServerMessageSchema, {
            message: {
              case: 'interactionUpdate',
              value: create(InteractionUpdateSchema, {
                message: {
                  case: 'textDelta',
                  value: create(TextDeltaUpdateSchema, { text: 'Answer' }),
                },
              }),
            },
          })
        )
      )
    );
    firstRequest.emit('end');
    await firstBody;

    const firstRun = decodeWrittenRun(firstRequest.write);
    const second = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      {
        model: 'cursor-model',
        prompt_cache_key: 'pi-session-1',
        stream: true,
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Answer' },
          {
            role: 'user',
            content: '<hindsight-memory>\nTurn 2 recall\n</hindsight-memory>',
          },
          { role: 'user', content: 'Follow up' },
        ],
      }
    );
    const secondBody = second!.text();
    secondRequest.emit('response', { ':status': 200 });
    secondRequest.emit('end');
    await secondBody;

    const secondRun = decodeWrittenRun(secondRequest.write);
    expect(secondRun.conversationId).toBe(firstRun.conversationId);
    expect(secondRun.conversationState?.clientName).toBe('cached-turn');
    expect(secondRun.action?.action).toMatchObject({
      case: 'userMessageAction',
      value: {
        userMessage: {
          text: '<hindsight-memory>\nTurn 2 recall\n</hindsight-memory>\n\nFollow up',
        },
      },
    });
  });

  it('rotates the Cursor conversation after compacted history', async () => {
    const firstRequest = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      close: vi.fn(),
    });
    const secondRequest = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      close: vi.fn(),
    });
    transport.connect
      .mockReturnValueOnce(
        Object.assign(new EventEmitter(), {
          request: vi.fn(() => firstRequest),
          close: vi.fn(),
        })
      )
      .mockReturnValueOnce(
        Object.assign(new EventEmitter(), {
          request: vi.fn(() => secondRequest),
          close: vi.fn(),
        })
      );

    const first = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      { ...payload, prompt_cache_key: 'pi-session-1', stream: true }
    );
    const firstBody = first!.text();
    firstRequest.emit('response', { ':status': 200 });
    firstRequest.emit(
      'data',
      connectFrame(
        toBinary(
          AgentServerMessageSchema,
          create(AgentServerMessageSchema, {
            message: {
              case: 'interactionUpdate',
              value: create(InteractionUpdateSchema, {
                message: {
                  case: 'textDelta',
                  value: create(TextDeltaUpdateSchema, { text: 'Answer' }),
                },
              }),
            },
          })
        )
      )
    );
    firstRequest.emit('end');
    await firstBody;

    const firstRun = decodeWrittenRun(firstRequest.write);
    const second = await executeCursorSdkRequest(
      CURSOR_SDK_TRANSPORT_URL,
      { Authorization: 'Bearer key' },
      {
        model: 'cursor-model',
        prompt_cache_key: 'pi-session-1',
        stream: true,
        messages: [{ role: 'user', content: 'Summarized follow-up' }],
      }
    );
    const secondBody = second!.text();
    secondRequest.emit('response', { ':status': 200 });
    secondRequest.emit('end');
    await secondBody;

    const secondRun = decodeWrittenRun(secondRequest.write);
    expect(secondRun.conversationId).not.toBe(firstRun.conversationId);
    expect(secondRun.action?.action).toMatchObject({
      case: 'userMessageAction',
      value: { userMessage: { text: 'Summarized follow-up' } },
    });
  });
});

function connectFrame(data: Uint8Array): Buffer {
  const result = Buffer.alloc(5 + data.byteLength);
  result.writeUInt32BE(data.byteLength, 1);
  result.set(data, 5);
  return result;
}
