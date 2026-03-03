"use strict";
// ─────────────────────────────────────────────────────────────────
//  SPORTS SCOREBOARD  v10
//  · Tap card  → pinned full-screen detail (box score + play-by-play)
//  · Swipe row → jump to next/prev sport immediately
//  · Favorite teams → always first, star badge on card
//  · Live games first, then finals, then upcoming within each slot
// ─────────────────────────────────────────────────────────────────
const e = React.createElement;
const { useState, useEffect, useRef, useCallback, Fragment } = React;
const F = "'Barlow Condensed','Arial Narrow',Arial,sans-serif";

const POLL_MS          = 30000;
const SPEED_ROW1       = 52;
const SPEED_ROW2       = 42;
const LOOPS_PER_ROTATE = 2;
const ALERT_MS         = 6000;

// ── FAVORITE TEAMS (abbreviations) ───────────────────────────────
// Edit this list — these teams always appear first in their row
const DEFAULT_FAVS = new Set(["DAL","TEX","MFW","SMU","TCU","DAL","LAL","NYK"]);

// Active non-CBB leagues
const NON_CBB = [
  { key:"nba", sport:"basketball", league:"nba", label:"NBA", icon:"🏀", accent:"#C9082A" },
  { key:"mlb", sport:"baseball",   league:"mlb", label:"MLB", icon:"⚾",  accent:"#002D72" },
  { key:"nhl", sport:"hockey",     league:"nhl", label:"NHL", icon:"🏒", accent:"#00539B" },
];

// ── GAME SORT: live first, then final, then pre ───────────────────
function sortGames(games, favs) {
  const statusRank = g => g.status === "live" ? 0 : g.status === "final" ? 1 : 2;
  const isFav      = g => favs.has(g.home.abbr) || favs.has(g.away.abbr);
  return [...games].sort((a, b) => {
    // Favorites always bubble up within their status group
    const fa = isFav(a) ? 0 : 1, fb = isFav(b) ? 0 : 1;
    const sa = statusRank(a),    sb = statusRank(b);
    if (sa !== sb) return sa - sb;
    if (fa !== fb) return fa - fb;
    return 0;
  });
}

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
      return (data && data.events) || [];
    } catch (err) {
      if (err.message === "TOO_LARGE") continue;
      throw err;
    }
  }
  return [];
}

// ── MODEL PICKS ───────────────────────────────────────────────────
async function fetchPicks() {
  try {
    const res = await fetch("https://cbbmodel.vercel.app/latest.json", {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    const data = await res.json();
    // Return a map of game_id → pick object for fast lookup
    const map = {};
    (data.picks || []).forEach(p => { map[p.game_id] = p; });
    return map;
  } catch { return {}; }
}

// ── PARSE EVENT ───────────────────────────────────────────────────
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
    const sit  = comp.situation || null;

    const bc = comp.broadcasts || [];
    let channel = null;
    if (bc.length) {
      const n = bc.find(b => b.market === "national") || bc[0];
      channel = (n.names && n.names[0]) || (n.media && n.media.shortName) || null;
    }
    if (!channel && (comp.geoBroadcasts || []).length)
      channel = ((comp.geoBroadcasts[0].media || {}).shortName) || null;

    const hr = (home.curatedRank && home.curatedRank.current <= 25) ? home.curatedRank.current : null;
    const ar = (away.curatedRank && away.curatedRank.current <= 25) ? away.curatedRank.current : null;

    let clockSecs = null;
    if (status === "live" && clock) {
      const p = clock.split(":").map(Number);
      if (p.length === 2) clockSecs = p[0] * 60 + p[1];
    }

    const confName = (comp.groups && (comp.groups.shortName || comp.groups.name)) || null;

    // Store team names for detail panel
    const homeName = (home.team && (home.team.displayName || home.team.location)) || "";
    const awayName = (away.team && (away.team.displayName || away.team.location)) || "";

    return {
      id: ev.id, sport, league, status,
      period: periodLabel, clock: (status === "live" && sport !== "baseball") ? clock : "",
      clockSecs, confName, homeName, awayName,
      home: {
        abbr:   (home.team && home.team.abbreviation) || "HM",
        name:   homeName,
        color:  col(home), logo: (home.team && home.team.logo) || null,
        score:  status !== "pre" ? parseInt(home.score || 0) : null,
        record: (home.records && home.records[0] && home.records[0].summary) || "",
        rank:   hr,
      },
      away: {
        abbr:   (away.team && away.team.abbreviation) || "AW",
        name:   awayName,
        color:  col(away), logo: (away.team && away.team.logo) || null,
        score:  status !== "pre" ? parseInt(away.score || 0) : null,
        record: (away.records && away.records[0] && away.records[0].summary) || "",
        rank:   ar,
      },
      spread, channel,
      bases: sit ? [!!sit.onFirst, !!sit.onSecond, !!sit.onThird] : [false,false,false],
      outs:  (sit && sit.outs) || 0,
      leaders: { home:[], away:[] },
      alert: null,
      detail: null,   // loaded on tap
    };
  } catch { return null; }
}

// ── GROUP CBB ─────────────────────────────────────────────────────
const CONF_ORDER = ["ACC","SEC","Big 12","Big Ten","Big East","AAC","A-10","MVC","MWC","WCC","MAC","CUSA","Sun Belt"];
function groupCBBByConf(games) {
  const map = {};
  games.forEach(g => { const k = g.confName||"Other"; if (!map[k]) map[k]=[]; map[k].push(g); });
  return Object.entries(map)
    .sort(([a],[b]) => {
      const ai=CONF_ORDER.indexOf(a),bi=CONF_ORDER.indexOf(b);
      if (ai!==-1&&bi!==-1) return ai-bi; if (ai!==-1) return -1; if (bi!==-1) return 1;
      return a.localeCompare(b);
    })
    .map(([confName, gs]) => ({
      key: "cbb_" + confName.replace(/[\s\/]/g,"_"),
      label:"CBB", shortLabel:confName, icon:"🏀", accent:"#1A4A8A",
      isCBB:true, sport:"basketball", league:"mens-college-basketball",
      confName, games:gs,
    }));
}

// ── PARSE LEADERS ─────────────────────────────────────────────────
function parseLeaders(summary) {
  try {
    const result = { home:[], away:[] };
    const bs = summary && summary.boxscore;
    if (!bs) return result;
    const hc = ((summary.header&&summary.header.competitions&&summary.header.competitions[0])||{}).competitors||[];
    const homeId = (hc.find(c=>c.homeAway==="home")||{team:{}}).team.id;
    (bs.players||[]).forEach(grp => {
      const side  = grp.team&&grp.team.id===homeId ? "home" : "away";
      const stats = (grp.statistics||[])[0];
      if (!stats) return;
      const lb=stats.labels||[];
      const pi=lb.indexOf("PTS"),gi=lb.indexOf("G"),ri=lb.indexOf("REB"),ai=lb.indexOf("AST");
      const si=pi>=0?pi:gi>=0?gi:0;
      result[side] = (stats.athletes||[])
        .filter(a=>a.stats&&a.stats.some(s=>s!=="--"&&s!=="0"))
        .sort((a,b)=>parseFloat((b.stats&&b.stats[si])||0)-parseFloat((a.stats&&a.stats[si])||0))
        .slice(0,2)
        .map(a=>({
          name:(a.athlete&&(a.athlete.shortName||a.athlete.displayName))||"—",
          pts:(a.stats&&a.stats[si])||"—",
          reb:ri>=0?(a.stats&&a.stats[ri]):null,
          ast:ai>=0?(a.stats&&a.stats[ai]):null,
        }));
    });
    if (!result.home.length&&!result.away.length) {
      (summary.leaders||[]).forEach(lg=>{
        const l=(lg.leaders||[])[0]; if(!l) return;
        const side=homeId&&lg.team&&lg.team.id===homeId?"home":"away";
        if(result[side].length<2) result[side].push({
          name:(l.athlete&&(l.athlete.shortName||l.athlete.displayName))||"—",
          pts:l.value||"—",reb:null,ast:null,
        });
      });
    }
    return result;
  } catch { return {home:[],away:[]}; }
}

// ── PARSE DETAIL (box score + play by play) ───────────────────────
function parseDetail(summary) {
  try {
    const detail = { boxScore:{home:[],away:[]}, plays:[] };
    const bs = summary&&summary.boxscore;
    const hc = ((summary.header&&summary.header.competitions&&summary.header.competitions[0])||{}).competitors||[];
    const homeId = (hc.find(c=>c.homeAway==="home")||{team:{}}).team.id;

    if (bs) {
      (bs.players||[]).forEach(grp=>{
        const side = grp.team&&grp.team.id===homeId?"home":"away";
        const stats=(grp.statistics||[])[0]; if(!stats) return;
        const labels=stats.labels||[];
        detail.boxScore[side] = (stats.athletes||[])
          .filter(a=>a.stats&&a.stats.some(s=>s!=="--"&&s!=="0"))
          .map(a=>({
            name:(a.athlete&&a.athlete.shortName)||"?",
            pos:(a.athlete&&a.athlete.position&&a.athlete.position.abbreviation)||"",
            stats:labels.map((lbl,i)=>({lbl,val:(a.stats&&a.stats[i])||"—"})),
          }));
      });
    }

    // Play-by-play (last 15 plays, most recent first)
    const pbp = summary&&summary.plays;
    if (pbp) {
      detail.plays = pbp
        .filter(p=>p.text)
        .slice(-15)
        .reverse()
        .map(p=>({
          text:p.text,
          clock:p.clock&&p.clock.displayValue,
          period:p.period&&p.period.number,
          scoreHome:p.homeScore,
          scoreAway:p.awayScore,
          type:p.type&&p.type.text,
        }));
    }
    return detail;
  } catch { return {boxScore:{home:[],away:[]},plays:[]}; }
}

