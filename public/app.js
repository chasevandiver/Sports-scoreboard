// ═══════════════════════════════════════════════════════════════════
//  SPORTS SCOREBOARD — public/app.js
//  Plain JavaScript, no JSX, no Babel. Loads instantly on iPad.
//  React.createElement used throughout instead of JSX syntax.
// ═══════════════════════════════════════════════════════════════════
"use strict";

const e    = React.createElement;
const {useState, useEffect, useRef, useCallback, Fragment} = React;
const F    = "'Barlow Condensed','Arial Narrow',Arial,sans-serif";

// ── CONFIG ───────────────────────────────────────────────────────────
const POLL_SCORES_MS  = 30000;
const POLL_LEADERS_MS = 60000;
const SPEED_ROW1      = 90;
const SPEED_ROW2      = 75;
const ALERT_MS        = 8000;
const BATCH_SIZE      = 4;
const BATCH_DELAY_MS  = 400;

// ── CBB CONFERENCES ───────────────────────────────────────────────────
const CBB_CONFS = [
  {id:"2",  name:"Big 12"},  {id:"8",  name:"ACC"},
  {id:"23", name:"Big East"},{id:"21", name:"Big Ten"},
  {id:"9",  name:"SEC"},     {id:"18", name:"AAC"},
  {id:"25", name:"MWC"},     {id:"45", name:"A-10"},
  {id:"49", name:"WCC"},     {id:"24", name:"MAC"},
  {id:"46", name:"CUSA"},    {id:"48", name:"Sun Belt"},
  {id:"37", name:"Horizon"}, {id:"44", name:"MVC"},
  {id:"26", name:"Ivy"},     {id:"40", name:"Patriot"},
  {id:"29", name:"SoCon"},   {id:"60", name:"CAA"},
  {id:"11", name:"SWAC"},    {id:"31", name:"MEAC"},
  {id:"13", name:"OVC"},     {id:"38", name:"NEC"},
  {id:"62", name:"Summit"},  {id:"10", name:"WAC"},
  {id:"41", name:"Big South"},{id:"56",name:"Am. East"},
  {id:"43", name:"Big West"},{id:"30", name:"ASun"},
].map(c=>({
  sport:"basketball", league:"mens-college-basketball",
  label:"CBB·"+c.name, shortLabel:c.name,
  icon:"🏀", accent:"#1A4A8A",
  groups:c.id, isCBB:true,
}));

const NON_CBB = [
  {sport:"basketball",league:"nba",          label:"NBA",  icon:"🏀",accent:"#C9082A",groups:null},
  {sport:"hockey",    league:"nhl",          label:"NHL",  icon:"🏒",accent:"#00539B",groups:null},
  {sport:"baseball",  league:"mlb",          label:"MLB",  icon:"⚾",accent:"#002D72",groups:null},
  {sport:"football",  league:"nfl",          label:"NFL",  icon:"🏈",accent:"#013369",groups:null},
  {sport:"football",  league:"college-football",label:"NCAAF",icon:"🏈",accent:"#8B2500",groups:"80"},
  {sport:"basketball",league:"wnba",         label:"WNBA", icon:"🏀",accent:"#C96A2A",groups:null},
];

const ALL_LEAGUES = [...NON_CBB, ...CBB_CONFS];

const SETTINGS_GROUPS = [
  {key:"NCAAM", label:"NCAAM (all D1 conferences)", icon:"🏀", accent:"#1A4A8A"},
  ...NON_CBB.map(l=>({key:l.league, label:l.label, icon:l.icon, accent:l.accent})),
];

function leagueKey(lg) { return lg.isCBB ? "cbb_"+lg.groups : lg.league; }
function leagueParams(lg) {
  if (lg.isCBB)    return {groups:lg.groups, limit:30};
  if (lg.groups)   return {groups:lg.groups, limit:80};
  return {limit:40};
}

