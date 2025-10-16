const { BrowserWindow } = require('electron');
const crypto = require('crypto');
const { URL } = require('url');

// ESI OAuth Configuration
const ESI_CONFIG = {
  clientId: 'be9837bdb49f4a708d81652e216a7a11',
  callbackUrl: 'http://localhost:3000/callback',
  authorizationUrl: 'https://login.eveonline.com/v2/oauth/authorize',
  tokenUrl: 'https://login.eveonline.com/v2/oauth/token',
  scopes: [
    'esi-industry.read_character_jobs.v1',
    'esi-industry.read_character_mining.v1',
    'esi-markets.read_character_orders.v1',
    'esi-assets.read_assets.v1',
    'esi-characters.read_blueprints.v1',
    'esi-corporations.read_blueprints.v1',
    'esi-wallet.read_character_wallet.v1',
    'esi-universe.read_structures.v1',
    'esi-skills.read_skills.v1',
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
 * @returns {Promise<Object>} Authentication result with character info and tokens
 */
async function authenticateWithESI() {
  return new Promise((resolve, reject) => {
    const state = generateState();
    const { codeVerifier, codeChallenge } = generatePKCE();

    // Build authorization URL
    const authUrl = new URL(ESI_CONFIG.authorizationUrl);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('redirect_uri', ESI_CONFIG.callbackUrl);
    authUrl.searchParams.append('client_id', ESI_CONFIG.clientId);
    authUrl.searchParams.append('scope', ESI_CONFIG.scopes.join(' '));
    authUrl.searchParams.append('code_challenge', codeChallenge);
    authUrl.searchParams.append('code_challenge_method', 'S256');
    authUrl.searchParams.append('state', state);

    // Create auth window
    const authWindow = new BrowserWindow({
      width: 600,
      height: 800,
      show: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
      title: 'Eve Online - Login',
    });

    authWindow.loadURL(authUrl.toString());

    // Prevent navigation to callback URL and handle it instead
    authWindow.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith(ESI_CONFIG.callbackUrl)) {
        event.preventDefault();
        handleCallback(url, state, codeVerifier, authWindow, resolve, reject);
      }
    });

    // Handle redirect
    authWindow.webContents.on('will-redirect', (event, url) => {
      if (url.startsWith(ESI_CONFIG.callbackUrl)) {
        event.preventDefault();
        handleCallback(url, state, codeVerifier, authWindow, resolve, reject);
      }
    });

    // Handle window close
    authWindow.on('closed', () => {
      reject(new Error('Authentication window was closed'));
    });
  });
}

/**
 * Handle the OAuth callback
 */
async function handleCallback(url, expectedState, codeVerifier, authWindow, resolve, reject) {
  const urlObj = new URL(url);

  // Check if this is our callback URL
  if (!url.startsWith(ESI_CONFIG.callbackUrl)) {
    return;
  }

  const code = urlObj.searchParams.get('code');
  const state = urlObj.searchParams.get('state');
  const error = urlObj.searchParams.get('error');

  if (error) {
    authWindow.close();
    reject(new Error(`OAuth error: ${error}`));
    return;
  }

  if (!code || state !== expectedState) {
    authWindow.close();
    reject(new Error('Invalid OAuth response'));
    return;
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await exchangeCodeForToken(code, codeVerifier);

    // Get character information
    const characterInfo = await getCharacterInfo(tokenResponse.access_token);

    authWindow.close();

    resolve({
      ...tokenResponse,
      character: characterInfo,
    });
  } catch (err) {
    authWindow.close();
    reject(err);
  }
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
        'User-Agent': 'Quantum Forge Industry Tool',
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