function getCover(game) {
  if (game.status!=="final"||!game.spread||!game.spread.line) return null;
  const f=game.spread.favorite===game.home.abbr;
  return(f?game.home.score-game.away.score:game.away.score-game.home.score)>Math.abs(game.spread.line);
}

// ═══════════════════════════════════════════════════════════════════
//  DETAIL PANEL — full screen overlay on card tap
// ═══════════════════════════════════════════════════════════════════
function DetailPanel({ game, sport, league, favs, onToggleFav, onClose }) {
  const pick = game.pick || null;
  const [detail,   setDetail]   = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [tab,      setTab]      = useState("box"); // "box" | "pbp"

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await espnFetch(sport, league, "summary?event=" + game.id, {});
        if (!cancelled) {
          setDetail(parseDetail(s));
          // also grab leaders if not already loaded
        }
      } catch {}
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [game.id, sport, league]);

  const isLive  = game.status === "live";
  const isFinal = game.status === "final";
  const hw = (game.home.score||0) > (game.away.score||0);
  const aw = (game.away.score||0) > (game.home.score||0);

  // Box score table for one side
  const BoxTable = ({ players, color }) => {
    if (!players || !players.length) return e("div",{style:{color:"rgba(255,255,255,0.25)",fontSize:16,padding:16,fontFamily:F}},"No data");
    const keyCols = ["MIN","PTS","REB","AST","STL","BLK","TO","FGM-A","3PM-A","FTM-A"];
    const allLabels = players[0].stats.map(s=>s.lbl);
    const cols = keyCols.filter(k=>allLabels.includes(k));
    if (!cols.length) cols.push(...allLabels.slice(0,6));
    return e("div",{style:{overflowX:"auto",WebkitOverflowScrolling:"touch"}},
      e("table",{style:{borderCollapse:"collapse",width:"100%",fontSize:15,fontFamily:F,color:"#fff"}},
        e("thead",null,
          e("tr",{style:{borderBottom:"1px solid rgba(255,255,255,0.12)"}},
            e("th",{style:{textAlign:"left",padding:"6px 8px",color,fontWeight:900,whiteSpace:"nowrap",minWidth:110,fontSize:13}},"PLAYER"),
            ...cols.map(c=>e("th",{key:c,style:{padding:"6px 7px",color:"rgba(255,255,255,0.5)",fontWeight:700,whiteSpace:"nowrap",textAlign:"right",fontSize:13}},c)),
          )
        ),
        e("tbody",null,
          players.map((p,i)=>{
            const vals=cols.map(c=>{ const s=p.stats.find(x=>x.lbl===c); return s?s.val:"—"; });
            return e("tr",{key:i,style:{borderBottom:"1px solid rgba(255,255,255,0.06)",background:i%2===0?"rgba(255,255,255,0.03)":"transparent"}},
              e("td",{style:{padding:"7px 8px",whiteSpace:"nowrap",fontWeight:700,fontSize:15}},
                e("span",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",marginRight:5}},p.pos),
                p.name),
              ...vals.map((v,vi)=>e("td",{key:vi,style:{padding:"7px 7px",textAlign:"right",fontVariantNumeric:"tabular-nums",fontSize:15,color:v==="0"||v==="--"?"rgba(255,255,255,0.2)":"#fff"}},v)),
            );
          })
        ),
      ),
    );
  };

  return e("div",{style:{position:"fixed",inset:0,zIndex:100,background:"rgba(0,0,0,0.97)",display:"flex",flexDirection:"column",overflow:"hidden"},
    onClick:ev=>{ if(ev.target===ev.currentTarget) onClose(); }},

    // Top bar
    e("div",{style:{flexShrink:0,padding:"16px 20px 0",background:"linear-gradient(180deg,#1e1e1e,#111)"}},
      e("button",{onClick:onClose,style:{position:"absolute",top:12,right:16,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,color:"rgba(255,255,255,0.7)",fontSize:20,cursor:"pointer",padding:"2px 10px",lineHeight:1.4,zIndex:1}},"✕"),

      // Teams + score — much larger
      e("div",{style:{display:"flex",alignItems:"center",justifyContent:"center",gap:24,paddingBottom:16}},
        e("div",{style:{display:"flex",flexDirection:"column",alignItems:"center",gap:8,flex:1}},
          game.away.logo&&e("img",{src:game.away.logo,width:72,height:72,style:{objectFit:"contain",filter:"drop-shadow(0 2px 10px rgba(0,0,0,0.9))"}}),
          e("div",{style:{display:"flex",alignItems:"center",gap:6}},
            e("span",{style:{fontSize:20,fontWeight:900,fontFamily:F,color:"#fff",letterSpacing:1}},game.away.abbr),
            e("button",{
              onClick:()=>onToggleFav(game.away.abbr),
              title: favs.has(game.away.abbr)?"Remove favorite":"Add favorite",
              style:{background:"none",border:"none",cursor:"pointer",fontSize:18,padding:"0 2px",
                opacity:favs.has(game.away.abbr)?1:0.3,filter:favs.has(game.away.abbr)?"none":"grayscale(1)"},
            },"⭐"),
          ),
          game.away.name&&e("span",{style:{fontSize:13,color:"rgba(255,255,255,0.4)",fontFamily:F,textAlign:"center",maxWidth:120,lineHeight:1.2}},game.away.name),
          game.away.rank&&e("span",{style:{fontSize:13,color:"#F5C518",fontFamily:F,fontWeight:900}},"#"+game.away.rank),
          game.status!=="pre"&&e("span",{style:{fontSize:56,fontWeight:900,fontFamily:F,fontVariantNumeric:"tabular-nums",lineHeight:1,color:aw?"#fff":"rgba(255,255,255,0.28)"}},game.away.score),
          game.away.record&&e("span",{style:{fontSize:13,color:"rgba(255,255,255,0.3)",fontFamily:F}},game.away.record),
        ),
        e("div",{style:{display:"flex",flexDirection:"column",alignItems:"center",gap:6,minWidth:80}},
          isLive&&e("div",{style:{display:"flex",alignItems:"center",gap:6}},
            e("div",{className:"live-dot",style:{width:10,height:10,borderRadius:"50%",background:"#FF3B30",boxShadow:"0 0 8px #FF3B30"}}),
            e("span",{style:{fontSize:16,fontWeight:900,fontFamily:F,color:"#FF3B30",letterSpacing:1}},game.period),
          ),
          isLive&&game.clock&&e("span",{style:{fontSize:18,fontFamily:F,fontWeight:700,color:"rgba(255,255,255,0.8)"}},game.clock),
          isFinal&&e("span",{style:{fontSize:16,fontWeight:900,fontFamily:F,color:"rgba(255,255,255,0.4)",letterSpacing:1}},game.period),
          game.status==="pre"&&e("span",{style:{fontSize:17,fontFamily:F,color:"rgba(255,255,255,0.5)",textAlign:"center"}},game.period),
          e("span",{style:{fontSize:20,color:"rgba(255,255,255,0.15)",fontFamily:F,marginTop:4}},"@"),
        ),
        e("div",{style:{display:"flex",flexDirection:"column",alignItems:"center",gap:8,flex:1}},
          game.home.logo&&e("img",{src:game.home.logo,width:72,height:72,style:{objectFit:"contain",filter:"drop-shadow(0 2px 10px rgba(0,0,0,0.9))"}}),
          e("div",{style:{display:"flex",alignItems:"center",gap:6}},
            e("span",{style:{fontSize:20,fontWeight:900,fontFamily:F,color:"#fff",letterSpacing:1}},game.home.abbr),
            e("button",{
              onClick:()=>onToggleFav(game.home.abbr),
              title: favs.has(game.home.abbr)?"Remove favorite":"Add favorite",
              style:{background:"none",border:"none",cursor:"pointer",fontSize:18,padding:"0 2px",
                opacity:favs.has(game.home.abbr)?1:0.3,filter:favs.has(game.home.abbr)?"none":"grayscale(1)"},
            },"⭐"),
          ),
          game.home.name&&e("span",{style:{fontSize:13,color:"rgba(255,255,255,0.4)",fontFamily:F,textAlign:"center",maxWidth:120,lineHeight:1.2}},game.home.name),
          game.home.rank&&e("span",{style:{fontSize:13,color:"#F5C518",fontFamily:F,fontWeight:900}},"#"+game.home.rank),
          game.status!=="pre"&&e("span",{style:{fontSize:56,fontWeight:900,fontFamily:F,fontVariantNumeric:"tabular-nums",lineHeight:1,color:hw?"#fff":"rgba(255,255,255,0.28)"}},game.home.score),
          game.home.record&&e("span",{style:{fontSize:13,color:"rgba(255,255,255,0.3)",fontFamily:F}},game.home.record),
        ),
      ),

      e("div",{style:{display:"flex",justifyContent:"center",gap:16,paddingBottom:12,borderBottom:"1px solid rgba(255,255,255,0.07)"}},
        game.channel&&e("span",{style:{fontSize:14,fontFamily:F,color:"rgba(255,255,255,0.45)"}},"📺 "+game.channel),
        game.spread&&e("span",{style:{fontSize:14,fontFamily:F,color:"rgba(255,255,255,0.45)"}},"SPR: "+game.spread.favorite+" "+(game.spread.line>0?"+":"")+game.spread.line),
      ),

      game.status!=="pre"&&e("div",{style:{display:"flex",gap:0,marginTop:10}},
        ["box","pbp"].map(t=>e("button",{key:t,onClick:()=>setTab(t),style:{
          flex:1,padding:"10px 0",background:tab===t?"rgba(255,255,255,0.08)":"transparent",
          border:"none",borderBottom:tab===t?"3px solid #fff":"3px solid transparent",
          color:tab===t?"#fff":"rgba(255,255,255,0.3)",
          fontSize:15,fontWeight:900,fontFamily:F,letterSpacing:1.5,cursor:"pointer",
        }},t==="box"?"BOX SCORE":"PLAY-BY-PLAY")),
      ),
    ),

    // Content
    e("div",{style:{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:"16px 20px"}},
      loading&&e("div",{style:{display:"flex",alignItems:"center",justifyContent:"center",height:160,gap:12}},
        e("div",{className:"spin",style:{width:18,height:18,borderRadius:"50%",border:"2px solid rgba(255,255,255,0.15)",borderTopColor:"#fff"}}),
        e("span",{style:{fontSize:16,fontFamily:F,color:"rgba(255,255,255,0.3)",letterSpacing:2}},"LOADING…"),
      ),

      !loading&&game.status==="pre"&&e("div",{style:{textAlign:"center",padding:60,color:"rgba(255,255,255,0.2)",fontSize:17,fontFamily:F,letterSpacing:2}},"GAME HASN'T STARTED YET"),

      // ── MODEL PICK BLOCK (always shown when pick exists) ──
      pick && e("div",{style:{
        marginBottom:16, borderRadius:10, overflow:"hidden",
        border:"1px solid rgba(126,184,247,0.2)",
        background:"linear-gradient(135deg,rgba(126,184,247,0.07),rgba(0,0,0,0))",
      }},
        // Header
        e("div",{style:{
          padding:"10px 14px 8px", display:"flex", alignItems:"center",
          justifyContent:"space-between",
          borderBottom:"1px solid rgba(255,255,255,0.06)",
        }},
          e("div",{style:{display:"flex",alignItems:"center",gap:8}},
            e("span",{style:{fontSize:18}},"🧠"),
            e("span",{style:{fontSize:16,fontWeight:900,fontFamily:F,color:"#7EB8F7",letterSpacing:1}},
              "MODEL PICK"),
          ),
          // Result badge if final
          game.status==="final" && (() => {
            const pickWon = (pick.pick_abbr===game.home.abbr&&(game.home.score||0)>(game.away.score||0))
                          ||(pick.pick_abbr===game.away.abbr&&(game.away.score||0)>(game.home.score||0));
            return e("div",{style:{
              padding:"3px 10px", borderRadius:6, fontWeight:900, fontSize:13,
              fontFamily:F, letterSpacing:1,
              background:pickWon?"rgba(48,209,88,0.15)":"rgba(255,69,58,0.15)",
              border:"1px solid "+(pickWon?"rgba(48,209,88,0.4)":"rgba(255,69,58,0.4)"),
              color:pickWon?"#30D158":"#FF453A",
            }}, pickWon?"✅ CORRECT":"❌ MISSED");
          })(),
          game.status!=="final" && e("div",{style:{
            padding:"3px 10px", borderRadius:6, fontWeight:900, fontSize:12,
            fontFamily:F, letterSpacing:1,
            background:"rgba(126,184,247,0.1)", color:"#7EB8F7",
          }}, Math.round(pick.confidence)+"% CONF"),
        ),

        // Main pick row
        e("div",{style:{padding:"12px 14px",display:"flex",alignItems:"center",gap:16}},
          // Pick team logo
          pick.pick_abbr===game.home.abbr
            ? (game.home.logo&&e("img",{src:game.home.logo,width:44,height:44,style:{objectFit:"contain",filter:"drop-shadow(0 1px 6px rgba(0,0,0,0.8))",flexShrink:0}}))
            : (game.away.logo&&e("img",{src:game.away.logo,width:44,height:44,style:{objectFit:"contain",filter:"drop-shadow(0 1px 6px rgba(0,0,0,0.8))",flexShrink:0}})),

          e("div",{style:{flex:1}},
            e("div",{style:{fontSize:22,fontWeight:900,fontFamily:F,color:"#fff",letterSpacing:0.5}},
              pick.pick_abbr),
            e("div",{style:{fontSize:13,color:"rgba(255,255,255,0.4)",fontFamily:F,marginTop:2}},
              "to win"),
          ),

          // Projected scores
          e("div",{style:{textAlign:"right"}},
            e("div",{style:{fontSize:13,color:"rgba(255,255,255,0.35)",fontFamily:F,marginBottom:3}},"PROJECTED"),
            e("div",{style:{fontSize:18,fontWeight:900,fontFamily:F,color:"#fff",fontVariantNumeric:"tabular-nums"}},
              Math.round(pick.away_projected_score)+" – "+Math.round(pick.home_projected_score)),
            e("div",{style:{fontSize:11,color:"rgba(255,255,255,0.25)",fontFamily:F,marginTop:1}},
              pick.away_abbr+" vs "+pick.home_abbr),
          ),
        ),

        // Spread comparison row
        e("div",{style:{
          padding:"8px 14px 12px",
          display:"flex", gap:8, flexWrap:"wrap",
        }},
          // Model spread
          e("div",{style:{
            flex:1, minWidth:100, background:"rgba(126,184,247,0.08)",
            border:"1px solid rgba(126,184,247,0.2)", borderRadius:7, padding:"7px 10px",
          }},
            e("div",{style:{fontSize:10,fontWeight:900,fontFamily:F,color:"rgba(126,184,247,0.7)",letterSpacing:1,marginBottom:3}},"MODEL SPREAD"),
            e("div",{style:{fontSize:18,fontWeight:900,fontFamily:F,color:"#7EB8F7",fontVariantNumeric:"tabular-nums"}},
              (pick.predicted_spread>0?"+":"")+pick.predicted_spread.toFixed(1)),
          ),
          // Market spread
          e("div",{style:{
            flex:1, minWidth:100, background:"rgba(255,255,255,0.04)",
            border:"1px solid rgba(255,255,255,0.1)", borderRadius:7, padding:"7px 10px",
          }},
            e("div",{style:{fontSize:10,fontWeight:900,fontFamily:F,color:"rgba(255,255,255,0.35)",letterSpacing:1,marginBottom:3}},"MARKET SPREAD"),
            e("div",{style:{fontSize:18,fontWeight:900,fontFamily:F,color:"rgba(255,255,255,0.7)",fontVariantNumeric:"tabular-nums"}},
              pick.market&&pick.market.spread!=null
                ? (pick.market.spread>0?"+":"")+pick.market.spread
                : "—"),
          ),
          // Edge
          pick.model_vs_market && e("div",{style:{
            flex:1, minWidth:100,
            background:pick.model_vs_market.spread_edge>0?"rgba(48,209,88,0.08)":"rgba(255,69,58,0.08)",
            border:"1px solid "+(pick.model_vs_market.spread_edge>0?"rgba(48,209,88,0.25)":"rgba(255,69,58,0.25)"),
            borderRadius:7, padding:"7px 10px",
          }},
            e("div",{style:{fontSize:10,fontWeight:900,fontFamily:F,color:"rgba(255,255,255,0.35)",letterSpacing:1,marginBottom:3}},"EDGE"),
            e("div",{style:{fontSize:18,fontWeight:900,fontFamily:F,fontVariantNumeric:"tabular-nums",
              color:pick.model_vs_market.spread_edge>0?"#30D158":"#FF453A"}},
              (pick.model_vs_market.spread_edge>0?"+":"")+pick.model_vs_market.spread_edge.toFixed(1)),
          ),
        ),
      ),

      !loading&&detail&&tab==="box"&&game.status!=="pre"&&e("div",{style:{display:"flex",flexDirection:"column",gap:24}},
        e("div",null,
          e("div",{style:{fontSize:14,fontWeight:900,fontFamily:F,letterSpacing:2,color:game.away.color,marginBottom:10,textTransform:"uppercase"}},game.away.abbr+" — "+game.away.name),
          e(BoxTable,{players:detail.boxScore.away,color:game.away.color}),
        ),
        e("div",null,
          e("div",{style:{fontSize:14,fontWeight:900,fontFamily:F,letterSpacing:2,color:game.home.color,marginBottom:10,textTransform:"uppercase"}},game.home.abbr+" — "+game.home.name),
          e(BoxTable,{players:detail.boxScore.home,color:game.home.color}),
        ),
      ),

      !loading&&detail&&tab==="pbp"&&game.status!=="pre"&&(
        detail.plays.length
          ? e("div",{style:{display:"flex",flexDirection:"column",gap:2}},
              detail.plays.map((p,i)=>e("div",{key:i,style:{
                padding:"12px 14px",background:i%2===0?"rgba(255,255,255,0.03)":"transparent",borderRadius:6,
              }},
                e("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12}},
                  e("span",{style:{fontSize:15,color:"rgba(255,255,255,0.85)",fontFamily:F,flex:1,lineHeight:1.5}},p.text),
                  e("div",{style:{flexShrink:0,display:"flex",flexDirection:"column",alignItems:"flex-end",gap:3}},
                    p.clock&&e("span",{style:{fontSize:13,color:"rgba(255,255,255,0.35)",fontFamily:F,whiteSpace:"nowrap"}},p.clock),
                    (p.scoreAway!=null&&p.scoreHome!=null)&&e("span",{style:{fontSize:14,fontWeight:900,fontFamily:F,color:"rgba(255,255,255,0.5)",whiteSpace:"nowrap"}},p.scoreAway+" – "+p.scoreHome),
                  ),
                ),
              ))
            )
          : e("div",{style:{textAlign:"center",padding:60,color:"rgba(255,255,255,0.2)",fontSize:17,fontFamily:F,letterSpacing:2}},"NO PLAY DATA")
      ),
    ),
  );
}