// ── ESPN FETCH ────────────────────────────────────────────────────────
async function espnFetch(sport, league, extra, params) {
  extra  = extra  || "scoreboard";
  params = params || {};
  let path = sport+"/"+league+"/"+extra;
  const qs = new URLSearchParams(params).toString();
  if (qs) path += (path.includes("?")?"&":"?")+qs;
  const res = await fetch("/api/espn?path="+encodeURIComponent(path), {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("HTTP "+res.status);
  const text = await res.text();
  if (!text || text.trim()[0]==="<") throw new Error("Bad response from proxy");
  return JSON.parse(text);
}

// ── PARSE GAME ────────────────────────────────────────────────────────
function parseGame(event, sport, league) {
  try {
    const comp = event.competitions&&event.competitions[0];
    if (!comp) return null;
    const competitors = comp.competitors||[];
    const home = competitors.find(c=>c.homeAway==="home");
    const away = competitors.find(c=>c.homeAway==="away");
    if (!home||!away) return null;

    const sType     = (comp.status&&comp.status.type)||{};
    const state     = sType.state||"pre";
    const completed = sType.completed||false;
    const status    = completed?"final":state==="in"?"live":"pre";

    const period = (comp.status&&comp.status.period)||0;
    const clock  = (comp.status&&comp.status.displayClock)||"";

    let periodLabel = "";
    if (status==="live") {
      if      (sport==="basketball") periodLabel="Q"+period;
      else if (sport==="hockey")     periodLabel="P"+period;
      else if (sport==="football")   periodLabel="Q"+period;
      else if (sport==="baseball")   periodLabel=sType.shortDetail||("INN "+period);
    } else if (status==="final") {
      periodLabel=sType.shortDetail||"Final";
    } else {
      const d=comp.date?new Date(comp.date):null;
      periodLabel=d?d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}):"TBD";
    }

    const odds=comp.odds&&comp.odds[0];
    let spread=null;
    if (odds&&odds.details&&odds.details!=="EVEN") {
      const p=odds.details.trim().split(" ");
      if (p.length===2) spread={favorite:p[0],line:parseFloat(p[1])};
    }

    const mkColor=t=>"#"+((t.team&&t.team.color)||"444444").replace("#","");
    const sit=comp.situation||null;

    const broadcasts=comp.broadcasts||[];
    let channel=null;
    if (broadcasts.length) {
      const nat=broadcasts.find(b=>b.market==="national")||broadcasts[0];
      channel=(nat.names&&nat.names[0])||(nat.media&&nat.media.shortName)||null;
    }
    if (!channel&&comp.geoBroadcasts&&comp.geoBroadcasts.length) {
      channel=(comp.geoBroadcasts[0].media&&comp.geoBroadcasts[0].media.shortName)||null;
    }

    const homeRank=(home.curatedRank&&home.curatedRank.current)||home.rank||null;
    const awayRank=(away.curatedRank&&away.curatedRank.current)||away.rank||null;

    // Clock to seconds remaining
    let clockSecs=null;
    if (status==="live"&&clock) {
      const pts=clock.split(":").map(Number);
      if (pts.length===2) clockSecs=pts[0]*60+pts[1];
    }

    return {
      id:event.id, sport, league, status,
      period:periodLabel,
      clock: status==="live"&&sport!=="baseball"?clock:"",
      clockSecs,
      home:{
        abbr:(home.team&&home.team.abbreviation)||"HM",
        color:mkColor(home),
        logo:(home.team&&home.team.logo)||null,
        score:status!=="pre"?parseInt((home.score||0)):null,
        record:(home.records&&home.records[0]&&home.records[0].summary)||"",
        rank:homeRank&&homeRank<=25?homeRank:null,
      },
      away:{
        abbr:(away.team&&away.team.abbreviation)||"AW",
        color:mkColor(away),
        logo:(away.team&&away.team.logo)||null,
        score:status!=="pre"?parseInt((away.score||0)):null,
        record:(away.records&&away.records[0]&&away.records[0].summary)||"",
        rank:awayRank&&awayRank<=25?awayRank:null,
      },
      spread, channel,
      bases:sit?[!!sit.onFirst,!!sit.onSecond,!!sit.onThird]:[false,false,false],
      outs:(sit&&sit.outs)||0,
      leaders:{home:[],away:[]},
      alert:null,
    };
  } catch(err) {
    return null;
  }
}

// ── DETECT ALERT ─────────────────────────────────────────────────────
function detectAlert(game, prev) {
  if (game.status!=="live") return null;
  const hs=game.home.score||0, as=game.away.score||0;
  const diff=Math.abs(hs-as);
  const secs=game.clockSecs;

  if (prev&&(prev.home!==hs||prev.away!==as)) {
    const scorer=hs>(prev.home||0)?game.home.abbr:game.away.abbr;
    const pts=hs>(prev.home||0)?hs-(prev.home||0):as-(prev.away||0);
    return {type:"SCORE", text:scorer+" scores"+(pts>1?" ("+pts+")":""), color:"#F5A623"};
  }
  if (game.sport==="basketball"&&game.period==="Q4"&&secs!==null&&secs<=120&&diff<=5)
    return {type:"CLOSE", text:(diff===0?"TIE GAME":"CLOSE GAME")+" — "+game.period+" "+game.clock, color:"#FF453A"};
  if (game.sport==="football"&&game.period==="Q4"&&secs!==null&&secs<=120&&diff<=8)
    return {type:"CLOSE", text:"CLOSE GAME — "+game.period+" "+game.clock, color:"#FF453A"};
  if (game.sport==="hockey"&&game.period==="P3"&&secs!==null&&secs<=120&&diff<=1)
    return {type:"CLOSE", text:"CLOSE GAME — "+game.period+" "+game.clock, color:"#FF453A"};
  return null;
}

