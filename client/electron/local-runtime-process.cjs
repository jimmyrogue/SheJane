const REQUIRED_RUNTIME_CAPABILITIES = ['agent.run', 'agent.stream']

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForRuntimeReady({
  baseURL,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
  pollMs = 300,
  requestTimeoutMs = 2000,
  delay = sleep,
  signal,
}) {
  const endpoint = `${baseURL.replace(/\/$/, '')}/local/v1/runtime`
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      return false
    }
    const controller = new AbortController()
    const abortRequest = () => controller.abort()
    signal?.addEventListener('abort', abortRequest, { once: true })
    const remainingMs = Math.max(1, deadline - Date.now())
    const requestTimer = setTimeout(
      () => controller.abort(),
      Math.min(requestTimeoutMs, remainingMs),
    )
    try {
      const response = await fetchImpl(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      if (response.ok) {
        const runtime = await response.json()
        const capabilities = Array.isArray(runtime?.capabilities) ? runtime.capabilities : []
        if (
          runtime?.protocol_version === 1 &&
          REQUIRED_RUNTIME_CAPABILITIES.every((capability) => capabilities.includes(capability))
        ) {
          return true
        }
      }
    } catch {
      // The Runtime may still be binding its loopback listener.
    } finally {
      clearTimeout(requestTimer)
      signal?.removeEventListener('abort', abortRequest)
    }
    if (signal?.aborted) {
      return false
    }
    const pollDelayMs = Math.min(pollMs, Math.max(0, deadline - Date.now()))
    if (pollDelayMs > 0) {
      await delay(pollDelayMs)
    }
  }

  return false
}

async function stopRuntimeProcess(child, {
  graceMs = 5000,
  forceExitMs = 2000,
  delay = sleep,
  forceKill,
}) {
  if (!child || child.exitCode !== null) {
    return
  }

  let exited = false
  const exitPromise = new Promise((resolve) => {
    child.once('exit', () => {
      exited = true
      resolve(true)
    })
  })

  let termSent = false
  try {
    child.kill('SIGTERM')
    termSent = true
  } catch {
    // Some platforms can reject the graceful signal even while the process is
    // still alive. Continue into the confirmed force-kill path.
  }

  const graceful = termSent
    ? await Promise.race([
        exitPromise,
        delay(graceMs).then(() => false),
      ])
    : exited || child.exitCode !== null
  if (!graceful && !exited) {
    await forceKill(child.pid)
    const forcedExit = await Promise.race([
      exitPromise,
      delay(forceExitMs).then(() => false),
    ])
    if (!forcedExit && !exited) {
      throw new Error(`Runtime process ${child.pid} did not exit after force kill`)
    }
  }
}

module.exports = {
  stopRuntimeProcess,
  waitForRuntimeReady,
}
