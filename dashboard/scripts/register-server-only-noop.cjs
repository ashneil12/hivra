const Module = require("module");
const path = require("path");

require("dotenv").config({
  path: path.join(process.cwd(), ".env.local"),
  quiet: true,
});

const originalLoad = Module._load;

Module._load = function loadWithServerOnlyNoop(request, parent, isMain) {
  if (request === "server-only" || request.endsWith("/server-only") || request.includes("server-only/index")) {
    return {};
  }

  return originalLoad.call(this, request, parent, isMain);
};
