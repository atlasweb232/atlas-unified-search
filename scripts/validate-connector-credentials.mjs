import { loadConfig } from '../src/config.js';
import { createConnectorRegistry } from '../src/connectors/index.js';

const sources = list('VALIDATE_CONNECTOR_SOURCES') || ['slack', 'google_drive', 'data_fabric'];
const requireConfigured = truthy(process.env.VALIDATE_CONNECTOR_REQUIRE_CONFIG);
const probeLimit = positiveInt(process.env.VALIDATE_CONNECTOR_PROBE_LIMIT, 3);

const config = loadConfig();
const registry = createConnectorRegistry(config);
const report = {
  generatedAt: new Date().toISOString(),
  requireConfigured,
  sources: [],
};

for (const source of sources) {
  const connector = registry.get(source);
  const readiness = (await registry.readiness(source))[0];
  const item = {
    source,
    configured: readiness.configured,
    ready: readiness.ready,
    status: readiness.status,
    missing: readiness.requirements?.filter((requirement) => !requirement.configured && !requirement.optional).map((requirement) => requirement.name) || [],
    details: safeDetails(readiness.details || {}),
    probes: [],
  };

  if (!readiness.configured) {
    item.ok = !requireConfigured;
    report.sources.push(item);
    continue;
  }

  if (!readiness.ready) {
    item.ok = false;
    item.error = readiness.error || readiness.status;
    report.sources.push(item);
    continue;
  }

  item.probes = await sourceProbes({ source, connector, config, probeLimit });
  item.ok = item.probes.every((probe) => probe.ok);
  report.sources.push(item);
}

report.ok = report.sources.every((item) => item.ok);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);

async function sourceProbes({ source, connector, config, probeLimit }) {
  if (source === 'slack') return slackProbes(connector, config.slack.channelIds.slice(0, probeLimit));
  if (source === 'google_drive') return googleDriveProbes(connector);
  if (source === 'data_fabric') return dataFabricProbes(connector);
  return [{ name: 'readiness', ok: true }];
}

async function slackProbes(connector, channelIds) {
  const probes = [];
  for (const channelId of channelIds) {
    try {
      const history = await connector.call('conversations.history', { channel: channelId, limit: '1' });
      probes.push({
        name: 'slack_channel_history',
        ok: true,
        channelId,
        sampleMessageVisible: Boolean(history.messages?.length),
      });
    } catch (error) {
      probes.push({
        name: 'slack_channel_history',
        ok: false,
        channelId,
        error: error.message,
      });
    }
  }
  return probes.length ? probes : [{ name: 'slack_channel_history', ok: false, error: 'No channel IDs configured' }];
}

async function googleDriveProbes(connector) {
  try {
    const drive = (await import('googleapis')).google.drive({ version: 'v3', auth: await connector.auth() });
    const files = await connector.listFiles(drive, { limit: 1, folderIds: connector.config.folderIds });
    return [{
      name: 'google_drive_file_list',
      ok: true,
      folderScoped: Boolean(connector.config.folderIds.length),
      sampleFileVisible: Boolean(files.length),
    }];
  } catch (error) {
    return [{ name: 'google_drive_file_list', ok: false, error: error.message }];
  }
}

async function dataFabricProbes(connector) {
  try {
    const readiness = await connector.checkReadiness();
    return [{ name: 'data_fabric_readiness', ok: readiness.ready, status: readiness.status }];
  } catch (error) {
    return [{ name: 'data_fabric_readiness', ok: false, error: error.message }];
  }
}

function safeDetails(details) {
  return JSON.parse(JSON.stringify(details, (key, value) => (
    /token|secret|password|credential/i.test(key) ? '[REDACTED]' : value
  )));
}

function list(name) {
  const values = String(process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length ? values : null;
}

function truthy(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