// ── PARSE LEADERS ────────────────────────────────────────────────────
function parseLeaders(summary, game) {
  try {
    const result={home:[],away:[]};
    const boxscore=summary&&summary.boxscore;
    if (!boxscore) return result;
    const headerComps=((summary.header&&summary.header.competitions&&summary.header.competitions[0])||{}).competitors||[];
    const homeId=(headerComps.find(c=>c.homeAway==="home")||{team:{}}).team.id;

    (boxscore.players||[]).forEach(group=>{
      const side=group.team&&group.team.id===homeId?"home":"away";
      const stats=group.statistics&&group.statistics[0];
      if (!stats) return;
      const labels=stats.labels||[];
      const ptsIdx=labels.indexOf("PTS");
      const gIdx=labels.indexOf("G");
      const rebIdx=labels.indexOf("REB");
      const astIdx=labels.indexOf("AST");
      const si=ptsIdx>=0?ptsIdx:gIdx>=0?gIdx:0;
      result[side]=(stats.athletes||[])
        .filter(a=>a.stats&&a.stats.length&&a.stats.some(s=>s!=="--"&&s!=="0"))
        .sort((a,b)=>parseFloat((b.stats&&b.stats[si])||0)-parseFloat((a.stats&&a.stats[si])||0))
        .slice(0,2)
        .map(a=>({
          name:(a.athlete&&(a.athlete.shortName||a.athlete.displayName))||"—",
          pts:(a.stats&&a.stats[si])||"—",
          reb:rebIdx>=0?(a.stats&&a.stats[rebIdx]):null,
          ast:astIdx>=0?(a.stats&&a.stats[astIdx]):null,
        }));
    });

    if (!result.home.length&&!result.away.length) {
      (summary.leaders||[]).forEach(lg=>{
        const l=lg.leaders&&lg.leaders[0];
        if (!l) return;
        const side=homeId===lg.team&&lg.team.id?"home":"away";
        if (result[side].length<2) result[side].push({
          name:(l.athlete&&(l.athlete.shortName||l.athlete.displayName))||"—",
          pts:l.value||"—", reb:null, ast:null,
        });
      });
    }
    return result;
  } catch {return {home:[],away:[]};}
}

function getCover(game) {
  if (game.status!=="final"||!game.spread||!game.spread.line) return null;
  const {home,away,spread}=game;
  const favIsHome=spread.favorite===home.abbr;
  const margin=favIsHome?home.score-away.score:away.score-home.score;
  return margin>Math.abs(spread.line);
}

// ── INLINE STYLES HELPERS ─────────────────────────────────────────────
function s() {
  // merge style objects
  return Object.assign({}, ...arguments);
}

// ═══════════════════════════════════════════════════════════════════
//  COMPONENTS (React.createElement, no JSX)
// ═══════════════════════════════════════════════════════════════════

function Diamond({bases, outs}) {
  const S=13;
  const base=on=>({
    width:S,height:S,transform:"rotate(45deg)",flexShrink:0,display:"inline-block",
    background:on?"#F5A623":"rgba(255,255,255,0.1)",
    border:"2px solid "+(on?"#F5A623":"rgba(255,255,255,0.2)"),
    boxShadow:on?"0 0 6px #F5A623aa":"none",
  });
  return e("div",{style:{display:"flex",flexDirection:"column",alignItems:"center",gap:3,
    paddingRight:10,borderRight:"1px solid rgba(255,255,255,0.08)"}},
    e("div",{style:base(bases[1])}),
    e("div",{style:{display:"flex",gap:16}},
      e("div",{style:base(bases[2])}),
      e("div",{style:base(bases[0])}),
    ),
    e("div",{style:{display:"flex",gap:4,marginTop:3}},
      [0,1,2].map(i=>e("div",{key:i,style:{
        width:6,height:6,borderRadius:"50%",
        background:i<outs?"#F5A623":"rgba(255,255,255,0.12)",
        border:"1px solid rgba(255,255,255,0.2)",
      }}))
    )
  );
}

function TeamLogo({src, color, size}) {
  size=size||44;
  const [err,setErr]=useState(false);
  if (!src||err) return e("div",{style:{
    width:size,height:size,borderRadius:6,flexShrink:0,
    background:color+"33",border:"2px solid "+color+"22",
  }});
  return e("img",{src,alt:"",width:size,height:size,
    onError:()=>setErr(true),
    style:{objectFit:"contain",flexShrink:0,filter:"drop-shadow(0 2px 6px rgba(0,0,0,0.8))"},
  });
}

function RankBadge({rank,sz}) {
  if (!rank) return null;
  return e("span",{style:{
    fontSize:sz*0.55,fontWeight:900,fontFamily:F,
    color:"#F5C518",background:"rgba(245,197,24,0.15)",
    border:"1px solid rgba(245,197,24,0.4)",
    borderRadius:4,padding:"1px 4px",lineHeight:1,
    marginRight:3,flexShrink:0,
  }},"#"+rank);
}

function AlertBanner({alert,rowH}) {
  if (!alert) return null;
  const icon=alert.type==="CLOSE"?"🚨":"🔥";
  return e("div",{className:"alert-bar",style:{
    position:"absolute",top:0,left:0,right:0,
    height:Math.floor(rowH*0.14),
    display:"flex",alignItems:"center",justifyContent:"center",gap:8,zIndex:20,
    background:"linear-gradient(90deg,transparent,"+alert.color+"33,"+alert.color+"55,"+alert.color+"33,transparent)",
  }},
    e("span",{style:{fontSize:Math.floor(rowH*0.09),lineHeight:1}},icon),
    e("span",{style:{fontSize:Math.floor(rowH*0.09),fontWeight:900,fontFamily:F,
      color:alert.color,letterSpacing:1.5,textTransform:"uppercase"}},alert.text)
  );
}

