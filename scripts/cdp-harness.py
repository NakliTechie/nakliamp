#!/usr/bin/env python3
# Run a NakliAmp browser harness in Chirag's own Chrome through the CDP daemon
# (~/Code/infra/bin/chrome-cdpd.mjs on 127.0.0.1:9334), in a foreground tab.
# The headless runner (scripts/run-browser-harness.mjs) used a fresh profile and
# an autoplay flag; this one reproduces both: it clears NakliAmp's own storage
# by name before each run, disables the HTTP cache for the tab, gives the page
# user activation with trusted clicks, and holds AudioContext.resume() until
# that activation lands. Usage: python3 scripts/cdp-harness.py <url> [timeout] [--keep]
import json, urllib.request, sys, time
def call(**kw):
    r = urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:9334/', data=json.dumps(kw).encode()), timeout=180)
    return json.loads(r.read() or 'null')
def raw(method, params=None, t=None):
    kw = {'cmd':'raw','text':json.dumps({'method':method,'params':params or {}})}
    if t: kw['t']=t
    return call(**kw)
GUARD = r"""(()=>{ if (window.__errs) return; window.__errs=[]; const ce=console.error.bind(console);
console.error=(...a)=>{ try{window.__errs.push(a.map(x=>x&&x.stack||String(x)).join(' ').slice(0,400))}catch(_){} ce(...a)};
addEventListener('error',e=>window.__errs.push('error: '+(e.message||e.target?.src||'resource')));
const AC=window.AudioContext; if (AC && !AC.prototype.__held) { const orig=AC.prototype.resume; AC.prototype.__held=true;
const top=(()=>{try{return window.top.document&&window.top}catch(_){return window}})();
const active=()=>navigator.userActivation?.hasBeenActive||top.navigator.userActivation?.hasBeenActive;
let ready=new Promise(r=>{ const tick=()=>active()?r():setTimeout(tick,50); tick(); });
AC.prototype.resume=function(){ return active() ? orig.call(this) : ready.then(()=>orig.call(this)); }; }
addEventListener('unhandledrejection',e=>window.__errs.push('rejection: '+String(e.reason&&e.reason.stack||e.reason).slice(0,400)));})()"""
def clear_nakliamp(origin):
    # Delete by name: NakliAmp's localStorage keys, its IndexedDB database and
    # its OPFS harness folders. Other projects that share this port keep theirs.
    c = raw('Target.createTarget', {'url': origin + '/VENDOR.md', 'background': True})['targetId']
    time.sleep(1.2)
    r = call(cmd='eval', t=c, js='''(async()=>{ const keys=Object.keys(localStorage).filter(k=>k.startsWith('nakliamp'));
      keys.forEach(k=>localStorage.removeItem(k));
      await new Promise(r=>{const q=indexedDB.deleteDatabase('nakliamp'); q.onsuccess=q.onerror=q.onblocked=()=>r();});
      const removed=[]; try{ const root=await navigator.storage.getDirectory();
        for await (const [name] of root.entries()) if (/nakliamp/i.test(name)) { await root.removeEntry(name,{recursive:true}); removed.push(name);} }catch(e){}
      return {keys, removed}; })()''')
    release(c)
    return r
def release(target):
    # Chrome may report closeTarget as done and leave the tab open, still holding
    # NakliAmp's IndexedDB; the next run's deleteDatabase then blocks every open.
    # Blank the tab first so it holds nothing, then ask Chrome to close it.
    try: raw('Page.navigate', {'url': 'about:blank'}, target)
    except Exception: pass
    try: raw('Target.closeTarget', {'targetId': target})
    except Exception: pass
def run_harness(url, timeout=60):
    t = raw('Target.createTarget', {'url':'about:blank','background':False})['targetId']
    raw('Page.enable', {}, t)
    raw('Network.enable', {}, t)
    raw('Network.setCacheDisabled', {'cacheDisabled': True}, t)
    raw('Page.addScriptToEvaluateOnNewDocument', {'source':GUARD}, t)
    # Each harness expects a cold profile, as the headless runner gave it. Clear
    # only the test server's own origin, by name.
    from urllib.parse import urlsplit
    o = urlsplit(url); origin = f'{o.scheme}://{o.netloc}'
    if o.hostname == '127.0.0.1' and o.port in (8878, 8879):
        clear_nakliamp(origin)
    raw('Page.bringToFront', {}, t)
    # The laptop may lock and the tab may sit behind others; emulate focus so
    # the page behaves as a focused, visible tab would.
    try: raw('Emulation.setFocusEmulationEnabled', {'enabled': True}, t)
    except Exception: pass
    raw('Page.navigate', {'url':url}, t)
    # Trusted clicks give the page user activation, so AudioContext.resume()
    # succeeds in a normal Chrome profile (the headless runner used an
    # autoplay flag instead). Clicks land in the top-left corner, away from controls.
    for _ in range(6):
        time.sleep(0.25)
        for kind in ('mousePressed','mouseReleased'):
            try: raw('Input.dispatchMouseEvent', {'type':kind,'x':2,'y':2,'button':'left','clickCount':1}, t)
            except Exception: pass
    end=time.time()+timeout; st=None
    while time.time()<end:
        time.sleep(1)
        try:
            st = call(cmd='eval', t=t, js="""(()=>{const r=document.querySelector('#result');
            const remote=performance.getEntriesByType('resource').map(e=>e.name).filter(n=>!n.startsWith(location.origin)&&!/^(data|blob):/.test(n));
            return {status:r?.dataset.status||'missing', text:(r?.textContent||'').slice(0,3000), errs:window.__errs||[], remote};})()""")
        except Exception as e:
            st={'status':'eval-error','text':str(e)}
        if st and st.get('status') in ('pass','fail'): break
    return t, st
if __name__=='__main__':
    url=sys.argv[1]; t=None
    try:
        t,st=run_harness(url, int(sys.argv[2]) if len(sys.argv)>2 and sys.argv[2].isdigit() else 60)
        try: st = dict(st or {}, visibility=call(cmd='eval', t=t, js='document.visibilityState'))
        except Exception: pass
        print(json.dumps({'target':t, **(st or {})})[:4000])
    finally:
        # Close the tab on success and on failure alike; never leave tabs open.
        if t and '--keep' not in sys.argv:
            release(t)
