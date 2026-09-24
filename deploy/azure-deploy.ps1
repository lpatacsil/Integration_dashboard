# =============================================================================
# Azure Deployment Script - Integration Monitor Dashboard (PowerShell)
# Uses EXISTING Azure PostgreSQL + existing Azure Web App
# =============================================================================
$ErrorActionPreference = "Stop"

# ── Configuration ────────────────────────────────────────────────────────────
$RESOURCE_GROUP = "rg-app-webdb-fleetmaintenance"
$LOCATION       = "westus3"
$APP_NAME       = "integration-dashboard-erdxhhczasejb4hj"
$ACR_NAME       = "intdashboardacr"

# ── Helper functions ─────────────────────────────────────────────────────────
function Write-Step($step, $msg) { Write-Host "[$step] $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "  OK: $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  WARN: $msg" -ForegroundColor Yellow }

# ── Pre-flight checks ───────────────────────────────────────────────────────
Write-Step "0/6" "Pre-flight checks..."

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI not found. Install from https://aka.ms/installazurecli"
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker not found. Install Docker Desktop first."
}

try { az account show | Out-Null }
catch {
    Write-Warn "Not logged in. Running az login..."
    az login
}

$subscription = az account show --query name -o tsv
Write-OK "Subscription: $subscription"

# ── Collect existing Azure Storage account details ───────────────────────────
Write-Host ""
Write-Host "== Your existing Azure Storage account (Blob Storage) ==" -ForegroundColor Yellow
Write-Host "  (Find this in Azure Portal > your Storage account > Overview)" -ForegroundColor Gray
Write-Host ""

$STORAGE_ACCOUNT_NAME = Read-Host "Storage account name"
$STORAGE_CONTAINER = Read-Host "Blob container name (press Enter for 'teamcentral-logs')"
if ([string]::IsNullOrWhiteSpace($STORAGE_CONTAINER)) { $STORAGE_CONTAINER = "teamcentral-logs" }

if ([string]::IsNullOrWhiteSpace($STORAGE_ACCOUNT_NAME)) { throw "Storage account name is required" }

Write-OK "Will use storage account: $STORAGE_ACCOUNT_NAME"
Write-Warn "Make sure the Web App's managed identity has 'Storage Blob Data Contributor' on $STORAGE_ACCOUNT_NAME (see below)."

# ── Step 1: Verify Resource Group ────────────────────────────────────────────
Write-Step "1/6" "Verifying resource group ($RESOURCE_GROUP)..."
$rgCheck = az group show --name $RESOURCE_GROUP -o json 2>$null
if (-not $rgCheck) { throw "Resource group '$RESOURCE_GROUP' not found. Check the name and your subscription." }
Write-OK "Resource group exists."

# ── Step 2: Container Registry ──────────────────────────────────────────────
Write-Step "2/6" "Setting up Container Registry ($ACR_NAME)..."
$acrExists = az acr show --name $ACR_NAME --resource-group $RESOURCE_GROUP 2>$null
if (-not $acrExists) {
    az acr create --resource-group $RESOURCE_GROUP --name $ACR_NAME --sku Basic --admin-enabled true -o none
    Write-OK "ACR created."
} else {
    Write-OK "ACR already exists."
}

$ACR_LOGIN_SERVER = az acr show --name $ACR_NAME --query loginServer -o tsv

# ── Step 3: Enable managed identity + grant storage access ──────────────────
Write-Step "3/6" "Ensuring Web App managed identity has storage access..."

$PRINCIPAL_ID = az webapp identity assign --resource-group $RESOURCE_GROUP --name $APP_NAME --query principalId -o tsv
Write-OK "Managed identity: $PRINCIPAL_ID"

$STORAGE_ID = az storage account show --name $STORAGE_ACCOUNT_NAME --query id -o tsv 2>$null
if ($STORAGE_ID) {
    az role assignment create `
        --assignee-object-id $PRINCIPAL_ID --assignee-principal-type ServicePrincipal `
        --role "Storage Blob Data Contributor" --scope $STORAGE_ID -o none 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-OK "Granted Storage Blob Data Contributor on $STORAGE_ACCOUNT_NAME"
    } else {
        Write-Warn "Could not grant the role automatically — ask an Owner/User Access Administrator to grant 'Storage Blob Data Contributor' on $STORAGE_ACCOUNT_NAME to principal $PRINCIPAL_ID"
    }
} else {
    Write-Warn "Could not look up storage account '$STORAGE_ACCOUNT_NAME' — grant 'Storage Blob Data Contributor' to principal $PRINCIPAL_ID manually."
}

# ── Step 4: Build & push Docker image ───────────────────────────────────────
Write-Step "4/6" "Building and pushing Docker image..."
az acr login --name $ACR_NAME

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$IMAGE_TAG    = "$ACR_LOGIN_SERVER/integration-dashboard:$timestamp"
$IMAGE_LATEST = "$ACR_LOGIN_SERVER/integration-dashboard:latest"

$projectRoot = Join-Path $PSScriptRoot ".."
docker build -t $IMAGE_TAG -t $IMAGE_LATEST $projectRoot
docker push $IMAGE_TAG
docker push $IMAGE_LATEST
Write-OK "Image pushed: $IMAGE_TAG"

# ── Step 5: Configure Web App ───────────────────────────────────────────────
Write-Step "5/6" "Configuring Web App ($APP_NAME)..."

$ACR_USERNAME = az acr credential show --name $ACR_NAME --query username -o tsv
$ACR_PASSWORD_VAL = az acr credential show --name $ACR_NAME --query "passwords[0].value" -o tsv

az webapp config container set `
    --resource-group $RESOURCE_GROUP `
    --name $APP_NAME `
    --container-image-name $IMAGE_LATEST `
    --container-registry-url "https://$ACR_LOGIN_SERVER" `
    --container-registry-user $ACR_USERNAME `
    --container-registry-password $ACR_PASSWORD_VAL `
    -o none

az webapp config appsettings set `
    --resource-group $RESOURCE_GROUP `
    --name $APP_NAME `
    --settings `
        WEBSITES_PORT=3001 `
        PORT=3001 `
        AZURE_STORAGE_ACCOUNT_NAME="$STORAGE_ACCOUNT_NAME" `
        AZURE_STORAGE_CONTAINER="$STORAGE_CONTAINER" `
        NODE_ENV=production `
    -o none

Write-OK "Web App configured with storage account."

# ── Step 6: Restart & verify ────────────────────────────────────────────────
Write-Step "6/6" "Restarting Web App..."
az webapp restart --resource-group $RESOURCE_GROUP --name $APP_NAME -o none

$APP_URL = "https://$APP_NAME.azurewebsites.net"

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  DEPLOYMENT COMPLETE" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  Dashboard:  $APP_URL" -ForegroundColor White
Write-Host "  Storage:    $STORAGE_ACCOUNT_NAME / $STORAGE_CONTAINER" -ForegroundColor White
Write-Host "  ACR:        $ACR_LOGIN_SERVER" -ForegroundColor White
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "The app will be ready in 1-2 minutes." -ForegroundColor Yellow
Write-Host "View logs:  az webapp log tail --resource-group $RESOURCE_GROUP --name $APP_NAME" -ForegroundColor Yellow
Write-Host "Health check: curl $APP_URL/api/health" -ForegroundColor Yellow
Write-Host ""
Write-Host "NEXT: Set NetSuite & notification env vars with:" -ForegroundColor Yellow
Write-Host "  .\deploy\set-secrets.ps1" -ForegroundColor Yellow
