export class AssistantActionService {
  constructor({ store, chatProvider, artifactProvider }) {
    this.store = store;
    this.chatProvider = chatProvider;
    this.artifactProvider = artifactProvider;
  }

  async run({ tenantId, userId, searchRunId, actionType, selectedResultIds = [], prompt = '', provider = '' }) {
    const run = this.store.getSearchRun(searchRunId);
    if (!run || run.tenantId !== tenantId || run.userId !== userId) {
      throw new Error('Search run not found');
    }
    const selected = (run.results || []).filter((result) => selectedResultIds.includes(result.id) || selectedResultIds.includes(result.documentId));
    if (!selected.length) throw new Error('At least one accessible search result must be selected');
    const createAction = async () => {
      const action = this.store.createAssistantAction({ tenantId, userId, searchRunId, actionType, selectedResultIds, prompt, provider: provider || this.chatProvider.name });
      this.store.audit({ eventType: 'assistant_action_start', tenantId, userId, metadata: { actionId: action.id, actionType, selectedCount: selected.length } });
      await this.store.save();
      return action;
    };
    const action = typeof this.store.withStoreLock === 'function'
      ? await this.store.withStoreLock(createAction)
      : await createAction();
    try {
      this.store.updateAssistantAction(action.id, { tenantId, userId, searchRunId, actionType, selectedResultIds, prompt, provider: provider || this.chatProvider.name, status: 'running' });
      let response;
      try {
        response = await this.chatProvider.generate({ tenantId, userId, actionType, prompt, contextResults: selected });
      } catch (error) {
        if (actionType !== 'summarize') throw error;
        response = localSummary(selected);
      }
      const artifactIds = [];
      if (actionType === 'create_powerpoint' || actionType === 'create_pdf') {
        const artifact = await this.artifactProvider.create({
          type: actionType,
          title: actionType === 'create_powerpoint' ? 'Unified Search Presentation' : 'Unified Search Report',
          sections: [{ heading: 'Generated Content', body: response.text, citations: response.citations?.map((citation) => citation.resultId) || [] }],
          provenanceResultIds: selected.map((result) => result.id),
        });
        const stored = this.store.createArtifact({ tenantId, userId, actionJobId: action.id, type: actionType, title: artifact.artifactId, storageUri: artifact.storageUri, downloadUrl: artifact.downloadUrl, provenanceResultIds: selected.map((result) => result.id), metadata: artifact });
        artifactIds.push(stored.id);
      }
      const completeAction = async () => {
        const updated = this.store.updateAssistantAction(action.id, {
          tenantId,
          userId,
          searchRunId,
          actionType,
          selectedResultIds,
          prompt,
          provider: provider || this.chatProvider.name,
          status: 'completed',
          responseText: response.text,
          artifactIds,
          completedAt: new Date().toISOString(),
          citations: response.citations || [],
        });
        this.store.audit({ eventType: 'assistant_action_complete', tenantId, userId, metadata: { actionId: action.id, actionType, artifactIds } });
        await this.store.save();
        return updated;
      };
      return typeof this.store.withStoreLock === 'function'
        ? await this.store.withStoreLock(completeAction)
        : await completeAction();
    } catch (error) {
      const failAction = async () => {
        const updated = this.store.updateAssistantAction(action.id, {
          tenantId,
          userId,
          searchRunId,
          actionType,
          selectedResultIds,
          prompt,
          provider: provider || this.chatProvider.name,
          status: 'failed',
          error: error.message,
          completedAt: new Date().toISOString(),
        });
        this.store.audit({ eventType: 'assistant_action_failed', tenantId, userId, metadata: { actionId: action.id, actionType, error: error.message } });
        await this.store.save();
        return updated;
      };
      return typeof this.store.withStoreLock === 'function'
        ? await this.store.withStoreLock(failAction)
        : await failAction();
    }
  }
}

function localSummary(results) {
  const lines = results.slice(0, 10).map((result, index) => (
    `${index + 1}. ${result.oneLine || result.title || result.body || 'Untitled result'}`
  ));
  return {
    text: `Summary generated from ${results.length} retrieved result(s).\n\n${lines.join('\n')}`,
    citations: results.map((result) => ({ resultId: result.id, documentId: result.documentId })),
    degraded: true,
  };
}
