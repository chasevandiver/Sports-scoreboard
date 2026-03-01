// ─────────────────────────────────────────────
// ESPN PROXY SERVER
// Runs on Replit — fetches ESPN API server-side
// (no CORS issues) and serves the React app.
// ─────────────────────────────────────────────
const express  = require("express");
const https    = require("https");
const path     = require("path");
const app      = express();
const PORT     = process.env.PORT || 3000;

// Serve the React build (index.html + assets)
app.use(express.static(path.join(__dirname, "public")));

// ── ESPN PROXY ENDPOINT ──────────────────────
// iPad calls: /api/espn?path=basketball/nba/scoreboard
// Server fetches ESPN and returns JSON
app.get("/api/espn", (req, res) => {
  const espnPath = req.query.path;
  if (!espnPath) {
    return res.status(400).json({ error: "Missing path param" });
  }

  const url = `https://site.api.espn.com/apis/site/v2/sports/${espnPath}`;
  console.log(`[PROXY] Fetching: ${url}`);

  https.get(url, (espnRes) => {
    let data = "";
    espnRes.on("data", chunk => data += chunk);
    espnRes.on("end", () => {
      try {
        const json = JSON.parse(data);
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "no-cache");
        res.json(json);
        console.log(`[PROXY] ✓ ${espnPath} — ${(data.length/1024).toFixed(1)}kb`);
      } catch (e) {
        console.error("[PROXY] Parse error:", e.message);
        res.status(500).json({ error: "ESPN returned invalid JSON" });
      }
    });
  }).on("error", (e) => {
    console.error("[PROXY] Fetch error:", e.message);
    res.status(502).json({ error: e.message });
  });
});

// All other routes → serve the app
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ Sports scoreboard proxy running on port ${PORT}`);
});