function GameCard({game,flash,rowH}) {
  const covered  = getCover(game);
  const isLive   = game.status==="live";
  const isFinal  = game.status==="final";
  const isPre    = game.status==="pre";
  const homeWin  = (game.home.score||0)>(game.away.score||0);
  const awayWin  = (game.away.score||0)>(game.home.score||0);
  const hasAlert = !!game.alert;

  const scoreSz    = Math.floor(rowH*0.26);
  const abbrSz     = Math.floor(rowH*0.14);
  const leaderSz   = Math.floor(rowH*0.08);
  const leaderPtSz = Math.floor(rowH*0.10);
  const logoSz     = Math.floor(rowH*0.22);
  const cardW      = Math.floor(rowH*1.4);
  const pad        = Math.floor(rowH*0.07);

  const teamRow=(side)=>{
    const t=game[side];
    const isWin=side==="home"?homeWin:awayWin;
    const isLose=side==="home"?awayWin:homeWin;
    return e("div",{style:{display:"flex",alignItems:"center",gap:9,
      opacity:isFinal&&isLose?0.45:1,transition:"opacity 0.4s"}},
      e(TeamLogo,{src:t.logo,color:t.color,size:logoSz}),
      e("div",{style:{display:"flex",alignItems:"baseline",gap:5,flex:1,minWidth:0}},
        e(RankBadge,{rank:t.rank,sz:abbrSz}),
        e("span",{style:{fontSize:abbrSz,fontWeight:900,color:"#fff",letterSpacing:0.5,
          lineHeight:1,fontFamily:F}},t.abbr),
        !isPre&&e("span",{style:{
          fontSize:scoreSz,fontWeight:900,lineHeight:1,fontFamily:F,
          fontVariantNumeric:"tabular-nums",marginLeft:6,
          color:isWin?"#fff":"rgba(255,255,255,0.45)",
          textShadow:isWin&&isLive?"0 0 22px "+t.color+"cc":"none",
          transition:"all 0.4s",
        }},t.score),
        t.record&&!t.rank&&isPre&&e("span",{style:{fontSize:Math.floor(rowH*0.065),
          color:"rgba(255,255,255,0.3)",fontWeight:600}},t.record),
      )
    );
  };

  const leaderCol=(side)=>{
    const t=game[side];
    const players=game.leaders[side];
    return e("div",{style:{flex:1,minWidth:0}},
      e("div",{style:{fontSize:Math.floor(rowH*0.06),fontWeight:800,letterSpacing:1.5,
        marginBottom:3,color:t.color,textTransform:"uppercase",fontFamily:F,
        textShadow:"0 0 8px "+t.color+"44"}},t.abbr),
      players.length?players.map((p,i)=>
        e("div",{key:i,style:{display:"flex",alignItems:"baseline",gap:4,marginBottom:2}},
          e("span",{style:{fontSize:leaderSz,fontWeight:800,color:"rgba(255,255,255,0.85)",
            whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",
            maxWidth:Math.floor(rowH*0.65),fontFamily:F}},p.name),
          e("span",{style:{fontSize:leaderPtSz,fontWeight:900,color:"#fff",lineHeight:1,
            fontVariantNumeric:"tabular-nums",fontFamily:F}},p.pts),
          p.reb&&p.reb!=="0"&&p.reb!=="--"&&e("span",{style:{fontSize:leaderSz*0.8,
            color:"rgba(255,255,255,0.4)",fontWeight:700}},p.reb+"r"),
          p.ast&&p.ast!=="0"&&p.ast!=="--"&&e("span",{style:{fontSize:leaderSz*0.8,
            color:"rgba(255,255,255,0.4)",fontWeight:700}},p.ast+"a"),
        )
      ):e("span",{style:{fontSize:leaderSz,color:"rgba(255,255,255,0.15)",fontStyle:"italic"}},"—")
    );
  };

  return e("div",{style:{
    display:"inline-flex",flexDirection:"column",
    width:cardW,height:"100%",flexShrink:0,
    padding:pad+"px "+Math.floor(rowH*0.08)+"px",
    borderRight:"1px solid rgba(255,255,255,0.07)",
    background:hasAlert
      ?"linear-gradient(180deg,"+game.alert.color+"18 0%,transparent 40%)"
      :flash
        ?"linear-gradient(180deg,rgba(255,210,0,0.12) 0%,transparent 50%)"
        :"linear-gradient(180deg,rgba(255,255,255,0.02) 0%,transparent 100%)",
    position:"relative",overflow:"hidden",
  }},
    // Top color stripe
    e("div",{style:{position:"absolute",top:0,left:0,right:0,height:3,
      background:"linear-gradient(90deg,"+game.away.color+","+game.home.color+")",opacity:0.8}}),

    // Alert banner
    hasAlert&&e(AlertBanner,{alert:game.alert,rowH}),

    // Status row
    e("div",{style:{display:"flex",alignItems:"center",justifyContent:"space-between",
      marginBottom:Math.floor(rowH*0.05),flexShrink:0,
      marginTop:hasAlert?Math.floor(rowH*0.14):0}},

      // Left: period + clock
      e("div",{style:{display:"flex",alignItems:"center",gap:7}},
        isLive&&e("div",{className:"live-dot",style:{width:9,height:9,borderRadius:"50%",
          background:"#FF3B30",boxShadow:"0 0 7px #FF3B30",flexShrink:0}}),
        e("span",{style:{fontSize:Math.floor(rowH*0.10),fontWeight:900,fontFamily:F,letterSpacing:1,
          color:isLive?"#FF3B30":"rgba(255,255,255,0.38)"}},game.period),
        isLive&&game.clock&&e("span",{style:{fontSize:Math.floor(rowH*0.12),fontWeight:800,
          fontFamily:F,color:"rgba(255,255,255,0.85)"}},game.clock),
      ),

      // Right: channel + spread
      e("div",{style:{display:"flex",alignItems:"center",gap:8}},
        game.channel&&e("div",{style:{display:"flex",alignItems:"center",gap:4,
          background:"rgba(255,255,255,0.08)",borderRadius:5,
          padding:"2px "+Math.floor(rowH*0.04)+"px"}},
          e("span",{style:{fontSize:Math.floor(rowH*0.07)}},"📺"),
          e("span",{style:{fontSize:Math.floor(rowH*0.08),fontWeight:800,fontFamily:F,
            color:"rgba(255,255,255,0.75)",letterSpacing:0.5}},game.channel),
        ),
        game.spread&&e("div",{style:{display:"flex",alignItems:"center",gap:5,
          background:"rgba(255,255,255,0.07)",borderRadius:5,
          padding:"2px "+Math.floor(rowH*0.04)+"px"}},
          e("span",{style:{fontSize:Math.floor(rowH*0.065),fontWeight:700,
            color:"rgba(255,255,255,0.35)",letterSpacing:1}},"SPR"),
          e("span",{style:{fontSize:Math.floor(rowH*0.09),fontWeight:800,fontFamily:F,
            color:"rgba(255,255,255,0.8)"}},
            game.spread.favorite+" "+(game.spread.line>0?"+":"")+game.spread.line),
          covered!==null&&e("span",{style:{fontSize:Math.floor(rowH*0.09),fontWeight:900,
            color:covered?"#30D158":"#FF453A",
            textShadow:covered?"0 0 8px rgba(48,209,88,0.7)":"0 0 8px rgba(255,69,58,0.7)"}},
            covered?"✓":"✗"),
        ),
      )
    ),

    // Teams
    e("div",{style:{display:"flex",flexDirection:"column",gap:Math.floor(rowH*0.04),
      flex:1,justifyContent:"center"}},
      teamRow("away"),
      e("div",{style:{height:1,background:"rgba(255,255,255,0.07)"}}),
      teamRow("home"),
    ),

    // Leaders
    e("div",{style:{display:"flex",gap:8,alignItems:"flex-start",
      borderTop:"1px solid rgba(255,255,255,0.07)",
      paddingTop:Math.floor(rowH*0.055),marginTop:Math.floor(rowH*0.04),flexShrink:0}},
      game.sport==="baseball"&&!isPre&&e(Diamond,{bases:game.bases,outs:game.outs}),
      leaderCol("away"),
      e("div",{style:{width:1,background:"rgba(255,255,255,0.07)",alignSelf:"stretch"}}),
      leaderCol("home"),
    )
  );
}

