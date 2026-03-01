// ═══════════════════════════════════════════════════════════════════
//  SPORTS SCOREBOARD — public/app.jsx
//  Two independent scrolling rows, each showing a different sport.
//  Only sports with games TODAY are shown — off-season sports hidden.
//  Auto-rotates sports every time the row loops back to the start.
//  Top 2 scorers per team pulled from ESPN game summaries.
//  Scores refresh every 30s, leaders every 60s.
// ═══════════════════════════════════════════════════════════════════

const { useState, useEffect, useRef, useCallback } = React;

const POLL_SCORES_MS  = 30_000;
const POLL_LEADERS_MS = 60_000;
// Row 1 scrolls slightly faster than Row 2 so they feel independent
const SPEED_ROW1 = 45;
const SPEED_ROW2 = 35;

const F = "'Barlow Condensed','Arial Narrow',Arial,sans-serif";

// All possible leagues — only ones with games today will be shown
const ALL_LEAGUES = [
  { sport:"basketball", league:"nba",                     label:"NBA",   icon:"🏀", accent:"#C9082A" },
  { sport:"basketball", league:"mens-college-basketball", label:"NCAAM", icon:"🏀", accent:"#1A4A8A" },
  { sport:"hockey",     league:"nhl",                     label:"NHL",   icon:"🏒", accent:"#00539B" },
  { sport:"baseball",   league:"mlb",                     label:"MLB",   icon:"⚾", accent:"#002D72" },
  { sport:"football",   league:"nfl",                     label:"NFL",   icon:"🏈", accent:"#013369" },
  { sport:"football",   league:"college-football",        label:"NCAAF", icon:"🏈", accent:"#8B2500" },
  { sport:"basketball", league:"wnba",                    label:"WNBA",  icon:"🏀", accent:"#C96A2A" },
];

