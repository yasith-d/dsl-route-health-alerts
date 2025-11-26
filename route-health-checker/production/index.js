const functions = require('@google-cloud/functions-framework');
const axios = require("axios");
const { Pool } = require("pg");
const crypto = require("crypto");
const { WebClient } = require("@slack/web-api");
const routeOwners = require("./routeOwners.json");

const API_KEY = process.env.TELERIVET_API_KEY;
const PROJECT_ID = process.env.TELERIVET_PROJECT_ID;

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 5432,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

// Battery thresholds
const CRITICAL_BATTERY_THRESHOLD = 20;
const WARNING_BATTERY_THRESHOLD = 30;

// Slack client
const slackClient = new WebClient(SLACK_BOT_TOKEN);

// --- Centralized logger ---
function logError(context, error) {
  if (!error) {
    console.error(`[${context}] Unknown error`);
    return;
  }
  if (error.response) {
    console.error(`[${context}] Request failed`, {
      status: error.response.status,
      data: error.response.data,
    });
  } else {
    console.error(`[${context}]`, error.message || error);
  }
}

// --- Persist unhealthy routes to DB ---
async function storeUnhealthyRoutes(unhealthyRoutes, runId) {
  if (!Array.isArray(unhealthyRoutes) || unhealthyRoutes.length === 0) return;

  const client = await pool.connect();
  try {
    const query = `
      INSERT INTO unhealthy_routes_log (
        run_id, route_id, route_name, phone_number, country,
        app_version, battery, charging, last_active_time, issues
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `;

    for (const r of unhealthyRoutes) {
      // In case route id is null by telerivet, put uuid for tracing purposes
      const safeRouteId = r.id ?? `unknown-${crypto.randomUUID()}`;

      const values = [
        runId,
        safeRouteId,
        r.name || null,
        r.phone_number || null,
        r.country || null,
        r.app_version || null,
        typeof r.battery === "number" ? r.battery : null,
        typeof r.charging === "boolean" ? r.charging : null,
        typeof r.last_active_time === "number" ? r.last_active_time : null,
        JSON.stringify(r.issues ?? [])
      ];

      try {
        await client.query(query, values);
      } catch (err) {
        logError("DB Insert Error (single route)", err);
        // continue inserting others
      }
    }
  } catch (err) {
    logError("DB Insert Error (outer)", err);
  } finally {
    client.release();
  }
}

// --- Send Slack alert ---
async function sendSlackAlert(unhealthyRoutes, runId) {
  if (!slackClient || !SLACK_CHANNEL_ID) {
    console.warn("Slack not configured - skipping Slack alert");
    return;
  }

  const header = `DSL Route Health Check — run_id: ${runId}\nUnhealthy routes detected:\n`;
  const body = unhealthyRoutes
    .map((r) => {
      const slackId = routeOwners[r.name];   // lookup Slack ID
      const mention = slackId ? `<@${slackId}> ` : "";
      return `• ${mention}${r.name || r.id} (${r.phone_number || "unknown"}): ${r.issues.join(", ")}`;
    })
    .join("\n");

  const messageText = header + body;

  try {
    await slackClient.chat.postMessage({
      channel: SLACK_CHANNEL_ID,
      text: messageText,
    });
    console.log("Slack alert sent successfully.");
  } catch (err) {
    logError("Slack Notification Error", err);
  }
}

// === Entry point ===
functions.http('monitorDSLRoutes', async (req, res) => {
  const url = `https://api.telerivet.com/v1/projects/${PROJECT_ID}/phones`;
  const runId = crypto.randomUUID(); // generate per cloud function execution

  console.log("\n====================================");
  console.log(`Run ID ${runId} started`);
  console.log("====================================");
  console.log(`Calling Telerivet API: ${url}`);

  try {
    let response;
    try {
      response = await axios.get(url, {
        auth: { username: API_KEY, password: "" },
        timeout: 15000,
      });
    } catch (err) {
      logError("Telerivet API Error", err);
      // respond 502 to indicate upstream failure
      return res.status(502).json({ error: "Failed to fetch Telerivet routes" });
    }

    const allRoutes = Array.isArray(response.data.data) ? response.data.data : [];

    // Filter only DSL-managed mobile routes using defined route variable
    const routes = allRoutes.filter(r => r.vars?.dsl_managed === true);
    console.log(`Total DSL routes found: ${routes.length}`);

    const unhealthyRoutes = [];
    const now = Date.now();

    // Loop through all DSL routes and find issues
    for (const r of routes) {
      const issues = [];

      // Last active time is NOT internet connectivity status
      // Connection / last active: if missing -> never reported active
      if (!r.last_active_time) {
        issues.push("Never reported active");
      } else {
        const lastActiveMs = r.last_active_time * 1000;
        const minutesAgo = (now - lastActiveMs) / 60000;

        // we treat any lag > 1 minute as noteworthy
        if (minutesAgo > 1) {
          issues.push(`Last active ${minutesAgo.toFixed(1)} minutes ago`);
        }
      }

      // Battery checks
      if (typeof r.battery === "number") {
        if (r.battery < CRITICAL_BATTERY_THRESHOLD) {
          issues.push(`Critical battery level (${r.battery}%)`);
        } else if (r.battery < WARNING_BATTERY_THRESHOLD && r.charging === false) {
          issues.push(`Battery low and not charging (${r.battery}%)`);
        }
      }

      // If any issues found, add to the list with metadata
      if (issues.length > 0) {
        unhealthyRoutes.push({
          id: r.id,
          name: r.name,
          phone_number: r.phone_number,
          country: r.country,
          app_version: r.app_version,
          battery: r.battery,
          charging: r.charging,
          last_active_time: r.last_active_time,
          issues
        });
      }
    }

    console.log("Route health summary for run ID: " + runId);

    if (unhealthyRoutes.length === 0) {
      console.log("All routes are healthy.");
      return res.status(200).json({
        status: "ok",
        total_routes: routes.length,
        unhealthy_count: 0
      });
    }

    console.log(`Unhealthy routes: ${unhealthyRoutes.length}`);
    console.log(JSON.stringify(unhealthyRoutes, null, 2));

    // Persist into DB and then notify Slack
    try {
      await storeUnhealthyRoutes(unhealthyRoutes, runId);
    } catch (err) {
      logError("storeUnhealthyRoutes failed", err);
      // continue to attempt Slack notification even if DB save had issues
    }

    try {
      await sendSlackAlert(unhealthyRoutes, runId);
    } catch (err) {
      logError("sendSlackAlert failed", err);
    }

    return res.status(200).json({
      status: "ok",
      run_id: runId,
      total_routes: routes.length,
      unhealthy_count: unhealthyRoutes.length,
      unhealthy_routes: unhealthyRoutes
    });

  } catch (err) {
    logError("Unexpected Error", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});