// ═══════════════════════════════════════════════════════════════════
//  COMPONENTS
// ═══════════════════════════════════════════════════════════════════
function TeamLogo({ src, color, size }) {
  size = size || 40;
  const [err, setErr] = useState(false);
  if (!src||err) return e("div",{style:{width:size,height:size,borderRadius:5,flexShrink:0,background:color+"33",border:"1px solid "+color+"22"}});
  return e("img",{src,alt:"",width:size,height:size,onError:()=>setErr(true),style:{objectFit:"contain",flexShrink:0,filter:"drop-shadow(0 1px 5px rgba(0,0,0,0.9))"}});
}

function RankBadge({ rank, fontSize }) {
  if (!rank) return null;
  return e("span",{style:{fontSize,fontWeight:900,fontFamily:F,color:"#F5C518",background:"rgba(245,197,24,0.12)",border:"1px solid rgba(245,197,24,0.45)",borderRadius:3,padding:"0 3px",lineHeight:"1.3",flexShrink:0,marginRight:2}},"#"+rank);
}

// Return the market spread string from the picked team's perspective
// e.g. if market says "SIU +9.5" and pick is SIU → "+9.5"
//      if market says "SIU +9.5" and pick is the other team → "-9.5"
function pickSpreadLabel(pick) {
  if (!pick || !pick.market || pick.market.spread == null) return null;
  const mkt = pick.market.spread;
  const holder = (pick.market.spread_holder || "").trim();
  // If the spread_holder matches the pick, use as-is; otherwise flip
  const val = holder === pick.pick_abbr || holder === pick.pick ? mkt : -mkt;
  return (val > 0 ? "+" : "") + val;
}

