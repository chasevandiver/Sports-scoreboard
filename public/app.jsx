// ═══════════════════════════════════════════════════════════════════
//  SPORTS SCOREBOARD — public/app.jsx
//  v4 — All D1 CBB conferences, Top-25 rankings, TV channel,
//       breaking news / close game flash alerts, faster scroll
// ═══════════════════════════════════════════════════════════════════

const { useState, useEffect, useRef, useCallback } = React;

const POLL_SCORES_MS  = 30_000;
const POLL_LEADERS_MS = 60_000;
const SPEED_ROW1 = 90;   // px/sec — fast couch-readable pace
const SPEED_ROW2 = 75;   // px/sec — slightly slower so rows drift apart

const F = "'Barlow Condensed','Arial Narrow',Arial,sans-serif";

// ── ALERT SYSTEM ─────────────────────────────────────────────────────
// Conditions that trigger a flashing alert banner on a card:
//   SCORE_CHANGE  — any live score update
//   CLOSE_GAME    — live game within 3 pts in final 2 min (bball) or final period
//   COMEBACK      — team erases 10+ point deficit
const ALERT_DURATION_MS = 8000;

// ── CBB CONFERENCES ───────────────────────────────────────────────────
// Each major D1 conference gets its own rotation slot.
// ESPN groups IDs: https://gist.github.com/akeaswaran/b48f02bf897b960f6e98
// Fetching per-conference means ~8-12 games per request instead of 100+,
// which prevents the memory crash on the server.
const CBB_CONFERENCES = [
  { id:"2",   label:"Big 12"    },
  { id:"8",   label:"ACC"       },
  { id:"23",  label:"Big East"  },
  { id:"21",  label:"Big Ten"   },
  { id:"7",   label:"Pac-12"    },
  { id:"9",   label:"SEC"       },
  { id:"18",  label:"AAC"       },
  { id:"25",  label:"MWC"       },
  { id:"45",  label:"A-10"      },
  { id:"49",  label:"WCC"       },
  { id:"24",  label:"MAC"       },
  { id:"46",  label:"CUSA"      },
  { id:"48",  label:"Sun Belt"  },
  { id:"37",  label:"Horizon"   },
  { id:"44",  label:"Missouri V"},
  { id:"26",  label:"Ivy"       },
  { id:"40",  label:"Patriot"   },
  { id:"29",  label:"SoCon"     },
  { id:"60",  label:"CAA"       },
  { id:"11",  label:"SWAC"      },
  { id:"31",  label:"MEAC"      },
  { id:"13",  label:"OVC"       },
  { id:"38",  label:"NEC"       },
  { id:"62",  label:"Summit"    },
  { id:"10",  label:"WAC"       },
  { id:"41",  label:"Big South" },
  { id:"56",  label:"Am. East"  },
  { id:"43",  label:"Big West"  },
  { id:"30",  label:"ASun"      },
].map(c => ({
  sport:   "basketball",
  league:  "mens-college-basketball",
  label:   `CBB·${c.label}`,
  shortLabel: c.label,
  icon:    "🏀",
  accent:  "#1A4A8A",
  groups:  c.id,
  isCBB:   true,
}));

// ── ALL LEAGUES ───────────────────────────────────────────────────────
// CBB conferences are separate entries — each fetches only its own games.
// isCBB entries share the "NCAAM" settings-panel label so they toggle together.
const NON_CBB = [
  { sport:"basketball", league:"nba",              label:"NBA",   icon:"🏀", accent:"#C9082A", groups:null },
  { sport:"hockey",     league:"nhl",              label:"NHL",   icon:"🏒", accent:"#00539B", groups:null },
  { sport:"baseball",   league:"mlb",              label:"MLB",   icon:"⚾", accent:"#002D72", groups:null },
  { sport:"football",   league:"nfl",              label:"NFL",   icon:"🏈", accent:"#013369", groups:null },
  { sport:"football",   league:"college-football", label:"NCAAF", icon:"🏈", accent:"#8B2500", groups:"80" },
  { sport:"basketball", league:"wnba",             label:"WNBA",  icon:"🏀", accent:"#C96A2A", groups:null },
];

// Settings panel groups CBB conferences under one "NCAAM" toggle
const SETTINGS_GROUPS = [
  { key:"NCAAM", label:"NCAAM", icon:"🏀", accent:"#1A4A8A" },
  ...NON_CBB.map(l=>({ key:l.league, label:l.label, icon:l.icon, accent:l.accent })),
];

const ALL_LEAGUES = [...NON_CBB, ...CBB_CONFERENCES];

// ── ESPN FETCH ────────────────────────────────────────────────────────
async function espnFetch(sport, league, extra="", params={}) {
  let path = `${sport}/${league}/${extra}`;
  const qs  = new URLSearchParams(params).toString();
  if (qs) path += (path.includes("?") ? "&" : "?") + qs;
  const res = await fetch(`/api/espn?path=${encodeURIComponent(path)}`, {
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text || text.trim()[0] === "<") throw new Error("Non-JSON response");
  return JSON.parse(text);
}

// Unique storage key for a league entry (CBB conferences share league name but differ by groups)
function leagueKey(lg) {
  return lg.isCBB ? `cbb_${lg.groups}` : lg.league;
}
  if (lg.isCBB) return { groups: lg.groups, limit: 50 };
  if (lg.groups) return { groups: lg.groups, limit: 100 };
  return { limit: 50 };
}

