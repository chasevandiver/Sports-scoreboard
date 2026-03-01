// ═══════════════════════════════════════════════════════════════════
//  SPORTS SCOREBOARD — public/app.jsx
//  Calls /api/espn?path=... on the same Replit server (no CORS)
//  Full screen, iPad landscape optimized, live scores + top scorers
// ═══════════════════════════════════════════════════════════════════

const { useState, useEffect, useRef, useCallback } = React;

const POLL_SCORES_MS = 30_000;
const POLL_STATS_MS  = 60_000;
const SCROLL_SPEED   = 38;

const LEAGUES = [
  { sport: "basketball", league: "nba",                     label: "NBA",   icon: "🏀", accent: "#C9082A" },
  { sport: "basketball", league: "mens-college-basketball", label: "NCAAM", icon: "🏀", accent: "#1A4A8A" },
  { sport: "hockey",     league: "nhl",                     label: "NHL",   icon: "🏒", accent: "#00539B" },
  { sport: "baseball",   league: "mlb",                     label: "MLB",   icon: "⚾", accent: "#002D72" },
  { sport: "football",   league: "nfl",                     label: "NFL",   icon: "🏈", accent: "#013369" },
];

// ── FETCH via Replit proxy (same origin = no CORS) ───────────────────
async function espnFetch(sport, league, extra = "") {
  const path = `${sport}/${league}/${extra}`;
  const url  = `/api/espn?path=${encodeURIComponent(path)}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Proxy returned ${res.status}`);
  return res.json();
}

// ── PARSE SCOREBOARD EVENT → game object ────────────────────────────
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
      periodLabel = d ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "TBD";
    }

    // Spread from odds
    const odds = comp.odds?.[0];
    let spread = null;
    if (odds?.details && odds.details !== "EVEN") {
      const parts = odds.details.trim().split(" ");
      if (parts.length === 2) spread = { favorite: parts[0], line: parseFloat(parts[1]) };
    }

    const color    = t => "#" + (t.team?.color ?? "333333").replace("#","");
    const situation = comp.situation ?? null;

    return {
      id: event.id, sport, league, status,
      period: periodLabel,
      clock: (status === "live" && sport !== "baseball") ? clock : "",
      home: {
        abbr:   home.team.abbreviation ?? "HM",
        color:  color(home),
        logo:   home.team.logo ?? null,
        score:  status !== "pre" ? parseInt(home.score ?? 0) : null,
        record: home.records?.[0]?.summary ?? "",
      },
      away: {
        abbr:   away.team.abbreviation ?? "AW",
        color:  color(away),
        logo:   away.team.logo ?? null,
        score:  status !== "pre" ? parseInt(away.score ?? 0) : null,
        record: away.records?.[0]?.summary ?? "",
      },
      spread,
      bases: situation ? [!!situation.onFirst, !!situation.onSecond, !!situation.onThird] : [false,false,false],
      outs:  situation?.outs ?? 0,
      leaders: { home: [], away: [] },
    };
  } catch(e) {
    console.error("[PARSE]", e.message, event?.id);
    return null;
  }
}

