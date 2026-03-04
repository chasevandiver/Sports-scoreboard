// ─────────────────────────────────────────────
// ESPN PROXY SERVER  v2
// Streams ESPN responses directly to the client
// instead of buffering in RAM — prevents OOM
// crashes on large CBB payloads.
// ─────────────────────────────────────────────
const express = require("express");
const https   = require("https");
const path    = require("path");
const app     = express();
const PORT    = process.env.PORT || 3000;

// Scoreboard requests stay small; game summaries include pitch-by-pitch data
// for baseball which can reach 5-8 MB, so use a generous cap there.
const SCOREBOARD_MAX = 1.5 * 1024 * 1024; //  1.5 MB — scoreboard / CBB lists
const SUMMARY_MAX    = 10  * 1024 * 1024; // 10   MB — per-game summaries

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/espn", (req, res) => {
  const espnPath = req.query.path;
  if (!espnPath) return res.status(400).json({ error: "Missing path param" });

  const isSummary = espnPath.includes("summary");
  const MAX_RESPONSE_BYTES = isSummary ? SUMMARY_MAX : SCOREBOARD_MAX;

  const url = "https://site.api.espn.com/apis/site/v2/sports/" + espnPath;
  console.log("[PROXY] →", espnPath);

  const request = https.get(url, (espnRes) => {
    // Stream headers straight through
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache");

    let bytesSeen = 0;
    let aborted   = false;

    espnRes.on("data", (chunk) => {
      bytesSeen += chunk.length;
      if (bytesSeen > MAX_RESPONSE_BYTES) {
        aborted = true;
        espnRes.destroy();
        console.warn("[PROXY] ✗ TOO LARGE:", espnPath, Math.round(bytesSeen/1024)+"kb");
        // Always end the response so the client doesn't hang waiting for more data.
        if (!res.headersSent) {
          res.status(413).json({ error: "ESPN response too large ("+Math.round(bytesSeen/1024)+"kb)" });
        } else {
          res.end(); // partial JSON — client will get a parse error, not a timeout
        }
        return;
      }
      if (!aborted) res.write(chunk);
    });

    espnRes.on("end", () => {
      if (!aborted) {
        res.end();
        console.log("[PROXY] ✓", espnPath, Math.round(bytesSeen/1024)+"kb");
      }
    });

    espnRes.on("error", (err) => {
      if (!aborted && !res.headersSent) {
        res.status(502).json({ error: err.message });
      }
      console.error("[PROXY] stream error:", err.message);
    });
  });

  request.on("error", (err) => {
    console.error("[PROXY] request error:", err.message);
    if (!res.headersSent) res.status(502).json({ error: err.message });
  });

  // If client disconnects, kill the upstream request immediately
  req.on("close", () => request.destroy());
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("✅ Sports scoreboard proxy running on port", PORT);
});
