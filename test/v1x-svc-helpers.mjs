// Shared fakes for the v1.x services tests: storage, fetch and chat.
import { createConsent } from '../app/net/consent.mjs';

export function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
    dump: () => Object.fromEntries(map),
  };
}

export const brokenStorage = () => ({
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
});

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fetch that answers from `routes(url, init)` and records every call. */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return routes(new URL(String(url)), init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

export function grantedConsent(...origins) {
  const consent = createConsent({ storage: memoryStorage() });
  origins.forEach(o => consent.grant(o));
  return consent;
}

/** A chat that returns the given replies in order and records request bodies. */
export function fakeChat(...replies) {
  const bodies = [];
  const fn = async body => {
    bodies.push(body);
    const r = replies[Math.min(bodies.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(body) : { choices: [{ message: { content: typeof r === 'string' ? r : JSON.stringify(r) } }] };
  };
  fn.bodies = bodies;
  return fn;
}
