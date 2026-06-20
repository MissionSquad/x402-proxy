import { describe, expect, it } from "vitest";

import { createResourceServer } from "../../src/x402Server";

describe("createResourceServer", () => {
  it("creates a server with no facilitator config", () => {
    expect(createResourceServer()).toBeTruthy();
  });

  it("creates a server with a facilitator url", () => {
    expect(createResourceServer("https://facilitator.example.com")).toBeTruthy();
  });

  it("creates a server with a facilitator url and bearer auth", () => {
    expect(createResourceServer("https://facilitator.example.com", "secret-bearer")).toBeTruthy();
  });
});
