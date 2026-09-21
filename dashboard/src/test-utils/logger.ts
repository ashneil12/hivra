/**
 * Shared logger test double.
 *
 * 108 test files stub `@/lib/logger` with an identical four-method jest.fn()
 * object. This returns the same shape, plus the module object ready for
 * `jest.mock("@/lib/logger", () => createLoggerMock())`.
 */
export interface LoggerMock {
  debug: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
}

export function createLoggerMock(): { log: LoggerMock } {
  return {
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  };
}