// ── PARSE SCOREBOARD EVENT ────────────────────────────────────────────
function parseGame(event, sport, league) {
  try {
    const comp = event.competitions?.[0];
    if (!comp) return null;
    const home = comp.competitors?.find(c => c.homeAway === "home");
    const away = comp.competitors?.find(c => c.homeAway === "away");
    if (!home || !away) return null;

    const sType     = comp.status?.type ?? {};
    const state     = sType.state ?? "pre";
    const completed = sType.completed ?? false;
    const status    = completed ? "final" : state === "in" ? "live" : "pre";

    const period = comp.status?.period ?? 0;
    const clock  = comp.status?.displayClock ?? "";

    let periodLabel = "";
    if (status === "live") {
      if      (sport === "basketball") periodLabel = `Q${period}`;
      else if (sport === "hockey")     periodLabel = `P${period}`;
      else if (sport === "football")   periodLabel = `Q${period}`;
      else if (sport === "baseball")   periodLabel = sType.shortDetail ?? `INN ${period}`;
    } else if (status === "final") {
      periodLabel = sType.shortDetail ?? "Final";
    } else {
      const d = comp.date ? new Date(comp.date) : null;
      periodLabel = d ? d.toLocaleTimeString([], { hour:"numeric", minute:"2-digit" }) : "TBD";
    }

    // Spread
    const odds = comp.odds?.[0];
    let spread = null;
    if (odds?.details && odds.details !== "EVEN") {
      const p = odds.details.trim().split(" ");
      if (p.length === 2) spread = { favorite:p[0], line:parseFloat(p[1]) };
    }

    const mkColor = t => "#" + (t.team?.color ?? "444444").replace("#","");
    const sit = comp.situation ?? null;

    // ── Rankings (Top 25) ─────────────────────────────────────────
    // ESPN puts curatedRank.current or rank on the competitor object
    const homeRank = home.curatedRank?.current ?? home.rank ?? null;
    const awayRank = away.curatedRank?.current ?? away.rank ?? null;

    // ── TV / Broadcast channel ────────────────────────────────────
    // ESPN returns broadcasts as array of {market,names:[]} on competition
    const broadcasts = comp.broadcasts ?? [];
    let channel = null;
    if (broadcasts.length) {
      // Prefer national broadcast, fallback to first available
      const national = broadcasts.find(b => b.market === "national" || !b.market);
      const src = national ?? broadcasts[0];
      channel = src.names?.[0] ?? src.media?.shortName ?? null;
    }
    // Also check geoBroadcasts
    if (!channel && comp.geoBroadcasts?.length) {
      channel = comp.geoBroadcasts[0]?.media?.shortName ?? null;
    }

    // Conference (CBB / NCAAF)
    const conference = home.team?.conferenceId
      ? (home.team?.conference?.abbreviation ?? null)
      : null;

    return {
      id: event.id, sport, league, status,
      period: periodLabel,
      clock: status==="live" && sport!=="baseball" ? clock : "",
      clockSecs: parseClockToSeconds(clock, period, sport, status),
      home: {
        abbr:   home.team.abbreviation ?? "HM",
        color:  mkColor(home),
        logo:   home.team.logo ?? null,
        score:  status!=="pre" ? parseInt(home.score??0) : null,
        record: home.records?.[0]?.summary ?? "",
        rank:   homeRank && homeRank <= 25 ? homeRank : null,
      },
      away: {
        abbr:   away.team.abbreviation ?? "AW",
        color:  mkColor(away),
        logo:   away.team.logo ?? null,
        score:  status!=="pre" ? parseInt(away.score??0) : null,
        record: away.records?.[0]?.summary ?? "",
        rank:   awayRank && awayRank <= 25 ? awayRank : null,
      },
      spread, channel, conference,
      bases: sit ? [!!sit.onFirst,!!sit.onSecond,!!sit.onThird] : [false,false,false],
      outs: sit?.outs??0,
      leaders: { home:[], away:[] },
      alert: null,  // populated by alert engine
    };
  } catch { return null; }
}

// Convert "2:34" clock + period → total seconds remaining (approx)
function parseClockToSeconds(clock, period, sport, status) {
  if (status !== "live" || !clock) return null;
  const parts = clock.split(":").map(Number);
  if (parts.length !== 2) return null;
  return parts[0]*60 + parts[1];
}

// ── ALERT ENGINE ──────────────────────────────────────────────────────
// Returns alert object or null for a game given its previous state
function detectAlert(game, prev) {
  if (game.status !== "live") return null;
  const hs = game.home.score ?? 0;
  const as = game.away.score ?? 0;
  const diff = Math.abs(hs - as);
  const secs = game.clockSecs;

  // Score just changed
  if (prev && (prev.home !== hs || prev.away !== as)) {
    const scorer = hs > (prev.home??0) ? game.home.abbr : game.away.abbr;
    const pts    = hs > (prev.home??0) ? hs-(prev.home??0) : as-(prev.away??0);
    return { type:"SCORE", text:`${scorer} scores${pts>1?` (${pts})`:""}`, color:"#F5A623" };
  }

  // Close game in final stretch (basketball: Q4 under 2 min, ≤5 pts)
  if (game.sport==="basketball" && game.period==="Q4" && secs!==null && secs<=120 && diff<=5) {
    return { type:"CLOSE", text:`${diff===0?"TIE GAME":"CLOSE GAME"} — ${game.period} ${game.clock}`, color:"#FF453A" };
  }

  // Close game: football Q4 under 2 min within 8
  if (game.sport==="football" && game.period==="Q4" && secs!==null && secs<=120 && diff<=8) {
    return { type:"CLOSE", text:`CLOSE GAME — ${game.period} ${game.clock}`, color:"#FF453A" };
  }

  // Close game: hockey P3 under 2 min within 1
  if (game.sport==="hockey" && game.period==="P3" && secs!==null && secs<=120 && diff<=1) {
    return { type:"CLOSE", text:`CLOSE GAME — ${game.period} ${game.clock}`, color:"#FF453A" };
  }

  return null;
}

