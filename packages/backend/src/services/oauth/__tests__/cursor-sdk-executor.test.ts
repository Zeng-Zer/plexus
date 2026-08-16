import { create, fromBinary, toBinary, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  InteractionUpdateSchema,
  TextDeltaUpdateSchema,
  UserMessageSchema,
} from '../generated/cursor-agent_pb';
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

describe('Cursor protocol executor', () => {
  beforeEach(() => transport.connect.mockReset());

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
});

function connectFrame(data: Uint8Array): Buffer {
  const result = Buffer.alloc(5 + data.byteLength);
  result.writeUInt32BE(data.byteLength, 1);
  result.set(data, 5);
  return result;
}
