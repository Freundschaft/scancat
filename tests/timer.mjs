import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const source = fs.readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const code = source.slice(source.indexOf("let timedCapture = null"), source.indexOf("const burstCanvas"));
let now = 0, nextId = 0, captures = 0;
const timers = new Map(), button = { setAttribute() {} };
const ctx = vm.createContext({
  S: { running: true, starting: false, busy: 0, editing: null }, burstState: null,
  $: () => button, setRing() {}, setPill() {}, syncPreparedCapture() {},
  preparedCapture: { cancel() {} }, performance: { now: () => now },
  setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, deadline: now + delay }); return id; },
  clearTimeout: id => timers.delete(id),
  capture: async () => { captures++; return {}; },
});
vm.runInContext(code, ctx);
async function advance(ms) {
  now += ms;
  for (const [id, timer] of timers) if (timer.deadline <= now) { timers.delete(id); await timer.fn(); }
}
vm.runInContext("toggleTimedCapture()", ctx);
await advance(4999);
assert.equal(captures, 0, "must not fire early");
await advance(1);
assert.equal(captures, 1, "must capture at five seconds without waiting for a detected/still page");
vm.runInContext("toggleTimedCapture(); toggleTimedCapture()", ctx);
await advance(6000);
assert.equal(captures, 1, "second press must cancel");
ctx.S.busy = 1;
vm.runInContext("toggleTimedCapture()", ctx);
assert.equal(timers.size, 0, "busy camera must not arm");
console.log("Five-second timer: exact deadline, no stillness requirement, cancellation and busy guard passed.");
