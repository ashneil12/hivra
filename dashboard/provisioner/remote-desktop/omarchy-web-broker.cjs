'use strict';

// The shared Selkies broker dials its capture upstream on loopback.
//
// This file used to translate that loopback address onto the stream container's
// Docker network name, because the broker ran on its own bridge and could not
// reach the guest's loopback. That is no longer the layout and the translation
// must not come back: install-omarchy-web.py publishes the stream on this
// guest's loopback and runs the broker in the guest's network namespace so it
// reaches that loopback directly. Rewriting the address away from loopback
// sends every session to an address the stream does not serve, the broker hangs
// waiting for a reply, and the desktop fails with a 502 instead of rendering.
//
// Kept as the lane's entry point so the installer, the unit files and the
// pinned digests keep their shape.
module.exports = require('./broker.cjs');
