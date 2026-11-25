const OPS = ["get", "set", "has", "delete"];

// Runs the operations one after the other against the store and returns one result per operation.
export async function applyOps(store, ops) {
  const results = [];
  for (const op of ops) {
    if (!OPS.includes(op.type)) throw new Error(`Unknown op: ${op.type}`);
    results.push(await store[op.type](...op.args));
  }
  return results;
}
