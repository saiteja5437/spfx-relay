/** Test doubles for the provider layer — no network, no API keys. */

export interface RecordedCall {
  url: string;
  init: RequestInit;
  body: unknown;
}

export interface FakeFetch {
  fn: typeof fetch;
  calls: RecordedCall[];
}

/** A fetch double that replays queued responses (or response factories) in order. */
export function fakeFetch(...responses: Array<Response | (() => Response)>): FakeFetch {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fn: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const requestInit = init ?? {};
    calls.push({
      url,
      init: requestInit,
      body: typeof requestInit.body === 'string' ? JSON.parse(requestInit.body) : undefined,
    });
    const next = queue.shift();
    if (!next) return Promise.reject(new TypeError('fakeFetch: no responses left in queue'));
    return Promise.resolve(typeof next === 'function' ? next() : next);
  };
  return { fn, calls };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** A streaming Response whose body arrives in the exact chunks given. */
export function streamResponse(chunks: string[], contentType: string): Response {
  return new Response(chunkedStream(chunks), { status: 200, headers: { 'content-type': contentType } });
}

export function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** A fetch double that never resolves but honors AbortSignal — for timeout tests. */
export function hangingFetch(): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
}
