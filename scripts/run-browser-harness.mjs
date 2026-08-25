import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const [browserBin, harnessUrl, profilePath] = process.argv.slice(2);
if (!browserBin || !harnessUrl || !profilePath) {
  console.error('Usage: run-browser-harness.mjs BROWSER URL PROFILE_PATH');
  process.exit(2);
}

const chrome = spawn(browserBin, [
  '--headless=new',
  '--disable-extensions',
  '--no-default-browser-check',
  '--no-first-run',
  '--autoplay-policy=no-user-gesture-required',
  '--remote-allow-origins=*',
  '--remote-debugging-port=0',
  `--user-data-dir=${profilePath}`,
  harnessUrl,
], { stdio: ['ignore', 'ignore', 'pipe'] });

let chromeStderr = '';
chrome.stderr.setEncoding('utf8');
chrome.stderr.on('data', chunk => {
  chromeStderr = (chromeStderr + chunk).slice(-16_000);
});

async function devToolsEndpoint() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = chromeStderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) return match[1];
    if (chrome.exitCode !== null) {
      throw new Error(`Chrome exited before DevTools became available.\n${chromeStderr}`);
    }
    await delay(25);
  }
  throw new Error(`Chrome DevTools startup timed out.\n${chromeStderr}`);
}

async function pageTarget(browserEndpoint) {
  const { port } = new URL(browserEndpoint);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (response.ok) {
      const targets = await response.json();
      const target = targets.find(candidate => candidate.type === 'page' && candidate.url === harnessUrl)
        || targets.find(candidate => candidate.type === 'page');
      if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
    }
    await delay(25);
  }
  throw new Error('Chrome did not expose a page target.');
}

function connect(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error('Chrome DevTools WebSocket failed.')), { once: true });
  });
}

function cdpClient(socket) {
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (!message.id) {
      for (const listener of listeners.get(message.method) || []) listener(message.params);
      return;
    }
    if (!pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  return {
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(listener);
    },
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

let socket = null;
try {
  const browserEndpoint = await devToolsEndpoint();
  const targetEndpoint = await pageTarget(browserEndpoint);
  socket = await connect(targetEndpoint);
  const cdp = cdpClient(socket);
  const consoleErrors = [];
  const networkFailures = [];
  // What actually backs "no analytics — verify with the network tab".
  //
  // Failed requests and 4xx/5xx were the only thing checked, so a *successful*
  // beacon to a third party passed every gate. The rule is the origin, not the
  // outcome: this page may talk to the server serving it and to nothing else.
  const remoteRequests = [];
  const harnessOrigin = new URL(harnessUrl).origin;
  const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'about:', 'chrome-extension:', 'filesystem:']);
  const checkedResourceTypes = new Set(['Document', 'Script', 'Fetch', 'XHR', 'Media']);
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    consoleErrors.push(exceptionDetails.exception?.description || exceptionDetails.text);
  });
  cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
    if (type !== 'error') return;
    const text = args.map(argument => {
      if (Object.hasOwn(argument, 'value')) {
        return typeof argument.value === 'string' ? argument.value : JSON.stringify(argument.value);
      }
      return argument.description || argument.type;
    }).join(' ');
    consoleErrors.push(text);
  });
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'error' && entry.source !== 'network') {
      consoleErrors.push(`${entry.source}: ${entry.text}`);
    }
  });
  cdp.on('Network.requestWillBeSent', ({ request, type }) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return; // an unparseable URL cannot name a remote host
    }
    if (LOCAL_SCHEMES.has(url.protocol) || url.origin === harnessOrigin) return;
    remoteRequests.push(`${type ?? 'Other'}: ${request.method} ${request.url.slice(0, 200)}`);
  });
  cdp.on('Network.loadingFailed', event => {
    if (!event.canceled && checkedResourceTypes.has(event.type)) {
      networkFailures.push(`${event.type}: ${event.errorText}`);
    }
  });
  cdp.on('Network.responseReceived', ({ response, type }) => {
    if (response.status >= 400 && checkedResourceTypes.has(type)) {
      networkFailures.push(`${type}: HTTP ${response.status} ${response.url}`);
    }
  });
  await Promise.all([
    cdp.send('Runtime.enable'),
    cdp.send('Log.enable'),
    cdp.send('Network.enable'),
  ]);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const evaluation = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const result = document.querySelector('#result');
        return {
          status: result?.dataset.status || 'missing',
          text: (result?.textContent || '').slice(0, 12000),
          title: document.title,
        };
      })()`,
      returnByValue: true,
    });
    const state = evaluation.result.value;
    if (state.status === 'pass') {
      if (consoleErrors.length || networkFailures.length || remoteRequests.length) {
        throw new Error([
          `${state.title} reached pass with browser errors.`,
          ...consoleErrors.map(error => `console: ${error}`),
          ...networkFailures.map(error => `network: ${error}`),
          ...remoteRequests.map(error => `remote: ${error}`),
        ].join('\n'));
      }
      console.log(`${state.title}: ${state.status}; console errors: 0; network failures: 0; remote requests: 0`);
      break;
    }
    if (state.status === 'fail') {
      throw new Error([
        state.title,
        state.text,
        ...consoleErrors.map(item => `console: ${item}`),
        ...networkFailures.map(item => `network: ${item}`),
        ...remoteRequests.map(item => `remote: ${item}`),
      ].join('\n'));
    }
    await delay(50);
  }

  const finalEvaluation = await cdp.send('Runtime.evaluate', {
    expression: `document.querySelector('#result')?.dataset.status || 'missing'`,
    returnByValue: true,
  });
  if (finalEvaluation.result.value !== 'pass') {
    throw new Error([
      `Harness timed out with status: ${finalEvaluation.result.value}`,
      ...consoleErrors.map(item => `console: ${item}`),
      ...networkFailures.map(item => `network: ${item}`),
      ...remoteRequests.map(item => `remote: ${item}`),
    ].join('\n'));
  }
} catch (error) {
  console.error(error.stack || String(error));
  if (chromeStderr) console.error(chromeStderr);
  process.exitCode = 1;
} finally {
  if (socket) socket.close();
  if (chrome.exitCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([once(chrome, 'exit'), delay(2_000)]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
  }
}
