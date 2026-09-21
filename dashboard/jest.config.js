/** @type {import('jest').Config} */
const config = {
  preset: "ts-jest",
  testEnvironment: "node",
  cacheDirectory: "<rootDir>/.jest-cache",
  moduleNameMapper: {
    // Keep asset aliases ahead of the @/ source alias. Otherwise an imported
    // @/components/foo.module.css path is resolved to the raw stylesheet
    // before Jest gets a chance to apply the style mock.
    "\\.(css|less|scss|sass)$": "<rootDir>/__mocks__/styleMock.js",
    "^@/(.*)$": "<rootDir>/src/$1"
  },
  testMatch: [
    "**/__tests__/**/*.test.ts",
    "**/__tests__/**/*.test.tsx",
  ],
  roots: [
    "<rootDir>/src",
    "<rootDir>/__tests__",
  ],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.tsx"],
  // Clear mock.calls / mock.results between tests so test:ci's
  // --runInBand serial run doesn't bleed call history from one test
  // into the next. Without this, mocks declared at module scope
  // (e.g. `jest.mock("@/lib/x", () => ({ fn: jest.fn() }))`) accumulate
  // calls across the whole file, and a later test's
  // `expect(fn).toHaveBeenCalledWith(...)` matches against an earlier
  // test's call instead of its own — making which test "fails first"
  // dependent on test ordering. clearMocks preserves
  // `mockImplementation` / `mockReturnValue` so existing per-test
  // setup keeps working; only the call ledger gets wiped.
  clearMocks: true,
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        // Use the built-in TS compiler, not babel, for Node 25 compatibility
        useESM: false,
        tsconfig: {
          module: "commonjs",
          esModuleInterop: true,
          jsx: "react-jsx",
          strict: false,
        },
      },
    ],
  },
  collectCoverageFrom: [
    "src/lib/**/*.ts",
    "src/app/api/**/*.ts",
    "!src/**/*.d.ts",
  ],
  modulePathIgnorePatterns: [
    "<rootDir>/.next/",
    "<rootDir>/coverage/",
    "<rootDir>/.jest-cache/",
    "<rootDir>/node_modules.broken-",
  ],
  testPathIgnorePatterns: [
    "/node_modules/",
    "<rootDir>/.next/",
    "<rootDir>/coverage/",
    "<rootDir>/.jest-cache/",
    "<rootDir>/node_modules.broken-",
  ],
  watchPathIgnorePatterns: [
    "<rootDir>/.next/",
    "<rootDir>/coverage/",
    "<rootDir>/.jest-cache/",
    "<rootDir>/node_modules.broken-",
  ],
};

module.exports = config;
