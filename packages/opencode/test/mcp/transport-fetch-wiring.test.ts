import { describe, expect, mock, beforeEach } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const transportFetchOptions: Array<{ type: "streamable" | "sse"; fetch?: unknown }> = []

void mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    constructor(_url: URL, options: { fetch?: unknown }) {
      transportFetchOptions.push({ type: "streamable", fetch: options?.fetch })
    }
    async start() {
      throw new Error("Mock transport cannot connect")
    }
  },
}))

void mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(_url: URL, options: { fetch?: unknown }) {
      transportFetchOptions.push({ type: "sse", fetch: options?.fetch })
    }
    async start() {
      throw new Error("Mock transport cannot connect")
    }
  },
}))

beforeEach(() => {
  transportFetchOptions.length = 0
})

const { MCP } = await import("../../src/mcp/index")
const it = testEffect(LayerNode.compile(MCP.node))

describe("mcp transport fetch wiring", () => {
  it.instance("both StreamableHTTP and SSE transports receive a fetch wrapper", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp
        .add("test-server", { type: "remote", url: "https://example.com/mcp", headers: { Authorization: "Bearer T" } })
        .pipe(Effect.catch(() => Effect.void))
      expect(transportFetchOptions.length).toBeGreaterThanOrEqual(2)
      for (const call of transportFetchOptions) {
        expect(typeof call.fetch).toBe("function")
      }
    }),
  )
})
