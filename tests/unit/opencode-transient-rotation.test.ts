import { describe, it, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert";
import net from "node:net";
import { OpencodeExecutor } from "../../open-sse/executors/opencode.ts";
import type { ExecutorLog, ProviderCredentials } from "../../open-sse/executors/base.ts";
import { resolveProxyForRequest } from "../../open-sse/utils/proxyFetch.ts";

const log: ExecutorLog = { debug() {}, info() {}, warn() {}, error() {} };

const FP_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FP_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FP_C = "cccccccccccccccccccccccccccccccc";

let serverA: net.Server;
let serverB: net.Server;
let serverC: net.Server;
let portA = 0;
let portB = 0;
let portC = 0;

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

before(async () => {
  serverA = net.createServer((s) => s.destroy());
  serverB = net.createServer((s) => s.destroy());
  serverC = net.createServer((s) => s.destroy());
  portA = await listen(serverA);
  portB = await listen(serverB);
  portC = await listen(serverC);
});

after(() => {
  serverA?.close();
  serverB?.close();
  serverC?.close();
});

function portFor(fp: string): number {
  if (fp === FP_A) return portA;
  if (fp === FP_B) return portB;
  return portC;
}

function credentialsFor(fingerprints: string[]): ProviderCredentials {
  return {
    apiKey: null,
    accessToken: null,
    connectionId: "noauth",
    providerSpecificData: {
      fingerprints,
      accountProxies: fingerprints.map((fp) => ({
        fingerprint: fp,
        proxy: { type: "http", host: "127.0.0.1", port: portFor(fp) },
      })),
    },
  };
}

describe("OpencodeExecutor transient-failure rotation", () => {
  let originalFetch: typeof globalThis.fetch;
  let observed: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    observed = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  class CloneCountingResponse extends Response {
    static clones = 0;
    clone(): Response {
      CloneCountingResponse.clones++;
      return super.clone();
    }
  }

  function installFetch(plan: Array<{ status: number; body?: string }>) {
    let call = 0;
    CloneCountingResponse.clones = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const resolved = resolveProxyForRequest(url);
      observed.push(resolved.proxyUrl ? new URL(resolved.proxyUrl).port : "direct");
      const step = plan[Math.min(call, plan.length - 1)];
      call++;
      return new CloneCountingResponse(step.body ?? JSON.stringify({ ok: step.status === 200 }), {
        status: step.status,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;
  }

  it("rotates past a 500 to the healthy proxy without cooldown", async () => {
    const exec = new OpencodeExecutor("opencode-zen");
    installFetch([{ status: 500 }, { status: 200 }]);

    const result = await exec.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      signal: null,
      credentials: credentialsFor([FP_A, FP_B]),
      log,
    });

    assert.strictEqual((result as { response: Response }).response.status, 200);
    assert.strictEqual(observed.length, 2);
    assert.strictEqual(observed[0], String(portA));
    assert.strictEqual(
      CloneCountingResponse.clones,
      1,
      "only success-path normalize clones; 500 branch reads no body"
    );
  });

  it("rotates on 502/503/504 like on 500", async () => {
    for (const status of [502, 503, 504]) {
      observed = [];
      const exec = new OpencodeExecutor("opencode-zen");
      installFetch([{ status }, { status: 200 }]);

      const result = await exec.execute({
        model: "muse-spark-1.3-contributor-free",
        body: { messages: [{ role: "user", content: "hi" }], stream: false },
        stream: false,
        signal: null,
        credentials: credentialsFor([FP_A, FP_B]),
        log,
      });

      assert.strictEqual(
        (result as { response: Response }).response.status,
        200,
        `status ${status} must rotate`
      );
      assert.strictEqual(observed.length, 2);
    }
  });

  it("single account without proxy stays on fast path on 500 (propagates)", async () => {
    const exec = new OpencodeExecutor("opencode-zen");
    installFetch([{ status: 500 }]);

    const creds = credentialsFor([FP_A]);
    (creds.providerSpecificData as Record<string, unknown>).accountProxies = [];

    const result = await exec.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      signal: null,
      credentials: creds,
      log,
    });

    assert.strictEqual((result as { response: Response }).response.status, 500);
    assert.strictEqual(observed.length, 1);
  });

  it("true mono-direct (no fingerprints) propagates 500 without success mark", async () => {
    const exec = new OpencodeExecutor("opencode-zen");
    installFetch([{ status: 500 }]);

    const creds: ProviderCredentials = {
      apiKey: null,
      accessToken: null,
      connectionId: "noauth",
      providerSpecificData: { fingerprints: [] },
    };

    const result = await exec.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      signal: null,
      credentials: creds,
      log,
    });

    assert.strictEqual((result as { response: Response }).response.status, 500);
    assert.strictEqual(observed.length, 1, "fast path: single call, no loop");
  });

  it("propagates the last 500 after exhausting all proxies", async () => {
    const exec = new OpencodeExecutor("opencode-zen");
    installFetch([{ status: 200 }]);
    await exec.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      signal: null,
      credentials: credentialsFor([FP_A, FP_B, FP_C]),
      log,
    });
    const warm = (
      exec as unknown as { accounts: Array<{ cooldownUntil: number; consecutiveFails: number }> }
    ).accounts;
    assert.strictEqual(warm.length, 3, "warm-up materialized all accounts");
    for (const a of warm) a.consecutiveFails = 2;
    installFetch([{ status: 500 }, { status: 500 }, { status: 500 }]);
    observed = [];

    const result = await exec.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      signal: null,
      credentials: credentialsFor([FP_A, FP_B, FP_C]),
      log,
    });

    assert.strictEqual((result as { response: Response }).response.status, 500);
    assert.strictEqual(observed.length, 3, "every proxy tried exactly once");
    for (const port of [portA, portB, portC]) {
      assert.ok(observed.includes(String(port)), `proxy ${port} tried`);
    }
    const after = (
      exec as unknown as { accounts: Array<{ cooldownUntil: number; consecutiveFails: number }> }
    ).accounts;
    for (const a of after) {
      assert.strictEqual(a.cooldownUntil, 0, "no cooldown from 500 exhaustion");
      assert.strictEqual(a.consecutiveFails, 2, "500 exhaustion never marks success");
    }
  });

  it("never re-touches a proxy tried by either 500 or geo-403", async () => {
    const exec = new OpencodeExecutor("opencode-zen");
    const GEO_BODY = JSON.stringify({
      error: { type: "RegionError", message: "This model is not available in your country." },
    });
    installFetch([
      { status: 500 },
      { status: 403, body: GEO_BODY },
      { status: 200 },
    ]);

    const result = await exec.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      signal: null,
      credentials: credentialsFor([FP_A, FP_B, FP_C]),
      log,
    });

    assert.strictEqual((result as { response: Response }).response.status, 200);
    assert.strictEqual(observed.length, 3);
    assert.strictEqual(
      observed.filter((p) => p === String(portA)).length,
      1,
      "500-tried proxy A called exactly once"
    );
  });

  it("a 429 still cools down while a 500 rotates cleanly", async () => {
    const exec = new OpencodeExecutor("opencode-zen");
    installFetch([{ status: 500 }, { status: 429 }, { status: 200 }]);

    const result = await exec.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      signal: null,
      credentials: credentialsFor([FP_A, FP_B, FP_C]),
      log,
    });

    assert.strictEqual((result as { response: Response }).response.status, 200);
    assert.strictEqual(observed.length, 3);
    const state = (exec as unknown as { accounts: Array<{ cooldownUntil: number }> }).accounts;
    const cooled = state.filter((a) => a.cooldownUntil > Date.now());
    assert.strictEqual(cooled.length, 1, "exactly the 429 account cooled down");
  });

  it("single proxied account: one retry on 500, then last surfaces", async () => {
    const exec = new OpencodeExecutor("opencode-zen");
    const creds = credentialsFor([FP_A]);
    installFetch([{ status: 500 }, { status: 500 }]);

    const result = await exec.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      signal: null,
      credentials: creds,
      log,
    });

    assert.strictEqual((result as { response: Response }).response.status, 500);
    assert.strictEqual(observed.length, 2, "one retry via the mono budget, then stop");
  });

  it("500 rotation never cools the account down", async () => {
    const exec2 = new OpencodeExecutor("opencode-zen");
    installFetch([{ status: 200 }]);
    await exec2.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      signal: null,
      credentials: credentialsFor([FP_A, FP_B]),
      log,
    });
    const mid = (exec2 as unknown as { accounts: Array<{ cooldownUntil: number; consecutiveFails: number }> }).accounts;
    assert.strictEqual(mid.length, 2, "warm-up materialized both accounts");
    for (const a of mid) a.consecutiveFails = 2;
    installFetch([{ status: 500 }, { status: 200 }]);
    await exec2.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      signal: null,
      credentials: credentialsFor([FP_A, FP_B]),
      log,
    });
    const after = (exec2 as unknown as { accounts: Array<{ cooldownUntil: number; consecutiveFails: number }> }).accounts;
    for (const a of after) {
      assert.strictEqual(a.cooldownUntil, 0, "no cooldown from 500 rotation");
    }
    assert.strictEqual(
      after.filter((a) => a.consecutiveFails === 0).length,
      1,
      "exactly the winning account resets via markSuccess"
    );
    assert.strictEqual(
      after.filter((a) => a.consecutiveFails === 2).length,
      after.length - 1,
      "blocked accounts keep prior fails"
    );
  });

  it("a 500 on the last-resort direct attempt surfaces cleanly", async () => {
    const exec = new OpencodeExecutor("opencode-zen");
    const creds = credentialsFor([FP_A, FP_B]);
    (creds.providerSpecificData as Record<string, unknown>).accountProxies = [
      { fingerprint: FP_A, proxy: { type: "http", host: "127.0.0.1", port: portA } },
    ];
    installFetch([{ status: 500 }, { status: 500 }]);

    const result = await exec.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      signal: null,
      credentials: creds,
      log,
    });

    assert.strictEqual((result as { response: Response }).response.status, 500);
    assert.strictEqual(observed.length, 2, "one proxied + one direct, direct last");
    assert.strictEqual(observed[0], String(portA));
    assert.strictEqual(observed[1], "direct");
  });
});