function SportLabel({meta, rowH}) {
  return e("div",{style:{
    width:Math.floor(rowH*0.72),flexShrink:0,height:"100%",
    display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:2,
    background:"linear-gradient(160deg,"+meta.accent+","+meta.accent+"99)",
    borderRight:"3px solid "+meta.accent,zIndex:5,
  }},
    e("span",{style:{fontSize:Math.floor(rowH*0.22),lineHeight:1}},meta.icon),
    e("span",{style:{fontSize:Math.floor(rowH*0.09),fontWeight:900,color:"#fff",
      letterSpacing:2,fontFamily:F}},meta.isCBB?"CBB":meta.label),
    meta.isCBB&&e("span",{style:{fontSize:Math.floor(rowH*0.075),fontWeight:700,
      color:"rgba(255,255,255,0.75)",letterSpacing:1,fontFamily:F,textAlign:"center",
      padding:"0 4px"}},meta.shortLabel)
  );
}

function ScrollRow({rowH, speed, games, meta, flashIds, onLoop}) {
  const scrollRef=useRef(null);
  const animRef=useRef(null);
  const xRef=useRef(0);
  const tsRef=useRef(null);
  const pausedRef=useRef(false);

  const animate=useCallback((ts)=>{
    if (!scrollRef.current) return;
    if (!pausedRef.current) {
      if (tsRef.current===null) tsRef.current=ts;
      const delta=Math.min((ts-tsRef.current)/1000,0.05);
      tsRef.current=ts;
      xRef.current+=speed*delta;
      const half=scrollRef.current.scrollWidth/2;
      if (half>0&&xRef.current>=half){xRef.current=0;onLoop();}
      scrollRef.current.style.transform="translateX(-"+xRef.current+"px)";
    }
    animRef.current=requestAnimationFrame(animate);
  },[speed,onLoop]);

  useEffect(()=>{
    xRef.current=0;tsRef.current=null;
    cancelAnimationFrame(animRef.current);
    animRef.current=requestAnimationFrame(animate);
    return()=>cancelAnimationFrame(animRef.current);
  },[animate,meta.isCBB?meta.groups:meta.league]);

  if (!games.length) return e("div",{style:{flex:1,display:"flex",alignItems:"center",
    justifyContent:"center",color:"rgba(255,255,255,0.15)",fontSize:Math.floor(rowH*0.11),
    fontFamily:F,letterSpacing:3}},"NO GAMES");

  const doubled=[...games,...games];
  return e("div",{
    style:{flex:1,overflow:"hidden",position:"relative"},
    onTouchStart:()=>{pausedRef.current=true;},
    onTouchEnd:()=>{pausedRef.current=false;tsRef.current=null;},
  },
    e("div",{style:{position:"absolute",left:0,top:0,bottom:0,width:35,zIndex:4,
      background:"linear-gradient(to right,#0a0a0a 30%,transparent)",pointerEvents:"none"}}),
    e("div",{style:{position:"absolute",right:0,top:0,bottom:0,width:45,zIndex:4,
      background:"linear-gradient(to left,#0a0a0a 30%,transparent)",pointerEvents:"none"}}),
    e("div",{ref:scrollRef,style:{display:"inline-flex",alignItems:"stretch",
      height:"100%",willChange:"transform"}},
      doubled.map((g,i)=>e(GameCard,{
        key:g.id+"-"+i, game:g,
        flash:flashIds.has(g.id), rowH,
      }))
    )
  );
}

