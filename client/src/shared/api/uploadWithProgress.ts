/**
 * XHR-based PUT/POST upload with progress reporting.
 *
 * Why not fetch: as of 2026, fetch() in Chromium/WebKit/Electron has
 * no upload-side progress callback — `request.body.getReader()` /
 * `ReadableStream.tee()` give download progress only. Cross-border S3
 * uploads from China to AWS Singapore typically take tens of seconds
 * even with Transfer Acceleration; without a percentage indicator the
 * UI looks frozen and users repeatedly retry, making things worse.
 *
 * Wire the returned `progress` callback into a setState in the
 * caller — the callback fires on every byte chunk the browser flushes
 * to the socket (frequency is implementation-defined, typically every
 * ~16-64 KB or every 100 ms, whichever comes first).
 */

export interface UploadProgressEvent {
  /** Bytes already pushed by the browser. */
  loaded: number
  /** Total bytes the upload will send, or undefined when the body
   *  doesn't expose a length (rare for File / Blob — those always
   *  set `lengthComputable = true`). */
  total?: number
  /** 0..100 percentage. Convenience for renderers that don't need
   *  the raw byte counts. NaN when total is unknown. */
  percent: number
}

export interface UploadOptions {
  method: string
  url: string
  /** Header map exactly as returned by the server's presign call.
   *  Don't add Content-Type yourself unless the server requested it
   *  — S3 signature validation fails if the request header set
   *  doesn't match what was signed. */
  headers?: Record<string, string>
  body: Blob | File | ArrayBuffer | string
  /** Called on every byte chunk the browser flushes. Throttle in the
   *  caller if your renderer can't keep up. */
  onProgress?: (event: UploadProgressEvent) => void
  /** Aborts the in-flight request on the caller's signal. */
  signal?: AbortSignal
}

export interface UploadResult {
  status: number
  /** True iff `status` is 2xx. */
  ok: boolean
  /** Raw response body text. Empty string when the server returned
   *  no body (S3 PUT responds 200 with empty body on success). */
  body: string
}

export class UploadAbortError extends Error {
  constructor() {
    super('upload aborted')
    this.name = 'UploadAbortError'
  }
}

export class UploadNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadNetworkError'
  }
}

/**
 * Run a single-shot HTTP upload with progress. Returns when the
 * server's response status line + body have been received, or
 * rejects on transport error / abort.
 *
 * S3 presigned PUT note: the server-signed URL embeds the expected
 * headers. Pass them through unchanged via `headers`. Don't add
 * Origin or Cookie — the browser handles those, and any extra
 * header that wasn't part of the signature will cause S3 to reject
 * with SignatureDoesNotMatch.
 */
export function uploadWithProgress(options: UploadOptions): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(options.method, options.url, true)

    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        try {
          xhr.setRequestHeader(key, value)
        } catch {
          // Browsers forbid setting some headers (Cookie, Host, …);
          // silently drop those instead of failing — the server
          // either signed for them implicitly or didn't actually
          // need them on this request.
        }
      }
    }

    if (options.onProgress) {
      // `upload.onprogress` fires for the request body; `onprogress`
      // (without `.upload`) is for the response body. We want the
      // former — the latter only ticks once at the end for an S3 PUT.
      xhr.upload.onprogress = (event) => {
        const total = event.lengthComputable ? event.total : undefined
        const percent = total ? Math.min(100, (event.loaded / total) * 100) : NaN
        options.onProgress?.({
          loaded: event.loaded,
          total,
          percent,
        })
      }
    }

    xhr.onload = () => {
      resolve({
        status: xhr.status,
        ok: xhr.status >= 200 && xhr.status < 300,
        body: xhr.responseText ?? '',
      })
    }
    xhr.onerror = () => {
      reject(new UploadNetworkError('network error during upload'))
    }
    xhr.ontimeout = () => {
      reject(new UploadNetworkError('upload timed out'))
    }
    xhr.onabort = () => {
      reject(new UploadAbortError())
    }

    if (options.signal) {
      if (options.signal.aborted) {
        xhr.abort()
        reject(new UploadAbortError())
        return
      }
      options.signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }

    xhr.send(options.body as Document | XMLHttpRequestBodyInit | null)
  })
}
