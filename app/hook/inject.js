// GreenFrame, page side (runs in the page's own JavaScript world, before the page's scripts).
//
// Hooks WebRTC so every compressed video frame the Xbox sends is copied out *before* the browser decodes it, and
// handed to content.js (which sends it to the local bridge). The browser still gets every frame, so the stream,
// sound and controller keep working as normal behind SmoovPlay's window.
//
// Two ways in, whichever the browser has:
//   - createEncodedStreams (Chrome/Edge): each frame on the main thread; needs a flag when the RTCPeerConnection is
//     made, and then every sender/receiver must be piped through. Used whenever the browser has it: in Chrome 153
//     RTCRtpScriptTransform exists but frames bypass it (tested), so it's only the fallback.
//   - RTCRtpScriptTransform (browsers without the above): a small worker sees each frame.
// Also asks for H.264 first, the codec SmoovPlay's tap reads.
function greenframeHook() {
  'use strict';
  if (window.__greenframeTap) return;
  window.__greenframeTap = true;
  const VERSION = '0.1.0';
  const TAG = '[GreenFrame]';
  const NativePC = window.RTCPeerConnection;
  if (!NativePC) return;

  const post = (msg, transfer) => window.postMessage(Object.assign({ __greenframe: 'page' }, msg), '*', transfer || []);

  // One handler per video stream: copies frames out, drops frames on request so the browser's own decoder asks the
  // Xbox for a keyframe (what SmoovPlay needs to start decoding). Used in the worker too (as source text).
  function makeHandler(send) {
    let wantKey = false, breakNext = false, lastId = null, warned = false, w = 0, h = 0;
    const KEY_MODE = (typeof self !== 'undefined' && self.__greenframeKeyMode) || 'break';
    return {
      // SmoovPlay wants a keyframe. There's no API for a receiver to ask for one, so make the browser's own decoder
      // ask: hand it one deliberately broken frame (it fails to decode and requests a keyframe from the Xbox).
      // Frames up to that keyframe aren't sent to SmoovPlay (it couldn't decode them); the browser's own picture,
      // hidden behind SmoovPlay, may smear for a moment.
      wantKeyframe() { wantKey = true; breakNext = true; },
      onFrame(frame, ctl) {
        let md = {};
        try { md = frame.getMetadata() || {}; } catch (e) { /* no metadata */ }
        const mime = String(md.mimeType || '').toLowerCase();
        if (mime && !mime.includes('h264')) {
          if (!warned) {
            warned = true;
            send({ type: 'warn', msg: `the stream's video codec is ${mime}, not H.264; SmoovPlay can't read it` });
          }
          ctl.enqueue(frame);
          return;
        }
        const key = frame.type === 'key';
        if (key) {
          wantKey = false;
          if (md.width && md.height) { w = md.width; h = md.height; }
        } else if (wantKey) {
          if (breakNext) {
            breakNext = false;
            if (KEY_MODE === 'drop') return;
            const bad = new Uint8Array(Math.max(64, frame.data.byteLength));
            bad.set([0, 0, 0, 1, 0x65]); // an IDR slice header followed by garbage: undecodable
            for (let i = 5; i < bad.length; i++) bad[i] = (i * 151) & 0xff;
            frame.data = bad.buffer;
            ctl.enqueue(frame);
            return;
          }
          if (KEY_MODE === 'drop') return;
        }
        let lost = 0;
        if (typeof md.frameId === 'number') {
          if (lastId !== null && md.frameId > lastId + 1) lost = md.frameId - lastId - 1;
          lastId = md.frameId;
        }
        const src = new Uint8Array(frame.data);
        const buf = new ArrayBuffer(16 + src.byteLength);
        const dv = new DataView(buf);
        dv.setUint32(0, 0x4d465247, true); // 'GRFM'
        dv.setUint8(4, key ? 1 : 0);
        dv.setInt32(8, lost, true);
        dv.setUint16(12, w, true);
        dv.setUint16(14, h, true);
        new Uint8Array(buf, 16).set(src);
        send({ type: 'frame', buf }, [buf]);
        ctl.enqueue(frame);
      },
    };
  }

  // ------------------------------------------------------------ RTCRtpScriptTransform (worker)
  const WORKER_SRC = `'use strict';
${makeHandler.toString()}
const send = (m, t) => postMessage(m, t || []);
const live = new Set();
onmessage = (e) => {
  if (e.data !== 'keyframe') return;
  for (const s of live) {
    s.handler.wantKeyframe();
    try { if (s.t.sendKeyFrameRequest) s.t.sendKeyFrameRequest().catch(() => {}); } catch (err) {}
  }
};
onrtctransform = (e) => {
  const t = e.transformer;
  const s = { t, handler: makeHandler(send) };
  live.add(s);
  send({ type: 'begin', codec: 'h264', mode: 'transform' });
  t.readable
    .pipeThrough(new TransformStream({ transform: (f, c) => s.handler.onFrame(f, c) }))
    .pipeTo(t.writable)
    .catch(() => {})
    .finally(() => { live.delete(s); send({ type: 'end' }); });
};
send({ type: 'ready' });
`;
  // The worker starts in a few ms; a connection made before then still uses it (the transform is attached once
  // it's up). If the page's policy blocks it, `worker` goes back to null and nothing is tapped (the stream itself
  // is untouched).
  let worker = null, markReady;
  const workerUp = new Promise((r) => { markReady = r; });
  const hasLegacy = 'createEncodedStreams' in RTCRtpReceiver.prototype;
  if (!hasLegacy && 'RTCRtpScriptTransform' in window) {
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'ready') { markReady(true); return; }
        if (d.type === 'frame') post(d, [d.buf]);
        else post(d);
      };
      worker.onerror = () => {
        post({ type: 'warn', msg: "the tap's worker was blocked by the page; no frames will reach SmoovPlay" });
        worker = null;
        markReady(false);
      };
    } catch (e) {
      console.warn(TAG, 'no worker:', e);
      worker = null;
    }
  }

  // ------------------------------------------------------------ createEncodedStreams (main thread)
  const legacyPCs = new WeakSet();
  const piped = new WeakSet();
  const legacyHandlers = new Set();

  function passthrough(x) {
    if (piped.has(x)) return;
    piped.add(x);
    try {
      const { readable, writable } = x.createEncodedStreams();
      readable.pipeTo(writable).catch(() => {});
    } catch (e) { /* already piped, or not allowed for this one */ }
  }

  function tapLegacy(receiver) {
    if (piped.has(receiver)) return;
    piped.add(receiver);
    let streams;
    try { streams = receiver.createEncodedStreams(); } catch (e) { console.warn(TAG, e); return; }
    const handler = makeHandler(post);
    legacyHandlers.add(handler);
    post({ type: 'begin', codec: 'h264', mode: 'encoded-streams' });
    streams.readable
      .pipeThrough(new TransformStream({ transform: (f, c) => handler.onFrame(f, c) }))
      .pipeTo(streams.writable)
      .catch(() => {})
      .finally(() => { legacyHandlers.delete(handler); post({ type: 'end' }); });
  }

  function sweep(pc) {
    if (!legacyPCs.has(pc)) return;
    for (const s of pc.getSenders()) passthrough(s);
    for (const r of pc.getReceivers()) {
      if (r.track && r.track.kind === 'video') tapLegacy(r);
      else passthrough(r);
    }
  }

  // ------------------------------------------------------------ H.264 first
  function preferH264(transceiver) {
    try {
      if (!transceiver.setCodecPreferences || !RTCRtpReceiver.getCapabilities) return;
      const codecs = RTCRtpReceiver.getCapabilities('video').codecs;
      const h264 = codecs.filter((c) => /h264/i.test(c.mimeType));
      if (!h264.length) return;
      transceiver.setCodecPreferences(h264.concat(codecs.filter((c) => !/h264/i.test(c.mimeType))));
    } catch (e) { /* the page set its own; leave it */ }
  }

  // ------------------------------------------------------------ the hooks
  function tapReceiver(pc, receiver) {
    if (!receiver || !receiver.track) return;
    if (legacyPCs.has(pc)) { sweep(pc); return; }
    if (hasLegacy) return; // made before the hook could flag it: leave it alone
    if (receiver.track.kind !== 'video' || piped.has(receiver)) return;
    piped.add(receiver);
    if (!worker) {
      post({ type: 'warn', msg: 'this browser gave no way to read the video frames' });
      return;
    }
    workerUp.then((up) => {
      if (!up || !worker) return;
      try {
        receiver.transform = new RTCRtpScriptTransform(worker, { kind: 'video' });
      } catch (e) {
        post({ type: 'warn', msg: 'RTCRtpScriptTransform failed: ' + e });
      }
    });
  }

  function PC(config, ...rest) {
    let cfg = config;
    const legacy = hasLegacy; // proven in Chrome/Edge; the worker transform is for browsers without it
    if (legacy) cfg = Object.assign({}, config || {}, { encodedInsertableStreams: true });
    const pc = new NativePC(cfg, ...rest);
    if (legacy) legacyPCs.add(pc);
    pc.addEventListener('track', (e) => tapReceiver(pc, e.receiver));
    return pc;
  }
  PC.prototype = NativePC.prototype;
  Object.setPrototypeOf(PC, NativePC);
  window.RTCPeerConnection = PC;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = PC;

  const P = NativePC.prototype;
  const origAddTransceiver = P.addTransceiver;
  P.addTransceiver = function (trackOrKind, init) {
    const t = origAddTransceiver.apply(this, arguments);
    try {
      const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind && trackOrKind.kind;
      if (kind === 'video') preferH264(t);
    } catch (e) { /* ignore */ }
    if (legacyPCs.has(this)) passthrough(t.sender);
    return t;
  };
  const origAddTrack = P.addTrack;
  P.addTrack = function () {
    const s = origAddTrack.apply(this, arguments);
    if (legacyPCs.has(this)) passthrough(s);
    return s;
  };
  for (const name of ['setLocalDescription', 'setRemoteDescription']) {
    const orig = P[name];
    P[name] = function () {
      const r = orig.apply(this, arguments);
      if (legacyPCs.has(this) && r && r.then) r.then(() => sweep(this), () => {});
      return r;
    };
  }

  // Keyframe requests from SmoovPlay, via the bridge and content.js.
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__greenframe !== 'bridge' || d.type !== 'keyframe') return;
    if (worker) worker.postMessage('keyframe');
    for (const h of legacyHandlers) h.wantKeyframe();
  });

  post({ type: 'hello', version: VERSION, page: location.href,
         mode: hasLegacy ? 'encoded-streams' : worker ? 'transform' : 'none' });
  console.info(TAG, VERSION, 'ready');
}

// GreenFrame's app passes this function to the page (preload.js); the browser extension just runs it.
if (typeof module !== 'undefined' && module.exports) module.exports = greenframeHook;
else greenframeHook();