function GameCard({ game, flash, rowH, favs, onTap }) {
  const pick    = game.pick || null;
  const covered = getCover(game);
  const isLive  = game.status === "live";
  const isFinal = game.status === "final";
  const isPre   = game.status === "pre";
  const hw = (game.home.score||0) > (game.away.score||0);
  const aw = (game.away.score||0) > (game.home.score||0);
  const isFav   = favs && (favs.has(game.home.abbr) || favs.has(game.away.abbr));

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
    const tf = favs && favs.has(t.abbr);
    return e("div",{style:{display:"flex",alignItems:"center",height:TROW,gap:6,overflow:"hidden",opacity:isFinal&&lose?0.4:1}},
      e(TeamLogo,{src:t.logo,color:t.color,size:logoSz}),
      e("div",{style:{display:"flex",alignItems:"baseline",gap:3,flex:"0 0 auto"}},
        tf && e("span",{style:{fontSize:rankFz*0.9,flexShrink:0,marginRight:1}},"⭐"),
        e(RankBadge,{rank:t.rank,fontSize:rankFz}),
        e("span",{style:{fontSize:abbrFz,fontWeight:900,color:"#fff",fontFamily:F,letterSpacing:0.5,lineHeight:1,whiteSpace:"nowrap"}},t.abbr),
        !isPre && e("span",{style:{fontSize:scoreFz,fontWeight:900,lineHeight:1,fontFamily:F,fontVariantNumeric:"tabular-nums",marginLeft:6,flexShrink:0,color:win?"#fff":"rgba(255,255,255,0.4)",textShadow:win&&isLive?"0 0 16px "+t.color+"bb":"none"}},t.score),
      ),
      isPre && t.record && !t.rank && e("span",{style:{fontSize:Math.round(abbrFz*0.68),color:"rgba(255,255,255,0.28)",fontFamily:F,marginLeft:4,flexShrink:0}},t.record),
    );
  };

  const leadCol = side => {
    const t=game[side], pp=game.leaders[side];
    return e("div",{style:{flex:1,minWidth:0,overflow:"hidden"}},
      e("div",{style:{fontSize:lhFz,fontWeight:800,letterSpacing:1,color:t.color,textTransform:"uppercase",fontFamily:F,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginBottom:Math.round(LEAD*0.04)}},t.abbr),
      pp.length
        ? pp.map((p,i)=>e("div",{key:i,style:{display:"flex",alignItems:"baseline",gap:3,marginBottom:Math.round(LEAD*0.03),overflow:"hidden"}},
            e("span",{style:{fontSize:lnFz,fontWeight:700,color:"rgba(255,255,255,0.82)",fontFamily:F,flex:"1 1 0",minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},p.name),
            e("span",{style:{fontSize:lpFz,fontWeight:900,color:"#fff",fontFamily:F,fontVariantNumeric:"tabular-nums",flexShrink:0}},p.pts),
            p.reb&&p.reb!=="0"&&p.reb!=="--"&&e("span",{style:{fontSize:lsFz,color:"rgba(255,255,255,0.38)",flexShrink:0}},p.reb+"r"),
            p.ast&&p.ast!=="0"&&p.ast!=="--"&&e("span",{style:{fontSize:lsFz,color:"rgba(255,255,255,0.38)",flexShrink:0}},p.ast+"a"),
          ))
        : e("span",{style:{fontSize:lnFz,color:"rgba(255,255,255,0.15)",fontStyle:"italic"}},"—"),
    );
  };

  const diamond = () => {
    const S=Math.round(LEAD*0.22);
    const b=on=>e("div",{style:{width:S,height:S,transform:"rotate(45deg)",flexShrink:0,background:on?"#F5A623":"rgba(255,255,255,0.1)",border:"1.5px solid "+(on?"#F5A623":"rgba(255,255,255,0.22)"),boxShadow:on?"0 0 5px #F5A623aa":"none"}});
    return e("div",{style:{display:"flex",flexDirection:"column",alignItems:"center",gap:Math.round(S*0.22),paddingRight:7,borderRight:"1px solid rgba(255,255,255,0.08)",flexShrink:0}},
      b(game.bases[1]),
      e("div",{style:{display:"flex",gap:Math.round(S)}},b(game.bases[2]),b(game.bases[0])),
      e("div",{style:{display:"flex",gap:3,marginTop:2}},[0,1,2].map(i=>e("div",{key:i,style:{width:5,height:5,borderRadius:"50%",background:i<game.outs?"#F5A623":"rgba(255,255,255,0.12)"}})))
    );
  };

  const hasAlert = !!game.alert;

  return e("div",{
    onClick: onTap,
    style:{
      display:"inline-flex",flexDirection:"column",
      width:cardW,height:rowH,flexShrink:0,
      paddingTop:PAD,paddingBottom:PAD,
      paddingLeft:Math.round(rowH*0.055),paddingRight:Math.round(rowH*0.055),
      borderRight:"1px solid rgba(255,255,255,0.07)",
      background: isFav
        ? "linear-gradient(180deg,rgba(245,197,24,0.07) 0%,#0d0d0d 70%)"
        : hasAlert ? "linear-gradient(180deg,"+game.alert.color+"18 0%,#0d0d0d 60%)"
        : flash    ? "linear-gradient(180deg,rgba(255,200,0,0.1) 0%,#0d0d0d 60%)"
        : "linear-gradient(180deg,rgba(255,255,255,0.025) 0%,#0d0d0d 100%)",
      position:"relative",overflow:"hidden",boxSizing:"border-box",
      cursor:"pointer",
    }},
    e("div",{style:{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,"+game.away.color+","+game.home.color+")",opacity:0.9}}),
    // Fav stripe
    isFav&&e("div",{style:{position:"absolute",top:0,right:0,width:3,bottom:0,background:"rgba(245,197,24,0.4)"}}),
    hasAlert&&e("div",{className:"alert-bar",style:{position:"absolute",top:0,left:0,right:0,height:STATUS+PAD,display:"flex",alignItems:"center",justifyContent:"center",gap:6,zIndex:10,background:"linear-gradient(90deg,transparent,"+game.alert.color+"28,"+game.alert.color+"40,"+game.alert.color+"28,transparent)"}},
      e("span",{style:{fontSize:stFz}},game.alert.type==="CLOSE"?"🚨":"🔥"),
      e("span",{style:{fontSize:stFz*0.82,fontWeight:900,fontFamily:F,color:game.alert.color,letterSpacing:0.8,textTransform:"uppercase"}},game.alert.text),
    ),
    e("div",{style:{height:STATUS,flexShrink:0,marginBottom:GAP1,display:"flex",alignItems:"center",justifyContent:"space-between",overflow:"hidden"}},
      e("div",{style:{display:"flex",alignItems:"center",gap:5}},
        isLive&&e("div",{className:"live-dot",style:{width:8,height:8,borderRadius:"50%",flexShrink:0,background:"#FF3B30",boxShadow:"0 0 7px #FF3B30"}}),
        e("span",{style:{fontSize:stFz,fontWeight:900,fontFamily:F,letterSpacing:1,color:isLive?"#FF3B30":"rgba(255,255,255,0.35)"}},game.period),
        isLive&&game.clock&&e("span",{style:{fontSize:stFz,fontWeight:700,fontFamily:F,color:"rgba(255,255,255,0.78)",marginLeft:3}},game.clock),
      ),
      e("div",{style:{display:"flex",alignItems:"center",gap:5}},
        game.channel&&e("div",{style:{display:"flex",alignItems:"center",gap:3,background:"rgba(255,255,255,0.07)",borderRadius:4,padding:"1px 5px"}},
          e("span",{style:{fontSize:chanFz}},"📺"),
          e("span",{style:{fontSize:chanFz,fontWeight:800,fontFamily:F,color:"rgba(255,255,255,0.7)"}},game.channel),
        ),
        game.spread&&e("div",{style:{display:"flex",alignItems:"center",gap:3,background:"rgba(255,255,255,0.06)",borderRadius:4,padding:"1px 5px"}},
          e("span",{style:{fontSize:chanFz*0.85,fontWeight:700,color:"rgba(255,255,255,0.28)",letterSpacing:0.5}},"SPR"),
          e("span",{style:{fontSize:chanFz,fontWeight:800,fontFamily:F,color:"rgba(255,255,255,0.72)"}},game.spread.favorite+" "+(game.spread.line>0?"+":"")+game.spread.line),
          covered!==null&&e("span",{style:{fontSize:chanFz,fontWeight:900,color:covered?"#30D158":"#FF453A"}},covered?"✓":"✗"),
        ),
      ),
    ),
    e("div",{style:{height:TEAMS,flexShrink:0,display:"flex",flexDirection:"column",justifyContent:"space-around"}},
      teamRow("away"),
      e("div",{style:{height:1,background:"rgba(255,255,255,0.07)",margin:"1px 0",flexShrink:0}}),
      teamRow("home"),
    ),
    e("div",{style:{height:GAP2,flexShrink:0}}),
    // LEADERS / PICK row
    pick
      ? e("div",{style:{height:LEAD,flexShrink:0,display:"flex",alignItems:"center",gap:6,overflow:"hidden",borderTop:"1px solid rgba(255,255,255,0.07)",paddingTop:Math.round(LEAD*0.06)}},
          // Pick result indicator (after game ends)
          (() => {
            if (game.status==="final") {
              const pickWon = (pick.pick_abbr===game.home.abbr&&(game.home.score||0)>(game.away.score||0))
                            ||(pick.pick_abbr===game.away.abbr&&(game.away.score||0)>(game.home.score||0));
              return e("span",{style:{fontSize:Math.round(LEAD*0.22),flexShrink:0}}, pickWon?"✅":"❌");
            }
            return e("span",{style:{fontSize:Math.round(LEAD*0.18),flexShrink:0}},"🧠");
          })(),
          e("div",{style:{flex:1,minWidth:0,overflow:"hidden"}},
            // PICK: EWU -3.5 (64%)
            e("div",{style:{display:"flex",alignItems:"baseline",gap:4,overflow:"hidden"}},
              e("span",{style:{fontSize:Math.round(LEAD*0.13),fontWeight:900,color:"rgba(255,255,255,0.45)",fontFamily:F,letterSpacing:0.5,flexShrink:0}},"PICK:"),
              e("span",{style:{fontSize:Math.round(LEAD*0.17),fontWeight:900,color:"#fff",fontFamily:F,letterSpacing:0.5,flexShrink:0}},pick.pick_abbr),
              pickSpreadLabel(pick)&&e("span",{style:{fontSize:Math.round(LEAD*0.15),fontWeight:900,color:"rgba(255,255,255,0.65)",fontFamily:F,fontVariantNumeric:"tabular-nums",flexShrink:0}},
                pickSpreadLabel(pick)),
              e("span",{style:{fontSize:Math.round(LEAD*0.12),color:"rgba(255,255,255,0.35)",fontFamily:F,flexShrink:0}},
                "("+Math.round(pick.confidence)+"%)"),
            ),
          ),
          // Edge pill
          pick.model_vs_market&&Math.abs(pick.model_vs_market.spread_edge)>=2&&
            e("div",{style:{flexShrink:0,background:pick.model_vs_market.spread_edge>0?"rgba(48,209,88,0.15)":"rgba(255,69,58,0.15)",border:"1px solid "+(pick.model_vs_market.spread_edge>0?"rgba(48,209,88,0.4)":"rgba(255,69,58,0.4)"),borderRadius:5,padding:"1px 5px"}},
              e("span",{style:{fontSize:Math.round(LEAD*0.13),fontWeight:900,fontFamily:F,color:pick.model_vs_market.spread_edge>0?"#30D158":"#FF453A"}},
                "EDGE "+(pick.model_vs_market.spread_edge>0?"+":"")+pick.model_vs_market.spread_edge.toFixed(1)),
            ),
        )
      : e("div",{style:{height:LEAD,flexShrink:0,display:"flex",gap:6,overflow:"hidden",borderTop:"1px solid rgba(255,255,255,0.07)",paddingTop:Math.round(LEAD*0.06)}},
          game.sport==="baseball"&&!isPre&&diamond(),
          leadCol("away"),
          e("div",{style:{width:1,background:"rgba(255,255,255,0.07)",alignSelf:"stretch",flexShrink:0}}),
          leadCol("home"),
        ),
  );
}

function SportLabel({ slot, rowH }) {
  const w = Math.round(rowH * 0.65);
  return e("div",{style:{width:w,flexShrink:0,height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:3,background:"linear-gradient(170deg,"+slot.accent+"EE,"+slot.accent+"88)",borderRight:"3px solid "+slot.accent}},
    e("span",{style:{fontSize:Math.round(rowH*0.2),lineHeight:1}},slot.icon),
    e("span",{style:{fontSize:Math.round(rowH*0.085),fontWeight:900,color:"#fff",letterSpacing:2,fontFamily:F}},slot.isCBB?"CBB":slot.label),
    slot.isCBB&&e("span",{style:{fontSize:Math.round(rowH*0.068),fontWeight:700,color:"rgba(255,255,255,0.72)",letterSpacing:0.8,fontFamily:F,textAlign:"center",padding:"0 3px",lineHeight:1.2}},slot.shortLabel),
  );
}

// ── SWIPEABLE SCROLL ROW ──────────────────────────────────────────
function ScrollRow({ rowH, speed, games, slot, flashIds, favs, onLoop, onSwipe, onTapGame }) {
  const scrollRef  = useRef(null);
  const animRef    = useRef(null);
  const xRef       = useRef(0);
  const tsRef      = useRef(null);
  const loopCnt    = useRef(0);
  const prevKey    = useRef(slot.key);
  // Touch state
  const touchStart = useRef(null);
  const touchDx    = useRef(0);
  const wasSwiped  = useRef(false);

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

  // Touch handlers for swipe
  const onTouchStart = useCallback(ev => {
    touchStart.current = ev.touches[0].clientX;
    touchDx.current = 0;
    wasSwiped.current = false;
  }, []);

  const onTouchMove = useCallback(ev => {
    if (touchStart.current === null) return;
    touchDx.current = ev.touches[0].clientX - touchStart.current;
  }, []);

  const onTouchEnd = useCallback(() => {
    const dx = touchDx.current;
    if (Math.abs(dx) > 40) {
      wasSwiped.current = true;
      onSwipe(dx < 0 ? 1 : -1); // swipe left = next, right = prev
    }
    touchStart.current = null;
  }, [onSwipe]);

  if (!games.length) return e("div",{style:{flex:1,display:"flex",alignItems:"center",justifyContent:"center",color:"rgba(255,255,255,0.12)",fontSize:Math.round(rowH*0.1),fontFamily:F,letterSpacing:3}},"NO GAMES TODAY");

  return e("div",{
    style:{flex:1,overflow:"hidden",position:"relative"},
    onTouchStart, onTouchMove, onTouchEnd,
  },
    e("div",{style:{position:"absolute",left:0,top:0,bottom:0,width:30,zIndex:4,background:"linear-gradient(to right,#0a0a0a 15%,transparent)",pointerEvents:"none"}}),
    e("div",{style:{position:"absolute",right:0,top:0,bottom:0,width:40,zIndex:4,background:"linear-gradient(to left,#0a0a0a 15%,transparent)",pointerEvents:"none"}}),
    e("div",{ref:scrollRef,style:{display:"inline-flex",alignItems:"stretch",height:"100%",willChange:"transform"}},
      [...games,...games].map((g,i)=>e(GameCard,{
        key:g.id+"-"+i, game:g, flash:flashIds.has(g.id), rowH, favs,
        onTap:()=>{ if(!wasSwiped.current) onTapGame(g); },
      }))
    ),
  );
}

// ═══════════════════════════════════════════════════════════════════
//  SCORES VIEW — static ESPN-style scoreboard
// ═══════════════════════════════════════════════════════════════════

function ScoreRow({ game, favs, onTap }) {
  const pick    = game.pick || null;
  const isLive  = game.status === "live";
  const isFinal = game.status === "final";
  const isPre   = game.status === "pre";
  const hw = !isPre && (game.home.score||0) > (game.away.score||0);
  const aw = !isPre && (game.away.score||0) > (game.home.score||0);
  const isFav   = favs.has(game.home.abbr) || favs.has(game.away.abbr);
  const covered = getCover(game);

  // Pick result
  let pickResult = null;
  if (pick && isFinal) {
    const won = (pick.pick_abbr===game.home.abbr && hw) || (pick.pick_abbr===game.away.abbr && aw);
    pickResult = won ? "✅" : "❌";
  }

  const teamLine = (side) => {
    const t   = game[side];
    const win = side==="home" ? hw : aw;
    const isTf = favs.has(t.abbr);
    return e("div",{style:{display:"flex",alignItems:"center",gap:10,padding:"5px 0"}},
      // Logo
      t.logo
        ? e("img",{src:t.logo,width:30,height:30,style:{objectFit:"contain",flexShrink:0,filter:"drop-shadow(0 1px 4px rgba(0,0,0,0.9))"}})
        : e("div",{style:{width:30,height:30,borderRadius:5,flexShrink:0,background:t.color+"33"}}),
      // Name + record
      e("div",{style:{flex:1,minWidth:0,display:"flex",alignItems:"baseline",gap:5,overflow:"hidden"}},
        isTf && e("span",{style:{fontSize:12,flexShrink:0}},"⭐"),
        t.rank && e("span",{style:{fontSize:12,fontWeight:900,fontFamily:F,color:"#F5C518",flexShrink:0}},"#"+t.rank),
        e("span",{style:{
          fontSize:17,fontWeight:900,fontFamily:F,letterSpacing:0.3,
          color: isFinal&&!win ? "rgba(255,255,255,0.3)" : "#fff",
          overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
        }}, t.abbr),
        isPre && t.record && e("span",{style:{fontSize:12,color:"rgba(255,255,255,0.28)",fontFamily:F,flexShrink:0}},t.record),
      ),
      // Score
      !isPre && e("span",{style:{
        fontSize:22,fontWeight:900,fontFamily:F,fontVariantNumeric:"tabular-nums",flexShrink:0,
        color: isFinal&&!win ? "rgba(255,255,255,0.25)" : "#fff",
        textShadow: win&&isLive ? "0 0 14px "+t.color+"cc" : "none",
        minWidth:30,textAlign:"right",
      }}, t.score),
    );
  };

  return e("div",{
    onClick: onTap,
    style:{
      borderRadius:10,
      border:"1px solid rgba(255,255,255,0.07)",
      background: isFav
        ? "linear-gradient(135deg,rgba(245,197,24,0.07),rgba(20,20,20,0.95))"
        : "linear-gradient(135deg,rgba(255,255,255,0.03),rgba(15,15,15,0.98))",
      cursor:"pointer",
      overflow:"hidden",
      position:"relative",
    },
  },
    // Top color bar
    e("div",{style:{height:3,background:"linear-gradient(90deg,"+game.away.color+","+game.home.color+")",opacity:0.8}}),

    e("div",{style:{padding:"8px 12px 10px"}},
      // Status row
      e("div",{style:{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}},
        e("div",{style:{display:"flex",alignItems:"center",gap:5}},
          isLive && e("div",{className:"live-dot",style:{width:7,height:7,borderRadius:"50%",background:"#FF3B30",boxShadow:"0 0 6px #FF3B30",flexShrink:0}}),
          e("span",{style:{
            fontSize:12,fontWeight:900,fontFamily:F,letterSpacing:0.8,
            color: isLive?"#FF3B30" : isFinal?"rgba(255,255,255,0.35)" : "rgba(255,255,255,0.55)",
          }}, game.period),
          isLive && game.clock && e("span",{style:{fontSize:12,fontFamily:F,color:"rgba(255,255,255,0.6)",marginLeft:2}},game.clock),
        ),
        game.channel && e("span",{style:{fontSize:11,color:"rgba(255,255,255,0.25)",fontFamily:F}},"📺 "+game.channel),
      ),

      // Team lines
      teamLine("away"),
      e("div",{style:{height:1,background:"rgba(255,255,255,0.06)",margin:"1px 0 1px 40px"}}),
      teamLine("home"),

      // Bottom row: spread + pick
      e("div",{style:{
        display:"flex",alignItems:"center",justifyContent:"space-between",
        marginTop:7,paddingTop:7,
        borderTop:"1px solid rgba(255,255,255,0.06)",
        gap:8,flexWrap:"wrap",
      }},
        // Spread
        game.spread
          ? e("div",{style:{display:"flex",alignItems:"center",gap:5}},
              e("span",{style:{fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.3)",fontFamily:F,letterSpacing:0.5}},"SPR"),
              e("span",{style:{fontSize:13,fontWeight:900,fontFamily:F,color:"rgba(255,255,255,0.7)"}},
                game.spread.favorite+" "+(game.spread.line>0?"+":"")+game.spread.line),
              covered!==null && e("span",{style:{fontSize:12,fontWeight:900,color:covered?"#30D158":"#FF453A"}},
                covered?"✓":"✗"),
            )
          : e("span",{style:{fontSize:11,color:"rgba(255,255,255,0.15)",fontFamily:F}},isPre?"":"—"),

        // Pick badge
        pick
          ? e("div",{style:{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}},
              e("span",{style:{fontSize:12}}, pickResult || "🧠"),
              e("span",{style:{fontSize:12,fontWeight:900,color:"rgba(255,255,255,0.4)",fontFamily:F}},"PICK:"),
              e("span",{style:{
                fontSize:13,fontWeight:900,fontFamily:F,letterSpacing:0.5,
                color: pickResult==="✅"?"#30D158" : pickResult==="❌"?"#FF453A" : "#fff",
              }}, pick.pick_abbr),
              pickSpreadLabel(pick)&&e("span",{style:{fontSize:13,fontWeight:900,color:"rgba(255,255,255,0.65)",fontFamily:F,fontVariantNumeric:"tabular-nums"}},
                pickSpreadLabel(pick)),
              e("span",{style:{fontSize:12,color:"rgba(255,255,255,0.35)",fontFamily:F}},
                "("+Math.round(pick.confidence)+"%)"),
            )
          : null,
      ),
    ),
  );
}

function ScoresView({ slots, favs, flashIds, onTapGame }) {
  const sections = [];
  let cbbSection = null;

  slots.forEach(sl => {
    if (sl.isCBB) {
      if (!cbbSection) {
        cbbSection = { key:"cbb_all", label:"College Basketball", icon:"🏀", accent:"#1A4A8A", groups:[] };
        sections.push(cbbSection);
      }
      cbbSection.groups.push({ label: sl.shortLabel, games: sl.games, slot: sl });
    } else {
      sections.push({ key:sl.key, label:sl.label, icon:sl.icon, accent:sl.accent, groups:[{ label:null, games:sl.games, slot:sl }] });
    }
  });

  return e("div",{style:{
    flex:1, overflowY:"auto", WebkitOverflowScrolling:"touch",
    background:"#0a0a0a", padding:"0 0 24px",
  }},
    sections.length===0 && e("div",{style:{
      display:"flex",alignItems:"center",justifyContent:"center",
      height:200,color:"rgba(255,255,255,0.1)",fontSize:16,fontFamily:F,letterSpacing:3,
    }},"LOADING…"),

    sections.map(sec => e("div",{key:sec.key},

      // Section header — sticky
      e("div",{style:{
        display:"flex",alignItems:"center",gap:10,
        padding:"12px 14px 8px",
        position:"sticky",top:0,zIndex:10,
        backdropFilter:"blur(10px)",
        WebkitBackdropFilter:"blur(10px)",
        background:"linear-gradient(90deg,"+sec.accent+"44 0%,rgba(10,10,10,0.96) 55%)",
        borderLeft:"4px solid "+sec.accent,
        borderBottom:"1px solid rgba(255,255,255,0.07)",
      }},
        e("span",{style:{fontSize:20}},sec.icon),
        e("span",{style:{fontSize:18,fontWeight:900,fontFamily:F,color:"#fff",letterSpacing:1}},sec.label),
        e("span",{style:{fontSize:12,color:"rgba(255,255,255,0.35)",fontFamily:F,marginLeft:2}},
          sec.groups.reduce((n,g)=>n+g.games.length,0)+" games"),
      ),

      // Groups
      sec.groups.map((grp,gi) => e("div",{key:gi},

        // Conference sub-header for CBB
        grp.label && e("div",{style:{
          padding:"6px 14px 5px",
          background:"rgba(255,255,255,0.03)",
          borderBottom:"1px solid rgba(255,255,255,0.05)",
        }},
          e("span",{style:{fontSize:12,fontWeight:900,fontFamily:F,color:"rgba(255,255,255,0.45)",letterSpacing:1.5}},
            grp.label.toUpperCase()+"  ·  "+grp.games.length+" games"),
        ),

        // 2-column card grid
        e("div",{style:{
          display:"grid",
          gridTemplateColumns:"repeat(2, 1fr)",
          gap:10,
          padding:"10px 12px",
        }},
          grp.games.map(g => e(ScoreRow,{
            key:g.id, game:g, favs,
            onTap:()=>onTapGame(g, grp.slot),
          })),
        ),
      )),
    )),
  );
}

// ═══════════════════════════════════════════════════════════════════
//  FAVORITES PANEL
// ═══════════════════════════════════════════════════════════════════
function FavPanel({ slots, favs, onToggle, onClose }) {
  const [search, setSearch] = useState("");

  // Collect every unique team across all slots, deduplicated by abbr
  const allTeams = [];
  const seen = new Set();
  slots.forEach(slot => {
    (slot.games || []).forEach(g => {
      [g.home, g.away].forEach(t => {
        if (!seen.has(t.abbr)) {
          seen.add(t.abbr);
          allTeams.push({
            abbr:  t.abbr,
            name:  t.name || t.abbr,
            logo:  t.logo,
            color: t.color,
            sport: slot.isCBB ? "CBB" : slot.label,
            conf:  slot.isCBB ? slot.shortLabel : null,
          });
        }
      });
    });
  });

  // Sort: favorites first, then alphabetically by name
  allTeams.sort((a, b) => {
    const fa = favs.has(a.abbr) ? 0 : 1;
    const fb = favs.has(b.abbr) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return a.name.localeCompare(b.name);
  });

  const filtered = search.trim()
    ? allTeams.filter(t =>
        t.name.toLowerCase().includes(search.toLowerCase()) ||
        t.abbr.toLowerCase().includes(search.toLowerCase())
      )
    : allTeams;

  const favCount = favs.size;

  return e("div", { style:{
    position:"fixed", inset:0, zIndex:200,
    background:"#0d0d0d",
    display:"flex", flexDirection:"column", overflow:"hidden",
  }},

    // Header
    e("div", { style:{
      flexShrink:0, padding:"14px 16px 12px",
      background:"linear-gradient(180deg,#1e1e1e,#141414)",
      borderBottom:"1px solid rgba(255,255,255,0.08)",
      display:"flex", flexDirection:"column", gap:10,
    }},
      e("div", { style:{ display:"flex", alignItems:"center", justifyContent:"space-between" }},
        e("div", { style:{ display:"flex", alignItems:"center", gap:10 }},
          e("span", { style:{ fontSize:22 }}, "⭐"),
          e("div", null,
            e("div", { style:{ fontSize:18, fontWeight:900, fontFamily:F, color:"#fff", letterSpacing:1 }}, "FAVORITE TEAMS"),
            e("div", { style:{ fontSize:12, color:"rgba(255,255,255,0.35)", fontFamily:F, marginTop:1 }},
              favCount > 0
                ? favCount + " team" + (favCount !== 1 ? "s" : "") + " favorited — shown first in ticker"
                : "Tap a team to favorite it"
            ),
          ),
        ),
        e("button", { onClick: onClose, style:{
          background:"rgba(255,255,255,0.08)", border:"1px solid rgba(255,255,255,0.12)",
          borderRadius:8, color:"rgba(255,255,255,0.7)", fontSize:18,
          cursor:"pointer", padding:"4px 12px", fontFamily:F, lineHeight:1.4,
        }}, "Done"),
      ),

      // Search box
      e("div", { style:{ position:"relative" }},
        e("span", { style:{
          position:"absolute", left:10, top:"50%", transform:"translateY(-50%)",
          fontSize:14, pointerEvents:"none", opacity:0.4,
        }}, "🔍"),
        e("input", {
          type:"text",
          placeholder:"Search teams…",
          value: search,
          onChange: ev => setSearch(ev.target.value),
          style:{
            width:"100%", background:"rgba(255,255,255,0.07)",
            border:"1px solid rgba(255,255,255,0.1)", borderRadius:8,
            color:"#fff", fontSize:15, fontFamily:F,
            padding:"8px 12px 8px 32px",
            outline:"none", boxSizing:"border-box",
          },
        }),
        search && e("button", {
          onClick: () => setSearch(""),
          style:{
            position:"absolute", right:8, top:"50%", transform:"translateY(-50%)",
            background:"none", border:"none", color:"rgba(255,255,255,0.4)",
            fontSize:16, cursor:"pointer", padding:"0 4px",
          },
        }, "×"),
      ),
    ),

    // Team list
    e("div", { style:{ flex:1, overflowY:"auto", WebkitOverflowScrolling:"touch" }},
      filtered.length === 0 && e("div", { style:{
        textAlign:"center", padding:40,
        color:"rgba(255,255,255,0.2)", fontSize:14, fontFamily:F, letterSpacing:2,
      }}, "NO TEAMS FOUND"),

      filtered.map(t => {
        const isFav = favs.has(t.abbr);
        return e("div", {
          key: t.abbr,
          onClick: () => onToggle(t.abbr),
          style:{
            display:"flex", alignItems:"center", gap:14,
            padding:"10px 16px",
            borderBottom:"1px solid rgba(255,255,255,0.05)",
            background: isFav ? "linear-gradient(90deg,rgba(245,197,24,0.08),transparent)" : "transparent",
            cursor:"pointer",
            transition:"background 0.15s",
          },
        },
          // Logo
          t.logo
            ? e("img", { src:t.logo, width:40, height:40, style:{ objectFit:"contain", flexShrink:0, filter:"drop-shadow(0 1px 4px rgba(0,0,0,0.8))" }})
            : e("div", { style:{ width:40, height:40, borderRadius:8, flexShrink:0, background:t.color+"33", border:"1px solid "+t.color+"44" }}),

          // Name + sport
          e("div", { style:{ flex:1, minWidth:0 }},
            e("div", { style:{
              fontSize:17, fontWeight:900, fontFamily:F,
              color: isFav ? "#fff" : "rgba(255,255,255,0.8)",
              letterSpacing:0.5,
            }}, t.name),
            e("div", { style:{ fontSize:12, color:"rgba(255,255,255,0.3)", fontFamily:F, marginTop:2 }},
              t.abbr + (t.conf ? " · " + t.conf : " · " + t.sport)
            ),
          ),

          // Star toggle
          e("div", { style:{
            width:36, height:36, borderRadius:8, flexShrink:0,
            display:"flex", alignItems:"center", justifyContent:"center",
            background: isFav ? "rgba(245,197,24,0.15)" : "rgba(255,255,255,0.05)",
            border:"1px solid " + (isFav ? "rgba(245,197,24,0.4)" : "rgba(255,255,255,0.08)"),
            fontSize:18,
            transition:"all 0.15s",
          }}, isFav ? "⭐" : "☆"),
        );
      }),

      // Clear all button at bottom if any favs
      favCount > 0 && e("div", { style:{ padding:"16px", textAlign:"center" }},
        e("button", {
          onClick: () => {
            favs.forEach(abbr => onToggle(abbr));
          },
          style:{
            background:"rgba(255,59,48,0.12)", border:"1px solid rgba(255,59,48,0.3)",
            borderRadius:8, color:"#FF3B30", fontSize:14, fontWeight:800,
            fontFamily:F, letterSpacing:1, cursor:"pointer", padding:"8px 20px",
          },
        }, "CLEAR ALL FAVORITES"),
      ),
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
  const [pinnedGame,  setPinnedGame]  = useState(null);
  const [showFavs,    setShowFavs]    = useState(false);
  const [picks,       setPicks]       = useState({});
  const [viewMode,    setViewMode]    = useState(() => {
    try { return localStorage.getItem("sb_view") || "ticker"; } catch { return "ticker"; }
  });
  const [favs,        setFavs]        = useState(() => {
    try {
      const saved = localStorage.getItem("sb_favs");
      return saved ? new Set(JSON.parse(saved)) : DEFAULT_FAVS;
    } catch { return DEFAULT_FAVS; }
  });

  const toggleFav = useCallback((abbr) => {
    setFavs(prev => {
      const next = new Set(prev);
      next.has(abbr) ? next.delete(abbr) : next.add(abbr);
      try { localStorage.setItem("sb_favs", JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  const toggleView = useCallback(() => {
    setViewMode(prev => {
      const next = prev === "ticker" ? "scores" : "ticker";
      try { localStorage.setItem("sb_view", next); } catch {}
      return next;
    });
  }, []);

  const prevScores = useRef({});
  const slotsRef   = useRef([]);

  useEffect(() => {
    const iv = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(iv);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const nextSlots = [];

      const prevLeaders = {};
      slotsRef.current.forEach(sl => {
        (sl.games||[]).forEach(g => {
          if (g.leaders&&(g.leaders.home.length||g.leaders.away.length)) prevLeaders[g.id]=g.leaders;
        });
      });

      // Fetch scores + picks in parallel
      const [picksMap, ...results] = await Promise.all([
        fetchPicks(),
        ...NON_CBB.map(lg => Promise.allSettled([
          espnFetch(lg.sport,lg.league,"scoreboard",{limit:40}).then(data=>({lg,events:(data&&data.events)||[]}))
        ]).then(r=>r[0])),
      ]);

      setPicks(picksMap);

      results.forEach(r => {
        if (r.status!=="fulfilled") return;
        const {lg,events}=r.value;
        const games = events.map(ev=>parseGame(ev,lg.sport,lg.league)).filter(Boolean)
          .map(g=>({...g,leaders:prevLeaders[g.id]||g.leaders}));
        games.forEach(g=>{prevScores.current[g.id]={home:g.home.score,away:g.away.score};});
        if (games.length>0) nextSlots.push({key:lg.key,label:lg.label,icon:lg.icon,accent:lg.accent,isCBB:false,sport:lg.sport,league:lg.league,games});
      });

      try {
        const cbbEvents = await fetchCBBEvents();
        const allGames  = cbbEvents.map(ev=>parseGame(ev,"basketball","mens-college-basketball")).filter(Boolean)
          .map(g=>({...g, leaders:prevLeaders[g.id]||g.leaders, pick:picksMap[g.id]||null }));
        allGames.forEach(g=>{prevScores.current[g.id]={home:g.home.score,away:g.away.score};});
        const confSlots = groupCBBByConf(allGames);
        const nbaIdx = nextSlots.findIndex(s=>s.key==="nba");
        nextSlots.splice(nbaIdx>=0?nbaIdx+1:nextSlots.length, 0, ...confSlots);
      } catch(err) { console.warn("[CBB]",err.message); }

      // Sort games within each slot: live → final → pre, favorites first within group
      nextSlots.forEach(sl => { sl.games = sortGames(sl.games, favs); });

      slotsRef.current = nextSlots;
      setSlots(nextSlots);
      const len = nextSlots.length;
      setR1(prev => Math.min(prev, Math.max(len-1,0)));
      setR2(prev => Math.min(prev, Math.max(len-1,0)));
      setLastUpdated(new Date());
    } catch(err) { console.error("[loadAll]",err); }
    finally { setLoading(false); }
  }, [favs]);

  useEffect(() => { loadAll(); const iv=setInterval(loadAll,POLL_MS); return()=>clearInterval(iv); }, [loadAll]);

  // Keep r2 !== r1
  useEffect(() => {
    if (slots.length<2) return;
    setR2(prev => prev===r1 ? (r1+1)%slots.length : Math.min(prev,slots.length-1));
  }, [r1, slots.length]);

  // Leaders poll
  useEffect(() => {
    if (!slots.length) return;
    let cancelled = false;
    const load = async () => {
      const visible = [slots[r1], slots[r2]].filter(Boolean);
      for (const slot of visible) {
        for (const g of slot.games.filter(g=>g.status!=="pre")) {
          if (cancelled) return;
          try {
            const s = await espnFetch(slot.sport,slot.league,"summary?event="+g.id,{});
            const leaders = parseLeaders(s);
            setSlots(prev => {
              const next = prev.map(sl=>sl.key!==slot.key?sl:{...sl,games:sl.games.map(x=>x.id===g.id?{...x,leaders}:x)});
              slotsRef.current=next; return next;
            });
          } catch {}
          await new Promise(r=>setTimeout(r,400));
        }
      }
    };
    load();
    const iv = setInterval(load, 65000);
    return () => { cancelled=true; clearInterval(iv); };
  }, [slots.length, r1, r2]); // eslint-disable-line

  // ── Wake Lock — keep screen on while ticker is visible ──────────
  useEffect(() => {
    let lock = null;
    if (viewMode !== "ticker") return;
    const acquire = async () => {
      try {
        if (navigator.wakeLock) {
          lock = await navigator.wakeLock.request("screen");
        }
      } catch {}
    };
    acquire();
    // Re-acquire if the page becomes visible again (e.g. switching tabs)
    const onVisible = () => { if (document.visibilityState === "visible") acquire(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (lock) lock.release().catch(()=>{});
    };
  }, [viewMode]);

  // Rotation
  const handleLoop = useCallback((rowNum) => {
    const len = slots.length; if (len<2) return;
    if (rowNum===1) setR1(prev=>{ let n=(prev+1)%len; if(n===r2) n=(n+1)%len; return n; });
    else            setR2(prev=>{ let n=(prev+1)%len; if(n===r1) n=(n+1)%len; return n; });
  }, [slots.length, r1, r2]);

  // Swipe: jump row to next/prev slot immediately
  const handleSwipe = useCallback((rowNum, dir) => {
    const len = slots.length; if (len<2) return;
    const other = rowNum===1 ? r2 : r1;
    if (rowNum===1) setR1(prev=>{ let n=((prev+dir)+len)%len; if(n===other&&len>2) n=((n+dir)+len)%len; return n; });
    else            setR2(prev=>{ let n=((prev+dir)+len)%len; if(n===other&&len>2) n=((n+dir)+len)%len; return n; });
  }, [slots.length, r1, r2]);

  // ── Render ──────────────────────────────────────────────────
  const HEADER_H = 44;
  const rowH     = Math.floor((window.innerHeight - HEADER_H) / 2);
  const slot1    = slots[r1] || null;
  const slot2    = slots[r2] || null;
  const spin     = { width:10,height:10,borderRadius:"50%",border:"2px solid rgba(255,255,255,0.15)",borderTopColor:"#fff",flexShrink:0 };

  const renderRow = (slot, rowNum, speed) => {
    const isBottom = rowNum===2;
    return e("div",{style:{height:rowH,flexShrink:0,display:"flex",alignItems:"stretch",borderTop:isBottom?"2px solid rgba(255,255,255,0.06)":undefined}},
      slot
        ? e(Fragment,null,
            e(SportLabel,{slot,rowH}),
            loading&&!slot.games.length
              ? e("div",{style:{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:10}},
                  e("div",{className:"spin",style:{...spin,width:13,height:13,borderWidth:3,borderTopColor:slot.accent}}),
                  e("span",{style:{fontSize:14,fontWeight:800,color:"rgba(255,255,255,0.28)",fontFamily:F,letterSpacing:3}},"LOADING…"))
              : e(ScrollRow,{rowH,speed,games:slot.games,slot,flashIds,favs,
                  onLoop:()=>handleLoop(rowNum),
                  onSwipe:(dir)=>handleSwipe(rowNum,dir),
                  onTapGame:(g)=>setPinnedGame({game:g,sport:slot.sport,league:slot.league}),
                }),
          )
        : e("div",{style:{flex:1,display:"flex",alignItems:"center",justifyContent:"center",color:"rgba(255,255,255,0.07)",fontSize:12,fontFamily:F,letterSpacing:3}},
            loading?"LOADING…":"NO GAMES"),
    );
  };

  return e(Fragment,null,
    // Favorites panel
    showFavs && e(FavPanel,{
      slots, favs,
      onToggle: toggleFav,
      onClose:  ()=>setShowFavs(false),
    }),

    // Detail panel overlay
    pinnedGame && e(DetailPanel,{
      game:        pinnedGame.game,
      sport:       pinnedGame.sport,
      league:      pinnedGame.league,
      favs,
      onToggleFav: toggleFav,
      onClose:     ()=>setPinnedGame(null),
    }),

    e("div",{style:{width:"100vw",height:"100vh",display:"flex",flexDirection:"column",background:"#0a0a0a",overflow:"hidden"}},
      // HEADER
      e("div",{style:{height:HEADER_H,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 12px",background:"linear-gradient(180deg,#1c1c1c,#111)",borderBottom:"1px solid rgba(255,255,255,0.07)"}},
        e("div",{style:{display:"flex",gap:4,alignItems:"center",flex:1,overflow:"hidden"}},
          slots.map((sl,i) => {
            const isR1 = i===r1, isR2 = i===r2, active = isR1||isR2;
            return e("div",{
              key:sl.key,
              onClick:()=>{
                if (isR1||isR2) return; // already showing
                // Replace whichever row last looped (r2 is "older" heuristic)
                setR2(i);
              },
              style:{display:"flex",alignItems:"center",gap:3,padding:"2px 7px",borderRadius:20,flexShrink:0,
                cursor:active?"default":"pointer",
                background:active?sl.accent+"30":"rgba(255,255,255,0.04)",
                border:"1px solid "+(active?sl.accent:"rgba(255,255,255,0.08)"),
                transition:"all 0.15s",
                opacity:active?1:0.7,
              }},
              e("span",{style:{fontSize:11}},sl.icon),
              e("span",{style:{fontSize:10,fontWeight:800,fontFamily:F,letterSpacing:1,color:active?"#fff":"rgba(255,255,255,0.35)"}},sl.isCBB?sl.shortLabel:sl.label),
              e("span",{style:{fontSize:9,color:active?"rgba(255,255,255,0.5)":"rgba(255,255,255,0.16)"}}," "+sl.games.length),
              isR1&&e("span",{style:{fontSize:8,marginLeft:2,color:sl.accent,fontWeight:900,fontFamily:F}},"▲"),
              isR2&&e("span",{style:{fontSize:8,marginLeft:2,color:sl.accent,fontWeight:900,fontFamily:F}},"▼"),
            );
          }),
          loading&&e("div",{className:"spin",style:spin}),
        ),
        e("div",{style:{display:"flex",alignItems:"center",gap:6,flexShrink:0}},
          // View mode toggle
          e("button",{
            onClick: toggleView,
            title: viewMode==="ticker" ? "Switch to Scores view" : "Switch to Ticker view",
            style:{
              background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.12)",
              borderRadius:7, cursor:"pointer", padding:"3px 8px",
              fontSize:13, lineHeight:1, display:"flex", alignItems:"center", gap:4,
              color:"rgba(255,255,255,0.7)",
            },
          },
            e("span",null, viewMode==="ticker" ? "⊞" : "▶▶"),
            e("span",{style:{fontSize:10,fontWeight:900,fontFamily:F,letterSpacing:0.5}},
              viewMode==="ticker" ? "SCORES" : "TICKER"),
          ),
          e("button",{
            onClick:()=>setShowFavs(true),
            style:{
              background: favs.size>0 ? "rgba(245,197,24,0.15)" : "rgba(255,255,255,0.06)",
              border:"1px solid "+(favs.size>0?"rgba(245,197,24,0.35)":"rgba(255,255,255,0.1)"),
              borderRadius:7, cursor:"pointer", padding:"3px 8px",
              fontSize:14, lineHeight:1, display:"flex", alignItems:"center", gap:4,
            },
          },
            e("span",null,"⭐"),
            favs.size>0&&e("span",{style:{fontSize:10,fontWeight:900,fontFamily:F,color:"#F5C518"}},favs.size),
          ),
          lastUpdated&&e("span",{style:{fontSize:10,color:"rgba(255,255,255,0.18)",fontFamily:F}},lastUpdated.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})),
          e("span",{style:{fontSize:20,fontWeight:900,color:"rgba(255,255,255,0.78)",fontFamily:F}},clock.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})),
        ),
      ),
      viewMode === "ticker"
        ? e(Fragment, null,
            renderRow(slot1,1,SPEED_ROW1),
            renderRow(slot2,2,SPEED_ROW2),
          )
        : e(ScoresView, { slots, favs, flashIds, onTapGame:(g,sl)=>setPinnedGame({game:g,sport:sl.sport,league:sl.league}) }),
    ),
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(e(SportsBoard,null));
