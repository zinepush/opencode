import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { McpCallContext, makeMcpFetch } from "../../src/mcp/index"
import { Plugin } from "../../src/plugin/index"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Layer, Option } from "effect"
import { NpmTest } from "../fake/npm"

const emptyAccount = Layer.mock(Account.Service)({
  active: () => Effect.succeed(Option.none()),
  activeOrg: () => Effect.succeed(Option.none()),
})
const emptyAuth = Layer.mock(Auth.Service)({
  all: () => Effect.succeed({}),
})
const configLayer = Config.layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(emptyAuth),
  Layer.provide(emptyAccount),
  Layer.provide(NpmTest.noop),
)
const it = testEffect(
  Layer.mergeAll(
    Plugin.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(configLayer),
      Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: true })),
    ),
    CrossSpawnSpawner.defaultLayer,
  ),
)

function withProject<A, E, R>(source: string, self: Effect.Effect<A, E, R>) {
  return provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      const file = path.join(dir, "plugin.ts")
      yield* Effect.all(
        [
          Effect.promise(() => Bun.write(file, source)),
          Effect.promise(() =>
            Bun.write(
              path.join(dir, "opencode.json"),
              JSON.stringify(
                {
                  $schema: "https://opencode.ai/config.json",
                  plugin: [pathToFileURL(file).href],
                },
                null,
                2,
              ),
            ),
          ),
        ],
        { discard: true, concurrency: 2 },
      )
      return yield* self
    }),
  )
}

describe("mcp.call.before integration", () => {
  it.live("plugin-supplied headers reach the transport fetch wrapper", () =>
    withProject(
      [
        "export default async () => ({",
        '  "mcp.call.before": async (input, output) => {',
        '    output.headers["x-session-id"] = input.sessionID',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service

        // Static config-style starting headers (already lowercased per Task 5)
        const staticHeaders: Record<string, string> = { authorization: "Bearer T" }
        const output = { headers: { ...staticHeaders } }

        // Fire the hook — the fake plugin will add x-session-id from input.sessionID
        yield* plugin.trigger(
          "mcp.call.before",
          { server: "metrics", tool: "query", sessionID: "sess-1", callID: "call-1" },
          output,
        )

        // Verify the plugin did its job before we test the fetch path
        expect(output.headers["authorization"]).toBe("Bearer T")
        expect(output.headers["x-session-id"]).toBe("sess-1")

        // Drive the resolved headers through makeMcpFetch, just like the
        // real prompt-loop wrap does (Task 5)
        const fetchCalls: Array<RequestInit | undefined> = []
        const stubFetch = async (_url: string | URL, init?: RequestInit) => {
          fetchCalls.push(init)
          return new Response("ok")
        }
        const wrapped = makeMcpFetch(stubFetch)

        yield* Effect.promise(() =>
          McpCallContext.run(
            {
              server: "metrics",
              tool: "query",
              sessionID: "sess-1",
              callID: "call-1",
              headers: output.headers,
            },
            () => wrapped("https://example.com/", { headers: { "x-static-header": "preset" } }),
          ),
        )

        expect(fetchCalls.length).toBe(1)
        expect(fetchCalls[0]?.headers).toEqual({
          authorization: "Bearer T",
          "x-session-id": "sess-1",
          "x-static-header": "preset",
        })
      }),
    ),
  )

  it.live("headers mutated before a plugin throw still reach the transport fetch wrapper", () =>
    withProject(
      [
        "export default async () => ({",
        '  "mcp.call.before": async (_input, output) => {',
        '    output.headers["x-from-plugin"] = "before-throw"',
        '    throw new Error("boom")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service

        const output: { headers: Record<string, string> } = { headers: { authorization: "Bearer T" } }

        // Mirror what prompt.ts does: catchCause so a throwing plugin doesn't
        // propagate and abort the tool call.
        yield* plugin
          .trigger(
            "mcp.call.before",
            { server: "metrics", tool: "query", sessionID: "s", callID: "c" },
            output,
          )
          .pipe(Effect.catchCause(() => Effect.succeed(output)))

        // Whatever the plugin wrote before throwing must still be present
        expect(output.headers["x-from-plugin"]).toBe("before-throw")

        // Drive those headers through makeMcpFetch
        const fetchCalls: Array<RequestInit | undefined> = []
        const stubFetch = async (_url: string | URL, init?: RequestInit) => {
          fetchCalls.push(init)
          return new Response("ok")
        }
        const wrapped = makeMcpFetch(stubFetch)

        yield* Effect.promise(() =>
          McpCallContext.run(
            {
              server: "metrics",
              tool: "query",
              sessionID: "s",
              callID: "c",
              headers: output.headers,
            },
            () => wrapped("https://example.com/", { headers: { "x-static": "yes" } }),
          ),
        )

        expect(fetchCalls.length).toBe(1)
        expect(fetchCalls[0]?.headers).toEqual({
          authorization: "Bearer T",
          "x-from-plugin": "before-throw",
          "x-static": "yes",
        })
      }),
    ),
  )
})
