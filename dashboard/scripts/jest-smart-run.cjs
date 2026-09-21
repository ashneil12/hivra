#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const yargsParser = require("yargs-parser");
const jestCliRoot = path.dirname(require.resolve("jest-cli/package.json"));
const { options: jestOptions } = require(path.join(jestCliRoot, "build/args.js"));

function buildParserConfiguration() {
  const alias = {};
  const boolean = [];
  const string = [];
  const array = [];
  const number = [];

  for (const [name, option] of Object.entries(jestOptions)) {
    if (option.alias) {
      alias[name] = option.alias;
    }

    if (option.type === "boolean") {
      boolean.push(name);
      continue;
    }

    if (option.type === "string") {
      string.push(name);
      continue;
    }

    if (option.type === "array") {
      array.push(name);
      continue;
    }

    if (option.type === "number") {
      number.push(name);
    }
  }

  return {
    alias,
    boolean,
    string,
    array,
    number,
    configuration: {
      "camel-case-expansion": true,
      "short-option-groups": true,
      "strip-aliased": false,
      "strip-dashed": false,
    },
  };
}

const parserConfiguration = buildParserConfiguration();

function parseJestArgs(argv) {
  return yargsParser(argv, parserConfiguration);
}

function isConcreteTestPath(arg) {
  if (typeof arg !== "string" || arg.length === 0) {
    return false;
  }

  return (
    arg.includes("/") ||
    arg.includes("\\") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(arg)
  );
}

function pathExists(cwd, targetPath) {
  const resolvedPath = path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(cwd, targetPath);

  return fs.existsSync(resolvedPath);
}

function hasExplicitJestPathMode(parsedArgs) {
  return Boolean(
    parsedArgs.runTestsByPath ||
    parsedArgs.findRelatedTests ||
    parsedArgs.testPathPattern ||
    parsedArgs.testRegex
  );
}

function splitArgSeparator(argv) {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex === -1) {
    return {
      leadingArgs: [...argv],
      trailingArgs: null,
    };
  }

  return {
    leadingArgs: argv.slice(0, separatorIndex),
    trailingArgs: argv.slice(separatorIndex + 1),
  };
}

function shouldForceRunTestsByPath(argv, cwd = process.cwd()) {
  const { leadingArgs, trailingArgs } = splitArgSeparator(argv);
  const parsedArgs = parseJestArgs(trailingArgs ? leadingArgs : argv);
  const positionalArgs = trailingArgs
    ? trailingArgs.map(String)
    : (parsedArgs._ || []).map(String);

  if (positionalArgs.length === 0) {
    return false;
  }

  if (hasExplicitJestPathMode(parsedArgs)) {
    return false;
  }

  if (!positionalArgs.every(isConcreteTestPath)) {
    return false;
  }

  return positionalArgs.some((arg) => pathExists(cwd, arg));
}

function normalizeJestArgs(argv, cwd = process.cwd()) {
  if (!shouldForceRunTestsByPath(argv, cwd)) {
    return argv.filter((arg) => arg !== "--");
  }

  const { leadingArgs, trailingArgs } = splitArgSeparator(argv);
  if (trailingArgs) {
    return [...leadingArgs, "--runTestsByPath", ...trailingArgs];
  }

  return ["--runTestsByPath", ...argv];
}

function run() {
  const inputArgs = process.argv.slice(2);
  const normalizedArgs = normalizeJestArgs(inputArgs, process.cwd());
  const jestBin = require.resolve("jest/bin/jest");

  const result = spawnSync(process.execPath, [jestBin, ...normalizedArgs], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });

  if (typeof result.status === "number") {
    process.exit(result.status);
  }

  process.exit(1);
}

module.exports = {
  normalizeJestArgs,
  parseJestArgs,
  shouldForceRunTestsByPath,
};

if (require.main === module) {
  run();
}
