"use strict";
// ─────────────────────────────────────────────────────────────────
//  SPORTS SCOREBOARD  v8
//  Active: NBA · NCAAM (by conference) · MLB · NHL
//  Two rows always show DIFFERENT leagues/conferences.
//  CBB: one fetch groups=50, split client-side by comp.groups.shortName
// ─────────────────────────────────────────────────────────────────
const e = React.createElement;
const { useState, useEffect, useRef, useCallback, Fragment } = React;
const F = "'Barlow Condensed','Arial Narrow',Arial,sans-serif";

const POLL_MS          = 30000;
const SPEED_ROW1       = 52;
const SPEED_ROW2       = 42;
const LOOPS_PER_ROTATE = 2;
const ALERT_MS         = 6000;

// Active non-CBB leagues in rotation order
const NON_CBB = [
  { key:"nba", sport:"basketball", league:"nba", label:"NBA", icon:"🏀", accent:"#C9082A" },
  { key:"mlb", sport:"baseball",   league:"mlb", label:"MLB", icon:"⚾",  accent:"#002D72" },
  { key:"nhl", sport:"hockey",     league:"nhl", label:"NHL", icon:"🏒", accent:"#00539B" },
];

// ── ESPN PROXY ────────────────────────────────────────────────────
async function espnFetch(sport, league, extra, params) {
  let path = sport + "/" + league + "/" + (extra || "scoreboard");
  const qs = new URLSearchParams(params || {}).toString();
  if (qs) path += "?" + qs;
  const res = await fetch("/api/espn?path=" + encodeURIComponent(path), {
    signal: AbortSignal.timeout(12000),
  });
  if (res.status === 413) throw new Error("TOO_LARGE");
  if (!res.ok) throw new Error("HTTP " + res.status);
  const txt = await res.text();
  if (!txt || txt.trim()[0] === "<") throw new Error("Bad response");
  return JSON.parse(txt);
}

async function fetchCBBEvents() {
  for (const limit of [200, 120, 70]) {
    try {
      const data = await espnFetch("basketball", "mens-college-basketball", "scoreboard", { groups:"50", limit });
      const evs = (data && data.events) || [];
      console.log("[CBB] " + evs.length + " events limit=" + limit);
      return evs;
    } catch (err) {
      if (err.message === "TOO_LARGE") { console.warn("[CBB] too large, retrying"); continue; }
      throw err;
    }
  }
  return [];
}

