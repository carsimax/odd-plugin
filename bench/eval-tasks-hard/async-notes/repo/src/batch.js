const OPS = ["get", "set", "has", "delete"];

// Runs the operations in order against the store and returns one result per operation.
export function applyOps(store, ops) {
  return ops.map((op) => {
    if (!OPS.includes(op.type)) throw new Error(`Unknown op: ${op.type}`);
    return store[op.type](...op.args);
  });
}
