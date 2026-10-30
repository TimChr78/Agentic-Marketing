import type { Context, MiddlewareHandler } from 'hono';

/**
 * Reusable request-body guard for the public and API surfaces.
 *
 * A trustworthy Content-Length is compared first, before any body bytes are touched. Without one
 * (a chunked request, or a hidden length) the body is counted in bytes as it streams in and the
 * request is refused as soon as the limit is crossed, so an oversized body is never buffered in
 * full. The remaining request body is discarded in the background rather than left unread: that
 * keeps the connection healthy so the caller actually receives the 413 instead of a connection
 * reset. Bodies within the limit are passed to the handler unchanged.
 */
export function bodyLimit(maxSize: number, onTooLarge: (c: Context) => Response | Promise<Response>) {
  return (async (c, next) => {
    const body = c.req.raw.body;
    if (!body) return next();

    const contentLength = c.req.header('content-length');
    const hasTransferEncoding = c.req.header('transfer-encoding') !== undefined;
    if (contentLength !== undefined && !hasTransferEncoding) {
      const declared = Number.parseInt(contentLength, 10);
      if (Number.isFinite(declared) && declared > maxSize) {
        discard(body);
        return onTooLarge(c);
      }
      return next();
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxSize) {
        discard(reader);
        return onTooLarge(c);
      }
      chunks.push(value);
    }
    // Rebuild the request so the handler can still read the body once (Hono requests are one-shot).
    c.req.raw = new Request(c.req.raw, {
      body: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    return next();
  }) as MiddlewareHandler;
}

/** How much more of a refused body is read and dropped, so a well-behaved caller can see the 413. */
const MAX_DISCARD_BYTES = 1024 * 1024;

/**
 * Read and drop what is left, so a caller that finishes sending can read the 413; past
 * MAX_DISCARD_BYTES the stream is cancelled, so an endless body cannot hold the connection.
 */
function discard(source: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array>) {
  const reader = 'getReader' in source ? source.getReader() : source;
  void (async () => {
    let dropped = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        dropped += value?.byteLength ?? 0;
        if (dropped > MAX_DISCARD_BYTES) {
          await reader.cancel('request body too large');
          return;
        }
      }
    } catch {
      // The caller may have stopped sending after reading the 413; nothing left to discard.
    }
  })();
}
