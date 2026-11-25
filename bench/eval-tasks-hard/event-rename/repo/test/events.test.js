import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/index.js";

test("handlers receive the payload and the event name", () => {
  const bus = new EventBus();
  const seen = [];
  bus.on("a.b", (payload, name) => seen.push([payload, name]));
  assert.equal(bus.emit("a.b", 1), 1);
  assert.equal(bus.emit("a.c", 2), 0);
  assert.deepEqual(seen, [[1, "a.b"]]);
});

test("entity wildcard and unsubscribe", () => {
  const bus = new EventBus();
  const seen = [];
  const off = bus.on("a.*", (_, name) => seen.push(name));
  bus.emit("a.x");
  bus.emit("b.x");
  off();
  bus.emit("a.y");
  assert.deepEqual(seen, ["a.x"]);
});
