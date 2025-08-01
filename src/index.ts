import {
  type AgentSessionEventWebhookPayload,
  LinearWebhooks,
} from "@linear/sdk";
import {
  handleOAuthAuthorize,
  handleOAuthCallback,
  getOAuthToken,
} from "./lib/oauth";
import { AgentClient } from "./lib/agent/agentClient";

/**
 * This Cloudflare worker handles all requests for the demo agent.
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Weather bot says hello! 🌤️", { status: 200 });
    }

    // Handle OAuth authorize route
    if (url.pathname === "/oauth/authorize") {
      return handleOAuthAuthorize(request, env);
    }

    // Handle OAuth callback route
    if (url.pathname === "/oauth/callback") {
      return handleOAuthCallback(request, env);
    }

    // Handle webhook route
    if (url.pathname === "/webhook" && request.method === "POST") {
      console.log("[WEBHOOK] POST request received to /webhook");
      
      // Check for required environment variables
      if (!env.LINEAR_WEBHOOK_SECRET) {
        console.error("[WEBHOOK] LINEAR_WEBHOOK_SECRET not configured");
        return new Response("Webhook secret not configured", { status: 500 });
      }
      console.log("[WEBHOOK] LINEAR_WEBHOOK_SECRET is configured");

      if (!env.OPENAI_API_KEY) {
        console.error("[WEBHOOK] OPENAI_API_KEY not configured");
        return new Response("OpenAI API key not configured", { status: 500 });
      }
      console.log("[WEBHOOK] OPENAI_API_KEY is configured");

      try {
        // Verify that the webhook is valid and of a type we need to handle
        console.log("[WEBHOOK] Reading request body");
        const text = await request.text();
        console.log("[WEBHOOK] Request body length:", text.length);
        
        const payloadBuffer = Buffer.from(text);
        const linearSignature = request.headers.get("linear-signature") || "";
        console.log("[WEBHOOK] Linear signature present:", !!linearSignature);
        
        // Log all headers for debugging
        console.log("[WEBHOOK] Request headers:");
        request.headers.forEach((value, key) => {
          console.log(`[WEBHOOK] Header ${key}: ${value.substring(0, 50)}${value.length > 50 ? '...' : ''}`);
        });
        
        console.log("[WEBHOOK] Attempting to parse webhook payload");
        const linearWebhooks = new LinearWebhooks(env.LINEAR_WEBHOOK_SECRET);
        
        try {
          const parsedPayload = linearWebhooks.parseData(
            payloadBuffer,
            linearSignature
          );
          
          console.log("[WEBHOOK] Successfully parsed payload, type:", parsedPayload.type);

          if (parsedPayload.type !== "AgentSessionEvent") {
            console.log("[WEBHOOK] Ignoring non-AgentSessionEvent webhook");
            return new Response("Webhook received (non-agent event)", { status: 200 });
          }

          console.log("[WEBHOOK] Processing AgentSessionEvent");
          const webhook = parsedPayload as AgentSessionEventWebhookPayload;
          console.log("[WEBHOOK] Organization ID:", webhook.organizationId);
          console.log("[WEBHOOK] Agent Session ID:", webhook.agentSession.id);
          
          console.log("[WEBHOOK] Getting OAuth token");
          const token = await getOAuthToken(env, webhook.organizationId);
          if (!token) {
            console.error("[WEBHOOK] OAuth token not found for organization:", webhook.organizationId);
            return new Response("Linear OAuth token not found", { status: 500 });
          }
          console.log("[WEBHOOK] OAuth token retrieved successfully");

          // Use waitUntil to ensure async processing completes
          console.log("[WEBHOOK] Calling handleWebhook asynchronously");
          ctx.waitUntil(
            this.handleWebhook(webhook, token, env.OPENAI_API_KEY).catch(
              (error: unknown) => {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error("[WEBHOOK] Error in handleWebhook:", errorMessage);
                console.error("[WEBHOOK] Error details:", error);
                return new Response(`Error handling webhook: ${errorMessage}`, { status: 500 });
              }
            )
          );

          // Return immediately to prevent timeout
          console.log("[WEBHOOK] Returning success response");
          return new Response("Webhook handled", { status: 200 });
        } catch (parseError) {
          const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
          console.error("[WEBHOOK] Failed to parse webhook payload:", errorMessage);
          console.error("[WEBHOOK] Parse error details:", parseError);
          return new Response(`Error parsing webhook: ${errorMessage}`, { status: 500 });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("[WEBHOOK] Unhandled error processing webhook:", errorMessage);
        console.error("[WEBHOOK] Error details:", error);
        return new Response(`Error handling webhook: ${errorMessage}`, { status: 500 });
      }
    }

    return new Response("OK", { status: 200 });
  },

  /**
   * Handle a Linear webhook asynchronously (for non-blocking processing).
   * @param webhook The agent session event webhook payload.
   * @param linearAccessToken The Linear access token.
   * @param openaiApiKey The OpenAI API key.
   * @returns A promise that resolves when the webhook is handled.
   */
  async handleWebhook(
    webhook: AgentSessionEventWebhookPayload,
    linearAccessToken: string,
    openaiApiKey: string
  ): Promise<void> {
    console.log("[HANDLE_WEBHOOK] Starting webhook processing");
    try {
      console.log("[HANDLE_WEBHOOK] Creating AgentClient");
      const agentClient = new AgentClient(linearAccessToken, openaiApiKey);
      
      console.log("[HANDLE_WEBHOOK] Generating user prompt");
      const userPrompt = this.generateUserPrompt(webhook);
      console.log("[HANDLE_WEBHOOK] User prompt generated, length:", userPrompt.length);
      
      console.log("[HANDLE_WEBHOOK] Calling handleUserPrompt for session:", webhook.agentSession.id);
      await agentClient.handleUserPrompt(webhook.agentSession.id, userPrompt);
      console.log("[HANDLE_WEBHOOK] Successfully processed webhook");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[HANDLE_WEBHOOK] Error processing webhook:", errorMessage);
      console.error("[HANDLE_WEBHOOK] Error details:", error);
      throw error; // Re-throw to be caught by the caller
    }
  },

  /**
   * Generate a user prompt for the agent based on the webhook payload.
   * Modify this as needed if you want to give the agent more context by querying additional APIs.
   *
   * @param webhook The webhook payload.
   * @returns The user prompt.
   */
  generateUserPrompt(webhook: AgentSessionEventWebhookPayload): string {
    const issueTitle = webhook.agentSession.issue?.title;
    const commentBody = webhook.agentSession.comment?.body;
    if (issueTitle && commentBody) {
      return `Issue: ${issueTitle}\n\nTask: ${commentBody}`;
    } else if (issueTitle) {
      return `Task: ${issueTitle}`;
    } else if (commentBody) {
      return `Task: ${commentBody}`;
    }
    return "";
  },
};
