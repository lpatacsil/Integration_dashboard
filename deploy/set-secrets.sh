#!/bin/bash
# =============================================================================
# Set additional secrets/env vars on the Azure Web App
# Run this after azure-deploy.sh to configure NetSuite & notification settings
# =============================================================================
set -e

RESOURCE_GROUP="rg-app-webdb-fleetmaintenance"
APP_NAME="integration-dashboard-erdxhhczasejb4hj"

echo "Setting additional app settings..."
echo "Leave blank to skip a setting."
echo ""

read -p "NETSUITE_ACCOUNT_ID: " NETSUITE_ACCOUNT_ID
read -p "NETSUITE_CONSUMER_KEY: " NETSUITE_CONSUMER_KEY
read -s -p "NETSUITE_CONSUMER_SECRET: " NETSUITE_CONSUMER_SECRET; echo
read -p "NETSUITE_TOKEN_ID: " NETSUITE_TOKEN_ID
read -s -p "NETSUITE_TOKEN_SECRET: " NETSUITE_TOKEN_SECRET; echo
read -p "TEAMS_WEBHOOK_URL: " TEAMS_WEBHOOK_URL
read -p "SMTP_HOST (e.g. smtp.office365.com): " SMTP_HOST
read -p "SMTP_PORT (default 587): " SMTP_PORT
read -p "SMTP_USER: " SMTP_USER
read -s -p "SMTP_PASS: " SMTP_PASS; echo
read -p "SMTP_FROM: " SMTP_FROM

SETTINGS=""
[ -n "$NETSUITE_ACCOUNT_ID" ]     && SETTINGS="$SETTINGS NETSUITE_ACCOUNT_ID=$NETSUITE_ACCOUNT_ID"
[ -n "$NETSUITE_CONSUMER_KEY" ]   && SETTINGS="$SETTINGS NETSUITE_CONSUMER_KEY=$NETSUITE_CONSUMER_KEY"
[ -n "$NETSUITE_CONSUMER_SECRET" ] && SETTINGS="$SETTINGS NETSUITE_CONSUMER_SECRET=$NETSUITE_CONSUMER_SECRET"
[ -n "$NETSUITE_TOKEN_ID" ]       && SETTINGS="$SETTINGS NETSUITE_TOKEN_ID=$NETSUITE_TOKEN_ID"
[ -n "$NETSUITE_TOKEN_SECRET" ]   && SETTINGS="$SETTINGS NETSUITE_TOKEN_SECRET=$NETSUITE_TOKEN_SECRET"
[ -n "$TEAMS_WEBHOOK_URL" ]       && SETTINGS="$SETTINGS TEAMS_WEBHOOK_URL=$TEAMS_WEBHOOK_URL"
[ -n "$SMTP_HOST" ]               && SETTINGS="$SETTINGS SMTP_HOST=$SMTP_HOST"
[ -n "$SMTP_PORT" ]               && SETTINGS="$SETTINGS SMTP_PORT=${SMTP_PORT:-587}"
[ -n "$SMTP_USER" ]               && SETTINGS="$SETTINGS SMTP_USER=$SMTP_USER"
[ -n "$SMTP_PASS" ]               && SETTINGS="$SETTINGS SMTP_PASS=$SMTP_PASS"
[ -n "$SMTP_FROM" ]               && SETTINGS="$SETTINGS SMTP_FROM=$SMTP_FROM"

if [ -n "$SETTINGS" ]; then
  az webapp config appsettings set \
    --resource-group "$RESOURCE_GROUP" \
    --name "$APP_NAME" \
    --settings $SETTINGS \
    -o none
  echo ""
  echo "Settings updated. Restarting app..."
  az webapp restart --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" -o none
  echo "Done."
else
  echo "No settings provided. Nothing to update."
fi