// ── ESPN FETCH (same-origin proxy, no CORS) ──────────────────────────
async function espnFetch(sport, league, extra="") {
  const path = `${sport}/${league}/${extra}`;
  const res  = await fetch(`/api/espn?path=${encodeURIComponent(path)}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text || text.trim()[0] === "<") throw new Error("Server returned HTML");
  return JSON.parse(text);
}

// ── PARSE ESPN scoreboard event ──────────────────────────────────────
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

    const odds = comp.odds?.[0];
    let spread = null;
    if (odds?.details && odds.details !== "EVEN") {
      const p = odds.details.trim().split(" ");
      if (p.length === 2) spread = { favorite: p[0], line: parseFloat(p[1]) };
    }

    const mkColor = t => "#" + (t.team?.color ?? "444444").replace("#","");
    const sit = comp.situation ?? null;

    return {
      id: event.id, sport, league, status,
      period: periodLabel,
      clock:  status === "live" && sport !== "baseball" ? clock : "",
      home: {
        abbr:   home.team.abbreviation ?? "HM",
        color:  mkColor(home),
        logo:   home.team.logo ?? null,
        score:  status !== "pre" ? parseInt(home.score ?? 0) : null,
        record: home.records?.[0]?.summary ?? "",
      },
      away: {
        abbr:   away.team.abbreviation ?? "AW",
        color:  mkColor(away),
        logo:   away.team.logo ?? null,
        score:  status !== "pre" ? parseInt(away.score ?? 0) : null,
        record: away.records?.[0]?.summary ?? "",
      },
      spread,
      bases: sit ? [!!sit.onFirst, !!sit.onSecond, !!sit.onThird] : [false,false,false],
      outs:  sit?.outs ?? 0,
      leaders: { home:[], away:[] },
    };
  } catch(e) {
    return null;
  }
}

// ── PARSE game summary → top 2 scorers per team ──────────────────────
function parseLeaders(summary, game) {
  try {
    const result   = { home:[], away:[] };
    const boxscore = summary?.boxscore;
    if (!boxscore) return result;

    const headerComps = summary?.header?.competitions?.[0]?.competitors ?? [];
    const homeId      = headerComps.find(c => c.homeAway === "home")?.team?.id;

    (boxscore.players ?? []).forEach(group => {
      const side  = group.team?.id === homeId ? "home" : "away";
      const stats = group.statistics?.[0];
      if (!stats) return;

      const labels   = stats.labels ?? [];
      const ptsIdx   = labels.indexOf("PTS");
      const gIdx     = labels.indexOf("G");
      const rebIdx   = labels.indexOf("REB");
      const astIdx   = labels.indexOf("AST");
      const scoreIdx = ptsIdx >= 0 ? ptsIdx : gIdx >= 0 ? gIdx : 0;

      result[side] = (stats.athletes ?? [])
        .filter(a => a.stats?.length && a.stats.some(s => s !== "--" && s !== "0"))
        .sort((a,b) => parseFloat(b.stats?.[scoreIdx]??0) - parseFloat(a.stats?.[scoreIdx]??0))
        .slice(0,2)
        .map(a => ({
          name: a.athlete?.shortName ?? a.athlete?.displayName ?? "—",
          pts:  a.stats?.[scoreIdx] ?? "—",
          reb:  rebIdx >= 0 ? a.stats?.[rebIdx] : null,
          ast:  astIdx >= 0 ? a.stats?.[astIdx] : null,
        }));
    });

    // Fallback: ESPN pre-computed leaders array
    if (!result.home.length && !result.away.length) {
      (summary.leaders ?? []).forEach(lg => {
        const l = lg.leaders?.[0];
        if (!l) return;
        const isHome = homeId === lg.team?.id;
        const side   = isHome ? "home" : "away";
        if (result[side].length < 2) result[side].push({
          name: l.athlete?.shortName ?? "—",
          pts:  l.value ?? "—",
          reb: null, ast: null,
        });
      });
    }
    return result;
  } catch { return { home:[], away:[] }; }
}

function getCover(game) {
  if (game.status !== "final" || !game.spread?.line) return null;
  const { home, away, spread } = game;
  const favIsHome = spread.favorite === home.abbr;
  const margin    = favIsHome ? home.score - away.score : away.score - home.score;
  return margin > Math.abs(spread.line);
}

// ═══════════════════════════════════════════════════════════════════
//  COMPONENTS
// ═══════════════════════════════════════════════════════════════════

function Diamond({ bases, outs }) {
  const S = 13;
  const b = on => ({
    width:S, height:S, transform:"rotate(45deg)", flexShrink:0,
    background: on ? "#F5A623" : "rgba(255,255,255,0.1)",
    border:`2px solid ${on?"#F5A623":"rgba(255,255,255,0.2)"}`,
    boxShadow: on ? "0 0 6px #F5A623aa" : "none",
  });
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3,paddingRight:10,borderRight:"1px solid rgba(255,255,255,0.08)"}}>
      <div style={b(bases[1])}/>
      <div style={{display:"flex",gap:16}}><div style={b(bases[2])}/><div style={b(bases[0])}/></div>
      <div style={{display:"flex",gap:4,marginTop:3}}>
        {[0,1,2].map(i=><div key={i} style={{width:6,height:6,borderRadius:"50%",
          background:i<outs?"#F5A623":"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.2)"}}/>)}
      </div>
    </div>
  );
}

function Logo({ src, color, size=44 }) {
  const [err,setErr] = useState(false);
  if (!src||err) return <div style={{width:size,height:size,borderRadius:6,flexShrink:0,background:`${color}33`,border:`2px solid ${color}22`}}/>;
  return <img src={src} alt="" width={size} height={size} onError={()=>setErr(true)}
    style={{objectFit:"contain",flexShrink:0,filter:"drop-shadow(0 2px 6px rgba(0,0,0,0.8))"}}/>;
}

// ── GAME CARD — one game, fills half the screen height ───────────────
function GameCard({ game, flash, rowH }) {
  const covered  = getCover(game);
  const isLive   = game.status === "live";
  const isFinal  = game.status === "final";
  const isPre    = game.status === "pre";
  const homeWin  = (game.home.score??0) > (game.away.score??0);
  const awayWin  = (game.away.score??0) > (game.home.score??0);

  // Scale font sizes relative to row height
  const scoreSz  = Math.floor(rowH * 0.30);
  const abbrSz   = Math.floor(rowH * 0.16);
  const leaderSz = Math.floor(rowH * 0.09);
  const leaderPtSz = Math.floor(rowH * 0.12);

  return (
    <div style={{
      display:"inline-flex", flexDirection:"column",
      width: Math.floor(rowH * 2.1),   // card width proportional to row height
      height:"100%", flexShrink:0,
      padding:`${Math.floor(rowH*0.08)}px ${Math.floor(rowH*0.09)}px`,
      borderRight:"1px solid rgba(255,255,255,0.07)",
      background: flash
        ? "linear-gradient(180deg,rgba(255,210,0,0.14) 0%,transparent 50%)"
        : "linear-gradient(180deg,rgba(255,255,255,0.02) 0%,transparent 100%)",
      transition:"background 0.7s",
      position:"relative", overflow:"hidden",
    }}>
      {/* Top color stripe */}
      <div style={{position:"absolute",top:0,left:0,right:0,height:3,
        background:`linear-gradient(90deg,${game.away.color},${game.home.color})`,opacity:0.8}}/>

      {/* ── STATUS ROW ── */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
        marginBottom:Math.floor(rowH*0.06),flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          {isLive && <div style={{width:9,height:9,borderRadius:"50%",background:"#FF3B30",
            boxShadow:"0 0 7px #FF3B30",animation:"livePulse 1.1s ease-in-out infinite",flexShrink:0}}/>}
          <span style={{fontSize:Math.floor(rowH*0.11),fontWeight:900,fontFamily:F,letterSpacing:1,
            color:isLive?"#FF3B30":"rgba(255,255,255,0.38)"}}>{game.period}</span>
          {isLive&&game.clock&&(
            <span style={{fontSize:Math.floor(rowH*0.13),fontWeight:800,fontFamily:F,
              color:"rgba(255,255,255,0.85)"}}>{game.clock}</span>
          )}
        </div>

        {/* Spread badge */}
        {game.spread ? (
          <div style={{display:"flex",alignItems:"center",gap:6,
            background:"rgba(255,255,255,0.07)",borderRadius:6,
            padding:`2px ${Math.floor(rowH*0.05)}px`}}>
            <span style={{fontSize:Math.floor(rowH*0.07),fontWeight:700,
              color:"rgba(255,255,255,0.35)",letterSpacing:1}}>SPR</span>
            <span style={{fontSize:Math.floor(rowH*0.10),fontWeight:800,fontFamily:F,
              color:"rgba(255,255,255,0.8)"}}>
              {game.spread.favorite} {game.spread.line>0?"+":""}{game.spread.line}
            </span>
            {covered!==null&&(
              <span style={{fontSize:Math.floor(rowH*0.10),fontWeight:900,
                color:covered?"#30D158":"#FF453A",
                textShadow:covered?"0 0 8px rgba(48,209,88,0.7)":"0 0 8px rgba(255,69,58,0.7)"}}>
                {covered?"✓":"✗"}
              </span>
            )}
          </div>
        ):<div/>}
      </div>

      {/* ── TEAMS + SCORES ── */}
      <div style={{display:"flex",flexDirection:"column",gap:Math.floor(rowH*0.05),
        flex:1,justifyContent:"center"}}>

        {/* Away */}
        <div style={{display:"flex",alignItems:"center",gap:10,
          opacity:isFinal&&homeWin?0.45:1,transition:"opacity 0.4s"}}>
          <Logo src={game.away.logo} color={game.away.color} size={Math.floor(rowH*0.27)}/>
          <span style={{fontSize:abbrSz,fontWeight:900,color:"#fff",letterSpacing:0.5,
            lineHeight:1,flex:1,fontFamily:F}}>{game.away.abbr}</span>
          {!isPre&&(
            <span style={{fontSize:scoreSz,fontWeight:900,lineHeight:1,fontFamily:F,
              fontVariantNumeric:"tabular-nums",
              color:awayWin?"#fff":"rgba(255,255,255,0.5)",
              textShadow:awayWin&&isLive?`0 0 20px ${game.away.color}cc`:"none",
              transition:"all 0.4s"}}>{game.away.score}</span>
          )}
        </div>

        <div style={{height:1,background:"rgba(255,255,255,0.07)"}}/>

        {/* Home */}
        <div style={{display:"flex",alignItems:"center",gap:10,
          opacity:isFinal&&awayWin?0.45:1,transition:"opacity 0.4s"}}>
          <Logo src={game.home.logo} color={game.home.color} size={Math.floor(rowH*0.27)}/>
          <span style={{fontSize:abbrSz,fontWeight:900,color:"#fff",letterSpacing:0.5,
            lineHeight:1,flex:1,fontFamily:F}}>{game.home.abbr}</span>
          {!isPre&&(
            <span style={{fontSize:scoreSz,fontWeight:900,lineHeight:1,fontFamily:F,
              fontVariantNumeric:"tabular-nums",
              color:homeWin?"#fff":"rgba(255,255,255,0.5)",
              textShadow:homeWin&&isLive?`0 0 20px ${game.home.color}cc`:"none",
              transition:"all 0.4s"}}>{game.home.score}</span>
          )}
        </div>
      </div>

      {/* ── LEADERS ── */}
      <div style={{display:"flex",gap:8,alignItems:"flex-start",
        borderTop:"1px solid rgba(255,255,255,0.07)",
        paddingTop:Math.floor(rowH*0.06),marginTop:Math.floor(rowH*0.05),flexShrink:0}}>

        {game.sport==="baseball"&&!isPre&&(
          <Diamond bases={game.bases} outs={game.outs}/>
        )}

        {/* Away leaders */}
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:Math.floor(rowH*0.065),fontWeight:800,letterSpacing:1.5,
            marginBottom:3,color:game.away.color,textTransform:"uppercase",fontFamily:F,
            textShadow:`0 0 8px ${game.away.color}44`}}>{game.away.abbr}</div>
          {game.leaders.away.length>0 ? game.leaders.away.map((p,i)=>(
            <div key={i} style={{display:"flex",alignItems:"baseline",gap:5,marginBottom:2}}>
              <span style={{fontSize:leaderSz,fontWeight:800,color:"rgba(255,255,255,0.85)",
                whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",
                maxWidth:Math.floor(rowH*0.7),fontFamily:F}}>{p.name}</span>
              <span style={{fontSize:leaderPtSz,fontWeight:900,color:"#fff",lineHeight:1,
                fontVariantNumeric:"tabular-nums",fontFamily:F}}>{p.pts}</span>
              {p.reb&&p.reb!=="0"&&p.reb!=="--"&&<span style={{fontSize:leaderSz*0.85,
                color:"rgba(255,255,255,0.4)",fontWeight:700}}>{p.reb}r</span>}
              {p.ast&&p.ast!=="0"&&p.ast!=="--"&&<span style={{fontSize:leaderSz*0.85,
                color:"rgba(255,255,255,0.4)",fontWeight:700}}>{p.ast}a</span>}
            </div>
          )) : <span style={{fontSize:leaderSz,color:"rgba(255,255,255,0.15)",fontStyle:"italic"}}>—</span>}
        </div>

        <div style={{width:1,background:"rgba(255,255,255,0.07)",alignSelf:"stretch"}}/>

        {/* Home leaders */}
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:Math.floor(rowH*0.065),fontWeight:800,letterSpacing:1.5,
            marginBottom:3,color:game.home.color,textTransform:"uppercase",fontFamily:F,
            textShadow:`0 0 8px ${game.home.color}44`}}>{game.home.abbr}</div>
          {game.leaders.home.length>0 ? game.leaders.home.map((p,i)=>(
            <div key={i} style={{display:"flex",alignItems:"baseline",gap:5,marginBottom:2}}>
              <span style={{fontSize:leaderSz,fontWeight:800,color:"rgba(255,255,255,0.85)",
                whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",
                maxWidth:Math.floor(rowH*0.7),fontFamily:F}}>{p.name}</span>
              <span style={{fontSize:leaderPtSz,fontWeight:900,color:"#fff",lineHeight:1,
                fontVariantNumeric:"tabular-nums",fontFamily:F}}>{p.pts}</span>
              {p.reb&&p.reb!=="0"&&p.reb!=="--"&&<span style={{fontSize:leaderSz*0.85,
                color:"rgba(255,255,255,0.4)",fontWeight:700}}>{p.reb}r</span>}
              {p.ast&&p.ast!=="0"&&p.ast!=="--"&&<span style={{fontSize:leaderSz*0.85,
                color:"rgba(255,255,255,0.4)",fontWeight:700}}>{p.ast}a</span>}
            </div>
          )) : <span style={{fontSize:leaderSz,color:"rgba(255,255,255,0.15)",fontStyle:"italic"}}>—</span>}
        </div>
      </div>
    </div>
  );
}

// ── SPORT LABEL — static pill on left of each row ────────────────────
function SportLabel({ meta, rowH }) {
  return (
    <div style={{
      width: Math.floor(rowH*0.75), flexShrink:0, height:"100%",
      display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4,
      background:`linear-gradient(160deg,${meta.accent},${meta.accent}99)`,
      borderRight:`3px solid ${meta.accent}`,
      zIndex:5, position:"relative",
    }}>
      <span style={{fontSize:Math.floor(rowH*0.25),lineHeight:1}}>{meta.icon}</span>
      <span style={{fontSize:Math.floor(rowH*0.10),fontWeight:900,color:"#fff",
        letterSpacing:2,fontFamily:F}}>{meta.label}</span>
    </div>
  );
}

// ── SCROLLING ROW — one sport, scrolls horizontally ──────────────────
function ScrollRow({ rowH, speed, games, meta, flashIds, onLoop }) {
  const scrollRef = useRef(null);
  const animRef   = useRef(null);
  const xRef      = useRef(0);
  const tsRef     = useRef(null);
  const pausedRef = useRef(false);

  const animate = useCallback((ts) => {
    if (!scrollRef.current) return;
    if (!pausedRef.current) {
      if (tsRef.current===null) tsRef.current=ts;
      const delta = Math.min((ts-tsRef.current)/1000, 0.05);
      tsRef.current = ts;
      xRef.current += speed * delta;
      const half = scrollRef.current.scrollWidth / 2;
      if (half > 0 && xRef.current >= half) {
        xRef.current = 0;
        onLoop(); // notify parent to rotate sport
      }
      scrollRef.current.style.transform = `translateX(-${xRef.current}px)`;
    }
    animRef.current = requestAnimationFrame(animate);
  }, [speed, onLoop]);

  useEffect(() => {
    xRef.current = 0; tsRef.current = null;
    cancelAnimationFrame(animRef.current);
    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, [animate, meta.league]);

  if (!games.length) return (
    <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",
      color:"rgba(255,255,255,0.2)",fontSize:Math.floor(rowH*0.12),fontFamily:F,letterSpacing:3}}>
      NO GAMES
    </div>
  );

  return (
    <div style={{flex:1,overflow:"hidden",position:"relative"}}
      onTouchStart={()=>{pausedRef.current=true;}}
      onTouchEnd={()=>{pausedRef.current=false;tsRef.current=null;}}
    >
      {/* Vignettes */}
      <div style={{position:"absolute",left:0,top:0,bottom:0,width:40,zIndex:4,
        background:"linear-gradient(to right,#0a0a0a 30%,transparent)",pointerEvents:"none"}}/>
      <div style={{position:"absolute",right:0,top:0,bottom:0,width:50,zIndex:4,
        background:"linear-gradient(to left,#0a0a0a 30%,transparent)",pointerEvents:"none"}}/>

      <div ref={scrollRef} style={{display:"inline-flex",alignItems:"stretch",
        height:"100%",willChange:"transform"}}>
        {[...games,...games].map((g,i)=>(
          <GameCard key={`${g.id}-${i}`} game={g} flash={flashIds.has(g.id)} rowH={rowH}/>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════════════
function SportsBoard() {
  // allGames: { [league]: game[] }
  const [allGames,    setAllGames]    = useState({});
  const [flashIds,    setFlashIds]    = useState(new Set());
  const [loading,     setLoading]     = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [clock,       setClock]       = useState(new Date());

  // activeLeagues: leagues that have at least 1 game today (auto-detected)
  const [activeLeagues, setActiveLeagues] = useState([]);

  // Each row independently tracks which sport index it's showing
  const [row1Idx, setRow1Idx] = useState(0);
  const [row2Idx, setRow2Idx] = useState(1);

  const prevScores = useRef({});

  // Clock tick
  useEffect(()=>{
    const iv=setInterval(()=>setClock(new Date()),1000);
    return()=>clearInterval(iv);
  },[]);

  // ── FETCH ALL LEAGUES ────────────────────────────────────────────
  const fetchLeague = useCallback(async (lg) => {
    const data   = await espnFetch(lg.sport, lg.league, "scoreboard");
    const events = data.events ?? [];
    const games  = events.map(e=>parseGame(e,lg.sport,lg.league)).filter(Boolean);

    // Flash on score change
    games.forEach(g=>{
      const prev=prevScores.current[g.id];
      if(prev&&g.status==="live"&&(prev.home!==g.home.score||prev.away!==g.away.score)){
        setFlashIds(f=>new Set([...f,g.id]));
        setTimeout(()=>setFlashIds(f=>{const n=new Set(f);n.delete(g.id);return n;}),2500);
      }
      prevScores.current[g.id]={home:g.home.score,away:g.away.score};
    });

    return { league: lg.league, games };
  }, []);

  const fetchLeaders = useCallback(async (game, lg) => {
    if (game.status==="pre") return;
    try {
      const summary = await espnFetch(lg.sport, lg.league, `summary?event=${game.id}`);
      const leaders = parseLeaders(summary, game);
      setAllGames(prev=>({
        ...prev,
        [lg.league]:(prev[lg.league]??[]).map(g=>g.id===game.id?{...g,leaders}:g),
      }));
    } catch{}
  },[]);

  const loadAllScores = useCallback(async()=>{
    setLoading(true);
    const results = await Promise.allSettled(ALL_LEAGUES.map(fetchLeague));

    const nextGames = {};
    const withGames = [];

    results.forEach((r,i)=>{
      if(r.status==="fulfilled"){
        const {league,games}=r.value;
        nextGames[league]=games;
        if(games.length>0) withGames.push(ALL_LEAGUES[i]);
      }
    });

    setAllGames(nextGames);
    setActiveLeagues(withGames);

    // Ensure row indices are valid for the new active league list
    setRow1Idx(i=>Math.min(i,Math.max(withGames.length-1,0)));
    setRow2Idx(i=>withGames.length>1?Math.min(i,withGames.length-1):0);

    setLastUpdated(new Date());
    setLoading(false);
  },[fetchLeague]);

  // Poll scores
  useEffect(()=>{
    loadAllScores();
    const iv=setInterval(loadAllScores,POLL_SCORES_MS);
    return()=>clearInterval(iv);
  },[loadAllScores]);

  // Poll leaders for both active rows
  useEffect(()=>{
    if(!activeLeagues.length) return;

    const loadLeaders=async()=>{
      const rows=[activeLeagues[row1Idx],activeLeagues[row2Idx]].filter(Boolean);
      for(const lg of rows){
        const games=(allGames[lg.league]??[]).filter(g=>g.status!=="pre");
        for(const g of games){
          await fetchLeaders(g,lg);
          await new Promise(r=>setTimeout(r,350));
        }
      }
    };

    loadLeaders();
    const iv=setInterval(loadLeaders,POLL_LEADERS_MS);
    return()=>clearInterval(iv);
  },[activeLeagues,row1Idx,row2Idx,allGames,fetchLeaders]);

  // ── SPORT ROTATION when a row loops ─────────────────────────────
  // Each row rotates to the next available sport independently
  const handleRow1Loop = useCallback(()=>{
    setRow1Idx(prev=>{
      const next=(prev+1)%Math.max(activeLeagues.length,1);
      return next===row2Idx&&activeLeagues.length>2?(next+1)%activeLeagues.length:next;
    });
  },[activeLeagues.length,row2Idx]);

  const handleRow2Loop = useCallback(()=>{
    setRow2Idx(prev=>{
      const next=(prev+1)%Math.max(activeLeagues.length,1);
      return next===row1Idx&&activeLeagues.length>2?(next+1)%activeLeagues.length:next;
    });
  },[activeLeagues.length,row1Idx]);

  // Current league objects for each row
  const meta1 = activeLeagues[row1Idx] ?? ALL_LEAGUES[0];
  const meta2 = activeLeagues.length>1 ? (activeLeagues[row2Idx]??ALL_LEAGUES[1]) : null;
  const games1 = allGames[meta1.league] ?? [];
  const games2 = meta2 ? (allGames[meta2.league]??[]) : [];

  // iPad landscape: take full viewport, split into 2 equal rows
  const headerH = 48;
  const rowH    = `calc((100vh - ${headerH}px) / 2)`;
  const rowHNum = Math.floor((typeof window!=="undefined" ? window.innerHeight : 768) - headerH) / 2;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800;900&display=swap');
        *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
        html,body { width:100%; height:100%; overflow:hidden; background:#0a0a0a; -webkit-text-size-adjust:100%; }
        @keyframes livePulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:0.15;transform:scale(0.6);}}
        @keyframes spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}
      `}</style>

      <div style={{width:"100vw",height:"100vh",display:"flex",flexDirection:"column",background:"#0a0a0a"}}>

        {/* ── HEADER ── */}
        <div style={{
          height:headerH, flexShrink:0,
          display:"flex", alignItems:"center", justifyContent:"space-between",
          padding:"0 20px",
          background:"linear-gradient(180deg,#1a1a1a 0%,#111 100%)",
          borderBottom:"1px solid rgba(255,255,255,0.08)",
        }}>
          {/* Active sport pills */}
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            {activeLeagues.map((lg,i)=>(
              <div key={lg.league} style={{
                display:"flex",alignItems:"center",gap:5,
                padding:"3px 10px",borderRadius:20,
                background: (i===row1Idx||i===row2Idx) ? `${lg.accent}33` : "rgba(255,255,255,0.05)",
                border:`1px solid ${(i===row1Idx||i===row2Idx)?lg.accent:"rgba(255,255,255,0.1)"}`,
                transition:"all 0.3s",
              }}>
                <span style={{fontSize:14}}>{lg.icon}</span>
                <span style={{fontSize:13,fontWeight:800,fontFamily:F,letterSpacing:1,
                  color:(i===row1Idx||i===row2Idx)?"#fff":"rgba(255,255,255,0.4)"}}>
                  {lg.label}
                </span>
                <span style={{fontSize:11,fontWeight:700,
                  color:(i===row1Idx||i===row2Idx)?"rgba(255,255,255,0.6)":"rgba(255,255,255,0.2)"}}>
                  {allGames[lg.league]?.length??0}
                </span>
              </div>
            ))}
            {loading&&(
              <div style={{width:10,height:10,borderRadius:"50%",marginLeft:4,
                border:"2px solid rgba(255,255,255,0.15)",borderTopColor:"#fff",
                animation:"spin 0.8s linear infinite"}}/>
            )}
          </div>

          {/* Clock + last updated */}
          <div style={{display:"flex",alignItems:"center",gap:14}}>
            {lastUpdated&&(
              <span style={{fontSize:11,color:"rgba(255,255,255,0.22)",fontFamily:F,letterSpacing:1}}>
                UPD {lastUpdated.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})}
              </span>
            )}
            <span style={{fontSize:24,fontWeight:900,color:"rgba(255,255,255,0.8)",fontFamily:F,letterSpacing:1}}>
              {clock.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}
            </span>
          </div>
        </div>

        {/* ── ROW 1 ── */}
        <div style={{height:rowH,flexShrink:0,display:"flex",alignItems:"stretch",
          borderBottom:"2px solid rgba(255,255,255,0.06)"}}>
          <SportLabel meta={meta1} rowH={rowHNum}/>
          <ScrollRow
            rowH={rowHNum} speed={SPEED_ROW1}
            games={games1} meta={meta1}
            flashIds={flashIds}
            onLoop={handleRow1Loop}
          />
        </div>

        {/* ── ROW 2 ── */}
        {meta2 ? (
          <div style={{height:rowH,flexShrink:0,display:"flex",alignItems:"stretch"}}>
            <SportLabel meta={meta2} rowH={rowHNum}/>
            <ScrollRow
              rowH={rowHNum} speed={SPEED_ROW2}
              games={games2} meta={meta2}
              flashIds={flashIds}
              onLoop={handleRow2Loop}
            />
          </div>
        ) : (
          // Only 1 sport today — row 2 shows a gentle message
          <div style={{height:rowH,flexShrink:0,display:"flex",alignItems:"center",
            justifyContent:"center",color:"rgba(255,255,255,0.1)",fontSize:16,
            fontFamily:F,letterSpacing:3}}>
            NO OTHER SPORTS TODAY
          </div>
        )}
      </div>
    </>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<SportsBoard/>);
