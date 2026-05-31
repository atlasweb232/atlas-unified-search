# Azure Deployment

Default target:

- resource group: `atlas-azure-backend-rg`
- ACR: `atlasbackend2ba6c25e`
- Container Apps environment: `atlas-desktop-aca-env`
- app: `atlas-unified-search`

Deploy:

```bash
chmod +x infrastructure/azure/deploy-containerapp.sh
./infrastructure/azure/deploy-containerapp.sh
```

Production secrets should be set after creation:

```bash
az containerapp secret set \
  --resource-group atlas-azure-backend-rg \
  --name atlas-unified-search \
  --secrets \
    slack-bot-token='<xoxb-token>' \
    google-client-id='<id>' \
    google-client-secret='<secret>' \
    google-refresh-token='<token>' \
    openai-api-key='<key>'

az containerapp update \
  --resource-group atlas-azure-backend-rg \
  --name atlas-unified-search \
  --set-env-vars \
    SLACK_BOT_TOKEN=secretref:slack-bot-token \
    GOOGLE_CLIENT_ID=secretref:google-client-id \
    GOOGLE_CLIENT_SECRET=secretref:google-client-secret \
    GOOGLE_REFRESH_TOKEN=secretref:google-refresh-token \
    OPENAI_API_KEY=secretref:openai-api-key
```

For production-grade vector storage, replace the current JSON store with
Postgres + pgvector before using this for real customer data.
