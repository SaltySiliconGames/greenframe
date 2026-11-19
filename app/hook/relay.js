// GreenFrame's side of the page (runs in the preload's isolated world): passes messages between the hook in the
// page (inject.js) and GreenFrame's main process, which holds the connection to the bridge (bridge-link.js).
//
// The connection can't be made from here: xbox.com's Content Security Policy (connect-src) applies to this world
// too, and it doesn't allow ws://127.0.0.1:47820. Electron's IPC isn't subject to it.
'use strict';
const { ipcRenderer } = require('electron');

window.addEventListener('message', (e) => {
  const d = e.data;
  if (e.source !== window || !d || d.__greenframe !== 'page') return;
  if (d.type === 'frame') ipcRenderer.send('greenframe', { type: 'frame', buf: d.buf });
  else ipcRenderer.send('greenframe', { type: d.type, codec: d.codec, mode: d.mode, msg: d.msg,
                                        version: d.version, page: d.page });
});

ipcRenderer.on('greenframe-keyframe', () => {
  window.postMessage({ __greenframe: 'bridge', type: 'keyframe' }, '*');
});
