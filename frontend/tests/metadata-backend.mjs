import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export async function startMetadataBackend(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'task-timer-db-'))
  await writeFile(path.join(directory, 'clock.txt'), '2026-10-07T03:00:00Z')
  const python = process.env.TIMER_TEST_PYTHON ?? fileURLToPath(new URL('../../backend/.venv/Scripts/python.exe', import.meta.url))
  const backend = spawn(python, ['-B', fileURLToPath(new URL('./isolated-backend.py', import.meta.url)), directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', error = ''
  backend.stdout.on('data', chunk => { output += chunk }); backend.stderr.on('data', chunk => { error += chunk })
  t.after(async () => {
    if (backend.exitCode === null) {
      const exited = new Promise(resolve => backend.once('exit', resolve))
      backend.kill(); await exited
    }
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert(path.basename(directory).startsWith('task-timer-db-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  let base
  for (let attempt = 0; attempt < 200; attempt += 1) {
    assert.equal(backend.exitCode, null, error)
    const port = output.match(/TIMER_TEST_PORT=(\d+)/)?.[1]
    if (port) {
      base = `http://127.0.0.1:${port}`
      try { if ((await fetch(`${base}/health`)).ok) break } catch { /* Server startup. */ }
    }
    if (attempt === 199) assert.fail(error || 'Isolated Backend did not start')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const api = async (route, payload, method = 'POST') => {
    const response = await fetch(base + route, payload === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    const result = await response.json()
    assert(response.ok, `${route}: ${response.status} ${JSON.stringify(result)}`)
    return result
  }
  return { base, api, directory, python }
}