// ── PARSE EVENT → game object ─────────────────────────────────────
function parseGame(ev, sport, league) {
  try {
    const comp = (ev.competitions || [])[0];
    if (!comp) return null;
    const home = comp.competitors.find(c => c.homeAway === "home");
    const away = comp.competitors.find(c => c.homeAway === "away");
    if (!home || !away) return null;

    const sType  = (comp.status && comp.status.type) || {};
    const done   = sType.completed || false;
    const state  = sType.state || "pre";
    const status = done ? "final" : state === "in" ? "live" : "pre";

    const period = (comp.status && comp.status.period) || 0;
    const clock  = (comp.status && comp.status.displayClock) || "";

    let periodLabel = "";
    if (status === "live") {
      if      (sport === "basketball") periodLabel = "H" + period;
      else if (sport === "hockey")     periodLabel = "P" + period;
      else if (sport === "baseball")   periodLabel = sType.shortDetail || ("Inn " + period);
      else                             periodLabel = "Q" + period;
    } else if (status === "final") {
      periodLabel = sType.shortDetail || "Final";
    } else {
      const d = comp.date ? new Date(comp.date) : null;
      periodLabel = d ? d.toLocaleTimeString([], { hour:"numeric", minute:"2-digit" }) : "TBD";
    }

    const odds = (comp.odds || [])[0];
    let spread = null;
    if (odds && odds.details && odds.details !== "EVEN") {
      const p = odds.details.trim().split(" ");
      if (p.length === 2) spread = { favorite:p[0], line:parseFloat(p[1]) };
    }

    const col = t => "#" + ((t.team && t.team.color) || "444").replace("#", "");
    const sit = comp.situation || null;

    const bc = comp.broadcasts || [];
    let channel = null;
    if (bc.length) {
      const n = bc.find(b => b.market === "national") || bc[0];
      channel = (n.names && n.names[0]) || (n.media && n.media.shortName) || null;
    }
    if (!channel && (comp.geoBroadcasts || []).length) {
      channel = ((comp.geoBroadcasts[0].media || {}).shortName) || null;
    }

    const hr = (home.curatedRank && home.curatedRank.current <= 25) ? home.curatedRank.current : null;
    const ar = (away.curatedRank && away.curatedRank.current <= 25) ? away.curatedRank.current : null;

    let clockSecs = null;
    if (status === "live" && clock) {
      const p = clock.split(":").map(Number);
      if (p.length === 2) clockSecs = p[0] * 60 + p[1];
    }

    // Conference is on comp.groups (confirmed from ESPN response)
    const confName = (comp.groups && (comp.groups.shortName || comp.groups.name)) || null;

    return {
      id: ev.id, sport, league, status,
      period: periodLabel,
      clock: (status === "live" && sport !== "baseball") ? clock : "",
      clockSecs, confName,
      home: {
        abbr:   (home.team && home.team.abbreviation) || "HM",
        color:  col(home),
        logo:   (home.team && home.team.logo) || null,
        score:  status !== "pre" ? parseInt(home.score || 0) : null,
        record: (home.records && home.records[0] && home.records[0].summary) || "",
        rank:   hr,
      },
      away: {
        abbr:   (away.team && away.team.abbreviation) || "AW",
        color:  col(away),
        logo:   (away.team && away.team.logo) || null,
        score:  status !== "pre" ? parseInt(away.score || 0) : null,
        record: (away.records && away.records[0] && away.records[0].summary) || "",
        rank:   ar,
      },
      spread, channel,
      bases: sit ? [!!sit.onFirst, !!sit.onSecond, !!sit.onThird] : [false,false,false],
      outs:  (sit && sit.outs) || 0,
      leaders: { home:[], away:[] },
      alert: null,
    };
  } catch { return null; }
}

// ── GROUP CBB BY CONFERENCE ───────────────────────────────────────
const CONF_ORDER = ["ACC","SEC","Big 12","Big Ten","Big East","AAC","A-10","MVC","MWC","WCC","MAC","CUSA","Sun Belt"];

function groupCBBByConf(games) {
  const map = {};
  games.forEach(g => {
    const k = g.confName || "Other";
    if (!map[k]) map[k] = [];
    map[k].push(g);
  });
  return Object.entries(map)
    .sort(([a], [b]) => {
      const ai = CONF_ORDER.indexOf(a), bi = CONF_ORDER.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    })
    .map(([confName, gs]) => ({
      key: "cbb_" + confName.replace(/[\s\/]/g, "_"),
      label: "CBB", shortLabel: confName,
      icon: "🏀", accent: "#1A4A8A",
      isCBB: true,
      sport: "basketball", league: "mens-college-basketball",
      confName, games: gs,
    }));
}

// ── LEADERS ───────────────────────────────────────────────────────
function parseLeaders(summary) {
  try {
    const result = { home:[], away:[] };
    const bs = summary && summary.boxscore;
    if (!bs) return result;
    const hc = ((summary.header && summary.header.competitions && summary.header.competitions[0]) || {}).competitors || [];
    const homeId = (hc.find(c => c.homeAway === "home") || { team:{} }).team.id;
    (bs.players || []).forEach(grp => {
      const side = grp.team && grp.team.id === homeId ? "home" : "away";
      const stats = (grp.statistics || [])[0];
      if (!stats) return;
      const lb = stats.labels || [];
      const pi = lb.indexOf("PTS"), gi = lb.indexOf("G"), ri = lb.indexOf("REB"), ai = lb.indexOf("AST");
      const si = pi >= 0 ? pi : gi >= 0 ? gi : 0;
      result[side] = (stats.athletes || [])
        .filter(a => a.stats && a.stats.some(s => s !== "--" && s !== "0"))
        .sort((a, b) => parseFloat((b.stats&&b.stats[si])||0) - parseFloat((a.stats&&a.stats[si])||0))
        .slice(0, 2)
        .map(a => ({
          name: (a.athlete && (a.athlete.shortName || a.athlete.displayName)) || "—",
          pts:  (a.stats && a.stats[si]) || "—",
          reb:  ri >= 0 ? (a.stats && a.stats[ri]) : null,
          ast:  ai >= 0 ? (a.stats && a.stats[ai]) : null,
        }));
    });
    if (!result.home.length && !result.away.length) {
      (summary.leaders || []).forEach(lg => {
        const l = (lg.leaders||[])[0];
        if (!l) return;
        const side = homeId && lg.team && lg.team.id === homeId ? "home" : "away";
        if (result[side].length < 2) result[side].push({
          name: (l.athlete && (l.athlete.shortName||l.athlete.displayName)) || "—",
          pts: l.value||"—", reb:null, ast:null,
        });
      });
    }
    return result;
  } catch { return { home:[], away:[] }; }
}

