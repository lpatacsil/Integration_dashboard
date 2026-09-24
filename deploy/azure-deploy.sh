#!/bin/bash
# =============================================================================
# Azure Deployment Script - Integration Monitor Dashboard
# Uses EXISTING Azure PostgreSQL + existing Azure Web App
# =============================================================================
set -e

# ── Configuration ────────────────────────────────────────────────────────────
RESOURCE_GROUP="rg-app-webdb-fleetmaintenance"
LOCATION="westus3"
APP_NAME="integration-dashboard-erdxhhczasejb4hj"
ACR_NAME="intdashboardacr"

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
step()  { echo -e "${CYAN}[$1]${NC} $2"; }
ok()    { echo -e "${GREEN}  OK:${NC} $1"; }
warn()  { echo -e "${YELLOW}  WARN:${NC} $1"; }
error() { echo -e "${RED}  ERROR:${NC} $1"; exit 1; }

# ── Pre-flight checks ───────────────────────────────────────────────────────
step "0/6" "Pre-flight checks..."
command -v az >/dev/null 2>&1 || error "Azure CLI not found. Install: https://aka.ms/installazurecli"
command -v docker >/dev/null 2>&1 || error "Docker not found. Install Docker Desktop."

az account show >/dev/null 2>&1 || { warn "Not logged in."; az login; }
ok "Subscription: $(az account show --query name -o tsv)"

# ── Collect existing Azure Storage account details ───────────────────────────
echo ""
echo "== Your existing Azure Storage account (Blob Storage) =="
echo "  (Find in Azure Portal > Storage account > Overview)"
echo ""

read -p "Storage account name: " STORAGE_ACCOUNT_NAME
read -p "Blob container name [teamcentral-logs]: " STORAGE_CONTAINER
STORAGE_CONTAINER=${STORAGE_CONTAINER:-teamcentral-logs}

[ -z "$STORAGE_ACCOUNT_NAME" ] && error "Storage account name is required"

ok "Will use storage account: $STORAGE_ACCOUNT_NAME"
warn "Make sure the Web App's managed identity has 'Storage Blob Data Contributor' on $STORAGE_ACCOUNT_NAME (see below)."

# ── Step 1: Resource Group ───────────────────────────────────────────────────
step "1/6" "Ensuring resource group..."
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" -o none 2>/dev/null || true

# ── Step 2: Container Registry ──────────────────────────────────────────────
step "2/6" "Setting up Container Registry ($ACR_NAME)..."
if ! az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az acr create --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --sku Basic --admin-enabled true -o none
  ok "ACR created."
else
  ok "ACR already exists."
fi
ACR_LOGIN_SERVER=$(az acr show --name "$ACR_NAME" --query loginServer -o tsv)

# ── Step 3: Enable managed identity + grant storage access ──────────────────
step "3/6" "Ensuring Web App managed identity has storage access..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

PRINCIPAL_ID=$(az webapp identity assign --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --query principalId -o tsv)
ok "Managed identity: $PRINCIPAL_ID"

STORAGE_ID=$(az storage account show --name "$STORAGE_ACCOUNT_NAME" --query id -o tsv 2>/dev/null || true)
if [ -n "$STORAGE_ID" ]; then
  az role assignment create \
    --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
    --role "Storage Blob Data Contributor" --scope "$STORAGE_ID" -o none 2>/dev/null \
    && ok "Granted Storage Blob Data Contributor on $STORAGE_ACCOUNT_NAME" \
    || warn "Could not grant the role automatically — ask an Owner/User Access Administrator to grant 'Storage Blob Data Contributor' on $STORAGE_ACCOUNT_NAME to principal $PRINCIPAL_ID"
else
  warn "Could not look up storage account '$STORAGE_ACCOUNT_NAME' — grant 'Storage Blob Data Contributor' to principal $PRINCIPAL_ID manually."
fi

# ── Step 4: Build & push Docker image ───────────────────────────────────────
step "4/6" "Building and pushing Docker image..."
az acr login --name "$ACR_NAME"

IMAGE_TAG="$ACR_LOGIN_SERVER/integration-dashboard:$(date +%Y%m%d-%H%M%S)"
IMAGE_LATEST="$ACR_LOGIN_SERVER/integration-dashboard:latest"

docker build -t "$IMAGE_TAG" -t "$IMAGE_LATEST" "$SCRIPT_DIR/.."
docker push "$IMAGE_TAG"
docker push "$IMAGE_LATEST"
ok "Image pushed: $IMAGE_TAG"

# ── Step 5: Configure Web App ───────────────────────────────────────────────
step "5/6" "Configuring Web App ($APP_NAME)..."

ACR_USERNAME=$(az acr credential show --name "$ACR_NAME" --query username -o tsv)
ACR_PASSWORD_VAL=$(az acr credential show --name "$ACR_NAME" --query "passwords[0].value" -o tsv)

az webapp config container set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --container-image-name "$IMAGE_LATEST" \
  --container-registry-url "https://$ACR_LOGIN_SERVER" \
  --container-registry-user "$ACR_USERNAME" \
  --container-registry-password "$ACR_PASSWORD_VAL" \
  -o none

az webapp config appsettings set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --settings \
    WEBSITES_PORT=3001 \
    PORT=3001 \
    AZURE_STORAGE_ACCOUNT_NAME="$STORAGE_ACCOUNT_NAME" \
    AZURE_STORAGE_CONTAINER="$STORAGE_CONTAINER" \
    NODE_ENV=production \
  -o none

ok "Web App configured."

# ── Step 6: Restart ─────────────────────────────────────────────────────────
step "6/6" "Restarting Web App..."
az webapp restart --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" -o none

echo ""
echo "=========================================="
echo "  DEPLOYMENT COMPLETE"
echo "=========================================="
echo "  Dashboard:  https://${APP_NAME}.azurewebsites.net"
echo "  Storage:    $STORAGE_ACCOUNT_NAME / $STORAGE_CONTAINER"
echo "  ACR:        $ACR_LOGIN_SERVER"
echo "=========================================="
echo ""
echo "App will be ready in 1-2 minutes."
echo "View logs: az webapp log tail --resource-group $RESOURCE_GROUP --name $APP_NAME"
