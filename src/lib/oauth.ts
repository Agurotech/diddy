import { OAuthTokenResponse } from "./types";

const OAUTH_TOKEN_KEY_PREFIX = "linear_oauth_token_";

/**
 * Generate a workspace-specific key for storing OAuth tokens
 * @param workspaceId - The Linear workspace ID
 * @returns The storage key
 */
function getWorkspaceTokenKey(workspaceId: string): string {
  return `${OAUTH_TOKEN_KEY_PREFIX}${workspaceId}`;
}

/**
 * Handles the OAuth authorization request.
 * Redirects the user to Linear's OAuth authorization page.
 * @param request - The request object.
 * @param env - The environment variables.
 * @returns A response object.
 */
export function handleOAuthAuthorize(request: Request, env: Env): Response {
  const scope = "read,write,app:assignable,app:mentionable";

  const authUrl = new URL("https://linear.app/oauth/authorize");
  authUrl.searchParams.set("client_id", env.LINEAR_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", `${env.WORKER_URL}/oauth/callback`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("actor", "app");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
    },
  });
}

/**
 * Handles the OAuth callback from Linear by exchanging the authorization code for an access token and storing it.
 * @param request - The request object.
 * @param env - The environment variables.
 * @returns A response object.
 */
export async function handleOAuthCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(`OAuth Error: ${error}`, { status: 400 });
  }

  if (!code) {
    return new Response("Missing required OAuth parameters", { status: 400 });
  }

  try {
    // Exchange authorization code for access token
    const tokenResponse = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: env.LINEAR_CLIENT_ID,
        client_secret: env.LINEAR_CLIENT_SECRET,
        code,
        redirect_uri: `${env.WORKER_URL}/oauth/callback`,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      return new Response(`Token exchange failed: ${errorText}`, {
        status: 400,
      });
    }

    const tokenData = (await tokenResponse.json()) as OAuthTokenResponse;

    // Get workspace information using the access token
    const workspaceInfo = await getWorkspaceInfo(tokenData.access_token);

    // Store the token with workspace-specific key
    await setOAuthToken(env, tokenData.access_token, workspaceInfo.id);

    return new Response(
      `
      <html>
        <head><title>OAuth Success</title></head>
        <body>
          <h1>OAuth Authorization Successful!</h1>
          <p>Access token received and stored securely for workspace: <strong>${workspaceInfo.name}</strong></p>
          <p>You can now interact with weather bot!</p>
        </body>
      </html>
    `,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html",
        },
      }
    );
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    return new Response(`Token exchange error: ${errorMessage}`, {
      status: 500,
    });
  }
}

/**
 * Retrieves the stored OAuth token for a specific workspace.
 * This implementation uses a KV namespace to store the token.
 * @param env - The environment variables.
 * @param workspaceId - The Linear workspace ID (optional, will try to find any token if not provided)
 * @returns The OAuth token.
 */
export async function getOAuthToken(
  env: Env,
  workspaceId: string
): Promise<string | null> {
  if (!env.DIDDY_TOKENS) {
    return null;
  }

  if (workspaceId) {
    // Get token for specific workspace
    const key = getWorkspaceTokenKey(workspaceId);
    return await env.DIDDY_TOKENS.get(key);
  } else {
    // Try to find any stored token (for backward compatibility)
    // List all keys with our prefix and get the first one
    const keys = await env.DIDDY_TOKENS.list({
      prefix: OAUTH_TOKEN_KEY_PREFIX,
    });
    if (keys.keys.length > 0) {
      return await env.DIDDY_TOKENS.get(keys.keys[0].name);
    }
    return null;
  }
}

/**
 * Stores the OAuth token for a specific workspace.
 * This implementation uses a KV namespace to store the token.
 * @param env - The environment variables.
 * @param token - The OAuth token.
 * @param workspaceId - The Linear workspace ID.
 */
export async function setOAuthToken(
  env: Env,
  token: string,
  workspaceId: string
): Promise<void> {
  const key = getWorkspaceTokenKey(workspaceId);
  await env.DIDDY_TOKENS.put(key, token);
}

/**
 * Checks if OAuth token exists for a specific workspace.
 * @param env - The environment variables.
 * @param workspaceId - The Linear workspace ID (optional, will check for any token if not provided)
 * @returns True if the OAuth token exists, false otherwise.
 */
export async function hasOAuthToken(
  env: Env,
  workspaceId: string
): Promise<boolean> {
  const token = await getOAuthToken(env, workspaceId);
  return token !== null;
}

/**
 * Get the workspace information from Linear using the access token
 * @param accessToken - The Linear access token
 * @returns The workspace information
 */
async function getWorkspaceInfo(
  accessToken: string
): Promise<{ id: string; name: string }> {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: `
        query {
          viewer {
            organization {
              id
              name
            }
          }
        }
      `,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get workspace info: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    data?: {
      viewer?: {
        organization?: {
          id: string;
          name: string;
        };
      };
    };
  };

  const organization = data.data?.viewer?.organization;

  if (!organization) {
    throw new Error("No organization found in response");
  }

  return {
    id: organization.id,
    name: organization.name,
  };
}
