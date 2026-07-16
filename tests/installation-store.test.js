import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { InstallationStore } from '../src/installationStore.js';

function config(dataDir) {
  return {
    dataDir,
    connectorCredentialEncryptionKey: 'test-encryption-key',
    identity: { jwtSecret: '' },
    auth: { token: '' },
    postgres: { connectionString: '', ssl: false },
  };
}

test('installation credentials persist encrypted and survive restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atlas-installations-'));
  try {
    const first = new InstallationStore(config(dir));
    await first.load();
    await first.upsert({
      source: 'slack',
      providerTeamId: 'T123',
      tenantId: 'slack:T123',
      userId: 'U123',
      credentials: { botToken: 'xoxb-secret', channelIds: ['C1'] },
    });

    const raw = await readFile(path.join(dir, 'installations.json'), 'utf8');
    assert.doesNotMatch(raw, /xoxb-secret/);

    const restarted = new InstallationStore(config(dir));
    await restarted.load();
    assert.deepEqual(
      restarted.credentialsFor('slack', { tenantId: 'slack:T123', userId: 'U123' }),
      { botToken: 'xoxb-secret', channelIds: ['C1'] },
    );
    assert.equal(restarted.byProviderTeam('slack', 'T123').tenantId, 'slack:T123');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('connector event claims are idempotent and releasable after failure', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atlas-events-'));
  try {
    const store = new InstallationStore(config(dir));
    await store.load();
    const event = {
      eventId: 'Ev123',
      source: 'slack',
      providerTeamId: 'T123',
      tenantId: 'slack:T123',
      userId: 'U123',
    };
    assert.equal((await store.claimEvent(event)).claimed, true);
    assert.equal((await store.claimEvent(event)).claimed, false);
    await store.releaseEvent(event.eventId);
    assert.equal((await store.claimEvent(event)).claimed, true);
    await store.markEventJob(event.eventId, 'job-123');
    await store.markEventOutcome('job-123', 'completed');
    assert.equal(store.eventById(event.eventId).status, 'completed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
