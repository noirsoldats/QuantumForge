const { shell } = require('electron');
const crypto = require('crypto');
const { URL } = require('url');
const http = require('http');
const { getUserAgent } = require('./user-agent');

// ESI OAuth Configuration
const ESI_CONFIG = {
  clientId: 'be9837bdb49f4a708d81652e216a7a11',
  callbackUrl: 'http://localhost:42069/callback',
  authorizationUrl: 'https://login.eveonline.com/v2/oauth/authorize',
  tokenUrl: 'https://login.eveonline.com/v2/oauth/token',
  scopes: [
    'esi-industry.read_character_jobs.v1',
    'esi-industry.read_corporation_jobs.v1',
    'esi-industry.read_character_mining.v1',
    'esi-markets.read_character_orders.v1',
    'esi-assets.read_assets.v1',
    'esi-assets.read_corporation_assets.v1',
    'esi-characters.read_blueprints.v1',
    'esi-corporations.read_blueprints.v1',
    'esi-wallet.read_character_wallet.v1',
    'esi-universe.read_structures.v1',
    'esi-skills.read_skills.v1',
    'esi-corporations.read_divisions.v1',
  ],
};

/**
 * Generate a random state parameter for OAuth
 */
function generateState() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  return { codeVerifier, codeChallenge };
}

/**
 * Start the ESI authentication flow
 * Opens the authorization URL in the system browser and starts a temporary local server
 * @returns {Promise<Object>} Authentication result with character info and tokens
 */
async function authenticateWithESI() {
  return new Promise((resolve, reject) => {
    const state = generateState();
    const { codeVerifier, codeChallenge } = generatePKCE();
    let server = null;
    let serverTimeout = null;

    // Build authorization URL
    const authUrl = new URL(ESI_CONFIG.authorizationUrl);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('redirect_uri', ESI_CONFIG.callbackUrl);
    authUrl.searchParams.append('client_id', ESI_CONFIG.clientId);
    authUrl.searchParams.append('scope', ESI_CONFIG.scopes.join(' '));
    authUrl.searchParams.append('code_challenge', codeChallenge);
    authUrl.searchParams.append('code_challenge_method', 'S256');
    authUrl.searchParams.append('state', state);

    // Create temporary HTTP server to receive callback
    server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url, ESI_CONFIG.callbackUrl);

      // Only handle the callback path
      if (reqUrl.pathname === '/callback') {
        const code = reqUrl.searchParams.get('code');
        const receivedState = reqUrl.searchParams.get('state');
        const error = reqUrl.searchParams.get('error');

        // Send response to browser
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
              <head>
                <title>Authentication Failed</title>
                <style>
                  body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                  .error { color: #d32f2f; }
                </style>
              </head>
              <body>
                <h1 class="error">Authentication Failed</h1>
                <p>Error: ${error}</p>
                <p>You can close this window and try again.</p>
              </body>
            </html>
          `);
          cleanup();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code || receivedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
              <head>
                <title>Authentication Failed</title>
                <style>
                  body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                  .error { color: #d32f2f; }
                </style>
              </head>
              <body>
                <h1 class="error">Authentication Failed</h1>
                <p>Invalid OAuth response. Please try again.</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          cleanup();
          reject(new Error('Invalid OAuth response'));
          return;
        }

        // Send success response to browser first
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Authentication Successful</title>
              <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                .success { color: #388e3c; }
              </style>
            </head>
            <body>
              <h1 class="success">Authentication Successful!</h1>
              <p>You have successfully authenticated with Eve Online.</p>
              <p>You can close this window and return to Quantum Forge.</p>
            </body>
          </html>
        `);

        // Process the callback asynchronously
        try {
          // Exchange code for tokens
          const tokenResponse = await exchangeCodeForToken(code, codeVerifier);

          // Get character information
          const characterInfo = await getCharacterInfo(tokenResponse.access_token);

          cleanup();
          resolve({
            ...tokenResponse,
            character: characterInfo,
          });
        } catch (err) {
          cleanup();
          reject(err);
        }
      } else {
        // Handle unknown paths
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });

    // Cleanup function to close server and clear timeout
    const cleanup = () => {
      if (serverTimeout) {
        clearTimeout(serverTimeout);
        serverTimeout = null;
      }
      if (server) {
        server.close();
        server = null;
      }
    };

    // Start server
    server.listen(42069, 'localhost', () => {
      console.log('OAuth callback server listening on http://localhost:42069');

      // Open the authorization URL in the default browser
      shell.openExternal(authUrl.toString()).catch(err => {
        cleanup();
        reject(new Error(`Failed to open browser: ${err.message}`));
      });

      // Set timeout for authentication (5 minutes)
      serverTimeout = setTimeout(() => {
        cleanup();
        reject(new Error('Authentication timeout - no response received within 5 minutes'));
      }, 5 * 60 * 1000);
    });

    // Handle server errors
    server.on('error', (err) => {
      cleanup();
      reject(new Error(`Server error: ${err.message}`));
    });
  });
}

/**
 * Exchange authorization code for access token
 */
async function exchangeCodeForToken(code, codeVerifier) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    client_id: ESI_CONFIG.clientId,
    code_verifier: codeVerifier,
  });

  const response = await fetch(ESI_CONFIG.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Host': 'login.eveonline.com',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${errorText}`);
  }

  const data = await response.json();

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    token_type: data.token_type,
    expires_at: Date.now() + (data.expires_in * 1000),
  };
}

/**
 * Get character information from access token
 */
async function getCharacterInfo(accessToken) {
  // Verify token and get character ID
  const verifyResponse = await fetch('https://login.eveonline.com/oauth/verify', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!verifyResponse.ok) {
    throw new Error('Failed to verify token');
  }

  const verifyData = await verifyResponse.json();

  // Get character details from ESI
  const characterResponse = await fetch(
    `https://esi.evetech.net/latest/characters/${verifyData.CharacterID}/?datasource=tranquility`,
    {
      headers: {
        'User-Agent': getUserAgent(),
      },
    }
  );

  if (!characterResponse.ok) {
    throw new Error('Failed to get character details');
  }

  const characterData = await characterResponse.json();

  return {
    characterId: verifyData.CharacterID,
    characterName: verifyData.CharacterName,
    corporationId: characterData.corporation_id,
    allianceId: characterData.alliance_id,
    scopes: verifyData.Scopes ? verifyData.Scopes.split(' ') : [],
    portrait: `https://images.evetech.net/characters/${verifyData.CharacterID}/portrait`,
  };
}

/**
 * Refresh an expired access token
 */
async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: ESI_CONFIG.clientId,
  });

  const response = await fetch(ESI_CONFIG.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Host': 'login.eveonline.com',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: ${errorText}`);
  }

  const data = await response.json();

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    token_type: data.token_type,
    expires_at: Date.now() + (data.expires_in * 1000),
  };
}

/**
 * Check if a token is expired or about to expire
 */
function isTokenExpired(expiresAt) {
  // Consider expired if less than 5 minutes remaining
  return Date.now() >= (expiresAt - 5 * 60 * 1000);
}

module.exports = {
  authenticateWithESI,
  refreshAccessToken,
  isTokenExpired,
  ESI_CONFIG,
};