// ── PARSE GAME SUMMARY → top 2 scorers per team ─────────────────────
function parseLeaders(summary, game) {
  try {
    const result  = { home: [], away: [] };
    const boxscore = summary?.boxscore;
    if (!boxscore) return result;

    const headerComps = summary?.header?.competitions?.[0]?.competitors ?? [];
    const homeTeamId  = headerComps.find(c => c.homeAway === "home")?.team?.id;

    (boxscore.players ?? []).forEach(group => {
      const side   = group.team?.id === homeTeamId ? "home" : "away";
      const stats  = group.statistics?.[0];
      if (!stats) return;

      const labels = stats.labels ?? [];
      const ptsIdx = labels.indexOf("PTS");
      const gIdx   = labels.indexOf("G");
      const rebIdx = labels.indexOf("REB");
      const astIdx = labels.indexOf("AST");
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

    // Fallback to ESPN pre-computed leaders
    if (!result.home.length && !result.away.length) {
      (summary.leaders ?? []).forEach(lg => {
        const l    = lg.leaders?.[0];
        if (!l) return;
        const isHome = headerComps.find(c => c.homeAway === "home")?.team?.id === lg.team?.id;
        const side   = isHome ? "home" : "away";
        if (result[side].length < 2) {
          result[side].push({
            name: l.athlete?.shortName ?? "—",
            pts:  l.value ?? "—",
            reb: null, ast: null,
          });
        }
      });
    }

    return result;
  } catch(e) {
    return { home: [], away: [] };
  }
}

function getCover(game) {
  if (game.status !== "final" || !game.spread?.line) return null;
  const { home, away, spread } = game;
  const favIsHome = spread.favorite === home.abbr;
  const margin    = favIsHome ? home.score - away.score : away.score - home.score;
  return margin > Math.abs(spread.line);
}

// ═══════════════════════════════════════════════════════════════════
//  UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════

function Diamond({ bases, outs }) {
  const S = 15;
  const base = on => ({
    width:S, height:S, transform:"rotate(45deg)", flexShrink:0,
    background: on ? "#F5A623" : "rgba(255,255,255,0.1)",
    border:`2px solid ${on ? "#F5A623" : "rgba(255,255,255,0.2)"}`,
    boxShadow: on ? "0 0 8px #F5A623aa" : "none",
    transition:"all 0.3s",
  });
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
      <div style={base(bases[1])}/>
      <div style={{display:"flex",gap:20}}>
        <div style={base(bases[2])}/>
        <div style={base(bases[0])}/>
      </div>
      <div style={{display:"flex",gap:5,marginTop:4}}>
        {[0,1,2].map(i=>(
          <div key={i} style={{
            width:8,height:8,borderRadius:"50%",
            background:i<outs?"#F5A623":"rgba(255,255,255,0.12)",
            border:"1.5px solid rgba(255,255,255,0.25)",
          }}/>
        ))}
      </div>
    </div>
  );
}

function TeamLogo({ src, color, size=46 }) {
  const [err, setErr] = useState(false);
  if (!src || err) return (
    <div style={{width:size,height:size,borderRadius:8,flexShrink:0,background:`${color}44`,border:`2px solid ${color}33`}}/>
  );
  return (
    <img src={src} alt="" width={size} height={size} onError={()=>setErr(true)}
      style={{objectFit:"contain",flexShrink:0,filter:"drop-shadow(0 2px 8px rgba(0,0,0,0.7))"}}/>
  );
}

function LeaderLine({ p }) {
  if (!p) return null;
  const F = "'Barlow Condensed','Arial Narrow',sans-serif";
  return (
    <div style={{display:"flex",alignItems:"baseline",gap:5,minWidth:0}}>
      <span style={{fontSize:14,fontWeight:800,color:"#fff",whiteSpace:"nowrap",
        overflow:"hidden",textOverflow:"ellipsis",maxWidth:105,fontFamily:F}}>{p.name}</span>
      <span style={{fontSize:20,fontWeight:900,color:"#fff",lineHeight:1,
        fontVariantNumeric:"tabular-nums",fontFamily:F}}>{p.pts}</span>
      {p.reb && p.reb!=="0" && p.reb!=="--" && (
        <span style={{fontSize:12,color:"rgba(255,255,255,0.4)",fontWeight:700}}>{p.reb}r</span>
      )}
      {p.ast && p.ast!=="0" && p.ast!=="--" && (
        <span style={{fontSize:12,color:"rgba(255,255,255,0.4)",fontWeight:700}}>{p.ast}a</span>
      )}
    </div>
  );
}

// ── GAME CARD ────────────────────────────────────────────────────────
function GameCard({ game, flash }) {
  const F         = "'Barlow Condensed','Arial Narrow',sans-serif";
  const covered   = getCover(game);
  const isLive    = game.status === "live";
  const isFinal   = game.status === "final";
  const isPre     = game.status === "pre";
  const homeWin   = (game.home.score??0) > (game.away.score??0);
  const awayWin   = (game.away.score??0) > (game.home.score??0);

  return (
    <div style={{
      display:"inline-flex",flexDirection:"column",
      width:390,height:"100%",flexShrink:0,
      padding:"16px 18px 14px",
      borderRight:"1px solid rgba(255,255,255,0.06)",
      background: flash
        ? "linear-gradient(180deg,rgba(255,200,0,0.13) 0%,transparent 60%)"
        : "linear-gradient(180deg,rgba(255,255,255,0.025) 0%,transparent 100%)",
      transition:"background 0.7s ease",
      position:"relative",overflow:"hidden",
    }}>
      {/* Top color stripe */}
      <div style={{position:"absolute",top:0,left:0,right:0,height:3,
        background:`linear-gradient(90deg,${game.away.color},${game.home.color})`,opacity:0.75}}/>

      {/* Status row */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          {isLive && (
            <div style={{width:9,height:9,borderRadius:"50%",background:"#FF3B30",
              boxShadow:"0 0 7px #FF3B30",animation:"livePulse 1.1s ease-in-out infinite",flexShrink:0}}/>
          )}
          <span style={{
            fontSize:isLive?18:14, fontWeight:900, fontFamily:F,
            color:isLive?"#FF3B30":"rgba(255,255,255,0.4)", letterSpacing:1,
          }}>{game.period}</span>
          {isLive && game.clock && (
            <span style={{fontSize:20,fontWeight:800,color:"rgba(255,255,255,0.85)",fontFamily:F}}>
              {game.clock}
            </span>
          )}
        </div>

        {game.spread ? (
          <div style={{display:"flex",alignItems:"center",gap:6,
            background:"rgba(255,255,255,0.07)",borderRadius:6,padding:"3px 10px"}}>
            <span style={{fontSize:11,color:"rgba(255,255,255,0.35)",fontWeight:700,letterSpacing:1}}>SPR</span>
            <span style={{fontSize:15,fontWeight:800,color:"rgba(255,255,255,0.8)",fontFamily:F}}>
              {game.spread.favorite} {game.spread.line>0?"+":""}{game.spread.line}
            </span>
            {covered!==null && (
              <span style={{fontSize:15,fontWeight:900,
                color:covered?"#30D158":"#FF453A",
                textShadow:covered?"0 0 8px rgba(48,209,88,0.7)":"0 0 8px rgba(255,69,58,0.7)"}}>
                {covered?"✓":"✗"}
              </span>
            )}
          </div>
        ) : <div/>}
      </div>

      {/* Teams + scores */}
      <div style={{display:"flex",flexDirection:"column",gap:9,flex:1,justifyContent:"center"}}>
        {/* Away */}
        <div style={{display:"flex",alignItems:"center",gap:11,
          opacity:isFinal&&homeWin?0.5:1,transition:"opacity 0.4s"}}>
          <TeamLogo src={game.away.logo} color={game.away.color}/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:25,fontWeight:900,color:"#fff",lineHeight:1,letterSpacing:0.5,fontFamily:F}}>
              {game.away.abbr}
            </div>
            {game.away.record?<div style={{fontSize:12,color:"rgba(255,255,255,0.3)",fontWeight:600,marginTop:1}}>{game.away.record}</div>:null}
          </div>
          {!isPre && (
            <span style={{
              fontSize:54,fontWeight:900,lineHeight:1,fontVariantNumeric:"tabular-nums",fontFamily:F,
              color:awayWin?"#fff":"rgba(255,255,255,0.55)",
              textShadow:awayWin&&isLive?`0 0 20px ${game.away.color}bb`:"none",
              transition:"color 0.4s,text-shadow 0.4s",
            }}>{game.away.score}</span>
          )}
        </div>

        <div style={{height:1,background:"rgba(255,255,255,0.07)",margin:"0 2px"}}/>

        {/* Home */}
        <div style={{display:"flex",alignItems:"center",gap:11,
          opacity:isFinal&&awayWin?0.5:1,transition:"opacity 0.4s"}}>
          <TeamLogo src={game.home.logo} color={game.home.color}/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:25,fontWeight:900,color:"#fff",lineHeight:1,letterSpacing:0.5,fontFamily:F}}>
              {game.home.abbr}
            </div>
            {game.home.record?<div style={{fontSize:12,color:"rgba(255,255,255,0.3)",fontWeight:600,marginTop:1}}>{game.home.record}</div>:null}
          </div>
          {!isPre && (
            <span style={{
              fontSize:54,fontWeight:900,lineHeight:1,fontVariantNumeric:"tabular-nums",fontFamily:F,
              color:homeWin?"#fff":"rgba(255,255,255,0.55)",
              textShadow:homeWin&&isLive?`0 0 20px ${game.home.color}bb`:"none",
              transition:"color 0.4s,text-shadow 0.4s",
            }}>{game.home.score}</span>
          )}
        </div>
      </div>

      {/* Leaders + diamond */}
      <div style={{display:"flex",gap:10,alignItems:"flex-start",
        borderTop:"1px solid rgba(255,255,255,0.07)",paddingTop:11,marginTop:10,flexShrink:0}}>
        {game.sport==="baseball"&&!isPre&&(
          <div style={{paddingRight:10,borderRight:"1px solid rgba(255,255,255,0.07)",display:"flex",alignItems:"center"}}>
            <Diamond bases={game.bases} outs={game.outs}/>
          </div>
        )}

        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:10,fontWeight:800,letterSpacing:1.5,marginBottom:4,
            color:game.away.color,textTransform:"uppercase",fontFamily:F,
            textShadow:`0 0 10px ${game.away.color}55`}}>{game.away.abbr}</div>
          {game.leaders.away.length
            ? game.leaders.away.map((p,i)=><LeaderLine key={i} p={p}/>)
            : <span style={{fontSize:13,color:"rgba(255,255,255,0.15)",fontStyle:"italic"}}>—</span>}
        </div>

        <div style={{width:1,background:"rgba(255,255,255,0.07)",alignSelf:"stretch"}}/>

        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:10,fontWeight:800,letterSpacing:1.5,marginBottom:4,
            color:game.home.color,textTransform:"uppercase",fontFamily:F,
            textShadow:`0 0 10px ${game.home.color}55`}}>{game.home.abbr}</div>
          {game.leaders.home.length
            ? game.leaders.home.map((p,i)=><LeaderLine key={i} p={p}/>)
            : <span style={{fontSize:13,color:"rgba(255,255,255,0.15)",fontStyle:"italic"}}>—</span>}
        </div>
      </div>
    </div>
  );
}

