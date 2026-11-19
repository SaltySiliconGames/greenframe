// Runs in every xbox.com frame before the page's scripts: puts the WebRTC hook (hook/inject.js) into the page's own
// JavaScript world, and runs the relay (hook/relay.js) here, in GreenFrame's isolated world, where it sends the
// frames to the bridge.
'use strict';
const { contextBridge, webFrame } = require('electron');

const PAGE_HOSTS = /(^|\.)xbox\.com$/i;

if (PAGE_HOSTS.test(location.hostname) || (process.env.GREENFRAME_URL && location.hostname === 'localhost')) {
  const hook = require('./hook/inject.js');
  if (contextBridge.executeInMainWorld) {
    // Synchronous, so the hook is in place before the page makes its RTCPeerConnection.
    contextBridge.executeInMainWorld({ func: hook });
  } else {
    webFrame.executeJavaScript(`(${hook.toString()})()`);
  }
  require('./hook/relay.js');
}