// ── PARSE GAME SUMMARY → top 2 scorers ───────────────────────────────
function parseLeaders(summary, game) {
  try {
    const result   = { home:[], away:[] };
    const boxscore = summary?.boxscore;
    if (!boxscore) return result;

    const headerComps = summary?.header?.competitions?.[0]?.competitors ?? [];
    const homeId      = headerComps.find(c=>c.homeAway==="home")?.team?.id;

    (boxscore.players??[]).forEach(group=>{
      const side  = group.team?.id===homeId?"home":"away";
      const stats = group.statistics?.[0];
      if (!stats) return;
      const labels   = stats.labels??[];
      const ptsIdx   = labels.indexOf("PTS");
      const gIdx     = labels.indexOf("G");
      const rebIdx   = labels.indexOf("REB");
      const astIdx   = labels.indexOf("AST");
      const scoreIdx = ptsIdx>=0?ptsIdx:gIdx>=0?gIdx:0;
      result[side] = (stats.athletes??[])
        .filter(a=>a.stats?.length&&a.stats.some(s=>s!=="--"&&s!=="0"))
        .sort((a,b)=>parseFloat(b.stats?.[scoreIdx]??0)-parseFloat(a.stats?.[scoreIdx]??0))
        .slice(0,2)
        .map(a=>({
          name: a.athlete?.shortName??a.athlete?.displayName??"—",
          pts:  a.stats?.[scoreIdx]??"—",
          reb:  rebIdx>=0?a.stats?.[rebIdx]:null,
          ast:  astIdx>=0?a.stats?.[astIdx]:null,
        }));
    });

    if (!result.home.length&&!result.away.length) {
      (summary.leaders??[]).forEach(lg=>{
        const l=lg.leaders?.[0];
        if(!l) return;
        const side=homeId===lg.team?.id?"home":"away";
        if(result[side].length<2) result[side].push({
          name:l.athlete?.shortName??"—", pts:l.value??"—", reb:null, ast:null,
        });
      });
    }
    return result;
  } catch { return { home:[], away:[] }; }
}

function getCover(game) {
  if (game.status!=="final"||!game.spread?.line) return null;
  const {home,away,spread}=game;
  const favIsHome=spread.favorite===home.abbr;
  const margin=favIsHome?home.score-away.score:away.score-home.score;
  return margin>Math.abs(spread.line);
}

// ═══════════════════════════════════════════════════════════════════
//  COMPONENTS
// ═══════════════════════════════════════════════════════════════════

function Diamond({bases,outs}) {
  const S=13;
  const b=on=>({
    width:S,height:S,transform:"rotate(45deg)",flexShrink:0,
    background:on?"#F5A623":"rgba(255,255,255,0.1)",
    border:`2px solid ${on?"#F5A623":"rgba(255,255,255,0.2)"}`,
    boxShadow:on?"0 0 6px #F5A623aa":"none",
  });
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3,
      paddingRight:10,borderRight:"1px solid rgba(255,255,255,0.08)"}}>
      <div style={b(bases[1])}/>
      <div style={{display:"flex",gap:16}}>
        <div style={b(bases[2])}/><div style={b(bases[0])}/>
      </div>
      <div style={{display:"flex",gap:4,marginTop:3}}>
        {[0,1,2].map(i=>(
          <div key={i} style={{width:6,height:6,borderRadius:"50%",
            background:i<outs?"#F5A623":"rgba(255,255,255,0.12)",
            border:"1px solid rgba(255,255,255,0.2)"}}/>
        ))}
      </div>
    </div>
  );
}

function Logo({src,color,size=44}) {
  const [err,setErr]=useState(false);
  if(!src||err) return (
    <div style={{width:size,height:size,borderRadius:6,flexShrink:0,
      background:`${color}33`,border:`2px solid ${color}22`}}/>
  );
  return <img src={src} alt="" width={size} height={size} onError={()=>setErr(true)}
    style={{objectFit:"contain",flexShrink:0,filter:"drop-shadow(0 2px 6px rgba(0,0,0,0.8))"}}/>;
}

// ── Rank badge ────────────────────────────────────────────────────────
function RankBadge({rank,sz}) {
  if (!rank) return null;
  return (
    <span style={{
      fontSize:sz*0.55, fontWeight:900, fontFamily:F,
      color:"#F5C518", background:"rgba(245,197,24,0.15)",
      border:"1px solid rgba(245,197,24,0.4)",
      borderRadius:4, padding:"1px 4px", lineHeight:1,
      marginRight:3, flexShrink:0,
    }}>#{rank}</span>
  );
}

// ── Alert Banner ──────────────────────────────────────────────────────
function AlertBanner({alert,rowH}) {
  if (!alert) return null;
  return (
    <div style={{
      position:"absolute", top:0, left:0, right:0,
      height:Math.floor(rowH*0.14),
      display:"flex", alignItems:"center", justifyContent:"center",
      gap:8, zIndex:20,
      background:`linear-gradient(90deg, transparent, ${alert.color}33, ${alert.color}55, ${alert.color}33, transparent)`,
      animation:"alertPulse 0.6s ease-in-out infinite alternate",
    }}>
      <span style={{fontSize:Math.floor(rowH*0.09),lineHeight:1}}>
        {alert.type==="CLOSE"?"🚨":alert.type==="SCORE"?"🔥":"📺"}
      </span>
      <span style={{
        fontSize:Math.floor(rowH*0.09), fontWeight:900, fontFamily:F,
        color:alert.color, letterSpacing:1.5, textTransform:"uppercase",
      }}>{alert.text}</span>
    </div>
  );
}

