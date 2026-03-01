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

const MAX_RESPONSE_BYTES = 1.5 * 1024 * 1024; // 1.5 MB hard cap per request

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/espn", (req, res) => {
  const espnPath = req.query.path;
  if (!espnPath) return res.status(400).json({ error: "Missing path param" });

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
        // Response is too large — destroy the upstream and bail
        aborted = true;
        espnRes.destroy();
        if (!res.headersSent) {
          res.status(413).json({ error: "ESPN response too large ("+Math.round(bytesSeen/1024)+"kb)" });
        }
        console.warn("[PROXY] ✗ TOO LARGE:", espnPath, Math.round(bytesSeen/1024)+"kb");
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
