import { expect, test } from "bun:test";
import { judge, parseEndpoint, pidAlive } from "../tools/endpoint";

const ep = { port: 59703, token: "t", pid: 100 };

test("parseEndpoint takes a well-formed file and refuses the rest", () => {
  expect(parseEndpoint({ port: 1, token: "x", pid: 5 })).toEqual({ port: 1, token: "x", pid: 5 });
  expect(parseEndpoint({ port: 1, token: "x" })).toEqual({ port: 1, token: "x" });
  expect(parseEndpoint({ port: "1", token: "x" })).toBeNull();
  expect(parseEndpoint({ port: 1, token: "" })).toBeNull();
  expect(parseEndpoint(null)).toBeNull();
  expect(parseEndpoint({ port: 1, token: "x", pid: -3 })).toEqual({ port: 1, token: "x" });
});

test("a dead pid is stale whatever the port says", () => {
  expect(judge(ep, false, null).kind).toBe("dead");
  /* even if something answers as Volery — it is not the writer */
  expect(judge(ep, false, 100).kind).toBe("dead");
});

test("a live pid is trusted only when /health names the same pid", () => {
  expect(judge(ep, true, 100)).toEqual({ kind: "live" });
  expect(judge(ep, true, 200).kind).toBe("unconfirmed");
  expect(judge(ep, true, null).kind).toBe("unconfirmed");
});

test("a file with no pid is confirmed by /health alone", () => {
  const old = { port: 1, token: "t" };
  expect(judge(old, null, 77).kind).toBe("live");
  expect(judge(old, null, null).kind).toBe("unconfirmed");
});

test("pidAlive sees this process and not an impossible one", () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(2 ** 22 + 12345)).toBe(false);
});