function getCover(game) {
  if (game.status !== "final" || !game.spread || !game.spread.line) return null;
  const f = game.spread.favorite === game.home.abbr;
  const m = f ? game.home.score - game.away.score : game.away.score - game.home.score;
  return m > Math.abs(game.spread.line);
}

// ═══════════════════════════════════════════════════════════════════
//  COMPONENTS
// ═══════════════════════════════════════════════════════════════════

function TeamLogo({ src, color, size }) {
  size = size || 40;
  const [err, setErr] = useState(false);
  if (!src || err) return e("div", { style:{ width:size, height:size, borderRadius:5, flexShrink:0, background:color+"33", border:"1px solid "+color+"22" }});
  return e("img", { src, alt:"", width:size, height:size, onError:()=>setErr(true), style:{ objectFit:"contain", flexShrink:0, filter:"drop-shadow(0 1px 5px rgba(0,0,0,0.9))" }});
}

function RankBadge({ rank, fontSize }) {
  if (!rank) return null;
  return e("span", { style:{ fontSize, fontWeight:900, fontFamily:F, color:"#F5C518", background:"rgba(245,197,24,0.12)", border:"1px solid rgba(245,197,24,0.45)", borderRadius:3, padding:"0 3px", lineHeight:"1.3", flexShrink:0, marginRight:2 }}, "#" + rank);
}

