require("dotenv").config();
const axios = require("axios");
const { WebClient } = require("@slack/web-api");

// Battery thresholds
const CRITICAL_BATTERY_THRESHOLD = 20;
const WARNING_BATTERY_THRESHOLD = 30;

// Initialize Slack client
const slackToken = process.env.SLACK_BOT_TOKEN;
const slackChannel = process.env.SLACK_CHANNEL_ID;
const slackClient = new WebClient(slackToken);

// Centralized logger
function logError(context, error) {
  if (error.response) {
    console.error(`[${context}] Request failed`, {
      status: error.response.status,
      data: error.response.data,
    });
  } else {
    console.error(`[${context}]`, error.message || error);
  }
}

async function sendSlackAlert(unhealthyRoutes) {
  const messageText =
    `DSL Route Health Check\nUnhealthy routes detected:\n` +
    unhealthyRoutes
      .map(
        (r) =>
          `• ${r.name} (${r.phone_number}): ${r.issues.join(", ")}`
      )
      .join("\n");

  try {
    await slackClient.chat.postMessage({
      channel: slackChannel,
      text: messageText,
    });
    console.log("Slack alert sent successfully.");
  } catch (err) {
    logError("Slack Notification Error", err);
  }
}

async function testTelerivetRoutes() {
  try {
    const apiKey = process.env.TELERIVET_API_KEY;
    const projectId = process.env.TELERIVET_PROJECT_ID;

    if (!apiKey || !projectId) {
      console.error("Missing TELERIVET_API_KEY or TELERIVET_PROJECT_ID environment variables.");
      process.exit(1);
    }

    const url = `https://api.telerivet.com/v1/projects/${projectId}/phones`;
    console.log(`Calling Telerivet API: ${url}`);

    let response;

    try {
      response = await axios.get(url, {
        auth: { username: apiKey, password: "" },
        timeout: 15000,
      });
    } catch (err) {
      logError("Telerivet API Error", err);
      return;
    }

    const routes = Array.isArray(response.data.data) ? response.data.data : [];
    console.log(`Total routes found: ${routes.length}`);

    const unhealthyRoutes = [];
    const now = Date.now();

    for (const r of routes) {
      const issues = [];

      // 1. Always flag if last_active_time is greater than 0
      if (!r.last_active_time) {
        issues.push("Never reported active");
      } else {
        const lastActiveMs = r.last_active_time * 1000;
        const minutesAgo = (now - lastActiveMs) / 60000;

        if (minutesAgo > 1) {
          issues.push(`Last active ${minutesAgo.toFixed(1)} minutes ago`);
        }
      }

      // 2. Battery checks
      if (typeof r.battery === "number") {
        if (r.battery < CRITICAL_BATTERY_THRESHOLD) {
          issues.push(`Critical battery level (${r.battery}%)`);
        } else if (r.battery < WARNING_BATTERY_THRESHOLD && r.charging === false) {
          issues.push(`Battery low and not charging (${r.battery}%)`);
        }
      }

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
          issues,
        });
      }
    }

    console.log("\n====================================");
    console.log("ROUTE HEALTH SUMMARY");
    console.log("====================================");

    if (unhealthyRoutes.length === 0) {
      console.log("All routes are healthy.");
      return;
    }

    console.log(`Unhealthy routes: ${unhealthyRoutes.length}`);
    console.log(JSON.stringify(unhealthyRoutes, null, 2));

    await sendSlackAlert(unhealthyRoutes);
  } catch (err) {
    logError("Unexpected Error", err);
  }
}

// Execute the test
testTelerivetRoutes();
