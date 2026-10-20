import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const snapshotScript = `
import hashlib, pathlib, sqlite3, sys, tempfile
folder = pathlib.Path(sys.argv[1])
assert folder.is_absolute() and folder == folder.resolve()
assert folder.parent == pathlib.Path(tempfile.gettempdir()).resolve()
assert folder.name.startswith('task-timer-db-') and not folder.is_symlink()
database, baseline = folder / 'timer.db', folder / 'scenario-baseline.sqlite'
assert database.is_file() and not database.is_symlink() and not baseline.is_symlink()
mode = sys.argv[2]
assert mode in ('capture', 'restore')
assert not baseline.exists() if mode == 'capture' else baseline.is_file()
source, target = (database, baseline) if mode == 'capture' else (baseline, database)
with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as reader:
    with sqlite3.connect(target.as_uri() + ('?mode=rwc' if mode == 'capture' else '?mode=rw'), uri=True) as writer:
        reader.backup(writer)
        assert writer.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
        expected = hashlib.sha256('\\n'.join(reader.iterdump()).encode()).hexdigest()
        actual = hashlib.sha256('\\n'.join(writer.iterdump()).encode()).hexdigest()
        assert actual == expected
print(actual)
`

// Only guarded, synthetic browser-test DBs may be snapshotted/restored.
export async function captureScenarioDatabase(directory, python) {
  const resolved = await realpath(directory)
  assert.equal(path.dirname(resolved), await realpath(tmpdir()))
  assert(path.basename(resolved).startsWith('task-timer-db-'))
  assert(!(await lstat(directory)).isSymbolicLink())
  const run = async mode => {
    const { stdout } = await execute(python, ['-B', '-c', snapshotScript, resolved, mode], { windowsHide: true })
    return stdout.trim()
  }
  const fingerprint = await run('capture')
  return async () => assert.equal(await run('restore'), fingerprint, 'Restore the exact initial fixture, including Active and IDs')
}

// Lifecycle belongs to each case; assertions and deliberate multi-step actions
// stay in their original tests. Failed assertions still propagate to node:test.
export async function isolateScenarios(t, { browser, directory, python, reset = async () => {}, prepare = async () => {}, ready = async () => {} }) {
  const viewport = await browser.evaluate('[innerWidth, innerHeight]')
  const restore = directory ? await captureScenarioDatabase(directory, python) : async () => {}
  const pending = new Set()
  const observe = message => { if (message.method === 'Fetch.requestPaused') pending.add(message.params.requestId) }
  browser.listeners.push(observe)
  const send = browser.send
  browser.send = async function (method, params) {
    try { return await send.call(this, method, params) } finally {
      if (['Fetch.fulfillRequest', 'Fetch.failRequest', 'Fetch.continueRequest'].includes(method)) pending.delete(params.requestId)
    }
  }
  const drain = async () => {
    const deadline = Date.now() + 15000
    while (pending.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(pending.size, 0, 'All held/forwarded requests released before restoring the fixture')
  }
  const cleanup = async () => {
    await reset()
    await drain()
    await browser.evaluate('if (location.protocol === "http:") { localStorage.clear(); sessionStorage.clear() }; undefined')
    await browser.send('Page.navigate', { url: 'about:blank' })
    await browser.until('location.href === "about:blank"', 'Previous scenario unmounted (including Modal/Filter/Picker)')
    await browser.send('Input.setInterceptDrags', { enabled: false })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 0, y: 0, button: 'left', buttons: 0, clickCount: 1 })
    await drain()
    await restore()
  }
  t.beforeEach(async child => {
    // Also safe when a single child is selected from the command line.
    await cleanup()
    await prepare(child.name)
    await browser.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await browser.send('Emulation.setDeviceMetricsOverride', { width: viewport[0], height: viewport[1], deviceScaleFactor: 1, mobile: false })
    await browser.navigate()
    await ready(child.name)
  })
  t.afterEach(async child => {
    await cleanup()
    child.diagnostic(`Scenario cleanup complete: requests drained, previous UI unmounted, ${directory ? 'initial temporary DB restored' : 'mock state reset'}`)
  })
  t.after(() => {
    browser.send = send
    const index = browser.listeners.indexOf(observe)
    if (index !== -1) browser.listeners.splice(index, 1)
  })
}
