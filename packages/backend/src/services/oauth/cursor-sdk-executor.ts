import { create, fromBinary, fromJson, toBinary, toJson, type JsonValue } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { createHash } from 'node:crypto';
import http2 from 'node:http2';
import {
  AgentClientMessageSchema,
  AgentConversationTurnStructureSchema,
  AgentRunRequestSchema,
  AgentServerMessageSchema,
  AssistantMessageSchema,
  BackgroundShellSpawnResultSchema,
  ClientHeartbeatSchema,
  ComputerUseErrorSchema,
  ComputerUseResultSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  DeleteRejectedSchema,
  DeleteResultSchema,
  DiagnosticsRejectedSchema,
  DiagnosticsResultSchema,
  ExecClientMessageSchema,
  FetchErrorSchema,
  FetchResultSchema,
  GetBlobResultSchema,
  GrepErrorSchema,
  GrepResultSchema,
  KvClientMessageSchema,
  ListMcpResourcesExecResultSchema,
  ListMcpResourcesRejectedSchema,
  LsRejectedSchema,
  LsResultSchema,
  McpArgsSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolCallSchema,
  McpToolDefinitionSchema,
  McpToolNotFoundSchema,
  McpToolResultContentItemSchema,
  McpToolResultSchema,
  McpToolsSchema,
  ReadMcpResourceExecResultSchema,
  ReadMcpResourceRejectedSchema,
  ReadRejectedSchema,
  ReadResultSchema,
  RecordScreenFailureSchema,
  RecordScreenResultSchema,
  RequestedModelSchema,
  RequestedModelParameterSchema,
  ResumeActionSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SelectedContextSchema,
  SelectedImageSchema,
  SetBlobResultSchema,
  ShellRejectedSchema,
  ShellResultSchema,
  ShellStreamSchema,
  ToolCallSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  WriteRejectedSchema,
  WriteResultSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
  type AgentServerMessage,
  type ExecServerMessage,
  type McpToolDefinition,
} from './generated/cursor-agent_pb';

const CURSOR_TRANSPORT = 'cursor-sdk://';
const CURSOR_API_URL = 'https://api2.cursor.sh';
const CURSOR_RPC_PATH = '/agent.v1.AgentService/Run';
const CURSOR_TOKEN_EXCHANGE_URL = 'https://api2.cursor.sh/auth/exchange_user_api_key';
const CURSOR_CLIENT_VERSION = 'cli-2026.05.01-eea359f';
const CONNECT_END_STREAM_FLAG = 0b00000010;
const HEARTBEAT_MS = 5_000;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5_242_880;
const TOKEN_CACHE_MS = 4 * 60 * 1000;

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: string;
  content?: unknown;
  images?: CursorImage[];
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

interface CursorImage {
  data: Uint8Array;
  mimeType: string;
}

interface CursorToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type CursorRunEvent =
  | { type: 'delta'; delta: Record<string, string> }
  | { type: 'tool'; call: CursorToolCall }
  | { type: 'terminal'; usage?: CursorUsage }
  | { type: 'error'; error: unknown };

