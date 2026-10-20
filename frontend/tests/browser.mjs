import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function selectPriority(browser, scope, value) {
  await browser.click(scope + ' .task-priority-pill')
  await browser.until(`document.querySelector(${JSON.stringify(scope + ' .priority-popup')})`, 'Priority menu open')
  await browser.click(scope + ` .priority-popup [data-priority="${value}"]`)
  await browser.until(`!document.querySelector(${JSON.stringify(scope + ' .priority-popup')})`, 'Priority selected')
}

export async function selectProject(browser, selector, projectId) {
  const input = JSON.stringify(selector)
  await browser.evaluate(`document.querySelector(${input}).closest('.project-picker').querySelector('button').click()`)
  await browser.until(`document.querySelector(${input}).closest('.project-picker').querySelector('.project-picker-popup')`, 'Project Picker open')
  await browser.until(`document.querySelector(${input}).closest('.project-picker').querySelector('[data-project-id="${projectId ?? ''}"]')?.disabled === false`, 'Requested Project option ready')
  await browser.evaluate(`document.querySelector(${input}).closest('.project-picker').querySelector('[data-project-id="${projectId ?? ''}"]').click()`)
  await browser.until(`!document.querySelector(${input}).closest('.project-picker').querySelector('.project-picker-popup')`, 'Project selected')
}

// Pause remains available in Details; the main Header action is Start / Stop.
export async function pauseOrResumeTimer(browser) {
  const active = await browser.evaluate('document.querySelector(".global-top-timer.timer-session:not(.paused)") !== null')
  if (!active) {
    await browser.click('.global-top-timer .timer-pause-resume')
    await browser.until('document.querySelector(".global-top-timer.timer-session:not(.paused)") && !document.querySelector(".global-top-timer .timer-stop").disabled', 'Resume confirmed')
    return
  }
  await browser.click('.global-top-timer .timer-time-button')
  await browser.until('document.querySelector(".timer-modal .timer-controls button")?.disabled === false', 'Timer Details ready')
  await browser.click('.timer-modal .timer-controls button:first-child')
  await browser.until('document.querySelector(".global-top-timer.paused") && !document.querySelector(".global-top-timer .timer-play-button").disabled', 'Paused from Details')
  await browser.click('.timer-modal .icon-close')
  await browser.until('!document.querySelector(".timer-modal")', 'Timer Details closed')
}

export async function selectTimerTask(browser, taskId) {
  await browser.until('document.querySelector(".timer-task-picker input")?.disabled === false', 'Task search ready')
  await browser.click('.timer-task-picker input')
  await browser.evaluate(`(() => {
    const input = document.querySelector('.timer-task-picker input'); input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const option = `.timer-task-suggestions [data-task-id="${Number(taskId)}"] button`
  await browser.until(`document.querySelector(${JSON.stringify(option)})`, 'Existing Task suggestion')
  await browser.click(option)
}

export async function openBrowser() {
  const candidates = [process.env.BROWSER_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean)
  let executable
  for (const candidate of candidates) {
    try { await access(candidate); executable = candidate; break } catch { /* Try the next local browser. */ }
  }
  assert(executable, 'Chrome/Chromium/Edge is required. Set BROWSER_PATH to the browser executable.')
  const profile = await mkdtemp(path.join(tmpdir(), 'task-timer-browser-'))
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  await server.listen()
  const url = `http://127.0.0.1:${server.httpServer.address().port}`
  const browser = spawn(executable, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update',
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, '--window-size=1600,1100', 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let log = ''
  browser.stderr.on('data', chunk => { log += chunk.toString() })
  let socket
  let cdp
  const close = async () => {
    if (cdp) { try { await cdp.send('Browser.close') } catch { /* Browser already closed. */ } }
    socket?.close()
    if (browser.exitCode === null) {
      const exited = new Promise(resolve => browser.once('exit', resolve))
      browser.kill()
      await Promise.race([exited, sleep(3000)])
    }
    await server.close()
    assert.equal(path.dirname(profile), path.resolve(tmpdir()))
    assert(path.basename(profile).startsWith('task-timer-browser-'))
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
  try {
    let port
    for (let i = 0; i < 150; i += 1) {
      try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break } catch { /* Browser is initializing. */ }
      if (browser.exitCode !== null) throw new Error(`Browser exited: ${log}`)
      await sleep(100)
    }
    assert(port, `Browser debugger did not start: ${log}`)
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const target = targets.find(item => item.type === 'page')
    assert(target, 'Browser page is missing')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    let next = 0
    const pending = new Map()
    const listeners = []
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const request = pending.get(message.id)
        if (!request) return
        pending.delete(message.id)
        clearTimeout(request.timeout)
        if (message.error) request.reject(new Error(JSON.stringify(message.error)))
        else request.resolve(message.result)
      } else {
        for (const listener of listeners) listener(message)
      }
    })
    socket.addEventListener('close', () => {
      for (const request of pending.values()) {
        clearTimeout(request.timeout)
        request.reject(new Error('CDP connection closed'))
      }
      pending.clear()
    })
    cdp = {
      listeners,
      send(method, params = {}) {
        if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP connection closed'))
        const id = ++next
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 15000)
          pending.set(id, { resolve, reject, timeout })
          socket.send(JSON.stringify({ id, method, params }))
        })
      },
      async evaluate(expression) {
        const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
        return result.result.value
      },
      async until(expression, label, timeout = 12000) {
        const deadline = Date.now() + timeout
        while (Date.now() < deadline) {
          try {
            if (await this.evaluate(`Boolean(${expression})`)) return
          } catch (error) {
            // A reload can replace the execution context between polling calls.
            if (!/Inspected target navigated or closed|Execution context was destroyed|Cannot find context with specified id/.test(error.message)) throw error
          }
          await sleep(40)
        }
        assert.fail(`Timeout: ${label}\n${await this.evaluate('document.body.innerText.slice(0,1800)')}`)
      },
      async click(selector) {
        const encoded = JSON.stringify(selector)
        assert(await this.evaluate(`Boolean(document.querySelector(${encoded}))`), `Missing: ${selector}`)
        assert(await this.evaluate(`!document.querySelector(${encoded}).disabled`), `Disabled: ${selector}`)
        await this.evaluate(`document.querySelector(${encoded}).click()`)
      },
      async navigate(reload = false) {
        const token = String(Date.now()) + Math.random()
        await this.evaluate(`document.documentElement.dataset.testNavigationToken = ${JSON.stringify(token)}; undefined`)
        await this.send(reload ? 'Page.reload' : 'Page.navigate', reload ? {} : { url })
        await this.until(`document.documentElement?.dataset.testNavigationToken !== ${JSON.stringify(token)} && document.getElementById('root')`, 'New page document')
      },
      async fulfill(requestId, body, status = 200) {
        await this.send('Fetch.fulfillRequest', {
          requestId, responseCode: status,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Access-Control-Allow-Origin', value: '*' },
            { name: 'Access-Control-Allow-Methods', value: 'GET,POST,PUT,PATCH,DELETE,OPTIONS' },
            { name: 'Access-Control-Allow-Headers', value: 'Content-Type' },
          ],
          body: Buffer.from(JSON.stringify(body)).toString('base64'),
        })
      },
      close,
      url,
    }
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    // Headless Edge can keep a page unfocused after navigation, suppressing blur.
    // Give editing tests the same focus events as a user operating the page.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp.send('Network.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false })
    return cdp
  } catch (error) { error.message += `\nBrowser log: ${log}`; await close(); throw error }
}
