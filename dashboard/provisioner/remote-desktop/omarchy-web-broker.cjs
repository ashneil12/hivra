'use strict';

// The shared Selkies broker deliberately targets loopback. Omarchy keeps its
// compositor and capture container separate, so translate only that sealed
// upstream connection onto their private Docker network.
const http = require('node:http');
const originalRequest = http.request;
http.request = function omarchyRequest(options, ...rest) {
  if (options && options.hostname === '127.0.0.1' && Number(options.port) === 8080) {
    options = { ...options, hostname: 'hivra-omarchy-web' };
  }
  return originalRequest.call(this, options, ...rest);
};

module.exports = require('./broker.cjs');
