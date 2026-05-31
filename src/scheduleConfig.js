const DEFAULT_MIN_INTERVAL_SECONDS = 300;

export function parseSyncSchedules(raw, { minIntervalSeconds = DEFAULT_MIN_INTERVAL_SECONDS } = {}) {
  if (!raw) return [];
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`UNIFIED_SEARCH_SYNC_SCHEDULES must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(value)) {
    throw new Error('UNIFIED_SEARCH_SYNC_SCHEDULES must be a JSON array');
  }
  return value
    .map((item, index) => normalizeSchedule(item, index, minIntervalSeconds))
    .filter((item) => item.enabled);
}

export function summarizeSchedules(schedules) {
  return schedules.map((item) => ({
    name: item.name,
    source: item.source,
    tenantId: item.tenantId,
    userId: item.userId,
    everySeconds: item.everySeconds,
    runOnStart: item.runOnStart,
    reindex: item.reindex,
  }));
}

function normalizeSchedule(item, index, minIntervalSeconds) {
  if (!item || typeof item !== 'object') throw new Error(`schedule[${index}] must be an object`);
  const source = stringField(item, 'source', index);
  const tenantId = stringField(item, 'tenantId', index);
  const userId = stringField(item, 'userId', index);
  const everySeconds = Number(item.everySeconds || item.intervalSeconds || item.interval || 0);
  if (!Number.isFinite(everySeconds) || everySeconds < minIntervalSeconds) {
    throw new Error(`schedule[${index}].everySeconds must be at least ${minIntervalSeconds}`);
  }
  return {
    name: item.name || `${tenantId}:${userId}:${source}`,
    source,
    tenantId,
    userId,
    everySeconds,
    options: item.options && typeof item.options === 'object' ? item.options : {},
    enabled: item.enabled !== false,
    runOnStart: item.runOnStart !== false,
    reindex: Boolean(item.reindex),
  };
}

function stringField(item, field, index) {
  const value = item[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`schedule[${index}].${field} is required`);
  }
  return value.trim();
}