interface CursorUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface PendingCursorTool {
  resolve: (result: string) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CursorRunSession {
  apiKey: string;
  model: string;
  id: string;
  created: number;
  events: CursorRunEvent[];
  cursor: number;
  wake?: () => void;
  pending: Map<string, PendingCursorTool>;
  transport?: CursorTransport;
  closed: boolean;
  closeError?: unknown;
}

interface CursorTransport {
  readonly alive: boolean;
  write: (data: Uint8Array) => void;
  close: () => void;
}

const cursorToolSessions = new Map<string, CursorRunSession>();
const cursorAccessTokens = new Map<string, { token: string; expiresAt: number }>();

async function exchangeCursorApiKey(apiKey: string, signal?: AbortSignal): Promise<string> {
  const cacheKey = createHash('sha256').update(apiKey).digest('hex');
  const cached = cursorAccessTokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(CURSOR_TOKEN_EXCHANGE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    throw new Error(`Cursor token exchange failed with status ${response.status}.`);
  }
  const body = (await response.json()) as { accessToken?: unknown };
  if (typeof body.accessToken !== 'string' || !body.accessToken.trim()) {
    throw new Error('Cursor token exchange returned no access token.');
  }
  const token = body.accessToken.trim();
  cursorAccessTokens.set(cacheKey, { token, expiresAt: Date.now() + TOKEN_CACHE_MS });
  return token;
}

function unsupported(message: string): Response {
  return Response.json(
    { error: { message, type: 'invalid_request_error', code: 'cursor_unsupported' } },
    { status: 400 }
  );
}

function decodeImage(data: string, mimeType: string): CursorImage {
  const normalizedMimeType = mimeType.trim().toLowerCase().replace('image/jpg', 'image/jpeg');
  const base64 = data.replace(/\s/g, '');
  if (base64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 1024) {
    throw new Error(`Cursor image exceeds the ${MAX_IMAGE_BYTES} byte limit.`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error('Cursor image contains invalid base64 data.');
  }
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Cursor image must contain 1 to ${MAX_IMAGE_BYTES} bytes.`);
  }
  const detectedMimeType =
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      ? 'image/jpeg'
      : bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        ? 'image/png'
        : bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
          ? 'image/gif'
          : bytes[0] === 0x52 &&
              bytes[1] === 0x49 &&
              bytes[2] === 0x46 &&
              bytes[3] === 0x46 &&
              bytes[8] === 0x57 &&
              bytes[9] === 0x45 &&
              bytes[10] === 0x42 &&
              bytes[11] === 0x50
            ? 'image/webp'
            : undefined;
  if (!detectedMimeType) {
    throw new Error('Cursor supports JPEG, PNG, GIF, and WebP images only.');
  }
  if (normalizedMimeType !== detectedMimeType) {
    throw new Error(`Cursor image MIME type ${normalizedMimeType} does not match its data.`);
  }
  return { data: bytes, mimeType: detectedMimeType };
}

function parseContent(content: unknown): { text: string; images: CursorImage[] } | null {
  if (typeof content === 'string') return { text: content, images: [] };
  if (content == null) return { text: '', images: [] };
  if (!Array.isArray(content)) return null;
  const text: string[] = [];
  const images: CursorImage[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') return null;
    if ((part as any).type === 'text' && typeof (part as any).text === 'string') {
      text.push((part as any).text);
      continue;
    }
    if ((part as any).type === 'image_url') {
      const imageUrl = (part as any).image_url;
      const url = typeof imageUrl === 'string' ? imageUrl : imageUrl?.url;
      if (typeof url !== 'string') return null;
      if (/^https?:\/\//i.test(url)) {
        throw new Error('Cursor supports inline image data only, not remote image URLs.');
      }
      const match = url.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/is);
      if (!match?.[1] || match[2] === undefined) {
        throw new Error('Cursor image_url must use data:image/...;base64,... format.');
      }
      images.push(decodeImage(match[2], match[1]));
      continue;
    }
    if (
      (part as any).type === 'image' &&
      typeof (part as any).data === 'string' &&
      typeof (part as any).mimeType === 'string'
    ) {
      images.push(decodeImage((part as any).data, (part as any).mimeType));
      continue;
    }
    return null;
  }
  return { text: text.join(''), images };
}

function contentText(content: unknown): string | null {
  return parseContent(content)?.text ?? null;
}

/** Cursor supports system/user/assistant roots. Developer messages map to system. */
export function normalizeCursorMessages(payload: any): OpenAIMessage[] {
  if (!Array.isArray(payload?.messages) || payload.messages.length === 0) {
    throw new Error('Cursor requires at least one chat message.');
  }
  return payload.messages.map((message: OpenAIMessage) => {
    const parsed = parseContent(message?.content);
    if (!parsed) {
      throw new Error('Cursor does not support this non-text message content.');
    }
    const role = message.role === 'developer' ? 'system' : message.role;
    if (parsed.images.length > 0 && role !== 'user') {
      throw new Error('Cursor supports images in user messages only.');
    }
    return {
      role,
      content: parsed.text,
      ...(parsed.images.length > 0 ? { images: parsed.images } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    };
  });
}

function jsonRootMessage(message: OpenAIMessage): unknown {
  const role = message.role === 'tool' ? 'user' : message.role;
  return {
    role,
    content:
      role === 'system'
        ? (message.content as string)
        : [{ type: 'text', text: message.content as string }],
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  };
}

function storeBlob(data: Uint8Array, blobs: Map<string, Uint8Array>): Uint8Array {
  const id = new Uint8Array(createHash('sha256').update(data).digest());
  blobs.set(Buffer.from(id).toString('hex'), data);
  return id;
}

function toolResultText(messages: OpenAIMessage[], id: string): string | undefined {
  const message = messages.find(
    (candidate) => candidate.role === 'tool' && candidate.tool_call_id === id
  );
  return message ? (message.content as string) : undefined;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : { value: parsed };
  } catch {
    return raw ? { __raw: raw } : {};
  }
}

function mcpResult(content: string) {
  return create(McpToolResultSchema, {
    result: {
      case: 'success',
      value: create(McpSuccessSchema, {
        content: [
          create(McpToolResultContentItemSchema, {
            content: {
              case: 'text',
              value: create(McpTextContentSchema, { text: content }),
            },
          }),
        ],
      }),
    },
  });
}

function cursorUserMessage(text: string, images: CursorImage[] = []) {
  const id = crypto.randomUUID();
  return create(UserMessageSchema, {
    text,
    messageId: id,
    mode: 1,
    correlationId: id,
    ...(images.length > 0
      ? {
          selectedContext: create(SelectedContextSchema, {
            selectedImages: images.map((image) =>
              create(SelectedImageSchema, {
                uuid: crypto.randomUUID(),
                mimeType: image.mimeType,
                dataOrBlobId: { case: 'data', value: image.data },
              })
            ),
          }),
        }
      : {}),
  });
}

function historyTurns(messages: OpenAIMessage[], blobs: Map<string, Uint8Array>): Uint8Array[] {
  const turns: Uint8Array[] = [];
  let current: { user: Uint8Array; steps: Uint8Array[] } | undefined;
  const flush = () => {
    if (!current) return;
    const turn = create(ConversationTurnStructureSchema, {
      turn: {
        case: 'agentConversationTurn',
        value: create(AgentConversationTurnStructureSchema, {
          userMessage: current.user,
          steps: current.steps,
          requestId: crypto.randomUUID(),
        }),
      },
    });
    turns.push(storeBlob(toBinary(ConversationTurnStructureSchema, turn), blobs));
    current = undefined;
  };

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') continue;
    if (message.role === 'user') {
      flush();
      current = {
        user: storeBlob(
          toBinary(UserMessageSchema, cursorUserMessage(message.content as string, message.images)),
          blobs
        ),
        steps: [],
      };
      continue;
    }
    if (!current || message.role !== 'assistant') continue;
    if (message.content) {
      current.steps.push(
        storeBlob(
          toBinary(
            ConversationStepSchema,
            create(ConversationStepSchema, {
              message: {
                case: 'assistantMessage',
                value: create(AssistantMessageSchema, { text: message.content as string }),
              },
            })
          ),
          blobs
        )
      );
    }
    for (const call of message.tool_calls ?? []) {
      const result = toolResultText(messages, call.id);
      const args = createMcpArgs(
        call.function.name,
        call.id,
        parseToolArguments(call.function.arguments)
      );
      current.steps.push(
        storeBlob(
          toBinary(
            ConversationStepSchema,
            create(ConversationStepSchema, {
              message: {
                case: 'toolCall',
                value: create(ToolCallSchema, {
                  tool: {
                    case: 'mcpToolCall',
                    value: create(McpToolCallSchema, {
                      args,
                      ...(result == null ? {} : { result: mcpResult(result) }),
                    }),
                  },
                }),
              },
            })
          ),
          blobs
        )
      );
    }
  }
  flush();
  return turns;
}

function createMcpArgs(name: string, id: string, args: Record<string, unknown>) {
  return create(McpArgsSchema, {
    name,
    args: Object.fromEntries(
      Object.entries(args).map(([key, value]) => [
        key,
        toBinary(ValueSchema, fromJson(ValueSchema, value as JsonValue)),
      ])
    ),
    toolCallId: id,
    providerIdentifier: 'client',
    toolName: name,
  });
}

function clientTools(payload: any): McpToolDefinition[] {
  if (payload?.tool_choice === 'none' || payload?.function_call === 'none') return [];
  const tools: any[] = [
    ...(Array.isArray(payload?.tools) ? payload.tools : []),
    ...(Array.isArray(payload?.functions)
      ? payload.functions.map((fn: any) => ({ type: 'function', function: fn }))
      : []),
  ];
  return [
    ...new Map(
      tools
        .filter((tool) => tool?.type === 'function' && typeof tool?.function?.name === 'string')
        .map((tool) => {
          const fn = tool.function;
          const schema =
            fn.parameters && typeof fn.parameters === 'object'
              ? fn.parameters
              : { type: 'object', properties: {} };
          return [
            fn.name,
            create(McpToolDefinitionSchema, {
              name: fn.name,
              description: fn.description || '',
              inputSchema: fromJson(ValueSchema, schema as JsonValue),
              providerIdentifier: 'client',
              toolName: fn.name,
            }),
          ];
        })
    ).values(),
  ];
}

function forcedToolChoice(payload: any): boolean {
  const choice = payload?.tool_choice;
  const functionCall = payload?.function_call;
  return (
    (choice != null && choice !== 'auto' && choice !== 'none') ||
    (functionCall != null && functionCall !== 'auto' && functionCall !== 'none')
  );
}

export function buildCursorRequest(payload: any): {
  request: Uint8Array;
  blobs: Map<string, Uint8Array>;
  tools: McpToolDefinition[];
} {
  if (
    payload?.plexus_cursor_fast !== undefined &&
    typeof payload.plexus_cursor_fast !== 'boolean'
  ) {
    throw new Error('plexus_cursor_fast must be a boolean.');
  }
  const messages = normalizeCursorMessages(payload);
  const blobs = new Map<string, Uint8Array>();
  const lastUser = messages.findLastIndex((message) => message.role === 'user');
  if (lastUser < 0) throw new Error('Cursor requires a user message.');

  const hasMessagesAfterUser = lastUser < messages.length - 1;
  const history = hasMessagesAfterUser ? messages : messages.slice(0, lastUser);
  const roots = history
    .filter((message) => ['system', 'user', 'assistant', 'tool'].includes(message.role))
    .map((message) =>
      storeBlob(new TextEncoder().encode(JSON.stringify(jsonRootMessage(message))), blobs)
    );
  const turns = historyTurns(history, blobs);
  const userText = messages[lastUser]!.content as string;
  const tools = clientTools(payload);
  const request = create(AgentClientMessageSchema, {
    message: {
      case: 'runRequest',
      value: create(AgentRunRequestSchema, {
        conversationState: create(ConversationStateStructureSchema, {
          rootPromptMessagesJson: roots,
          turns,
        }),
        action: create(ConversationActionSchema, {
          action: hasMessagesAfterUser
            ? { case: 'resumeAction', value: create(ResumeActionSchema, {}) }
            : {
                case: 'userMessageAction',
                value: create(UserMessageActionSchema, {
                  userMessage: cursorUserMessage(userText, messages[lastUser]!.images),
                }),
              },
        }),
        requestedModel: create(RequestedModelSchema, {
          modelId: payload.model,
          parameters:
            typeof payload.plexus_cursor_fast === 'boolean'
              ? [
                  create(RequestedModelParameterSchema, {
                    id: 'fast',
                    value: String(payload.plexus_cursor_fast),
                  }),
                ]
              : [],
        }),
        mcpTools: create(McpToolsSchema, { mcpTools: tools }),
        conversationId: crypto.randomUUID(),
      }),
    },
  });
  return { request: toBinary(AgentClientMessageSchema, request), blobs, tools };
}

function frame(data: Uint8Array): Buffer {
  if (data.byteLength > MAX_FRAME_BYTES) throw new Error('Cursor request frame is too large.');
  const result = Buffer.alloc(5 + data.byteLength);
  result[0] = 0;
  result.writeUInt32BE(data.byteLength, 1);
  result.set(data, 5);
  return result;
}

function pushEvent(session: CursorRunSession, event: CursorRunEvent): void {
  session.events.push(event);
  session.wake?.();
  session.wake = undefined;
}

async function nextEvent(session: CursorRunSession, signal?: AbortSignal): Promise<CursorRunEvent> {
  while (session.cursor >= session.events.length) {
    if (session.closed) throw session.closeError ?? new Error('Cursor run closed.');
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        session.wake = undefined;
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      session.wake = () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  }
  return session.events[session.cursor++]!;
}

function closeSession(session: CursorRunSession, error?: unknown): void {
  if (session.closed) return;
  session.closed = true;
  session.closeError = error;
  for (const [id, pending] of session.pending) {
    clearTimeout(pending.timer);
    cursorToolSessions.delete(id);
    pending.reject(error ?? new Error('Cursor run ended before receiving a tool result.'));
  }
  session.pending.clear();
  session.transport?.close();
  session.wake?.();
  session.wake = undefined;
}

function sendClientMessage(session: CursorRunSession, message: any): void {
  session.transport?.write(toBinary(AgentClientMessageSchema, message));
}

function sendKvResponse(session: CursorRunSession, message: any): void {
  const value = message.message.value;
  const response = create(KvClientMessageSchema, {
    id: message.id,
    message:
      message.message.case === 'getBlobArgs'
        ? {
            case: 'getBlobResult',
            value: create(GetBlobResultSchema, {
              blobData: sessionBlobs.get(session)?.get(Buffer.from(value.blobId).toString('hex')),
            }),
          }
        : {
            case: 'setBlobResult',
            value: create(SetBlobResultSchema, {}),
          },
  });
  if (message.message.case === 'setBlobArgs') {
    sessionBlobs.get(session)?.set(Buffer.from(value.blobId).toString('hex'), value.blobData);
  }
  sendClientMessage(
    session,
    create(AgentClientMessageSchema, {
      message: { case: 'kvClientMessage', value: response },
    })
  );
}

const sessionBlobs = new WeakMap<CursorRunSession, Map<string, Uint8Array>>();
const sessionTools = new WeakMap<CursorRunSession, McpToolDefinition[]>();

function sendExecResponse(
  session: CursorRunSession,
  message: ExecServerMessage,
  response: any
): void {
  sendClientMessage(
    session,
    create(AgentClientMessageSchema, {
      message: {
        case: 'execClientMessage',
        value: create(ExecClientMessageSchema, {
          id: message.id,
          execId: message.execId,
          message: response,
        }),
      },
    })
  );
}

function rejectNativeTool(session: CursorRunSession, message: ExecServerMessage): boolean {
  const reason = 'Tool unavailable';
  const args: any = message.message.value;
  const response = (() => {
    switch (message.message.case) {
      case 'shellArgs':
        return {
          case: 'shellResult',
          value: create(ShellResultSchema, {
            result: {
              case: 'rejected',
              value: create(ShellRejectedSchema, {
                command: args.command,
                workingDirectory: args.workingDirectory,
                reason,
              }),
            },
          }),
        };
      case 'shellStreamArgs':
        return {
          case: 'shellStream',
          value: create(ShellStreamSchema, {
            event: {
              case: 'rejected',
              value: create(ShellRejectedSchema, {
                command: args.command,
                workingDirectory: args.workingDirectory,
                reason,
              }),
            },
          }),
        };
      case 'writeArgs':
        return rejectedPath(
          'writeResult',
          WriteResultSchema,
          WriteRejectedSchema,
          args.path,
          reason
        );
      case 'deleteArgs':
        return rejectedPath(
          'deleteResult',
          DeleteResultSchema,
          DeleteRejectedSchema,
          args.path,
          reason
        );
      case 'readArgs':
        return rejectedPath('readResult', ReadResultSchema, ReadRejectedSchema, args.path, reason);
      case 'lsArgs':
        return rejectedPath('lsResult', LsResultSchema, LsRejectedSchema, args.path, reason);
      case 'diagnosticsArgs':
        return rejectedPath(
          'diagnosticsResult',
          DiagnosticsResultSchema,
          DiagnosticsRejectedSchema,
          args.path,
          reason
        );
      case 'grepArgs':
        return {
          case: 'grepResult',
          value: create(GrepResultSchema, {
            result: { case: 'error', value: create(GrepErrorSchema, { error: reason }) },
          }),
        };
      case 'backgroundShellSpawnArgs':
        return {
          case: 'backgroundShellSpawnResult',
          value: create(BackgroundShellSpawnResultSchema, {
            result: {
              case: 'rejected',
              value: create(ShellRejectedSchema, {
                command: args.command,
                workingDirectory: args.workingDirectory,
                reason,
              }),
            },
          }),
        };
      case 'fetchArgs':
        return {
          case: 'fetchResult',
          value: create(FetchResultSchema, {
            result: {
              case: 'error',
              value: create(FetchErrorSchema, { url: args.url, error: reason }),
            },
          }),
        };
      case 'writeShellStdinArgs':
        return {
          case: 'writeShellStdinResult',
          value: create(WriteShellStdinResultSchema, {
            result: {
              case: 'error',
              value: create(WriteShellStdinErrorSchema, { error: reason }),
            },
          }),
        };
      case 'listMcpResourcesExecArgs':
        return {
          case: 'listMcpResourcesExecResult',
          value: create(ListMcpResourcesExecResultSchema, {
            result: {
              case: 'rejected',
              value: create(ListMcpResourcesRejectedSchema, { reason }),
            },
          }),
        };
      case 'readMcpResourceExecArgs':
        return {
          case: 'readMcpResourceExecResult',
          value: create(ReadMcpResourceExecResultSchema, {
            result: {
              case: 'rejected',
              value: create(ReadMcpResourceRejectedSchema, { uri: args.uri, reason }),
            },
          }),
        };
      case 'recordScreenArgs':
        return {
          case: 'recordScreenResult',
          value: create(RecordScreenResultSchema, {
            result: {
              case: 'failure',
              value: create(RecordScreenFailureSchema, { error: reason }),
            },
          }),
        };
      case 'computerUseArgs':
        return {
          case: 'computerUseResult',
          value: create(ComputerUseResultSchema, {
            result: {
              case: 'error',
              value: create(ComputerUseErrorSchema, {
                error: reason,
                actionCount: args.actions.length,
              }),
            },
          }),
        };
      default:
        return null;
    }
  })();
  if (!response) return false;
  sendExecResponse(session, message, response);
  return true;
}

function rejectedPath(
  responseCase: string,
  resultSchema: any,
  rejectedSchema: any,
  path: string,
  reason: string
) {
  return {
    case: responseCase,
    value: create(resultSchema, {
      result: { case: 'rejected', value: create(rejectedSchema, { path, reason }) },
    }),
  };
}

function handleExec(session: CursorRunSession, message: ExecServerMessage): void {
  if (message.message.case === 'requestContextArgs') {
    const tools = sessionTools.get(session) ?? [];
    sendExecResponse(session, message, {
      case: 'requestContextResult',
      value: create(RequestContextResultSchema, {
        result: {
          case: 'success',
          value: create(RequestContextSuccessSchema, {
            requestContext: create(RequestContextSchema, { tools }),
          }),
        },
      }),
    });
    return;
  }
  if (message.message.case !== 'mcpArgs') {
    if (!rejectNativeTool(session, message)) {
      pushEvent(session, {
        type: 'error',
        error: new Error(`Unsupported Cursor exec request: ${message.message.case}`),
      });
    }
    return;
  }

  const args = message.message.value;
  const name = args.toolName || args.name;
  const allowed = sessionTools.get(session)?.some((tool) => tool.name === name);
  if (!allowed) {
    sendExecResponse(session, message, {
      case: 'mcpResult',
      value: create(McpResultSchema, {
        result: {
          case: 'toolNotFound',
          value: create(McpToolNotFoundSchema, {
            name,
            availableTools: (sessionTools.get(session) ?? []).map((tool) => tool.name),
          }),
        },
      }),
    });
    return;
  }

  const id = args.toolCallId || `call_${crypto.randomUUID()}`;
  const decodedArgs = Object.fromEntries(
    Object.entries(args.args).map(([key, value]) => {
      try {
        return [key, toJson(ValueSchema, fromBinary(ValueSchema, value))];
      } catch {
        return [key, new TextDecoder().decode(value)];
      }
    })
  );
  const timer = setTimeout(
    () => {
      closeSession(session, new Error(`Cursor tool continuation '${id}' timed out.`));
    },
    5 * 60 * 1000
  );
  timer.unref?.();
  session.pending.set(id, {
    timer,
    resolve: (result) => {
      sendExecResponse(session, message, {
        case: 'mcpResult',
        value: create(McpResultSchema, {
          result: {
            case: 'success',
            value: create(McpSuccessSchema, {
              content: [
                create(McpToolResultContentItemSchema, {
                  content: {
                    case: 'text',
                    value: create(McpTextContentSchema, { text: result }),
                  },
                }),
              ],
            }),
          },
        }),
      });
    },
    reject: () => undefined,
  });
  cursorToolSessions.set(id, session);
  pushEvent(session, {
    type: 'tool',
    call: {
      id,
      type: 'function',
      function: { name, arguments: JSON.stringify(decodedArgs) },
    },
  });
}

function processServerMessage(session: CursorRunSession, message: AgentServerMessage): void {
  switch (message.message.case) {
    case 'interactionUpdate': {
      const update = message.message.value.message;
      if (update.case === 'textDelta' && update.value.text) {
        pushEvent(session, { type: 'delta', delta: { content: update.value.text } });
      } else if (update.case === 'thinkingDelta' && update.value.text) {
        pushEvent(session, {
          type: 'delta',
          delta: { reasoning_content: update.value.text },
        });
      } else if (update.case === 'tokenDelta') {
        sessionUsage.get(session)!.outputTokens += update.value.tokens;
      }
      break;
    }
    case 'conversationCheckpointUpdate': {
      const used = message.message.value.tokenDetails?.usedTokens;
      if (used != null) sessionUsage.get(session)!.totalTokens = used;
      break;
    }
    case 'kvServerMessage':
      sendKvResponse(session, message.message.value);
      break;
    case 'execServerMessage':
      handleExec(session, message.message.value);
      break;
    case 'interactionQuery':
      pushEvent(session, {
        type: 'error',
        error: new Error('Cursor requested an unsupported built-in interaction.'),
      });
      break;
  }
}

const sessionUsage = new WeakMap<CursorRunSession, CursorUsage>();

function openTransport(
  session: CursorRunSession,
  accessToken: string,
  firstMessage: Uint8Array
): CursorTransport {
  const client = http2.connect(CURSOR_API_URL);
  const request = client.request({
    ':method': 'POST',
    ':path': CURSOR_RPC_PATH,
    'content-type': 'application/connect+proto',
    'connect-protocol-version': '1',
    te: 'trailers',
    authorization: `Bearer ${accessToken}`,
    'x-ghost-mode': 'true',
    'x-cursor-client-version': CURSOR_CLIENT_VERSION,
    'x-cursor-client-type': 'cli',
    'x-request-id': crypto.randomUUID(),
  });
  let pending = Buffer.alloc(0);
  let ended = false;
  let disposed = false;
  const heartbeat = setInterval(() => {
    write(
      toBinary(
        AgentClientMessageSchema,
        create(AgentClientMessageSchema, {
          message: {
            case: 'clientHeartbeat',
            value: create(ClientHeartbeatSchema, {}),
          },
        })
      )
    );
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ended = true;
    clearInterval(heartbeat);
    request.close();
    client.close();
  };

  const finish = (error?: unknown) => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    if (error) pushEvent(session, { type: 'error', error });
    else pushEvent(session, { type: 'terminal', usage: sessionUsage.get(session) });
    dispose();
  };
  request.on('response', (headers) => {
    const status = Number(headers[':status'] || 0);
    if (status < 200 || status >= 300) finish(new Error(`Cursor HTTP ${status}`));
  });
  request.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 5) {
      const flags = pending[0]!;
      const length = pending.readUInt32BE(1);
      if (length > MAX_FRAME_BYTES) {
        finish(new Error('Cursor response frame is too large.'));
        return;
      }
      if (pending.length < 5 + length) return;
      const body = pending.subarray(5, 5 + length);
      pending = pending.subarray(5 + length);
      if (flags & CONNECT_END_STREAM_FLAG) {
        try {
          const envelope = JSON.parse(body.toString());
          if (envelope.error) {
            finish(
              new Error(
                `Cursor Connect ${envelope.error.code ?? 'error'}: ${envelope.error.message || 'request failed.'}`
              )
            );
          }
        } catch {
          finish(new Error('Cursor returned an invalid end-stream frame.'));
        }
        continue;
      }
      try {
        processServerMessage(session, fromBinary(AgentServerMessageSchema, body));
      } catch (error) {
        finish(error);
      }
    }
  });
  request.on('end', () => finish());
  request.on('error', finish);
  client.on('error', finish);

  function write(data: Uint8Array) {
    if (!ended) request.write(frame(data));
  }
  write(firstMessage);
  return {
    get alive() {
      return !ended;
    },
    write,
    close: dispose,
  };
}

function sse(data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
  );
}

function chunk(session: CursorRunSession, delta: object, finishReason: string | null) {
  return {
    id: session.id,
    object: 'chat.completion.chunk',
    created: session.created,
    model: session.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function drainToolCalls(session: CursorRunSession, first: CursorToolCall): CursorToolCall[] {
  const calls = [first];
  while (session.events[session.cursor]?.type === 'tool') {
    calls.push(
      (session.events[session.cursor++] as Extract<CursorRunEvent, { type: 'tool' }>).call
    );
  }
  return calls;
}

function renderStream(session: CursorRunSession, signal?: AbortSignal): Response {
  let emitted = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          while (true) {
            const event = await nextEvent(session, signal);
            if (event.type === 'delta') {
              controller.enqueue(
                sse(
                  chunk(
                    session,
                    { ...(!emitted ? { role: 'assistant' } : {}), ...event.delta },
                    null
                  )
                )
              );
              emitted = true;
            } else if (event.type === 'tool') {
              const calls = drainToolCalls(session, event.call);
              controller.enqueue(
                sse(
                  chunk(
                    session,
                    {
                      ...(!emitted ? { role: 'assistant' } : {}),
                      tool_calls: calls.map((call, index) => ({ index, ...call })),
                    },
                    null
                  )
                )
              );
              controller.enqueue(sse(chunk(session, {}, 'tool_calls')));
              controller.enqueue(sse('[DONE]'));
              controller.close();
              return;
            } else if (event.type === 'terminal') {
              controller.enqueue(sse(chunk(session, {}, 'stop')));
              if (event.usage) {
                controller.enqueue(
                  sse({
                    id: session.id,
                    object: 'chat.completion.chunk',
                    created: session.created,
                    model: session.model,
                    choices: [],
                    usage: openAiUsage(event.usage),
                  })
                );
              }
              controller.enqueue(sse('[DONE]'));
              controller.close();
              closeSession(session);
              return;
            } else {
              throw event.error;
            }
          }
        } catch (error) {
          closeSession(session, error);
          controller.error(error);
        }
      })();
    },
    cancel(reason) {
      closeSession(session, reason);
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}

async function renderJson(session: CursorRunSession, signal?: AbortSignal): Promise<Response> {
  let content = '';
  let reasoning = '';
  try {
    while (true) {
      const event = await nextEvent(session, signal);
      if (event.type === 'delta') {
        content += event.delta.content ?? '';
        reasoning += event.delta.reasoning_content ?? '';
      } else if (event.type === 'tool') {
        const calls = drainToolCalls(session, event.call);
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
                tool_calls: calls,
              },
              finish_reason: 'tool_calls',
            },
          ],
        });
      } else if (event.type === 'terminal') {
        closeSession(session);
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
                content,
                reasoning_content: reasoning || null,
              },
              finish_reason: 'stop',
            },
          ],
          usage: event.usage ? openAiUsage(event.usage) : undefined,
        });
      } else {
        throw event.error;
      }
    }
  } catch (error) {
    closeSession(session, error);
    throw error;
  }
}

function openAiUsage(usage: CursorUsage) {
  return {
    prompt_tokens: Math.max(0, usage.totalTokens - usage.outputTokens),
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  };
}

async function resumeCursorRequest(
  apiKey: string,
  payload: any,
  signal?: AbortSignal
): Promise<Response | null> {
  const trailing = (payload.messages as OpenAIMessage[]).filter(
    (message) => message.role === 'tool' && typeof message.tool_call_id === 'string'
  );
  if (trailing.length === 0) return null;
  const sessions = new Set(
    trailing.map((message) => cursorToolSessions.get(message.tool_call_id!))
  );
  sessions.delete(undefined);
  if (sessions.size === 0) return null;
  if (sessions.size !== 1) {
    return unsupported('Cursor tool continuation is missing or expired. Retry the user request.');
  }
  const session = [...sessions][0]!;
  if (!session.transport?.alive || session.closed) {
    closeSession(session, new Error('Cursor tool bridge closed.'));
    return null;
  }
  if (session.apiKey !== apiKey || session.model !== payload.model) {
    return unsupported('Cursor tool continuation does not match this account or model.');
  }
  for (const message of trailing) {
    const pending = session.pending.get(message.tool_call_id!);
    if (!pending) continue;
    clearTimeout(pending.timer);
    session.pending.delete(message.tool_call_id!);
    cursorToolSessions.delete(message.tool_call_id!);
    pending.resolve(contentText(message.content) ?? JSON.stringify(message.content));
  }
  return payload.stream === true ? renderStream(session, signal) : renderJson(session, signal);
}

export async function executeCursorSdkRequest(
  url: string,
  headers: Record<string, string>,
  payload: any,
  signal?: AbortSignal
): Promise<Response | null> {
  if (!url.startsWith(CURSOR_TRANSPORT)) return null;
  if (forcedToolChoice(payload)) {
    return unsupported('Cursor cannot guarantee forced tool choice. Use tool_choice auto or none.');
  }
  const apiKey = headers.Authorization?.replace(/^Bearer\s+/i, '');
  if (!apiKey) return new Response('Cursor OAuth API key is missing.', { status: 401 });

  const resumed = await resumeCursorRequest(apiKey, payload, signal);
  if (resumed) return resumed;

  let built;
  try {
    built = buildCursorRequest(payload);
  } catch (error) {
    return unsupported(error instanceof Error ? error.message : String(error));
  }

  let accessToken: string;
  try {
    accessToken = await exchangeCursorApiKey(apiKey, signal);
  } catch (error) {
    return Response.json(
      {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: 'api_error',
          code: 'cursor_auth_failed',
        },
      },
      { status: 502 }
    );
  }
  const session: CursorRunSession = {
    apiKey,
    model: payload.model,
    id: `chatcmpl_${crypto.randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    events: [],
    cursor: 0,
    pending: new Map(),
    closed: false,
  };
  sessionBlobs.set(session, built.blobs);
  sessionTools.set(session, built.tools);
  sessionUsage.set(session, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  session.transport = openTransport(session, accessToken, built.request);
  return payload.stream === true ? renderStream(session, signal) : renderJson(session, signal);
}

export const CURSOR_SDK_TRANSPORT_URL = `${CURSOR_TRANSPORT}agent`;
