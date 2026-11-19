// The link from each page frame's video stream to the GreenFrame bridge (bridge/greenframe_bridge.py), kept in the
// main process so the page's security policy doesn't apply. One WebSocket per page frame with a stream; it opens
// when the stream starts and retries every 2 s while it runs.
'use strict';
const { ipcMain } = require('electron');

const MAX_BUFFERED = 8 * 1024 * 1024; // past this, frames are dropped rather than queued (the bridge fell behind)

function setup(port, log) {
  const url = `ws://127.0.0.1:${port}/`;
  const links = new Map(); // frame key -> link

  function linkFor(frame) {
    const key = `${frame.processId}:${frame.routingId}`;
    let l = links.get(key);
    if (!l) {
      l = { key, frame, ws: null, open: false, streaming: false, retry: null, hello: null, early: [], said: false,
            dropped: 0 };
      links.set(key, l);
    }
    l.frame = frame;
    return l;
  }

  function sendText(l, obj) {
    if (l.open) l.ws.send(JSON.stringify(obj));
    else if (l.early.length < 20) l.early.push(obj);
  }

  function connect(l) {
    if (l.ws || !l.streaming) return;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      log(`can't open the bridge connection: ${e.message}`);
      return schedule(l);
    }
    l.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      l.open = true;
      l.said = false;
      log('connected to the GreenFrame bridge');
      if (l.hello) sendText(l, l.hello);
      sendText(l, { type: 'begin', codec: 'h264' });
      for (const m of l.early.splice(0)) if (m.type !== 'begin' && m.type !== 'end') sendText(l, m);
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.type === 'keyframe') {
        try { l.frame.send('greenframe-keyframe'); } catch (err) { /* frame gone */ }
      }
    };
    ws.onclose = () => {
      if (!l.said) {
        log(`no GreenFrame bridge at ${url}; retrying`);
        l.said = true;
      }
      l.ws = null;
      l.open = false;
      schedule(l);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  function schedule(l) {
    if (l.retry || !l.streaming) return;
    l.retry = setTimeout(() => { l.retry = null; connect(l); }, 2000);
  }

  ipcMain.on('greenframe', (e, d) => {
    if (!e.senderFrame || !d) return;
    const l = linkFor(e.senderFrame);
    switch (d.type) {
      case 'frame': {
        if (!l.open) return;
        if (l.ws.bufferedAmount > MAX_BUFFERED) {
          if (l.dropped++ % 60 === 0) log('bridge is behind; dropping frames');
          return;
        }
        l.ws.send(d.buf);
        return;
      }
      case 'hello':
        l.hello = { type: 'hello', version: d.version, page: d.page, mode: d.mode };
        return;
      case 'begin':
        l.streaming = true;
        log(`video stream started (${d.mode || '?'})`);
        if (l.open) sendText(l, { type: 'begin', codec: d.codec, mode: d.mode });
        else connect(l);
        return;
      case 'end':
        sendText(l, { type: 'end' });
        return;
      case 'warn':
        log(`warning: ${d.msg}`);
        sendText(l, { type: 'warn', msg: d.msg });
        return;
    }
  });
}

module.exports = { setup };