function GameCard({ game, flash, rowH }) {
  const covered = getCover(game);
  const isLive  = game.status === "live";
  const isFinal = game.status === "final";
  const isPre   = game.status === "pre";
  const hw = (game.home.score||0) > (game.away.score||0);
  const aw = (game.away.score||0) > (game.home.score||0);

  const PAD    = Math.round(rowH * 0.052);
  const inner  = rowH - PAD * 2;
  const STATUS = Math.round(inner * 0.11);
  const GAP1   = Math.round(inner * 0.03);
  const TEAMS  = Math.round(inner * 0.44);
  const GAP2   = Math.round(inner * 0.03);
  const LEAD   = inner - STATUS - GAP1 - TEAMS - GAP2 - 1;
  const TROW   = Math.round((TEAMS - 4) / 2);
  const cardW  = Math.round(rowH * 1.32);

  const scoreFz = Math.round(TROW * 0.72);
  const abbrFz  = Math.round(TROW * 0.38);
  const rankFz  = Math.round(TROW * 0.28);
  const logoSz  = Math.round(TROW * 0.78);
  const stFz    = Math.round(STATUS * 0.65);
  const chanFz  = Math.round(STATUS * 0.56);
  const lhFz    = Math.round(LEAD * 0.155);
  const lnFz    = Math.round(LEAD * 0.135);
  const lpFz    = Math.round(LEAD * 0.16);
  const lsFz    = Math.round(LEAD * 0.11);

  const teamRow = side => {
    const t = game[side];
    const win = side==="home" ? hw : aw;
    const lose = side==="home" ? aw : hw;
    return e("div", { style:{ display:"flex", alignItems:"center", height:TROW, gap:6, overflow:"hidden", opacity:isFinal&&lose?0.4:1 }},
      e(TeamLogo, { src:t.logo, color:t.color, size:logoSz }),
      e("div", { style:{ display:"flex", alignItems:"baseline", gap:3, flex:"0 0 auto" }},
        e(RankBadge, { rank:t.rank, fontSize:rankFz }),
        e("span", { style:{ fontSize:abbrFz, fontWeight:900, color:"#fff", fontFamily:F, letterSpacing:0.5, lineHeight:1, whiteSpace:"nowrap" }}, t.abbr),
        !isPre && e("span", { style:{ fontSize:scoreFz, fontWeight:900, lineHeight:1, fontFamily:F, fontVariantNumeric:"tabular-nums", marginLeft:6, flexShrink:0, color:win?"#fff":"rgba(255,255,255,0.4)", textShadow:win&&isLive?"0 0 16px "+t.color+"bb":"none" }}, t.score),
      ),
      isPre && t.record && !t.rank && e("span", { style:{ fontSize:Math.round(abbrFz*0.68), color:"rgba(255,255,255,0.28)", fontFamily:F, marginLeft:4, flexShrink:0 }}, t.record),
    );
  };

  const leadCol = side => {
    const t = game[side];
    const pp = game.leaders[side];
    return e("div", { style:{ flex:1, minWidth:0, overflow:"hidden" }},
      e("div", { style:{ fontSize:lhFz, fontWeight:800, letterSpacing:1, color:t.color, textTransform:"uppercase", fontFamily:F, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", marginBottom:Math.round(LEAD*0.04) }}, t.abbr),
      pp.length
        ? pp.map((p,i) => e("div", { key:i, style:{ display:"flex", alignItems:"baseline", gap:3, marginBottom:Math.round(LEAD*0.03), overflow:"hidden" }},
            e("span", { style:{ fontSize:lnFz, fontWeight:700, color:"rgba(255,255,255,0.82)", fontFamily:F, flex:"1 1 0", minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}, p.name),
            e("span", { style:{ fontSize:lpFz, fontWeight:900, color:"#fff", fontFamily:F, fontVariantNumeric:"tabular-nums", flexShrink:0 }}, p.pts),
            p.reb&&p.reb!=="0"&&p.reb!=="--" && e("span", { style:{ fontSize:lsFz, color:"rgba(255,255,255,0.38)", flexShrink:0 }}, p.reb+"r"),
            p.ast&&p.ast!=="0"&&p.ast!=="--" && e("span", { style:{ fontSize:lsFz, color:"rgba(255,255,255,0.38)", flexShrink:0 }}, p.ast+"a"),
          ))
        : e("span", { style:{ fontSize:lnFz, color:"rgba(255,255,255,0.15)", fontStyle:"italic" }}, "—"),
    );
  };

  const diamond = () => {
    const S = Math.round(LEAD * 0.22);
    const b = on => e("div", { style:{ width:S, height:S, transform:"rotate(45deg)", flexShrink:0, background:on?"#F5A623":"rgba(255,255,255,0.1)", border:"1.5px solid "+(on?"#F5A623":"rgba(255,255,255,0.22)"), boxShadow:on?"0 0 5px #F5A623aa":"none" }});
    return e("div", { style:{ display:"flex", flexDirection:"column", alignItems:"center", gap:Math.round(S*0.22), paddingRight:7, borderRight:"1px solid rgba(255,255,255,0.08)", flexShrink:0 }},
      b(game.bases[1]),
      e("div", { style:{ display:"flex", gap:Math.round(S) }}, b(game.bases[2]), b(game.bases[0])),
      e("div", { style:{ display:"flex", gap:3, marginTop:2 }},
        [0,1,2].map(i => e("div", { key:i, style:{ width:5, height:5, borderRadius:"50%", background:i<game.outs?"#F5A623":"rgba(255,255,255,0.12)" }}))
      ),
    );
  };

  const hasAlert = !!game.alert;

  return e("div", { style:{
    display:"inline-flex", flexDirection:"column",
    width:cardW, height:rowH, flexShrink:0,
    paddingTop:PAD, paddingBottom:PAD,
    paddingLeft:Math.round(rowH*0.055), paddingRight:Math.round(rowH*0.055),
    borderRight:"1px solid rgba(255,255,255,0.07)",
    background: hasAlert ? "linear-gradient(180deg,"+game.alert.color+"18 0%,#0d0d0d 60%)"
      : flash ? "linear-gradient(180deg,rgba(255,200,0,0.1) 0%,#0d0d0d 60%)"
      : "linear-gradient(180deg,rgba(255,255,255,0.025) 0%,#0d0d0d 100%)",
    position:"relative", overflow:"hidden", boxSizing:"border-box",
  }},
    e("div", { style:{ position:"absolute", top:0, left:0, right:0, height:3, background:"linear-gradient(90deg,"+game.away.color+","+game.home.color+")", opacity:0.9 }}),
    hasAlert && e("div", { className:"alert-bar", style:{ position:"absolute", top:0, left:0, right:0, height:STATUS+PAD, display:"flex", alignItems:"center", justifyContent:"center", gap:6, zIndex:10, background:"linear-gradient(90deg,transparent,"+game.alert.color+"28,"+game.alert.color+"40,"+game.alert.color+"28,transparent)" }},
      e("span", { style:{ fontSize:stFz }}, game.alert.type==="CLOSE"?"🚨":"🔥"),
      e("span", { style:{ fontSize:stFz*0.82, fontWeight:900, fontFamily:F, color:game.alert.color, letterSpacing:0.8, textTransform:"uppercase" }}, game.alert.text),
    ),
    // STATUS BAR
    e("div", { style:{ height:STATUS, flexShrink:0, marginBottom:GAP1, display:"flex", alignItems:"center", justifyContent:"space-between", overflow:"hidden" }},
      e("div", { style:{ display:"flex", alignItems:"center", gap:5 }},
        isLive && e("div", { className:"live-dot", style:{ width:8, height:8, borderRadius:"50%", flexShrink:0, background:"#FF3B30", boxShadow:"0 0 7px #FF3B30" }}),
        e("span", { style:{ fontSize:stFz, fontWeight:900, fontFamily:F, letterSpacing:1, color:isLive?"#FF3B30":"rgba(255,255,255,0.35)" }}, game.period),
        isLive && game.clock && e("span", { style:{ fontSize:stFz, fontWeight:700, fontFamily:F, color:"rgba(255,255,255,0.78)", marginLeft:3 }}, game.clock),
      ),
      e("div", { style:{ display:"flex", alignItems:"center", gap:5 }},
        game.channel && e("div", { style:{ display:"flex", alignItems:"center", gap:3, background:"rgba(255,255,255,0.07)", borderRadius:4, padding:"1px 5px" }},
          e("span", { style:{ fontSize:chanFz }}, "📺"),
          e("span", { style:{ fontSize:chanFz, fontWeight:800, fontFamily:F, color:"rgba(255,255,255,0.7)" }}, game.channel),
        ),
        game.spread && e("div", { style:{ display:"flex", alignItems:"center", gap:3, background:"rgba(255,255,255,0.06)", borderRadius:4, padding:"1px 5px" }},
          e("span", { style:{ fontSize:chanFz*0.85, fontWeight:700, color:"rgba(255,255,255,0.28)", letterSpacing:0.5 }}, "SPR"),
          e("span", { style:{ fontSize:chanFz, fontWeight:800, fontFamily:F, color:"rgba(255,255,255,0.72)" }},
            game.spread.favorite + " " + (game.spread.line>0?"+":"") + game.spread.line),
          covered !== null && e("span", { style:{ fontSize:chanFz, fontWeight:900, color:covered?"#30D158":"#FF453A" }}, covered?"✓":"✗"),
        ),
      ),
    ),
    // TEAMS
    e("div", { style:{ height:TEAMS, flexShrink:0, display:"flex", flexDirection:"column", justifyContent:"space-around" }},
      teamRow("away"),
      e("div", { style:{ height:1, background:"rgba(255,255,255,0.07)", margin:"1px 0", flexShrink:0 }}),
      teamRow("home"),
    ),
    e("div", { style:{ height:GAP2, flexShrink:0 }}),
    // LEADERS
    e("div", { style:{ height:LEAD, flexShrink:0, display:"flex", gap:6, overflow:"hidden", borderTop:"1px solid rgba(255,255,255,0.07)", paddingTop:Math.round(LEAD*0.06) }},
      game.sport === "baseball" && !isPre && diamond(),
      leadCol("away"),
      e("div", { style:{ width:1, background:"rgba(255,255,255,0.07)", alignSelf:"stretch", flexShrink:0 }}),
      leadCol("home"),
    ),
  );
}

function SportLabel({ slot, rowH }) {
  const w = Math.round(rowH * 0.65);
  return e("div", { style:{ width:w, flexShrink:0, height:"100%", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:3, background:"linear-gradient(170deg,"+slot.accent+"EE,"+slot.accent+"88)", borderRight:"3px solid "+slot.accent }},
    e("span", { style:{ fontSize:Math.round(rowH*0.2), lineHeight:1 }}, slot.icon),
    e("span", { style:{ fontSize:Math.round(rowH*0.085), fontWeight:900, color:"#fff", letterSpacing:2, fontFamily:F }}, slot.isCBB ? "CBB" : slot.label),
    slot.isCBB && e("span", { style:{ fontSize:Math.round(rowH*0.068), fontWeight:700, color:"rgba(255,255,255,0.72)", letterSpacing:0.8, fontFamily:F, textAlign:"center", padding:"0 3px", lineHeight:1.2 }}, slot.shortLabel),
  );
}

function ScrollRow({ rowH, speed, games, slot, flashIds, onLoop }) {
  const scrollRef = useRef(null);
  const animRef   = useRef(null);
  const xRef      = useRef(0);
  const tsRef     = useRef(null);
  const loopCnt   = useRef(0);
  const prevKey   = useRef(slot.key);

  const onLoopCb = useCallback(() => {
    loopCnt.current += 1;
    if (loopCnt.current >= LOOPS_PER_ROTATE) { loopCnt.current = 0; onLoop(); }
  }, [onLoop]);

  const animate = useCallback(ts => {
    if (!scrollRef.current) { animRef.current = requestAnimationFrame(animate); return; }
    if (tsRef.current === null) tsRef.current = ts;
    const delta = Math.min((ts - tsRef.current) / 1000, 0.05);
    tsRef.current = ts;
    xRef.current += speed * delta;
    const half = scrollRef.current.scrollWidth / 2;
    if (half > 0 && xRef.current >= half) { xRef.current = 0; onLoopCb(); }
    scrollRef.current.style.transform = "translateX(-" + xRef.current + "px)";
    animRef.current = requestAnimationFrame(animate);
  }, [speed, onLoopCb]);

  useEffect(() => {
    if (slot.key !== prevKey.current) {
      xRef.current = 0; tsRef.current = null; loopCnt.current = 0;
      prevKey.current = slot.key;
    }
    cancelAnimationFrame(animRef.current);
    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, [animate, slot.key]);

  if (!games.length) return e("div", { style:{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", color:"rgba(255,255,255,0.12)", fontSize:Math.round(rowH*0.1), fontFamily:F, letterSpacing:3 }}, "NO GAMES TODAY");

  return e("div", { style:{ flex:1, overflow:"hidden", position:"relative" }},
    e("div", { style:{ position:"absolute", left:0, top:0, bottom:0, width:30, zIndex:4, background:"linear-gradient(to right,#0a0a0a 15%,transparent)", pointerEvents:"none" }}),
    e("div", { style:{ position:"absolute", right:0, top:0, bottom:0, width:40, zIndex:4, background:"linear-gradient(to left,#0a0a0a 15%,transparent)", pointerEvents:"none" }}),
    e("div", { ref:scrollRef, style:{ display:"inline-flex", alignItems:"stretch", height:"100%", willChange:"transform" }},
      [...games, ...games].map((g, i) => e(GameCard, { key:g.id+"-"+i, game:g, flash:flashIds.has(g.id), rowH }))
    ),
  );
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════════════
function SportsBoard() {
  const [slots,       setSlots]       = useState([]);
  const [flashIds,    setFlashIds]    = useState(new Set());
  const [loading,     setLoading]     = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [clock,       setClock]       = useState(new Date());
  const [r1,          setR1]          = useState(0);
  const [r2,          setR2]          = useState(1);

  const prevScores = useRef({});
  const slotsRef   = useRef([]);  // mirror of slots state for reading inside callbacks

  useEffect(() => {
    const iv = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(iv);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const nextSlots = [];

      // Snapshot existing leaders so we can carry them forward during refresh
      const prevLeaders = {};
      slotsRef.current.forEach(sl => {
        (sl.games || []).forEach(g => {
          if (g.leaders && (g.leaders.home.length || g.leaders.away.length)) {
            prevLeaders[g.id] = g.leaders;
          }
        });
      });

      // Fetch non-CBB in parallel
      const results = await Promise.allSettled(
        NON_CBB.map(lg =>
          espnFetch(lg.sport, lg.league, "scoreboard", { limit:40 })
            .then(data => ({ lg, events:(data&&data.events)||[] }))
        )
      );

      results.forEach(r => {
        if (r.status !== "fulfilled") { console.warn("[fetch]", r.reason); return; }
        const { lg, events } = r.value;
        const games = events.map(ev => parseGame(ev, lg.sport, lg.league)).filter(Boolean)
          .map(g => ({ ...g, leaders: prevLeaders[g.id] || g.leaders }));
        games.forEach(g => { prevScores.current[g.id] = { home:g.home.score, away:g.away.score }; });
        if (games.length > 0) {
          nextSlots.push({ key:lg.key, label:lg.label, icon:lg.icon, accent:lg.accent, isCBB:false, sport:lg.sport, league:lg.league, games });
        }
      });

      // Fetch CBB
      try {
        const cbbEvents = await fetchCBBEvents();
        const allGames  = cbbEvents.map(ev => parseGame(ev, "basketball", "mens-college-basketball")).filter(Boolean)
          .map(g => ({ ...g, leaders: prevLeaders[g.id] || g.leaders }));
        allGames.forEach(g => { prevScores.current[g.id] = { home:g.home.score, away:g.away.score }; });
        const confSlots = groupCBBByConf(allGames);
        // Insert CBB slots after NBA
        const nbaIdx = nextSlots.findIndex(s => s.key === "nba");
        nextSlots.splice(nbaIdx >= 0 ? nbaIdx + 1 : nextSlots.length, 0, ...confSlots);
      } catch (err) {
        console.warn("[CBB]", err.message);
      }

      slotsRef.current = nextSlots;
      setSlots(nextSlots);

      // Keep r1/r2 in bounds and different
      const len = nextSlots.length;
      setR1(prev => Math.min(prev, Math.max(len-1, 0)));
      setR2(prev => {
        const clamped = Math.min(prev, Math.max(len-1, 0));
        // re-check after r1 is set — use functional update so we see latest r1
        return clamped;
      });

      setLastUpdated(new Date());
    } catch (err) {
      console.error("[loadAll]", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); const iv = setInterval(loadAll, POLL_MS); return () => clearInterval(iv); }, [loadAll]);

  // Keep r2 !== r1 whenever either changes
  useEffect(() => {
    if (slots.length < 2) return;
    setR2(prev => prev === r1 ? (r1 + 1) % slots.length : Math.min(prev, slots.length-1));
  }, [r1, slots.length]);

  // Leaders poll for visible rows
  useEffect(() => {
    if (!slots.length) return;
    let cancelled = false;
    const load = async () => {
      const visible = [slots[r1], slots[r2]].filter(Boolean);
      for (const slot of visible) {
        for (const g of slot.games.filter(g => g.status !== "pre")) {
          if (cancelled) return;
          try {
            const s = await espnFetch(slot.sport, slot.league, "summary?event=" + g.id, {});
            const leaders = parseLeaders(s);
            setSlots(prev => { const next = prev.map(sl => sl.key !== slot.key ? sl : { ...sl, games: sl.games.map(x => x.id===g.id ? {...x, leaders} : x) }); slotsRef.current = next; return next; });
          } catch {}
          await new Promise(r => setTimeout(r, 400));
        }
      }
    };
    load();
    const iv = setInterval(load, 65000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [slots.length, r1, r2]); // eslint-disable-line

  // Row rotation — ensure next index is different from the OTHER row
  const handleLoop = useCallback((rowNum) => {
    const len = slots.length;
    if (len < 2) return;
    if (rowNum === 1) {
      setR1(prev => {
        let next = (prev + 1) % len;
        if (next === r2) next = (next + 1) % len;
        return next;
      });
    } else {
      setR2(prev => {
        let next = (prev + 1) % len;
        if (next === r1) next = (next + 1) % len;
        return next;
      });
    }
  }, [slots.length, r1, r2]);

  // ── Render ────────────────────────────────────────────────────
  const HEADER_H = 44;
  const rowH     = Math.floor((window.innerHeight - HEADER_H) / 2);
  const slot1    = slots[r1] || null;
  const slot2    = slots[r2] || null;

  const spin = { width:10, height:10, borderRadius:"50%", border:"2px solid rgba(255,255,255,0.15)", borderTopColor:"#fff", flexShrink:0 };

  const renderRow = (slot, rowNum, speed) => {
    const isBottom = rowNum === 2;
    return e("div", { style:{ height:rowH, flexShrink:0, display:"flex", alignItems:"stretch", borderTop: isBottom ? "2px solid rgba(255,255,255,0.06)" : undefined }},
      slot
        ? e(Fragment, null,
            e(SportLabel, { slot, rowH }),
            loading && !slot.games.length
              ? e("div", { style:{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:10 }},
                  e("div", { className:"spin", style:{...spin, width:13, height:13, borderWidth:3, borderTopColor:slot.accent} }),
                  e("span", { style:{ fontSize:14, fontWeight:800, color:"rgba(255,255,255,0.28)", fontFamily:F, letterSpacing:3 }}, "LOADING…"))
              : e(ScrollRow, { rowH, speed, games:slot.games, slot, flashIds, onLoop:()=>handleLoop(rowNum) }),
          )
        : e("div", { style:{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", color:"rgba(255,255,255,0.07)", fontSize:12, fontFamily:F, letterSpacing:3 }},
            loading ? "LOADING…" : "NO GAMES"),
    );
  };

  return e(Fragment, null,
    e("div", { style:{ width:"100vw", height:"100vh", display:"flex", flexDirection:"column", background:"#0a0a0a", overflow:"hidden" }},

      // HEADER
      e("div", { style:{ height:HEADER_H, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 12px", background:"linear-gradient(180deg,#1c1c1c,#111)", borderBottom:"1px solid rgba(255,255,255,0.07)" }},
        e("div", { style:{ display:"flex", gap:4, alignItems:"center", flex:1, overflow:"hidden" }},
          slots.map((sl, i) => {
            const active = i===r1 || i===r2;
            return e("div", { key:sl.key, style:{ display:"flex", alignItems:"center", gap:3, padding:"2px 7px", borderRadius:20, flexShrink:0, background:active?sl.accent+"30":"rgba(255,255,255,0.04)", border:"1px solid "+(active?sl.accent:"rgba(255,255,255,0.08)") }},
              e("span", { style:{ fontSize:11 }}, sl.icon),
              e("span", { style:{ fontSize:10, fontWeight:800, fontFamily:F, letterSpacing:1, color:active?"#fff":"rgba(255,255,255,0.35)" }}, sl.isCBB ? sl.shortLabel : sl.label),
              e("span", { style:{ fontSize:9, color:active?"rgba(255,255,255,0.5)":"rgba(255,255,255,0.16)" }}, " " + sl.games.length),
            );
          }),
          loading && e("div", { className:"spin", style:spin }),
        ),
        e("div", { style:{ display:"flex", alignItems:"center", gap:8, flexShrink:0 }},
          lastUpdated && e("span", { style:{ fontSize:10, color:"rgba(255,255,255,0.18)", fontFamily:F }},
            lastUpdated.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit", second:"2-digit" })),
          e("span", { style:{ fontSize:20, fontWeight:900, color:"rgba(255,255,255,0.78)", fontFamily:F }},
            clock.toLocaleTimeString([], { hour:"numeric", minute:"2-digit" })),
        ),
      ),

      renderRow(slot1, 1, SPEED_ROW1),
      renderRow(slot2, 2, SPEED_ROW2),
    ),
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(e(SportsBoard, null));
