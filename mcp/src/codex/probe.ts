#!/usr/bin/env node

const CODEX_PROTOCOL_TIMEOUT_MS = 3_000

async function main(): Promise<void> {
  const socketPath = process.argv[2]
  const timeoutMs = Number(process.argv[3] ?? CODEX_PROTOCOL_TIMEOUT_MS)
  if (!socketPath || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error('usage: probe.js <unix-socket> [timeout-ms]')
    process.exitCode = 2
    return
  }

  let AppServerClient
  try {
    ;({ AppServerClient } = await import('./appServerClient.js'))
  } catch (err) {
    console.error(`Codex health probe unavailable: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 2
    return
  }

  const client = new AppServerClient(socketPath)
  try {
    await client.connect(timeoutMs)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  } finally {
    client.close()
  }
}

void main()
