// GreenFrame, extension side: relays frames from inject.js to the local bridge over a WebSocket, and the
// bridge's keyframe requests back. Connects only once a video stream starts, and keeps retrying while it runs.
(() => {
  'use strict';
  const BRIDGE = 'ws://127.0.0.1:47820/';
  const TAG = '[GreenFrame]';
  const MAX_BUFFERED = 8 * 1024 * 1024; // past this, frames are dropped rather than queued (the bridge fell behind)

  let ws = null, open = false, streaming = false, retry = null, hello = null, said = false, dropped = 0;

  const early = []; // text messages from before the bridge connection opened (warnings, mostly)

  function sendText(obj) {
    if (open) ws.send(JSON.stringify(obj));
    else if (early.length < 20) early.push(obj);
  }

  function connect() {
    if (ws || !streaming) return;
    try {
      ws = new WebSocket(BRIDGE);
    } catch (e) {
      console.warn(TAG, "can't open the bridge connection:", e);
      ws = null;
      return schedule();
    }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      open = true;
      said = false;
      console.info(TAG, 'connected to the GreenFrame bridge');
      if (hello) sendText(hello);
      sendText({ type: 'begin', codec: 'h264' });
      for (const m of early.splice(0)) if (m.type !== 'begin' && m.type !== 'end') sendText(m);
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.type === 'keyframe') window.postMessage({ __greenframe: 'bridge', type: 'keyframe' }, '*');
    };
    ws.onclose = () => {
      if (!said) {
        console.warn(TAG, `no GreenFrame bridge at ${BRIDGE}; is it running? Retrying.`);
        said = true;
      }
      ws = null;
      open = false;
      schedule();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  function schedule() {
    if (retry || !streaming) return;
    retry = setTimeout(() => { retry = null; connect(); }, 2000);
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__greenframe !== 'page') return;
    switch (d.type) {
      case 'frame':
        if (!open) return;
        if (ws.bufferedAmount > MAX_BUFFERED) {
          if (dropped++ % 60 === 0) console.warn(TAG, 'bridge is behind; dropping frames');
          return;
        }
        ws.send(d.buf);
        return;
      case 'hello':
        hello = { type: 'hello', version: d.version, page: d.page, mode: d.mode };
        return;
      case 'begin':
        streaming = true;
        if (open) sendText({ type: 'begin', codec: d.codec, mode: d.mode });
        else connect();
        return;
      case 'end':
        sendText({ type: 'end' });
        return;
      case 'warn':
        console.warn(TAG, d.msg);
        sendText({ type: 'warn', msg: d.msg });
        return;
    }
  });
})();
