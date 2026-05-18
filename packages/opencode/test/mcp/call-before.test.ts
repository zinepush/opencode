import { describe, expect, test } from "bun:test"
import { McpCallContext } from "../../src/mcp/index"

describe("McpCallContext", () => {
  test("getStore returns undefined outside run scope", () => {
    expect(McpCallContext.getStore()).toBeUndefined()
  })

  test("getStore returns the store inside run scope", () => {
    const captured = McpCallContext.run(
      {
        server: "s",
        tool: "t",
        sessionID: "sess",
        callID: "call",
        headers: { "X-Foo": "1" },
      },
      () => McpCallContext.getStore(),
    )
    expect(captured).toEqual({
      server: "s",
      tool: "t",
      sessionID: "sess",
      callID: "call",
      headers: { "X-Foo": "1" },
    })
  })

  test("concurrent run scopes do not leak between callbacks", async () => {
    const seen: Array<string | undefined> = []
    await Promise.all([
      McpCallContext.run(
        { server: "a", tool: "t", sessionID: "s", callID: "c-a", headers: {} },
        async () => {
          await new Promise((r) => setTimeout(r, 5))
          seen.push(McpCallContext.getStore()?.callID)
        },
      ),
      McpCallContext.run(
        { server: "b", tool: "t", sessionID: "s", callID: "c-b", headers: {} },
        async () => {
          seen.push(McpCallContext.getStore()?.callID)
          await new Promise((r) => setTimeout(r, 1))
        },
      ),
    ])
    expect(new Set(seen)).toEqual(new Set(["c-a", "c-b"]))
    expect(McpCallContext.getStore()).toBeUndefined()
  })
})

describe("MCP.tools metadata", () => {
  test("each tool carries __mcp = { server, tool }", async () => {
    const { convertMcpTool } = await import("../../src/mcp/index")
    const fakeClient = { callTool: async () => ({ content: [] }) } as any
    const wrapped = convertMcpTool(
      { name: "query", description: "", inputSchema: { type: "object" } } as any,
      "metrics",
      fakeClient,
      5000,
    )
    expect((wrapped as any).__mcp).toEqual({ server: "metrics", tool: "query" })
  })
})
