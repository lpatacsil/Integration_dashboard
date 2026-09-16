import crypto from 'node:crypto';

export interface NetSuiteCredentials {
  accountId: string;
  consumerKey: string;
  consumerSecret: string;
  tokenId: string;
  tokenSecret: string;
}

export function loadCredentials(): NetSuiteCredentials {
  const accountId = process.env.NETSUITE_ACCOUNT_ID || '';
  const consumerKey = process.env.NETSUITE_CONSUMER_KEY || '';
  const consumerSecret = process.env.NETSUITE_CONSUMER_SECRET || '';
  const tokenId = process.env.NETSUITE_TOKEN_ID || '';
  const tokenSecret = process.env.NETSUITE_TOKEN_SECRET || '';

  return { accountId, consumerKey, consumerSecret, tokenId, tokenSecret };
}

export function isConfigured(): boolean {
  const creds = loadCredentials();
  return !!(
    creds.accountId &&
    creds.consumerKey &&
    creds.consumerSecret &&
    creds.tokenId &&
    creds.tokenSecret
  );
}

/**
 * Build the base URL for NetSuite REST API calls.
 * Account IDs with underscores (sandbox, e.g. "1234567_SB1") use dashes in the hostname.
 */
function buildBaseUrl(accountId: string): string {
  const host = accountId.toLowerCase().replace(/_/g, '-');
  return `https://${host}.suitetalk.api.netsuite.com`;
}

/**
 * Percent-encode per RFC 5849 §3.6 (OAuth 1.0 encoding).
 */
function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Generate an OAuth 1.0 Authorization header using HMAC-SHA256 signing.
 */
export function generateAuthHeader(
  method: string,
  url: string,
  creds: NetSuiteCredentials,
): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: timestamp,
    oauth_token: creds.tokenId,
    oauth_version: '1.0',
  };

  // Parse the URL to separate base URL from any query parameters
  const parsedUrl = new URL(url);
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;

  // Merge query params with oauth params
  const allParams: Record<string, string> = { ...oauthParams };
  parsedUrl.searchParams.forEach((value, key) => {
    allParams[key] = value;
  });

  // Sort and build parameter string
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join('&');

  // Signature base string
  const signatureBase = [
    method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(paramString),
  ].join('&');

  // Signing key
  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.tokenSecret)}`;

  // HMAC-SHA256 signature
  const signature = crypto
    .createHmac('sha256', signingKey)
    .update(signatureBase)
    .digest('base64');

  oauthParams['oauth_signature'] = signature;

  // Build Authorization header
  const headerParts = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(', ');

  return `OAuth realm="${creds.accountId}", ${headerParts}`;
}

/**
 * Get the base URL for a given account.
 */
export function getBaseUrl(): string {
  const creds = loadCredentials();
  return buildBaseUrl(creds.accountId);
}
