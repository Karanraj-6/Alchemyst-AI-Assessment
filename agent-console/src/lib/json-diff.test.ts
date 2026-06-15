import assert from "node:assert";
import { test } from "node:test";
import { computeDiff } from "./json-diff";

test("JSON Diff - Identical Objects", () => {
  const oldObj = { a: 1, b: "hello", c: { d: true } };
  const newObj = { a: 1, b: "hello", c: { d: true } };
  
  const result = computeDiff(oldObj, newObj);
  assert.strictEqual(result.entries.length, 0);
  assert.strictEqual(result.addedCount, 0);
  assert.strictEqual(result.removedCount, 0);
  assert.strictEqual(result.changedCount, 0);
});

test("JSON Diff - Flat Key Added, Removed, Changed", () => {
  const oldObj = { a: 1, b: "hello" };
  const newObj = { b: "world", c: true }; // a removed, b changed, c added
  
  const result = computeDiff(oldObj, newObj);
  
  assert.strictEqual(result.addedCount, 1);
  assert.strictEqual(result.removedCount, 1);
  assert.strictEqual(result.changedCount, 1);
  
  const aDiff = result.entries.find((e) => e.path.join(".") === "a");
  const bDiff = result.entries.find((e) => e.path.join(".") === "b");
  const cDiff = result.entries.find((e) => e.path.join(".") === "c");
  
  assert.ok(aDiff && aDiff.kind === "removed" && aDiff.oldValue === 1);
  assert.ok(bDiff && bDiff.kind === "changed" && bDiff.oldValue === "hello" && bDiff.newValue === "world");
  assert.ok(cDiff && cDiff.kind === "added" && cDiff.newValue === true);
});

test("JSON Diff - Nested Objects", () => {
  const oldObj = { user: { name: "John", age: 30 } };
  const newObj = { user: { name: "John", age: 31, email: "john@example.com" } };
  
  const result = computeDiff(oldObj, newObj);
  assert.strictEqual(result.addedCount, 1); // user.email added
  assert.strictEqual(result.removedCount, 0);
  assert.strictEqual(result.changedCount, 1); // user.age changed
  
  const ageDiff = result.entries.find((e) => e.path.join(".") === "user.age");
  const emailDiff = result.entries.find((e) => e.path.join(".") === "user.email");
  
  assert.ok(ageDiff && ageDiff.kind === "changed" && ageDiff.oldValue === 30 && ageDiff.newValue === 31);
  assert.ok(emailDiff && emailDiff.kind === "added" && emailDiff.newValue === "john@example.com");
});

test("JSON Diff - Arrays", () => {
  const oldObj = { list: [10, 20, 30] };
  const newObj = { list: [10, 25] }; // list[1] changed, list[2] removed
  
  const result = computeDiff(oldObj, newObj);
  assert.strictEqual(result.addedCount, 0);
  assert.strictEqual(result.removedCount, 1);
  assert.strictEqual(result.changedCount, 1);
  
  const list1Diff = result.entries.find((e) => e.path.join(".") === "list.1");
  const list2Diff = result.entries.find((e) => e.path.join(".") === "list.2");
  
  assert.ok(list1Diff && list1Diff.kind === "changed" && list1Diff.oldValue === 20 && list1Diff.newValue === 25);
  assert.ok(list2Diff && list2Diff.kind === "removed" && list2Diff.oldValue === 30);
});

test("JSON Diff - Type Changes", () => {
  const oldObj = { value: 42 };
  const newObj = { value: { num: 42 } }; // primitive -> object
  
  const result = computeDiff(oldObj, newObj);
  assert.strictEqual(result.changedCount, 1);
  
  const valDiff = result.entries.find((e) => e.path.join(".") === "value");
  assert.ok(valDiff && valDiff.kind === "changed" && valDiff.oldValue === 42 && typeof valDiff.newValue === "object");
});
