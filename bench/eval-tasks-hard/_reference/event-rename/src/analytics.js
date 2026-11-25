// Events counted per entity: the event name is "<entity>.<verb>".
const TRACKED = { order: ["placed", "shipped", "cancelled"] };

export function createAnalytics(bus) {
  const counts = {};
  for (const [entity, verbs] of Object.entries(TRACKED)) {
    for (const verb of verbs) {
      const name = `${entity}.${verb}`;
      counts[name] = 0;
      bus.on(name, () => {
        counts[name] += 1;
      });
    }
  }
  return {
    count: (name) => counts[name] ?? 0,
    snapshot: () => ({ ...counts }),
  };
}
