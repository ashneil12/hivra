import vm from "node:vm";

import { HERMES_RUNTIME_CONFIG_BOOTSTRAP } from "../runtime-config-bootstrap";

describe("runtime config bootstrap", () => {
  it("defines CONFIG as a browser global before classic third-party scripts execute", () => {
    const context = vm.createContext({});
    Object.assign(context, { window: context });

    vm.runInContext(HERMES_RUNTIME_CONFIG_BOOTSTRAP, context);

    expect(vm.runInContext("CONFIG", context)).toEqual({});
  });

  it("keeps an existing CONFIG object intact", () => {
    const existingConfig = { release: "existing" };
    const context = vm.createContext({ CONFIG: existingConfig });
    Object.assign(context, { window: context });

    vm.runInContext(HERMES_RUNTIME_CONFIG_BOOTSTRAP, context);

    expect(vm.runInContext("CONFIG", context)).toBe(existingConfig);
  });
});