// ── SPORT TAB ────────────────────────────────────────────────────────
function SportTab({ meta, active, count, onClick }) {
  const F = "'Barlow Condensed','Arial Narrow',sans-serif";
  return (
    <div onClick={onClick} style={{
      display:"flex",alignItems:"center",gap:7,padding:"0 18px",
      cursor:"pointer",height:"100%",
      borderBottom:active?`3px solid ${meta.accent}`:"3px solid transparent",
      background:active?`${meta.accent}22`:"transparent",
      transition:"all 0.2s",
    }}>
      <span style={{fontSize:20}}>{meta.icon}</span>
      <span style={{fontSize:15,fontWeight:900,letterSpacing:2,fontFamily:F,
        color:active?"#fff":"rgba(255,255,255,0.4)",transition:"color 0.2s"}}>{meta.label}</span>
      {count>0&&(
        <span style={{fontSize:11,fontWeight:800,color:"rgba(255,255,255,0.5)",
          background:"rgba(255,255,255,0.1)",borderRadius:10,padding:"1px 6px",lineHeight:1.6}}>
          {count}
        </span>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════════════
function SportsBoard() {
  const [activeSport,  setActiveSport]  = useState(0);
  const [allGames,     setAllGames]     = useState({});
  const [flashIds,     setFlashIds]     = useState(new Set());
  const [lastUpdated,  setLastUpdated]  = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(null);
  const [clock,        setClock]        = useState(new Date());

  const scrollRef  = useRef(null);
  const animRef    = useRef(null);
  const scrollXRef = useRef(0);
  const lastTsRef  = useRef(null);
  const pausedRef  = useRef(false);
  const prevScores = useRef({});

  const meta         = LEAGUES[activeSport];
  const currentGames = allGames[meta.league] ?? [];

  useEffect(()=>{
    const iv = setInterval(()=>setClock(new Date()), 1000);
    return ()=>clearInterval(iv);
  },[]);

  // ── FETCH SCORES ────────────────────────────────────────────────
  const fetchLeague = useCallback(async (lg) => {
    const data   = await espnFetch(lg.sport, lg.league, "scoreboard");
    const events = data.events ?? [];
    console.log(`[${lg.label}] ${events.length} games from ESPN`);

    const games = events.map(e=>parseGame(e,lg.sport,lg.league)).filter(Boolean);

    games.forEach(g=>{
      const prev = prevScores.current[g.id];
      if (prev && g.status==="live" && (prev.home!==g.home.score || prev.away!==g.away.score)) {
        setFlashIds(f=>new Set([...f,g.id]));
        setTimeout(()=>setFlashIds(f=>{const n=new Set(f);n.delete(g.id);return n;}),2500);
      }
      prevScores.current[g.id]={home:g.home.score,away:g.away.score};
    });

    setAllGames(prev=>({...prev,[lg.league]:games}));
  }, []);

  // ── FETCH LEADERS ───────────────────────────────────────────────
  const fetchLeaders = useCallback(async (game, lg) => {
    if (game.status==="pre") return;
    try {
      const summary = await espnFetch(lg.sport, lg.league, `summary?event=${game.id}`);
      const leaders = parseLeaders(summary, game);
      setAllGames(prev=>({
        ...prev,
        [lg.league]:(prev[lg.league]??[]).map(g=>g.id===game.id?{...g,leaders}:g),
      }));
    } catch(e) {
      console.warn("[LEADERS]", game.id, e.message);
    }
  }, []);

  // ── POLL ─────────────────────────────────────────────────────────
  useEffect(()=>{
    let scoreTimer, statsTimer;

    const loadScores = async () => {
      setLoading(true);
      setError(null);
      try {
        await Promise.allSettled(LEAGUES.map(fetchLeague));
        setLastUpdated(new Date());
      } catch(e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    };

    const loadStats = async () => {
      const lg    = LEAGUES[activeSport];
      const games = allGames[lg.league] ?? [];
      for (const g of games.filter(g=>g.status!=="pre")) {
        await fetchLeaders(g, lg);
        await new Promise(r=>setTimeout(r,400));
      }
    };

    loadScores();
    scoreTimer = setInterval(loadScores, POLL_SCORES_MS);
    statsTimer  = setInterval(loadStats,  POLL_STATS_MS);
    return ()=>{clearInterval(scoreTimer);clearInterval(statsTimer);};
  }, [activeSport, fetchLeague]);

  // Load leaders when game list first arrives
  useEffect(()=>{
    if (!currentGames.length) return;
    const lg = LEAGUES[activeSport];
    currentGames.filter(g=>g.status!=="pre").forEach(g=>fetchLeaders(g,lg));
  }, [currentGames.length, activeSport]);

  // ── SCROLL ───────────────────────────────────────────────────────
  const animate = useCallback((ts)=>{
    if (!scrollRef.current) return;
    if (!pausedRef.current) {
      if (lastTsRef.current===null) lastTsRef.current=ts;
      const delta = Math.min((ts-lastTsRef.current)/1000, 0.05);
      lastTsRef.current=ts;
      scrollXRef.current += SCROLL_SPEED*delta;
      const half = scrollRef.current.scrollWidth/2;
      if (half>0 && scrollXRef.current>=half) scrollXRef.current=0;
      scrollRef.current.style.transform=`translateX(-${scrollXRef.current}px)`;
    }
    animRef.current=requestAnimationFrame(animate);
  },[]);

  useEffect(()=>{
    scrollXRef.current=0; lastTsRef.current=null;
    cancelAnimationFrame(animRef.current);
    animRef.current=requestAnimationFrame(animate);
    return ()=>cancelAnimationFrame(animRef.current);
  },[activeSport,animate]);

  const switchSport = i => {
    setActiveSport(i);
    scrollXRef.current=0; lastTsRef.current=null;
  };

  const TAB_H = 54;
  const F     = "'Barlow Condensed','Arial Narrow',sans-serif";

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800;900&display=swap');
        @keyframes livePulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:0.2;transform:scale(0.65);}}
        @keyframes spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}
      `}</style>

      <div style={{width:"100vw",height:"100vh",display:"flex",flexDirection:"column",background:"#0a0a0a"}}>

        {/* TAB BAR */}
        <div style={{height:TAB_H,flexShrink:0,display:"flex",alignItems:"stretch",
          justifyContent:"space-between",
          background:"linear-gradient(180deg,#181818 0%,#111 100%)",
          borderBottom:"1px solid rgba(255,255,255,0.07)"}}>
          <div style={{display:"flex",alignItems:"stretch"}}>
            {LEAGUES.map((lg,i)=>(
              <SportTab key={lg.league} meta={lg} active={i===activeSport}
                count={allGames[lg.league]?.length??0} onClick={()=>switchSport(i)}/>
            ))}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:12,padding:"0 16px"}}>
            {loading && (
              <div style={{width:10,height:10,borderRadius:"50%",
                border:"2px solid rgba(255,255,255,0.2)",borderTopColor:meta.accent,
                animation:"spin 0.8s linear infinite"}}/>
            )}
            {lastUpdated && (
              <span style={{fontSize:11,color:"rgba(255,255,255,0.25)",fontFamily:F,letterSpacing:1}}>
                {lastUpdated.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})}
              </span>
            )}
            <span style={{fontSize:22,fontWeight:900,color:"rgba(255,255,255,0.75)",fontFamily:F,letterSpacing:1}}>
              {clock.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}
            </span>
          </div>
        </div>

        {/* BODY */}
        <div style={{flex:1,overflow:"hidden",position:"relative",background:"#0a0a0a"}}
          onTouchStart={()=>{pausedRef.current=true;}}
          onTouchEnd={()=>{pausedRef.current=false;lastTsRef.current=null;}}
          onMouseEnter={()=>{pausedRef.current=true;}}
          onMouseLeave={()=>{pausedRef.current=false;lastTsRef.current=null;}}>

          {/* Error */}
          {error && currentGames.length===0 && (
            <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",
              justifyContent:"center",flexDirection:"column",gap:16}}>
              <span style={{fontSize:48}}>📡</span>
              <div style={{fontSize:18,color:"rgba(255,255,255,0.5)",fontWeight:700,
                textAlign:"center",maxWidth:460,lineHeight:1.6,fontFamily:F}}>
                PROXY ERROR — IS REPLIT RUNNING?<br/>
                <span style={{fontSize:13,color:"rgba(255,255,255,0.25)"}}>{error}</span>
              </div>
            </div>
          )}

          {/* No games */}
          {!error&&currentGames.length===0&&!loading&&(
            <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",
              justifyContent:"center",flexDirection:"column",gap:14}}>
              <span style={{fontSize:56}}>{meta.icon}</span>
              <div style={{fontSize:24,fontWeight:900,color:"rgba(255,255,255,0.25)",
                letterSpacing:3,fontFamily:F}}>NO {meta.label} GAMES TODAY</div>
            </div>
          )}

          {/* Loading */}
          {loading&&currentGames.length===0&&(
            <div style={{position:"absolute",inset:0,display:"flex",
              alignItems:"center",justifyContent:"center",gap:14}}>
              <div style={{width:16,height:16,borderRadius:"50%",
                border:"3px solid rgba(255,255,255,0.1)",borderTopColor:meta.accent,
                animation:"spin 0.75s linear infinite"}}/>
              <span style={{fontSize:22,fontWeight:800,color:"rgba(255,255,255,0.35)",
                letterSpacing:3,fontFamily:F}}>LOADING SCORES…</span>
            </div>
          )}

          {/* Vignettes */}
          <div style={{position:"absolute",left:0,top:0,bottom:0,width:50,zIndex:10,
            background:"linear-gradient(to right,#0a0a0a 40%,transparent)",pointerEvents:"none"}}/>
          <div style={{position:"absolute",right:0,top:0,bottom:0,width:65,zIndex:10,
            background:"linear-gradient(to left,#0a0a0a 40%,transparent)",pointerEvents:"none"}}/>

          {/* Scrolling cards */}
          {currentGames.length>0&&(
            <div ref={scrollRef} style={{display:"inline-flex",alignItems:"stretch",
              height:"100%",willChange:"transform"}}>
              {[...currentGames,...currentGames].map((game,i)=>(
                <GameCard key={`${game.id}-${i}`} game={game} flash={flashIds.has(game.id)}/>
              ))}
            </div>
          )}

          {/* Bottom accent */}
          <div style={{position:"absolute",bottom:0,left:0,right:0,height:3,
            background:`linear-gradient(90deg,transparent,${meta.accent},transparent)`,opacity:0.5}}/>
        </div>
      </div>
    </>
  );
}

// Mount
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<SportsBoard/>);
