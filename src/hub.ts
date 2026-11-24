import type { CaptainConfig } from './config.ts';

/**
 * A minimal MCP client for the hub, spoken through the Sprites API gateway.
 *
 * The hub serves stateless Streamable HTTP MCP (POST only, JSON responses), so
 * one tools/call is one POST. The request carries no Authorization header: the
 * gateway identifies this Sprite from Fly.io's request signature and attaches
 * the hub key stored in the connector. The key never exists on the Sprite.
 */

export class HubError extends Error {
  override readonly name = 'HubError';
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: { content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Json; tools?: { name: string }[] };
  error?: { code: number; message: string };
}

const PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 30_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class HubClient {
  private nextId = 1;
  readonly endpoint: string;

  constructor(cfg: Pick<CaptainConfig, 'hubGatewayUrl' | 'hubPath'>, private readonly fetchImpl: FetchLike = fetch) {
    this.endpoint = `${cfg.hubGatewayUrl}${cfg.hubPath.startsWith('/') ? '' : '/'}${cfg.hubPath}`;
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<NonNullable<RpcResponse['result']>> {
    const id = this.nextId++;
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': PROTOCOL_VERSION,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new HubError(`Could not reach the hub through the gateway: ${(err as Error).message}`);
    }
    const body = await res.text();
    if (res.status === 401) throw new HubError('401 from gateway or hub: the call did not come from an authorized Sprite, or the connector\'s hub key was refused.', 401);
    if (res.status === 403) throw new HubError(`403: ${body.slice(0, 200)} (connector access policy, path allowlist, or a key bound to another compartment)`, 403);
    if (!res.ok) throw new HubError(`HTTP ${res.status} from ${this.endpoint}: ${body.slice(0, 300)}`, res.status);
    const msg = parseRpcBody(body, res.headers.get('content-type') ?? '');
    if (msg.error) throw new HubError(`MCP error ${msg.error.code}: ${msg.error.message}`);
    if (!msg.result) throw new HubError('MCP response had no result.');
    return msg.result;
  }

  /** Call a hub tool. Returns the tool's JSON result (parsed from its text content) or throws HubError with the hub's message. */
  async call<T = Json>(tool: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.rpc('tools/call', { name: tool, arguments: args });
    const text = (result.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
    if (result.isError) throw new HubError(text || `${tool} failed.`);
    if (result.structuredContent !== undefined) return result.structuredContent as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  async listTools(): Promise<string[]> {
    const result = await this.rpc('tools/list', {});
    return (result.tools ?? []).map((t) => t.name);
  }
}

/** The hub answers with JSON; accept an SSE body too in case a proxy or a future hub streams. */
export function parseRpcBody(body: string, contentType: string): RpcResponse {
  const raw = contentType.includes('text/event-stream')
    ? body
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .filter(Boolean)
        .pop() ?? ''
    : body;
  try {
    return JSON.parse(raw) as RpcResponse;
  } catch {
    throw new HubError(`Hub response was not JSON-RPC: ${body.slice(0, 200)}`);
  }
}
