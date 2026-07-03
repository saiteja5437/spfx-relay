import { ProviderError } from './types';

/**
 * Shared HTTP plumbing, written by hand on purpose: timeout via AbortController,
 * bounded exponential-backoff retry honoring `retry-after`, and streaming-body
 * parsers for the two wire formats our providers speak — SSE (Anthropic) and
 * NDJSON (Ollama).
 */

export interface HttpOptions {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  /** Injectable for tests — adapters are tested without any network. */
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: HttpOptions = {},
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    fetchFn = fetch,
  } = options;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(url, { ...init, signal: controller.signal });
      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        await sleep(retryDelayMs(response, attempt, baseDelayMs));
        continue;
      }
      return response;
    } catch (error) {
      const timedOut = controller.signal.aborted;
      if (attempt < maxRetries) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      if (timedOut) {
        throw new ProviderError('timeout', `Request timed out after ${timeoutMs}ms: ${url}`, {
          retryable: true,
          cause: error,
        });
      }
      throw new ProviderError('network', `Network error calling ${url}`, {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function retryDelayMs(response: Response, attempt: number, baseDelayMs: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return baseDelayMs * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// SSE (text/event-stream) — used by the Anthropic Messages API.
// Events are field lines ('event:', 'data:', ':' comments) terminated by a
// blank line; multi-line data joins with '\n'. Chunk boundaries can land
// anywhere, including mid-line — the parser buffers accordingly.
// ---------------------------------------------------------------------------

export interface SseEvent {
  event: string;
  data: string;
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];

  const consumeLine = (line: string): SseEvent | null => {
    if (line === '') {
      if (dataLines.length === 0) {
        eventName = 'message';
        return null;
      }
      const event: SseEvent = { event: eventName, data: dataLines.join('\n') };
      eventName = 'message';
      dataLines = [];
      return event;
    }
    if (line.startsWith(':')) return null; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    return null;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: RegExpExecArray | null;
    while ((newline = /\r?\n/.exec(buffer)) !== null) {
      const line = buffer.slice(0, newline.index);
      buffer = buffer.slice(newline.index + newline[0].length);
      const event = consumeLine(line);
      if (event) yield event;
    }
  }

  // Lenient flush of a final event missing its trailing blank line.
  if (buffer.length > 0) consumeLine(buffer);
  const trailing = consumeLine('');
  if (trailing) yield trailing;
}

// ---------------------------------------------------------------------------
// NDJSON (one JSON object per line) — used by the Ollama chat API.
// ---------------------------------------------------------------------------

export async function* parseNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '').trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) yield JSON.parse(line);
    }
  }

  const rest = buffer.trim();
  if (rest.length > 0) yield JSON.parse(rest);
}