// ── GAME CARD ─────────────────────────────────────────────────────────
function GameCard({game,flash,rowH}) {
  const covered  = getCover(game);
  const isLive   = game.status==="live";
  const isFinal  = game.status==="final";
  const isPre    = game.status==="pre";
  const homeWin  = (game.home.score??0)>(game.away.score??0);
  const awayWin  = (game.away.score??0)>(game.home.score??0);
  const hasAlert = !!game.alert;

  const scoreSz    = Math.floor(rowH*0.26);
  const abbrSz     = Math.floor(rowH*0.14);
  const leaderSz   = Math.floor(rowH*0.08);
  const leaderPtSz = Math.floor(rowH*0.10);
  const logoSz     = Math.floor(rowH*0.22);
  const cardW      = Math.floor(rowH*1.4);  // narrower cards = more games visible

  return (
    <div style={{
      display:"inline-flex", flexDirection:"column",
      width:cardW, height:"100%", flexShrink:0,
      padding:`${Math.floor(rowH*0.07)}px ${Math.floor(rowH*0.08)}px`,
      borderRight:"1px solid rgba(255,255,255,0.07)",
      background: hasAlert
        ? `linear-gradient(180deg,${game.alert.color}18 0%,transparent 40%)`
        : flash
          ? "linear-gradient(180deg,rgba(255,210,0,0.12) 0%,transparent 50%)"
          : "linear-gradient(180deg,rgba(255,255,255,0.02) 0%,transparent 100%)",
      transition:"background 0.5s",
      position:"relative", overflow:"hidden",
    }}>
      {/* Top color stripe */}
      <div style={{position:"absolute",top:0,left:0,right:0,height:3,
        background:`linear-gradient(90deg,${game.away.color},${game.home.color})`,opacity:0.8}}/>

      {/* Alert banner */}
      {hasAlert && <AlertBanner alert={game.alert} rowH={rowH}/>}

      {/* ── STATUS + CHANNEL ROW ── */}
      <div style={{
        display:"flex",alignItems:"center",justifyContent:"space-between",
        marginBottom:Math.floor(rowH*0.05),flexShrink:0,
        marginTop: hasAlert ? Math.floor(rowH*0.14) : 0,
        transition:"margin-top 0.3s",
      }}>
        {/* Left: live dot + period + clock */}
        <div style={{display:"flex",alignItems:"center",gap:7}}>
          {isLive&&(
            <div style={{width:9,height:9,borderRadius:"50%",background:"#FF3B30",
              boxShadow:"0 0 7px #FF3B30",animation:"livePulse 1.1s ease-in-out infinite",flexShrink:0}}/>
          )}
          <span style={{fontSize:Math.floor(rowH*0.10),fontWeight:900,fontFamily:F,letterSpacing:1,
            color:isLive?"#FF3B30":"rgba(255,255,255,0.38)"}}>{game.period}</span>
          {isLive&&game.clock&&(
            <span style={{fontSize:Math.floor(rowH*0.12),fontWeight:800,fontFamily:F,
              color:"rgba(255,255,255,0.85)"}}>{game.clock}</span>
          )}
        </div>

        {/* Right: TV channel + spread */}
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          {/* TV Channel */}
          {game.channel&&(
            <div style={{display:"flex",alignItems:"center",gap:4,
              background:"rgba(255,255,255,0.08)",borderRadius:5,
              padding:`2px ${Math.floor(rowH*0.04)}px`}}>
              <span style={{fontSize:Math.floor(rowH*0.07)}}>📺</span>
              <span style={{fontSize:Math.floor(rowH*0.08),fontWeight:800,fontFamily:F,
                color:"rgba(255,255,255,0.75)",letterSpacing:0.5}}>{game.channel}</span>
            </div>
          )}

          {/* Spread */}
          {game.spread&&(
            <div style={{display:"flex",alignItems:"center",gap:5,
              background:"rgba(255,255,255,0.07)",borderRadius:5,
              padding:`2px ${Math.floor(rowH*0.04)}px`}}>
              <span style={{fontSize:Math.floor(rowH*0.065),fontWeight:700,
                color:"rgba(255,255,255,0.35)",letterSpacing:1}}>SPR</span>
              <span style={{fontSize:Math.floor(rowH*0.09),fontWeight:800,fontFamily:F,
                color:"rgba(255,255,255,0.8)"}}>
                {game.spread.favorite} {game.spread.line>0?"+":""}{game.spread.line}
              </span>
              {covered!==null&&(
                <span style={{fontSize:Math.floor(rowH*0.09),fontWeight:900,
                  color:covered?"#30D158":"#FF453A",
                  textShadow:covered?"0 0 8px rgba(48,209,88,0.7)":"0 0 8px rgba(255,69,58,0.7)"}}>
                  {covered?"✓":"✗"}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── TEAMS + SCORES ── */}
      <div style={{display:"flex",flexDirection:"column",gap:Math.floor(rowH*0.04),
        flex:1,justifyContent:"center"}}>

        {/* Away */}
        <div style={{display:"flex",alignItems:"center",gap:9,
          opacity:isFinal&&homeWin?0.45:1,transition:"opacity 0.4s"}}>
          <Logo src={game.away.logo} color={game.away.color} size={logoSz}/>
          {/* Rank + Abbr + Score all snug together */}
          <div style={{display:"flex",alignItems:"baseline",gap:6,flex:1,minWidth:0}}>
            <RankBadge rank={game.away.rank} sz={abbrSz}/>
            <span style={{fontSize:abbrSz,fontWeight:900,color:"#fff",letterSpacing:0.5,
              lineHeight:1,fontFamily:F}}>{game.away.abbr}</span>
            {!isPre&&(
              <span style={{fontSize:scoreSz,fontWeight:900,lineHeight:1,fontFamily:F,
                fontVariantNumeric:"tabular-nums",marginLeft:4,
                color:awayWin?"#fff":"rgba(255,255,255,0.45)",
                textShadow:awayWin&&isLive?`0 0 22px ${game.away.color}cc`:"none",
                transition:"all 0.4s"}}>{game.away.score}</span>
            )}
            {game.away.record&&!game.away.rank&&isPre&&(
              <span style={{fontSize:Math.floor(rowH*0.065),color:"rgba(255,255,255,0.3)",
                fontWeight:600}}>{game.away.record}</span>
            )}
          </div>
        </div>

        <div style={{height:1,background:"rgba(255,255,255,0.07)"}}/>

        {/* Home */}
        <div style={{display:"flex",alignItems:"center",gap:9,
          opacity:isFinal&&awayWin?0.45:1,transition:"opacity 0.4s"}}>
          <Logo src={game.home.logo} color={game.home.color} size={logoSz}/>
          {/* Rank + Abbr + Score all snug together */}
          <div style={{display:"flex",alignItems:"baseline",gap:6,flex:1,minWidth:0}}>
            <RankBadge rank={game.home.rank} sz={abbrSz}/>
            <span style={{fontSize:abbrSz,fontWeight:900,color:"#fff",letterSpacing:0.5,
              lineHeight:1,fontFamily:F}}>{game.home.abbr}</span>
            {!isPre&&(
              <span style={{fontSize:scoreSz,fontWeight:900,lineHeight:1,fontFamily:F,
                fontVariantNumeric:"tabular-nums",marginLeft:4,
                color:homeWin?"#fff":"rgba(255,255,255,0.45)",
                textShadow:homeWin&&isLive?`0 0 22px ${game.home.color}cc`:"none",
                transition:"all 0.4s"}}>{game.home.score}</span>
            )}
            {game.home.record&&!game.home.rank&&isPre&&(
              <span style={{fontSize:Math.floor(rowH*0.065),color:"rgba(255,255,255,0.3)",
                fontWeight:600}}>{game.home.record}</span>
            )}
          </div>
        </div>
      </div>

      {/* ── LEADERS ── */}
      <div style={{display:"flex",gap:8,alignItems:"flex-start",
        borderTop:"1px solid rgba(255,255,255,0.07)",
        paddingTop:Math.floor(rowH*0.055),marginTop:Math.floor(rowH*0.04),flexShrink:0}}>

        {game.sport==="baseball"&&!isPre&&(
          <Diamond bases={game.bases} outs={game.outs}/>
        )}

        {["away","home"].map((side,si)=>(
          <React.Fragment key={side}>
            {si===1&&<div style={{width:1,background:"rgba(255,255,255,0.07)",alignSelf:"stretch"}}/>}
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:Math.floor(rowH*0.06),fontWeight:800,letterSpacing:1.5,
                marginBottom:3,color:game[side].color,textTransform:"uppercase",fontFamily:F,
                textShadow:`0 0 8px ${game[side].color}44`}}>{game[side].abbr}</div>
              {game.leaders[side].length>0 ? game.leaders[side].map((p,i)=>(
                <div key={i} style={{display:"flex",alignItems:"baseline",gap:4,marginBottom:2}}>
                  <span style={{fontSize:leaderSz,fontWeight:800,color:"rgba(255,255,255,0.85)",
                    whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",
                    maxWidth:Math.floor(rowH*0.65),fontFamily:F}}>{p.name}</span>
                  <span style={{fontSize:leaderPtSz,fontWeight:900,color:"#fff",lineHeight:1,
                    fontVariantNumeric:"tabular-nums",fontFamily:F}}>{p.pts}</span>
                  {p.reb&&p.reb!=="0"&&p.reb!=="--"&&(
                    <span style={{fontSize:leaderSz*0.8,color:"rgba(255,255,255,0.4)",fontWeight:700}}>
                      {p.reb}r</span>
                  )}
                  {p.ast&&p.ast!=="0"&&p.ast!=="--"&&(
                    <span style={{fontSize:leaderSz*0.8,color:"rgba(255,255,255,0.4)",fontWeight:700}}>
                      {p.ast}a</span>
                  )}
                </div>
              )) : (
                <span style={{fontSize:leaderSz,color:"rgba(255,255,255,0.15)",fontStyle:"italic"}}>—</span>
              )}
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// ── SETTINGS PANEL ────────────────────────────────────────────────────
function SettingsPanel({enabledSet,gameCount,onToggle,onClose}) {
  return (
    <div style={{
      position:"fixed",inset:0,zIndex:100,
      background:"rgba(0,0,0,0.85)",
      display:"flex",alignItems:"center",justifyContent:"center",
    }} onClick={onClose}>
      <div style={{
        background:"#181818",border:"1px solid rgba(255,255,255,0.12)",
        borderRadius:16,padding:28,minWidth:340,maxWidth:480,width:"90vw",
        maxHeight:"85vh",overflowY:"auto",
      }} onClick={e=>e.stopPropagation()}>

        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:22}}>
          <span style={{fontSize:22,fontWeight:900,color:"#fff",fontFamily:F,letterSpacing:2}}>
            SPORTS SELECTOR
          </span>
          <button onClick={onClose} style={{
            background:"rgba(255,255,255,0.1)",border:"1px solid rgba(255,255,255,0.15)",
            color:"#fff",borderRadius:8,padding:"6px 14px",fontSize:14,
            fontFamily:F,fontWeight:800,cursor:"pointer",letterSpacing:1,
          }}>DONE</button>
        </div>

        <p style={{fontSize:13,color:"rgba(255,255,255,0.35)",marginBottom:18,lineHeight:1.5}}>
          Toggle sports on/off. NCAAM shows one conference at a time per row.
        </p>

        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {SETTINGS_GROUPS.map(sg=>{
            const enabled = enabledSet.has(sg.key);
            const count   = gameCount(sg.key);
            return (
              <div key={sg.key} onClick={()=>onToggle(sg.key)} style={{
                display:"flex",alignItems:"center",gap:14,
                padding:"12px 16px",borderRadius:10,cursor:"pointer",
                background:enabled?`${sg.accent}22`:"rgba(255,255,255,0.04)",
                border:`1.5px solid ${enabled?sg.accent:"rgba(255,255,255,0.08)"}`,
                transition:"all 0.2s",
                opacity:count>0?1:0.45,
              }}>
                <span style={{fontSize:24}}>{sg.icon}</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:16,fontWeight:900,color:"#fff",fontFamily:F,letterSpacing:1}}>
                    {sg.label}
                  </div>
                  <div style={{fontSize:12,color:"rgba(255,255,255,0.35)",marginTop:1}}>
                    {count>0?`${count} game${count!==1?"s":""} today`:"No games today"}
                  </div>
                </div>
                <div style={{
                  width:44,height:24,borderRadius:12,position:"relative",
                  background:enabled?sg.accent:"rgba(255,255,255,0.15)",
                  transition:"background 0.2s",flexShrink:0,
                }}>
                  <div style={{
                    position:"absolute",top:3,
                    left:enabled?22:3,
                    width:18,height:18,borderRadius:"50%",
                    background:"#fff",transition:"left 0.2s",
                    boxShadow:"0 1px 4px rgba(0,0,0,0.4)",
                  }}/>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── SPORT LABEL (left of each row) ────────────────────────────────────
function SportLabel({meta,rowH}) {
  const topLine    = meta.isCBB ? "CBB" : meta.label;
  const bottomLine = meta.isCBB ? meta.shortLabel : null;
  return (
    <div style={{
      width:Math.floor(rowH*0.72),flexShrink:0,height:"100%",
      display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:2,
      background:`linear-gradient(160deg,${meta.accent},${meta.accent}99)`,
      borderRight:`3px solid ${meta.accent}`,zIndex:5,
    }}>
      <span style={{fontSize:Math.floor(rowH*0.22),lineHeight:1}}>{meta.icon}</span>
      <span style={{fontSize:Math.floor(rowH*0.09),fontWeight:900,color:"#fff",
        letterSpacing:2,fontFamily:F}}>{topLine}</span>
      {bottomLine&&(
        <span style={{fontSize:Math.floor(rowH*0.075),fontWeight:700,
          color:"rgba(255,255,255,0.7)",letterSpacing:1,fontFamily:F,textAlign:"center",
          padding:"0 4px"}}>{bottomLine}</span>
      )}
    </div>
  );
}

// ── SCROLLING ROW ─────────────────────────────────────────────────────
function ScrollRow({rowH,speed,games,meta,flashIds,onLoop}) {
  const scrollRef = useRef(null);
  const animRef   = useRef(null);
  const xRef      = useRef(0);
  const tsRef     = useRef(null);
  const pausedRef = useRef(false);

  const animate = useCallback((ts)=>{
    if (!scrollRef.current) return;
    if (!pausedRef.current) {
      if (tsRef.current===null) tsRef.current=ts;
      const delta=Math.min((ts-tsRef.current)/1000,0.05);
      tsRef.current=ts;
      xRef.current+=speed*delta;
      const half=scrollRef.current.scrollWidth/2;
      if (half>0&&xRef.current>=half) { xRef.current=0; onLoop(); }
      scrollRef.current.style.transform=`translateX(-${xRef.current}px)`;
    }
    animRef.current=requestAnimationFrame(animate);
  },[speed,onLoop]);

  useEffect(()=>{
    xRef.current=0; tsRef.current=null;
    cancelAnimationFrame(animRef.current);
    animRef.current=requestAnimationFrame(animate);
    return()=>cancelAnimationFrame(animRef.current);
  },[animate,meta.league]);

  if (!games.length) return (
    <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",
      color:"rgba(255,255,255,0.15)",fontSize:Math.floor(rowH*0.11),fontFamily:F,letterSpacing:3}}>
      NO GAMES
    </div>
  );

  return (
    <div style={{flex:1,overflow:"hidden",position:"relative"}}
      onTouchStart={()=>{pausedRef.current=true;}}
      onTouchEnd={()=>{pausedRef.current=false;tsRef.current=null;}}
    >
      <div style={{position:"absolute",left:0,top:0,bottom:0,width:35,zIndex:4,
        background:"linear-gradient(to right,#0a0a0a 30%,transparent)",pointerEvents:"none"}}/>
      <div style={{position:"absolute",right:0,top:0,bottom:0,width:45,zIndex:4,
        background:"linear-gradient(to left,#0a0a0a 30%,transparent)",pointerEvents:"none"}}/>

      <div ref={scrollRef} style={{display:"inline-flex",alignItems:"stretch",
        height:"100%",willChange:"transform"}}>
        {[...games,...games].map((g,i)=>(
          <GameCard key={`${g.id}-${i}`} game={g}
            flash={flashIds.has(g.id)} rowH={rowH}/>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════════════
function SportsBoard() {
  const [allGames,      setAllGames]      = useState({});
  const [flashIds,      setFlashIds]      = useState(new Set());
  const [loading,       setLoading]       = useState(true);
  const [loadError,     setLoadError]     = useState(null);
  const [lastUpdated,   setLastUpdated]   = useState(null);
  const [clock,         setClock]         = useState(new Date());
  const [activeLeagues, setActiveLeagues] = useState([]);
  const [row1Idx,       setRow1Idx]       = useState(0);
  const [row2Idx,       setRow2Idx]       = useState(1);
  const [showSettings,  setShowSettings]  = useState(false);
  // enabledLeagues: set of settings-group keys the user has turned ON
  // "NCAAM" covers all CBB conferences. Non-CBB use their league string.
  const [enabledLeagues, setEnabledLeagues] = useState(
    ()=>new Set(SETTINGS_GROUPS.map(g=>g.key))
  );

  const prevScores = useRef({});
  const alertTimers = useRef({});

  useEffect(()=>{
    const iv=setInterval(()=>setClock(new Date()),1000);
    return()=>clearInterval(iv);
  },[]);

  // ── FETCH LEAGUE ─────────────────────────────────────────────────
  const fetchLeague = useCallback(async(lg)=>{
    const key    = leagueKey(lg);
    const data   = await espnFetch(lg.sport, lg.league, "scoreboard", leagueParams(lg));
    const events = data.events ?? [];
    const games  = events.map(e=>parseGame(e,lg.sport,lg.league)).filter(Boolean);

    const updatedGames = games.map(g=>{
      const prev = prevScores.current[g.id];
      let alert  = detectAlert(g, prev);

      if (prev&&g.status==="live"&&(prev.home!==g.home.score||prev.away!==g.away.score)) {
        setFlashIds(f=>new Set([...f,g.id]));
        setTimeout(()=>setFlashIds(f=>{const n=new Set(f);n.delete(g.id);return n;}),2500);
      }

      if (alert) {
        if (alertTimers.current[g.id]) clearTimeout(alertTimers.current[g.id]);
        alertTimers.current[g.id] = setTimeout(()=>{
          setAllGames(prev=>({
            ...prev,
            [key]:(prev[key]??[]).map(x=>x.id===g.id?{...x,alert:null}:x),
          }));
        }, ALERT_DURATION_MS);
      }

      prevScores.current[g.id]={home:g.home.score,away:g.away.score};
      return {...g,alert};
    });

    return { key, games:updatedGames };
  },[]);

  // ── FETCH LEADERS ─────────────────────────────────────────────────
  const fetchLeaders = useCallback(async(game,lg)=>{
    if(game.status==="pre") return;
    const key = leagueKey(lg);
    try {
      const summary=await espnFetch(lg.sport,lg.league,`summary?event=${game.id}`);
      const leaders=parseLeaders(summary,game);
      setAllGames(prev=>({
        ...prev,
        [key]:(prev[key]??[]).map(g=>g.id===game.id?{...g,leaders}:g),
      }));
    } catch{}
  },[]);

  // ── LOAD ALL SCORES ────────────────────────────────────────────────
  // Fetch leagues in small batches to avoid hammering ESPN / OOM
  const loadAllScores=useCallback(async()=>{
    setLoading(true);
    try {
      const nextGames={};
      const withGames=[];
      const BATCH = 4; // fetch 4 leagues at a time

      for (let i=0; i<ALL_LEAGUES.length; i+=BATCH) {
        const batch = ALL_LEAGUES.slice(i, i+BATCH);
        const results = await Promise.allSettled(batch.map(fetchLeague));
        results.forEach((r,bi)=>{
          if(r.status==="fulfilled"){
            const {key,games}=r.value;
            nextGames[key]=games;
            const lg = batch[bi];
            const settingsKey = lg.isCBB ? "NCAAM" : lg.league;
            if(games.length>0 && enabledLeagues.has(settingsKey)) withGames.push(lg);
          }
        });
        // Small pause between batches — avoids ESPN rate-limit
        if (i+BATCH < ALL_LEAGUES.length) {
          await new Promise(r=>setTimeout(r,400));
        }
      }

      setAllGames(nextGames);
      setActiveLeagues(withGames);
      setRow1Idx(i=>Math.min(i,Math.max(withGames.length-1,0)));
      setRow2Idx(i=>withGames.length>1?Math.min(i,withGames.length-1):0);
      setLastUpdated(new Date());
      setLoadError(null);
    } catch(e) {
      console.error("[LOAD] Fatal error in loadAllScores:", e.message);
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  },[fetchLeague,enabledLeagues]);

  useEffect(()=>{
    loadAllScores();
    const iv=setInterval(loadAllScores,POLL_SCORES_MS);
    return()=>clearInterval(iv);
  },[loadAllScores]);

  // Poll leaders
  useEffect(()=>{
    if(!activeLeagues.length) return;
    const load=async()=>{
      const rows=[activeLeagues[row1Idx],activeLeagues[row2Idx]].filter(Boolean);
      for(const lg of rows){
        const games=(allGames[leagueKey(lg)]??[]).filter(g=>g.status!=="pre");
        for(const g of games){
          await fetchLeaders(g,lg);
          await new Promise(r=>setTimeout(r,350));
        }
      }
    };
    load();
    const iv=setInterval(load,POLL_LEADERS_MS);
    return()=>clearInterval(iv);
  },[activeLeagues,row1Idx,row2Idx,allGames,fetchLeaders]);

  // ── ROW ROTATION ──────────────────────────────────────────────────
  const handleRow1Loop=useCallback(()=>{
    setRow1Idx(prev=>{
      const next=(prev+1)%Math.max(activeLeagues.length,1);
      return next===row2Idx&&activeLeagues.length>2?(next+1)%activeLeagues.length:next;
    });
  },[activeLeagues.length,row2Idx]);

  const handleRow2Loop=useCallback(()=>{
    setRow2Idx(prev=>{
      const next=(prev+1)%Math.max(activeLeagues.length,1);
      return next===row1Idx&&activeLeagues.length>2?(next+1)%activeLeagues.length:next;
    });
  },[activeLeagues.length,row1Idx]);

  // ── TOGGLE A SPORT ON/OFF ─────────────────────────────────────────
  const toggleLeague = useCallback((league)=>{
    setEnabledLeagues(prev=>{
      const next=new Set(prev);
      if(next.has(league)) next.delete(league); else next.add(league);
      return next;
    });
  },[]);

  const meta1  = activeLeagues[row1Idx]??ALL_LEAGUES[0];
  const meta2  = activeLeagues.length>1?(activeLeagues[row2Idx]??ALL_LEAGUES[1]):null;
  const games1 = allGames[leagueKey(meta1)]??[];
  const games2 = meta2?(allGames[leagueKey(meta2)]??[]):[];

  const headerH=48;
  const rowHNum=Math.floor(((typeof window!=="undefined"?window.innerHeight:768)-headerH)/2);

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800;900&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
        html,body{width:100%;height:100%;overflow:hidden;background:#0a0a0a;-webkit-text-size-adjust:100%;}
        @keyframes livePulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:0.15;transform:scale(0.6);}}
        @keyframes spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}
        @keyframes alertPulse{from{opacity:0.7;}to{opacity:1;}}
      `}</style>

      {/* Settings panel overlay */}
      {showSettings&&(
        <SettingsPanel
          enabledSet={enabledLeagues}
          gameCount={key=>{
            if(key==="NCAAM") return CBB_CONFERENCES.reduce((s,c)=>s+(allGames[leagueKey(c)]?.length??0),0);
            return allGames[key]?.length??0;
          }}
          onToggle={toggleLeague}
          onClose={()=>setShowSettings(false)}
        />
      )}

      <div style={{width:"100vw",height:"100vh",display:"flex",flexDirection:"column",background:"#0a0a0a"}}>

        {/* Fatal error screen — shows instead of blank page */}
        {loadError && activeLeagues.length===0 && (
          <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",
            alignItems:"center",justifyContent:"center",gap:16,zIndex:50,background:"#0a0a0a"}}>
            <span style={{fontSize:48}}>📡</span>
            <div style={{fontSize:20,fontWeight:800,color:"rgba(255,255,255,0.5)",
              fontFamily:F,letterSpacing:2,textAlign:"center"}}>
              CONNECTION ERROR
            </div>
            <div style={{fontSize:13,color:"rgba(255,255,255,0.25)",fontFamily:F,
              maxWidth:400,textAlign:"center",lineHeight:1.6}}>
              {loadError}<br/>Retrying in 30 seconds…
            </div>
          </div>
        )}

        {/* ── HEADER ── */}
        <div style={{height:headerH,flexShrink:0,display:"flex",alignItems:"center",
          justifyContent:"space-between",padding:"0 18px",
          background:"linear-gradient(180deg,#1a1a1a 0%,#111 100%)",
          borderBottom:"1px solid rgba(255,255,255,0.08)"}}>

          <div style={{display:"flex",gap:7,alignItems:"center",flexWrap:"nowrap",overflow:"hidden"}}>
            {activeLeagues.map((lg,i)=>{
              const isActive=i===row1Idx||i===row2Idx;
              return (
                <div key={lg.league} style={{
                  display:"flex",alignItems:"center",gap:5,
                  padding:"3px 9px",borderRadius:20,flexShrink:0,
                  background:isActive?`${lg.accent}33`:"rgba(255,255,255,0.05)",
                  border:`1px solid ${isActive?lg.accent:"rgba(255,255,255,0.1)"}`,
                  transition:"all 0.3s",
                }}>
                  <span style={{fontSize:13}}>{lg.icon}</span>
                  <span style={{fontSize:12,fontWeight:800,fontFamily:F,letterSpacing:1,
                    color:isActive?"#fff":"rgba(255,255,255,0.4)"}}>{lg.label}</span>
                  <span style={{fontSize:11,fontWeight:700,
                    color:isActive?"rgba(255,255,255,0.6)":"rgba(255,255,255,0.2)"}}>
                    {allGames[leagueKey(lg)]?.length??0}
                  </span>
                </div>
              );
            })}
            {loading&&(
              <div style={{width:9,height:9,borderRadius:"50%",marginLeft:4,
                border:"2px solid rgba(255,255,255,0.15)",borderTopColor:"#fff",
                animation:"spin 0.8s linear infinite"}}/>
            )}
          </div>

          <div style={{display:"flex",alignItems:"center",gap:12}}>
            {lastUpdated&&(
              <span style={{fontSize:11,color:"rgba(255,255,255,0.2)",fontFamily:F,letterSpacing:1}}>
                {lastUpdated.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})}
              </span>
            )}
            <span style={{fontSize:24,fontWeight:900,color:"rgba(255,255,255,0.8)",fontFamily:F,letterSpacing:1}}>
              {clock.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}
            </span>
            {/* Gear button — opens sport selector */}
            <button
              onClick={()=>setShowSettings(s=>!s)}
              style={{
                background:"rgba(255,255,255,0.08)",
                border:"1px solid rgba(255,255,255,0.15)",
                color:"#fff",borderRadius:8,
                width:36,height:36,fontSize:18,
                cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",
                flexShrink:0,
              }}
              title="Select sports"
            >⚙️</button>
          </div>
        </div>

        {/* ── ROW 1 ── */}
        <div style={{height:`calc((100vh - ${headerH}px) / 2)`,flexShrink:0,
          display:"flex",alignItems:"stretch",borderBottom:"2px solid rgba(255,255,255,0.06)"}}>
          <SportLabel meta={meta1} rowH={rowHNum}/>
          <ScrollRow rowH={rowHNum} speed={SPEED_ROW1} games={games1}
            meta={meta1} flashIds={flashIds} onLoop={handleRow1Loop}/>
        </div>

        {/* ── ROW 2 ── */}
        {meta2?(
          <div style={{height:`calc((100vh - ${headerH}px) / 2)`,flexShrink:0,
            display:"flex",alignItems:"stretch"}}>
            <SportLabel meta={meta2} rowH={rowHNum}/>
            <ScrollRow rowH={rowHNum} speed={SPEED_ROW2} games={games2}
              meta={meta2} flashIds={flashIds} onLoop={handleRow2Loop}/>
          </div>
        ):(
          <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",
            color:"rgba(255,255,255,0.08)",fontSize:15,fontFamily:F,letterSpacing:3}}>
            NO OTHER SPORTS TODAY
          </div>
        )}
      </div>
    </>
  );
}

const root=ReactDOM.createRoot(document.getElementById("root"));
root.render(<SportsBoard/>);