function SettingsPanel({enabledSet, gameCount, onToggle, onClose}) {
  return e("div",{
    style:{position:"fixed",inset:0,zIndex:100,background:"rgba(0,0,0,0.88)",
      display:"flex",alignItems:"center",justifyContent:"center"},
    onClick:onClose,
  },
    e("div",{
      style:{background:"#181818",border:"1px solid rgba(255,255,255,0.12)",
        borderRadius:16,padding:28,minWidth:320,maxWidth:460,width:"90vw",
        maxHeight:"85vh",overflowY:"auto"},
      onClick:ev=>ev.stopPropagation(),
    },
      e("div",{style:{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}},
        e("span",{style:{fontSize:22,fontWeight:900,color:"#fff",fontFamily:F,letterSpacing:2}},
          "SPORTS SELECTOR"),
        e("button",{onClick:onClose,style:{background:"rgba(255,255,255,0.1)",
          border:"1px solid rgba(255,255,255,0.15)",color:"#fff",borderRadius:8,
          padding:"6px 14px",fontSize:14,fontFamily:F,fontWeight:800,cursor:"pointer",
          letterSpacing:1}},"DONE"),
      ),
      e("p",{style:{fontSize:13,color:"rgba(255,255,255,0.35)",marginBottom:16,lineHeight:1.5}},
        "NCAAM shows one conference per rotation slot."),
      e("div",{style:{display:"flex",flexDirection:"column",gap:10}},
        SETTINGS_GROUPS.map(sg=>{
          const enabled=enabledSet.has(sg.key);
          const count=gameCount(sg.key);
          return e("div",{key:sg.key,onClick:()=>onToggle(sg.key),style:{
            display:"flex",alignItems:"center",gap:14,
            padding:"11px 14px",borderRadius:10,cursor:"pointer",
            background:enabled?sg.accent+"22":"rgba(255,255,255,0.04)",
            border:"1.5px solid "+(enabled?sg.accent:"rgba(255,255,255,0.08)"),
            opacity:count>0?1:0.4,
          }},
            e("span",{style:{fontSize:22}},sg.icon),
            e("div",{style:{flex:1}},
              e("div",{style:{fontSize:15,fontWeight:900,color:"#fff",fontFamily:F,letterSpacing:1}},
                sg.label),
              e("div",{style:{fontSize:12,color:"rgba(255,255,255,0.35)",marginTop:1}},
                count>0?count+" game"+(count!==1?"s":"")+" today":"No games today"),
            ),
            e("div",{style:{width:44,height:24,borderRadius:12,position:"relative",
              background:enabled?sg.accent:"rgba(255,255,255,0.15)",flexShrink:0}},
              e("div",{style:{position:"absolute",top:3,left:enabled?22:3,
                width:18,height:18,borderRadius:"50%",background:"#fff",
                transition:"left 0.15s",boxShadow:"0 1px 4px rgba(0,0,0,0.4)"}})
            ),
          );
        })
      )
    )
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
  const [enabledLeagues,setEnabledLeagues]= useState(()=>new Set(SETTINGS_GROUPS.map(g=>g.key)));

  const prevScores  = useRef({});
  const alertTimers = useRef({});

  useEffect(()=>{
    const iv=setInterval(()=>setClock(new Date()),1000);
    return()=>clearInterval(iv);
  },[]);

  const fetchLeague=useCallback(async(lg)=>{
    const key=leagueKey(lg);
    const data=await espnFetch(lg.sport,lg.league,"scoreboard",leagueParams(lg));
    const events=(data&&data.events)||[];
    const games=events.map(ev=>parseGame(ev,lg.sport,lg.league)).filter(Boolean);

    const updated=games.map(g=>{
      const prev=prevScores.current[g.id];
      const alert=detectAlert(g,prev);
      if (prev&&g.status==="live"&&(prev.home!==g.home.score||prev.away!==g.away.score)) {
        setFlashIds(f=>new Set([...f,g.id]));
        setTimeout(()=>setFlashIds(f=>{const n=new Set(f);n.delete(g.id);return n;}),2500);
      }
      if (alert) {
        if (alertTimers.current[g.id]) clearTimeout(alertTimers.current[g.id]);
        alertTimers.current[g.id]=setTimeout(()=>{
          setAllGames(prev=>({...prev,[key]:(prev[key]||[]).map(x=>x.id===g.id?{...x,alert:null}:x)}));
        },ALERT_MS);
      }
      prevScores.current[g.id]={home:g.home.score,away:g.away.score};
      return {...g,alert};
    });

    return {key,games:updated};
  },[]);

  const fetchLeaders=useCallback(async(game,lg)=>{
    if (game.status==="pre") return;
    const key=leagueKey(lg);
    try {
      const summary=await espnFetch(lg.sport,lg.league,"summary?event="+game.id,{});
      const leaders=parseLeaders(summary,game);
      setAllGames(prev=>({...prev,[key]:(prev[key]||[]).map(g=>g.id===game.id?{...g,leaders}:g)}));
    } catch{}
  },[]);

  const loadAllScores=useCallback(async()=>{
    setLoading(true);
    setLoadError(null);
    try {
      const nextGames={};
      const withGames=[];
      for (let i=0;i<ALL_LEAGUES.length;i+=BATCH_SIZE) {
        const batch=ALL_LEAGUES.slice(i,i+BATCH_SIZE);
        const results=await Promise.allSettled(batch.map(lg=>fetchLeague(lg)));
        results.forEach((r,bi)=>{
          if (r.status==="fulfilled") {
            const {key,games}=r.value;
            nextGames[key]=games;
            const lg=batch[bi];
            const sk=lg.isCBB?"NCAAM":lg.league;
            if (games.length>0&&enabledLeagues.has(sk)) withGames.push(lg);
          }
        });
        if (i+BATCH_SIZE<ALL_LEAGUES.length)
          await new Promise(r=>setTimeout(r,BATCH_DELAY_MS));
      }
      setAllGames(nextGames);
      setActiveLeagues(withGames);
      setRow1Idx(v=>Math.min(v,Math.max(withGames.length-1,0)));
      setRow2Idx(v=>withGames.length>1?Math.min(v,withGames.length-1):0);
      setLastUpdated(new Date());
    } catch(err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  },[fetchLeague,enabledLeagues]);

  useEffect(()=>{
    loadAllScores();
    const iv=setInterval(loadAllScores,POLL_SCORES_MS);
    return()=>clearInterval(iv);
  },[loadAllScores]);

  // Leaders for active rows
  useEffect(()=>{
    if (!activeLeagues.length) return;
    const load=async()=>{
      const rows=[activeLeagues[row1Idx],activeLeagues[row2Idx]].filter(Boolean);
      for (const lg of rows) {
        const games=(allGames[leagueKey(lg)]||[]).filter(g=>g.status!=="pre");
        for (const g of games) {
          await fetchLeaders(g,lg);
          await new Promise(r=>setTimeout(r,400));
        }
      }
    };
    load();
    const iv=setInterval(load,POLL_LEADERS_MS);
    return()=>clearInterval(iv);
  },[activeLeagues,row1Idx,row2Idx,allGames,fetchLeaders]);

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

  const toggleLeague=useCallback((key)=>{
    setEnabledLeagues(prev=>{
      const n=new Set(prev);
      n.has(key)?n.delete(key):n.add(key);
      return n;
    });
  },[]);

  const meta1  = activeLeagues[row1Idx]||ALL_LEAGUES[0];
  const meta2  = activeLeagues.length>1?(activeLeagues[row2Idx]||ALL_LEAGUES[1]):null;
  const games1 = allGames[leagueKey(meta1)]||[];
  const games2 = meta2?(allGames[leagueKey(meta2)]||[]):[];
  const headerH= 48;
  const rowHNum= Math.floor((window.innerHeight-headerH)/2);

  return e(Fragment,null,
    // Settings overlay
    showSettings&&e(SettingsPanel,{
      enabledSet:enabledLeagues,
      gameCount:key=>{
        if (key==="NCAAM") return CBB_CONFS.reduce((s,c)=>s+(allGames[leagueKey(c)]||[]).length,0);
        return (allGames[key]||[]).length;
      },
      onToggle:toggleLeague,
      onClose:()=>setShowSettings(false),
    }),

    e("div",{style:{width:"100vw",height:"100vh",display:"flex",flexDirection:"column",background:"#0a0a0a"}},

      // Error screen
      loadError&&activeLeagues.length===0&&e("div",{style:{
        position:"absolute",inset:0,display:"flex",flexDirection:"column",
        alignItems:"center",justifyContent:"center",gap:16,zIndex:50,background:"#0a0a0a"}},
        e("span",{style:{fontSize:48}},"📡"),
        e("div",{style:{fontSize:18,fontWeight:800,color:"rgba(255,255,255,0.5)",
          fontFamily:F,letterSpacing:2,textAlign:"center"}},"CONNECTION ERROR"),
        e("div",{style:{fontSize:13,color:"rgba(255,255,255,0.25)",fontFamily:F,
          maxWidth:400,textAlign:"center",lineHeight:1.6}},
          loadError+"\nRetrying in 30 seconds…"),
      ),

      // Header
      e("div",{style:{height:headerH,flexShrink:0,display:"flex",alignItems:"center",
        justifyContent:"space-between",padding:"0 16px",
        background:"linear-gradient(180deg,#1a1a1a 0%,#111 100%)",
        borderBottom:"1px solid rgba(255,255,255,0.08)"}},

        e("div",{style:{display:"flex",gap:6,alignItems:"center",overflow:"hidden",flex:1}},
          activeLeagues.map((lg,i)=>{
            const isActive=i===row1Idx||i===row2Idx;
            return e("div",{key:leagueKey(lg),style:{
              display:"flex",alignItems:"center",gap:4,
              padding:"3px 8px",borderRadius:20,flexShrink:0,
              background:isActive?lg.accent+"33":"rgba(255,255,255,0.05)",
              border:"1px solid "+(isActive?lg.accent:"rgba(255,255,255,0.1)"),
            }},
              e("span",{style:{fontSize:12}},lg.icon),
              e("span",{style:{fontSize:11,fontWeight:800,fontFamily:F,letterSpacing:1,
                color:isActive?"#fff":"rgba(255,255,255,0.4)"}},
                lg.isCBB?lg.shortLabel:lg.label),
              e("span",{style:{fontSize:10,fontWeight:700,
                color:isActive?"rgba(255,255,255,0.6)":"rgba(255,255,255,0.2)"}},
                (allGames[leagueKey(lg)]||[]).length),
            );
          }),
          loading&&e("div",{className:"spin",style:{width:9,height:9,borderRadius:"50%",
            marginLeft:4,border:"2px solid rgba(255,255,255,0.15)",
            borderTopColor:"#fff",flexShrink:0}}),
        ),

        e("div",{style:{display:"flex",alignItems:"center",gap:10,flexShrink:0}},
          lastUpdated&&e("span",{style:{fontSize:11,color:"rgba(255,255,255,0.2)",
            fontFamily:F,letterSpacing:1}},
            lastUpdated.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})),
          e("span",{style:{fontSize:22,fontWeight:900,color:"rgba(255,255,255,0.8)",
            fontFamily:F,letterSpacing:1}},
            clock.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})),
          e("button",{
            onClick:()=>setShowSettings(s=>!s),
            style:{background:"rgba(255,255,255,0.08)",
              border:"1px solid rgba(255,255,255,0.15)",
              color:"#fff",borderRadius:8,width:34,height:34,
              fontSize:16,cursor:"pointer",display:"flex",
              alignItems:"center",justifyContent:"center",flexShrink:0},
          },"⚙️"),
        ),
      ),

      // Row 1
      e("div",{style:{height:"calc((100vh - "+headerH+"px) / 2)",flexShrink:0,
        display:"flex",alignItems:"stretch",
        borderBottom:"2px solid rgba(255,255,255,0.06)"}},
        e(SportLabel,{meta:meta1,rowH:rowHNum}),
        loading&&games1.length===0
          ?e("div",{style:{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:12}},
            e("div",{className:"spin",style:{width:14,height:14,borderRadius:"50%",
              border:"3px solid rgba(255,255,255,0.1)",borderTopColor:meta1.accent}}),
            e("span",{style:{fontSize:18,fontWeight:800,color:"rgba(255,255,255,0.3)",
              fontFamily:F,letterSpacing:3}},"LOADING…"))
          :e(ScrollRow,{rowH:rowHNum,speed:SPEED_ROW1,games:games1,
              meta:meta1,flashIds,onLoop:handleRow1Loop}),
      ),

      // Row 2
      meta2
        ?e("div",{style:{height:"calc((100vh - "+headerH+"px) / 2)",flexShrink:0,
            display:"flex",alignItems:"stretch"}},
            e(SportLabel,{meta:meta2,rowH:rowHNum}),
            loading&&games2.length===0
              ?e("div",{style:{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:12}},
                e("div",{className:"spin",style:{width:14,height:14,borderRadius:"50%",
                  border:"3px solid rgba(255,255,255,0.1)",borderTopColor:meta2.accent}}),
                e("span",{style:{fontSize:18,fontWeight:800,color:"rgba(255,255,255,0.3)",
                  fontFamily:F,letterSpacing:3}},"LOADING…"))
              :e(ScrollRow,{rowH:rowHNum,speed:SPEED_ROW2,games:games2,
                  meta:meta2,flashIds,onLoop:handleRow2Loop}),
          )
        :e("div",{style:{flex:1,display:"flex",alignItems:"center",justifyContent:"center",
            color:"rgba(255,255,255,0.08)",fontSize:14,fontFamily:F,letterSpacing:3}},
            "NO OTHER SPORTS TODAY"),
    )
  );
}

// Mount
const root=ReactDOM.createRoot(document.getElementById("root"));
root.render(e(SportsBoard,null));
