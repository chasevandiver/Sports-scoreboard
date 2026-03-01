"use strict";
// ═══════════════════════════════════════════════════════════════════
//  SPORTS SCOREBOARD  v7
//
//  CBB FIX: One single ESPN call with groups=100&limit=300 gets ALL
//  D1 games. We then group them client-side by conference name from
//  the team data — no more guessing ESPN conference group IDs.
//
//  LAYOUT FIX: Card height is partitioned into fixed sections
//  (status / teams / leaders) so nothing ever overflows or clips.
//
//  SCROLL: 50 px/sec row1, 40 row2. Each conference completes
//  3 full loops before rotating to the next.
// ═══════════════════════════════════════════════════════════════════
const e = React.createElement;
const {useState,useEffect,useRef,useCallback,Fragment} = React;
const F = "'Barlow Condensed','Arial Narrow',Arial,sans-serif";

// ── CONFIG ────────────────────────────────────────────────────────
const POLL_SCORES_MS   = 30000;
const POLL_LEADERS_MS  = 65000;
const SPEED_ROW1       = 50;    // px/sec
const SPEED_ROW2       = 40;    // px/sec
const ALERT_MS         = 7000;
const BATCH_SIZE       = 3;
const BATCH_DELAY_MS   = 500;
const LOOPS_PER_ROTATE = 3;     // full loops before rotating sport

// ── NON-CBB LEAGUES ───────────────────────────────────────────────
const NON_CBB = [
  {sport:"basketball",league:"nba",              label:"NBA",   icon:"🏀",accent:"#C9082A",groups:null,isCBB:false},
  {sport:"hockey",    league:"nhl",              label:"NHL",   icon:"🏒",accent:"#00539B",groups:null,isCBB:false},
  {sport:"baseball",  league:"mlb",              label:"MLB",   icon:"⚾",accent:"#002D72",groups:null,isCBB:false},
  {sport:"football",  league:"nfl",              label:"NFL",   icon:"🏈",accent:"#013369",groups:null,isCBB:false},
  {sport:"football",  league:"college-football", label:"NCAAF", icon:"🏈",accent:"#8B2500",groups:"80",isCBB:false},
  {sport:"basketball",league:"wnba",             label:"WNBA",  icon:"🏀",accent:"#C96A2A",groups:null,isCBB:false},
];

// CBB is a single "virtual" league entry — one fetch, split by conf client-side
const CBB_LEAGUE = {
  sport:"basketball",league:"mens-college-basketball",
  label:"CBB",icon:"🏀",accent:"#1A4A8A",
  groups:"100",    // "100" = ESPN magic number: return all D1 games
  limit:300,
  isCBB:true,
};

const SETTINGS_GROUPS = [
  {key:"NCAAM",  label:"NCAAM (all D1 conferences)", icon:"🏀",accent:"#1A4A8A"},
  ...NON_CBB.map(l=>({key:l.league,label:l.label,icon:l.icon,accent:l.accent})),
];

// ── ESPN PROXY FETCH ──────────────────────────────────────────────
async function espnFetch(sport,league,extra,params){
  extra  = extra  || "scoreboard";
  params = params || {};
  let path = sport+"/"+league+"/"+extra;
  const qs = new URLSearchParams(params).toString();
  if(qs) path+=(path.includes("?")?"&":"?")+qs;
  const res = await fetch("/api/espn?path="+encodeURIComponent(path),{
    signal:AbortSignal.timeout(12000),
  });
  if(!res.ok) throw new Error("HTTP "+res.status);
  const txt = await res.text();
  if(!txt||txt.trim()[0]==="<") throw new Error("Bad proxy response");
  return JSON.parse(txt);
}

// ── PARSE ONE ESPN EVENT → game object ───────────────────────────
function parseGame(ev,sport,league){
  try{
    const comp=(ev.competitions||[])[0];
    if(!comp) return null;
    const home=comp.competitors.find(c=>c.homeAway==="home");
    const away=comp.competitors.find(c=>c.homeAway==="away");
    if(!home||!away) return null;

    const sType=(comp.status&&comp.status.type)||{};
    const state=sType.state||"pre";
    const done =sType.completed||false;
    const status=done?"final":state==="in"?"live":"pre";

    const period=(comp.status&&comp.status.period)||0;
    const clock =(comp.status&&comp.status.displayClock)||"";

    let periodLabel="";
    if(status==="live"){
      if     (sport==="basketball") periodLabel="Q"+period;
      else if(sport==="hockey")     periodLabel="P"+period;
      else if(sport==="football")   periodLabel="Q"+period;
      else if(sport==="baseball")   periodLabel=sType.shortDetail||("Inn "+period);
    } else if(status==="final"){
      periodLabel=sType.shortDetail||"Final";
    } else {
      const d=comp.date?new Date(comp.date):null;
      periodLabel=d?d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}):"TBD";
    }

    const odds=(comp.odds||[])[0];
    let spread=null;
    if(odds&&odds.details&&odds.details!=="EVEN"){
      const p=odds.details.trim().split(" ");
      if(p.length===2) spread={favorite:p[0],line:parseFloat(p[1])};
    }

    const col=t=>"#"+((t.team&&t.team.color)||"444").replace("#","");
    const sit=comp.situation||null;

    // TV
    const bc=comp.broadcasts||[];
    let channel=null;
    if(bc.length){
      const n=bc.find(b=>b.market==="national")||bc[0];
      channel=(n.names&&n.names[0])||(n.media&&n.media.shortName)||null;
    }
    if(!channel&&(comp.geoBroadcasts||[]).length){
      channel=((comp.geoBroadcasts[0].media||{}).shortName)||null;
    }

    // Rankings
    const hr=(home.curatedRank&&home.curatedRank.current)||home.rank||null;
    const ar=(away.curatedRank&&away.curatedRank.current)||away.rank||null;

    // Clock secs
    let clockSecs=null;
    if(status==="live"&&clock){
      const p=clock.split(":").map(Number);
      if(p.length===2) clockSecs=p[0]*60+p[1];
    }

    // Conference — ESPN puts it on the team object for CBB
    const confName=(home.team&&home.team.conferenceId&&home.team.groups&&home.team.groups[0]&&home.team.groups[0].name)
      || (home.team&&home.team.conference&&home.team.conference.name)
      || null;

    return{
      id:ev.id,sport,league,status,
      period:periodLabel,
      clock:status==="live"&&sport!=="baseball"?clock:"",
      clockSecs,
      confName,
      home:{
        abbr:(home.team&&home.team.abbreviation)||"HM",
        color:col(home),logo:(home.team&&home.team.logo)||null,
        score:status!=="pre"?parseInt(home.score||0):null,
        record:(home.records&&home.records[0]&&home.records[0].summary)||"",
        rank:hr&&hr<=25?hr:null,
      },
      away:{
        abbr:(away.team&&away.team.abbreviation)||"AW",
        color:col(away),logo:(away.team&&away.team.logo)||null,
        score:status!=="pre"?parseInt(away.score||0):null,
        record:(away.records&&away.records[0]&&away.records[0].summary)||"",
        rank:ar&&ar<=25?ar:null,
      },
      spread,channel,
      bases:sit?[!!sit.onFirst,!!sit.onSecond,!!sit.onThird]:[false,false,false],
      outs:(sit&&sit.outs)||0,
      leaders:{home:[],away:[]},
      alert:null,
    };
  }catch(err){return null;}
}

// ── GROUP CBB GAMES BY CONFERENCE ─────────────────────────────────
// Returns array of { confName, games } sorted: live first, then by count desc
function groupByConference(games){
  const map={};
  games.forEach(g=>{
    // Try to get conf from the game; fall back to "Other"
    const key=g.confName||"Other";
    if(!map[key]) map[key]=[];
    map[key].push(g);
  });
  return Object.entries(map)
    .map(([confName,gs])=>({confName,games:gs}))
    .sort((a,b)=>{
      // Live games first, then largest conference
      const aLive=a.games.filter(g=>g.status==="live").length;
      const bLive=b.games.filter(g=>g.status==="live").length;
      if(bLive!==aLive) return bLive-aLive;
      return b.games.length-a.games.length;
    });
}

// Build league-like meta objects for each CBB conference bucket
function makeCBBMeta(confName){
  return{
    sport:"basketball",league:"mens-college-basketball",
    label:"CBB·"+confName,shortLabel:confName,
    icon:"🏀",accent:"#1A4A8A",
    isCBB:true,
    confName,
    // unique key
    _key:"cbb_conf_"+confName.replace(/\s+/g,"_"),
  };
}

function leagueKey(lg){
  if(lg._key) return lg._key;
  return lg.isCBB?"cbb":lg.league;
}

// ── ALERT ENGINE ─────────────────────────────────────────────────
function detectAlert(game,prev){
  if(game.status!=="live") return null;
  const hs=game.home.score||0,as=game.away.score||0;
  const diff=Math.abs(hs-as);
  const secs=game.clockSecs;
  if(prev&&(prev.home!==hs||prev.away!==as)){
    const scorer=hs>(prev.home||0)?game.home.abbr:game.away.abbr;
    const pts=hs>(prev.home||0)?hs-(prev.home||0):as-(prev.away||0);
    return{type:"SCORE",text:scorer+" scores"+(pts>1?" ("+pts+")":""),color:"#F5A623"};
  }
  if(game.sport==="basketball"&&game.period==="Q4"&&secs!==null&&secs<=120&&diff<=5)
    return{type:"CLOSE",text:(diff===0?"TIE GAME":"CLOSE GAME")+" • "+game.period+" "+game.clock,color:"#FF3B30"};
  if(game.sport==="football"&&game.period==="Q4"&&secs!==null&&secs<=120&&diff<=8)
    return{type:"CLOSE",text:"CLOSE GAME • "+game.period+" "+game.clock,color:"#FF3B30"};
  if(game.sport==="hockey"&&game.period==="P3"&&secs!==null&&secs<=120&&diff<=1)
    return{type:"CLOSE",text:"CLOSE GAME • "+game.period+" "+game.clock,color:"#FF3B30"};
  return null;
}

// ── PARSE LEADERS ────────────────────────────────────────────────
function parseLeaders(summary){
  try{
    const result={home:[],away:[]};
    const bs=summary&&summary.boxscore;
    if(!bs) return result;
    const hc=((summary.header&&summary.header.competitions&&summary.header.competitions[0])||{}).competitors||[];
    const homeId=(hc.find(c=>c.homeAway==="home")||{team:{}}).team.id;
    (bs.players||[]).forEach(grp=>{
      const side=grp.team&&grp.team.id===homeId?"home":"away";
      const stats=(grp.statistics||[])[0];
      if(!stats) return;
      const lb=stats.labels||[];
      const pi=lb.indexOf("PTS"),gi=lb.indexOf("G"),ri=lb.indexOf("REB"),ai=lb.indexOf("AST");
      const si=pi>=0?pi:gi>=0?gi:0;
      result[side]=(stats.athletes||[])
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
    if(!result.home.length&&!result.away.length){
      (summary.leaders||[]).forEach(lg=>{
        const l=(lg.leaders||[])[0];
        if(!l) return;
        const side=homeId&&lg.team&&lg.team.id===homeId?"home":"away";
        if(result[side].length<2) result[side].push({
          name:(l.athlete&&(l.athlete.shortName||l.athlete.displayName))||"—",
          pts:l.value||"—",reb:null,ast:null,
        });
      });
    }
    return result;
  }catch{return{home:[],away:[]};}
}

function getCover(game){
  if(game.status!=="final"||!game.spread||!game.spread.line) return null;
  const f=game.spread.favorite===game.home.abbr;
  const m=f?game.home.score-game.away.score:game.away.score-game.home.score;
  return m>Math.abs(game.spread.line);
}

// ═══════════════════════════════════════════════════════════════════
//  COMPONENTS
// ═══════════════════════════════════════════════════════════════════

function TeamLogo({src,color,size}){
  size=size||40;
  const [err,setErr]=useState(false);
  if(!src||err) return e("div",{style:{
    width:size,height:size,borderRadius:5,flexShrink:0,
    background:color+"33",border:"1px solid "+color+"22",
  }});
  return e("img",{src,alt:"",width:size,height:size,
    onError:()=>setErr(true),
    style:{objectFit:"contain",flexShrink:0,filter:"drop-shadow(0 1px 5px rgba(0,0,0,0.9))"},
  });
}

function RankBadge({rank,fontSize}){
  if(!rank) return null;
  return e("span",{style:{
    fontSize,fontWeight:900,fontFamily:F,
    color:"#F5C518",background:"rgba(245,197,24,0.12)",
    border:"1px solid rgba(245,197,24,0.45)",
    borderRadius:3,padding:"0 3px",lineHeight:"1.3",
    flexShrink:0,marginRight:2,
  }},"#"+rank);
}

// ── GAME CARD ─────────────────────────────────────────────────────
// Layout is STRICTLY partitioned — nothing can overflow into another section.
// Total card height = rowH (exact).
// Internal layout (all heights px):
//   pad top
//   [STATUS]   statusH
//   [TEAMS]    teamsH  (two rows of teamRowH each + 1px divider)
//   [DIVIDER]  1px
//   [LEADERS]  leadersH
//   pad bottom
// pad*2 + statusH + gap1 + teamsH + 2px + leadersH + gap2 = rowH
function GameCard({game,flash,rowH}){
  const covered=getCover(game);
  const isLive=game.status==="live";
  const isFinal=game.status==="final";
  const isPre=game.status==="pre";
  const hw=(game.home.score||0)>(game.away.score||0);
  const aw=(game.away.score||0)>(game.home.score||0);
  const hasAlert=!!game.alert;

  // ── Partition rowH into sections ─────────────────────────────
  const PAD    = Math.round(rowH*0.052);
  const inner  = rowH - PAD*2;
  const STATUS = Math.round(inner*0.11);
  const GAP1   = Math.round(inner*0.03);
  const TEAMS  = Math.round(inner*0.44);
  const DIV    = 1;
  const GAP2   = Math.round(inner*0.03);
  const LEAD   = inner - STATUS - GAP1 - TEAMS - DIV - GAP2;
  const TROW   = Math.round((TEAMS-4)/2);  // height per team row

  // ── Font sizes derived from section heights ───────────────────
  const scoreFz  = Math.round(TROW*0.72);
  const abbrFz   = Math.round(TROW*0.38);
  const rankFz   = Math.round(TROW*0.28);
  const logoSz   = Math.round(TROW*0.78);
  const stFz     = Math.round(STATUS*0.65);   // status/clock font
  const chanFz   = Math.round(STATUS*0.56);   // channel/spread font
  const lhFz     = Math.round(LEAD*0.155);    // leader header (abbr)
  const lnFz     = Math.round(LEAD*0.135);    // leader name
  const lpFz     = Math.round(LEAD*0.16);     // leader points
  const lsFz     = Math.round(LEAD*0.11);     // leader stat (reb/ast)

  const cardW = Math.round(rowH*1.32);

  // Team row
  const teamRow=(side)=>{
    const t=game[side];
    const win=side==="home"?hw:aw;
    const lose=side==="home"?aw:hw;
    return e("div",{style:{
      display:"flex",alignItems:"center",
      height:TROW,gap:6,overflow:"hidden",
      opacity:isFinal&&lose?0.4:1,
    }},
      e(TeamLogo,{src:t.logo,color:t.color,size:logoSz}),
      e("div",{style:{display:"flex",alignItems:"baseline",gap:3,
        flex:"0 0 auto",overflow:"hidden"}},
        e(RankBadge,{rank:t.rank,fontSize:rankFz}),
        e("span",{style:{fontSize:abbrFz,fontWeight:900,color:"#fff",
          fontFamily:F,letterSpacing:0.5,lineHeight:1,whiteSpace:"nowrap"}},t.abbr),
        !isPre&&e("span",{style:{
          fontSize:scoreFz,fontWeight:900,lineHeight:1,fontFamily:F,
          fontVariantNumeric:"tabular-nums",marginLeft:6,flexShrink:0,
          color:win?"#fff":"rgba(255,255,255,0.4)",
          textShadow:win&&isLive?"0 0 16px "+t.color+"bb":"none",
        }},t.score),
      ),
      isPre&&t.record&&!t.rank&&e("span",{style:{
        fontSize:Math.round(abbrFz*0.68),color:"rgba(255,255,255,0.28)",
        fontFamily:F,marginLeft:4,flexShrink:0,whiteSpace:"nowrap",
      }},t.record),
    );
  };

  // Leader column
  const leadCol=(side)=>{
    const t=game[side];
    const pp=game.leaders[side];
    return e("div",{style:{flex:1,minWidth:0,overflow:"hidden"}},
      e("div",{style:{
        fontSize:lhFz,fontWeight:800,letterSpacing:1,color:t.color,
        textTransform:"uppercase",fontFamily:F,
        overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
        marginBottom:Math.round(LEAD*0.04),
        textShadow:"0 0 6px "+t.color+"44",
      }},t.abbr),
      pp.length
        ?pp.map((p,i)=>e("div",{key:i,style:{
            display:"flex",alignItems:"baseline",gap:3,
            marginBottom:Math.round(LEAD*0.03),overflow:"hidden",
          }},
            e("span",{style:{
              fontSize:lnFz,fontWeight:700,color:"rgba(255,255,255,0.82)",
              fontFamily:F,flex:"1 1 0",minWidth:0,
              overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
            }},p.name),
            e("span",{style:{
              fontSize:lpFz,fontWeight:900,color:"#fff",fontFamily:F,
              fontVariantNumeric:"tabular-nums",flexShrink:0,
            }},p.pts),
            p.reb&&p.reb!=="0"&&p.reb!=="--"&&e("span",{style:{
              fontSize:lsFz,color:"rgba(255,255,255,0.38)",flexShrink:0,
            }},p.reb+"r"),
            p.ast&&p.ast!=="0"&&p.ast!=="--"&&e("span",{style:{
              fontSize:lsFz,color:"rgba(255,255,255,0.38)",flexShrink:0,
            }},p.ast+"a"),
          ))
        :e("span",{style:{fontSize:lnFz,color:"rgba(255,255,255,0.15)",fontStyle:"italic"}},"—"),
    );
  };

  // Baseball diamond
  const diamond=()=>{
    const S=Math.round(LEAD*0.22);
    const b=on=>e("div",{style:{
      width:S,height:S,transform:"rotate(45deg)",flexShrink:0,
      background:on?"#F5A623":"rgba(255,255,255,0.1)",
      border:"1.5px solid "+(on?"#F5A623":"rgba(255,255,255,0.22)"),
      boxShadow:on?"0 0 5px #F5A623aa":"none",
    }});
    const gap=Math.round(S*0.22);
    return e("div",{style:{
      display:"flex",flexDirection:"column",alignItems:"center",gap,
      paddingRight:7,borderRight:"1px solid rgba(255,255,255,0.08)",flexShrink:0,
    }},
      b(game.bases[1]),
      e("div",{style:{display:"flex",gap:Math.round(S*1.0)}},b(game.bases[2]),b(game.bases[0])),
      e("div",{style:{display:"flex",gap:3,marginTop:2}},
        [0,1,2].map(i=>e("div",{key:i,style:{
          width:5,height:5,borderRadius:"50%",
          background:i<game.outs?"#F5A623":"rgba(255,255,255,0.12)",
        }}))
      ),
    );
  };

  return e("div",{style:{
    display:"inline-flex",flexDirection:"column",
    width:cardW,height:rowH,flexShrink:0,
    paddingTop:PAD,paddingBottom:PAD,
    paddingLeft:Math.round(rowH*0.055),paddingRight:Math.round(rowH*0.055),
    borderRight:"1px solid rgba(255,255,255,0.07)",
    background:hasAlert
      ?"linear-gradient(180deg,"+game.alert.color+"18 0%,#0d0d0d 60%)"
      :flash
        ?"linear-gradient(180deg,rgba(255,200,0,0.1) 0%,#0d0d0d 60%)"
        :"linear-gradient(180deg,rgba(255,255,255,0.025) 0%,#0d0d0d 100%)",
    position:"relative",overflow:"hidden",boxSizing:"border-box",
  }},
    // Top stripe
    e("div",{style:{position:"absolute",top:0,left:0,right:0,height:3,
      background:"linear-gradient(90deg,"+game.away.color+","+game.home.color+")",opacity:0.9}}),

    // Alert bar
    hasAlert&&e("div",{className:"alert-bar",style:{
      position:"absolute",top:0,left:0,right:0,height:STATUS+PAD,
      display:"flex",alignItems:"center",justifyContent:"center",gap:6,zIndex:10,
      background:"linear-gradient(90deg,transparent,"+game.alert.color+"28,"+game.alert.color+"40,"+game.alert.color+"28,transparent)",
    }},
      e("span",{style:{fontSize:stFz}},game.alert.type==="CLOSE"?"🚨":"🔥"),
      e("span",{style:{fontSize:stFz*0.82,fontWeight:900,fontFamily:F,
        color:game.alert.color,letterSpacing:0.8,textTransform:"uppercase"}},game.alert.text),
    ),

    // ── STATUS BAR ───────────────────────────────────────────────
    e("div",{style:{
      height:STATUS,flexShrink:0,marginBottom:GAP1,
      display:"flex",alignItems:"center",justifyContent:"space-between",
      overflow:"hidden",
    }},
      // left
      e("div",{style:{display:"flex",alignItems:"center",gap:5}},
        isLive&&e("div",{className:"live-dot",style:{
          width:8,height:8,borderRadius:"50%",flexShrink:0,
          background:"#FF3B30",boxShadow:"0 0 7px #FF3B30",
        }}),
        e("span",{style:{fontSize:stFz,fontWeight:900,fontFamily:F,letterSpacing:1,
          color:isLive?"#FF3B30":"rgba(255,255,255,0.35)"}},game.period),
        isLive&&game.clock&&e("span",{style:{fontSize:stFz,fontWeight:700,fontFamily:F,
          color:"rgba(255,255,255,0.78)",marginLeft:3}},game.clock),
      ),
      // right
      e("div",{style:{display:"flex",alignItems:"center",gap:5}},
        game.channel&&e("div",{style:{display:"flex",alignItems:"center",gap:3,
          background:"rgba(255,255,255,0.07)",borderRadius:4,padding:"1px 5px"}},
          e("span",{style:{fontSize:chanFz}},"📺"),
          e("span",{style:{fontSize:chanFz,fontWeight:800,fontFamily:F,
            color:"rgba(255,255,255,0.7)"}},game.channel),
        ),
        game.spread&&e("div",{style:{display:"flex",alignItems:"center",gap:3,
          background:"rgba(255,255,255,0.06)",borderRadius:4,padding:"1px 5px"}},
          e("span",{style:{fontSize:chanFz*0.85,fontWeight:700,
            color:"rgba(255,255,255,0.28)",letterSpacing:0.5}},"SPR"),
          e("span",{style:{fontSize:chanFz,fontWeight:800,fontFamily:F,
            color:"rgba(255,255,255,0.72)"}},
            game.spread.favorite+" "+(game.spread.line>0?"+":"")+game.spread.line),
          covered!==null&&e("span",{style:{fontSize:chanFz,fontWeight:900,
            color:covered?"#30D158":"#FF453A"}},covered?"✓":"✗"),
        ),
      ),
    ),

    // ── TEAMS ────────────────────────────────────────────────────
    e("div",{style:{height:TEAMS,flexShrink:0,display:"flex",
      flexDirection:"column",justifyContent:"space-around"}},
      teamRow("away"),
      e("div",{style:{height:DIV,background:"rgba(255,255,255,0.07)",margin:"1px 0",flexShrink:0}}),
      teamRow("home"),
    ),

    // Section gap
    e("div",{style:{height:GAP2,flexShrink:0}}),

    // ── LEADERS ──────────────────────────────────────────────────
    e("div",{style:{
      height:LEAD,flexShrink:0,
      display:"flex",gap:6,overflow:"hidden",
      borderTop:"1px solid rgba(255,255,255,0.07)",
      paddingTop:Math.round(LEAD*0.06),
    }},
      game.sport==="baseball"&&!isPre&&diamond(),
      leadCol("away"),
      e("div",{style:{width:1,background:"rgba(255,255,255,0.07)",
        alignSelf:"stretch",flexShrink:0}}),
      leadCol("home"),
    ),
  );
}

// ── SPORT LABEL ──────────────────────────────────────────────────
function SportLabel({meta,rowH}){
  const w=Math.round(rowH*0.65);
  return e("div",{style:{
    width:w,flexShrink:0,height:"100%",
    display:"flex",flexDirection:"column",
    alignItems:"center",justifyContent:"center",gap:3,
    background:"linear-gradient(170deg,"+meta.accent+"EE,"+meta.accent+"88)",
    borderRight:"3px solid "+meta.accent,
  }},
    e("span",{style:{fontSize:Math.round(rowH*0.2),lineHeight:1}},meta.icon),
    e("span",{style:{fontSize:Math.round(rowH*0.085),fontWeight:900,color:"#fff",
      letterSpacing:2,fontFamily:F}},meta.isCBB?"CBB":meta.label),
    meta.isCBB&&meta.shortLabel&&e("span",{style:{
      fontSize:Math.round(rowH*0.068),fontWeight:700,
      color:"rgba(255,255,255,0.72)",letterSpacing:0.8,
      fontFamily:F,textAlign:"center",padding:"0 3px",lineHeight:1.2,
    }},meta.shortLabel),
  );
}

// ── SCROLLING ROW ────────────────────────────────────────────────
function ScrollRow({rowH,speed,games,meta,flashIds,onLoop}){
  const scrollRef=useRef(null);
  const animRef  =useRef(null);
  const xRef     =useRef(0);
  const tsRef    =useRef(null);
  const loopCnt  =useRef(0);
  const keyRef   =useRef(leagueKey(meta));

  const onLoopInternal=useCallback(()=>{
    loopCnt.current+=1;
    if(loopCnt.current>=LOOPS_PER_ROTATE){loopCnt.current=0;onLoop();}
  },[onLoop]);

  const animate=useCallback((ts)=>{
    if(!scrollRef.current){animRef.current=requestAnimationFrame(animate);return;}
    if(tsRef.current===null) tsRef.current=ts;
    const delta=Math.min((ts-tsRef.current)/1000,0.05);
    tsRef.current=ts;
    xRef.current+=speed*delta;
    const half=scrollRef.current.scrollWidth/2;
    if(half>0&&xRef.current>=half){xRef.current=0;onLoopInternal();}
    scrollRef.current.style.transform="translateX(-"+xRef.current+"px)";
    animRef.current=requestAnimationFrame(animate);
  },[speed,onLoopInternal]);

  useEffect(()=>{
    const newKey=leagueKey(meta);
    if(newKey!==keyRef.current){
      xRef.current=0;tsRef.current=null;loopCnt.current=0;
      keyRef.current=newKey;
    }
    cancelAnimationFrame(animRef.current);
    animRef.current=requestAnimationFrame(animate);
    return()=>cancelAnimationFrame(animRef.current);
  },[animate,meta]);

  if(!games.length) return e("div",{style:{flex:1,display:"flex",alignItems:"center",
    justifyContent:"center",color:"rgba(255,255,255,0.12)",fontSize:Math.round(rowH*0.1),
    fontFamily:F,letterSpacing:3}},"NO GAMES TODAY");

  return e("div",{style:{flex:1,overflow:"hidden",position:"relative"}},
    e("div",{style:{position:"absolute",left:0,top:0,bottom:0,width:30,zIndex:4,
      background:"linear-gradient(to right,#0a0a0a 15%,transparent)",pointerEvents:"none"}}),
    e("div",{style:{position:"absolute",right:0,top:0,bottom:0,width:40,zIndex:4,
      background:"linear-gradient(to left,#0a0a0a 15%,transparent)",pointerEvents:"none"}}),
    e("div",{ref:scrollRef,style:{
      display:"inline-flex",alignItems:"stretch",
      height:"100%",willChange:"transform",
    }},
      [...games,...games].map((g,i)=>e(GameCard,{
        key:g.id+"-"+i,game:g,flash:flashIds.has(g.id),rowH,
      }))
    ),
  );
}

// ── SETTINGS PANEL ───────────────────────────────────────────────
function SettingsPanel({enabledSet,gameCount,onToggle,onClose}){
  return e("div",{style:{
    position:"fixed",inset:0,zIndex:100,background:"rgba(0,0,0,0.88)",
    display:"flex",alignItems:"center",justifyContent:"center"},
    onClick:onClose},
    e("div",{style:{
      background:"#181818",border:"1px solid rgba(255,255,255,0.12)",
      borderRadius:16,padding:24,minWidth:310,maxWidth:440,width:"88vw",
      maxHeight:"88vh",overflowY:"auto"},
      onClick:ev=>ev.stopPropagation()},
      e("div",{style:{display:"flex",alignItems:"center",
        justifyContent:"space-between",marginBottom:16}},
        e("span",{style:{fontSize:19,fontWeight:900,color:"#fff",
          fontFamily:F,letterSpacing:2}},"SPORTS SELECTOR"),
        e("button",{onClick:onClose,style:{
          background:"rgba(255,255,255,0.1)",border:"1px solid rgba(255,255,255,0.15)",
          color:"#fff",borderRadius:8,padding:"5px 12px",
          fontSize:12,fontFamily:F,fontWeight:800,cursor:"pointer"}},"DONE"),
      ),
      e("p",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",marginBottom:14,lineHeight:1.5}},
        "NCAAM fetches all D1 games at once and groups by conference. "
        +"Each conference shows "+LOOPS_PER_ROTATE+" full loops before rotating."),
      e("div",{style:{display:"flex",flexDirection:"column",gap:8}},
        SETTINGS_GROUPS.map(sg=>{
          const on=enabledSet.has(sg.key);
          const cnt=gameCount(sg.key);
          return e("div",{key:sg.key,onClick:()=>onToggle(sg.key),style:{
            display:"flex",alignItems:"center",gap:12,
            padding:"10px 13px",borderRadius:10,cursor:"pointer",
            background:on?sg.accent+"20":"rgba(255,255,255,0.03)",
            border:"1.5px solid "+(on?sg.accent:"rgba(255,255,255,0.07)"),
            opacity:cnt>0?1:0.35,
          }},
            e("span",{style:{fontSize:19}},sg.icon),
            e("div",{style:{flex:1}},
              e("div",{style:{fontSize:14,fontWeight:900,color:"#fff",fontFamily:F,letterSpacing:1}},sg.label),
              e("div",{style:{fontSize:10,color:"rgba(255,255,255,0.3)",marginTop:1}},
                cnt>0?cnt+" game"+(cnt!==1?"s":"")+" today":"No games today"),
            ),
            e("div",{style:{width:42,height:22,borderRadius:11,position:"relative",
              background:on?sg.accent:"rgba(255,255,255,0.14)",flexShrink:0}},
              e("div",{style:{position:"absolute",top:2,left:on?21:2,
                width:18,height:18,borderRadius:"50%",background:"#fff",
                transition:"left 0.15s",boxShadow:"0 1px 3px rgba(0,0,0,0.4)"}}),
            ),
          );
        }),
      ),
    ),
  );
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════════════
function SportsBoard(){
  const [allGames,      setAllGames]      = useState({});  // key → games[]
  const [cbbConfs,      setCbbConfs]      = useState([]);  // [{confName,games}]
  const [flashIds,      setFlashIds]      = useState(new Set());
  const [loading,       setLoading]       = useState(true);
  const [loadError,     setLoadError]     = useState(null);
  const [lastUpdated,   setLastUpdated]   = useState(null);
  const [clock,         setClock]         = useState(new Date());
  const [activeLeagues, setActiveLeagues] = useState([]);  // meta objects for rows
  const [row1Idx,       setRow1Idx]       = useState(0);
  const [row2Idx,       setRow2Idx]       = useState(1);
  const [showSettings,  setShowSettings]  = useState(false);
  const [enabledSet,    setEnabledSet]    = useState(
    ()=>new Set(SETTINGS_GROUPS.map(g=>g.key))
  );

  const prevScores  = useRef({});
  const alertTimers = useRef({});

  useEffect(()=>{
    const iv=setInterval(()=>setClock(new Date()),1000);
    return()=>clearInterval(iv);
  },[]);

  // ── Fetch one non-CBB league ──────────────────────────────────
  const fetchLeague=useCallback(async(lg)=>{
    const params=lg.groups?{groups:lg.groups,limit:75}:{limit:40};
    const data=await espnFetch(lg.sport,lg.league,"scoreboard",params);
    const events=(data&&data.events)||[];
    const games=events.map(ev=>parseGame(ev,lg.sport,lg.league)).filter(Boolean);
    const updated=games.map(g=>{
      const prev=prevScores.current[g.id];
      const alert=detectAlert(g,prev);
      if(prev&&g.status==="live"&&(prev.home!==g.home.score||prev.away!==g.away.score)){
        setFlashIds(f=>new Set([...f,g.id]));
        setTimeout(()=>setFlashIds(f=>{const n=new Set(f);n.delete(g.id);return n;}),2500);
      }
      if(alert){
        if(alertTimers.current[g.id]) clearTimeout(alertTimers.current[g.id]);
        alertTimers.current[g.id]=setTimeout(()=>{
          setAllGames(p=>({...p,[lg.league]:(p[lg.league]||[]).map(x=>x.id===g.id?{...x,alert:null}:x)}));
        },ALERT_MS);
      }
      prevScores.current[g.id]={home:g.home.score,away:g.away.score};
      return{...g,alert};
    });
    return{key:lg.league,games:updated};
  },[]);

  // ── Fetch ALL CBB at once → split by conference ───────────────
  const fetchCBB=useCallback(async()=>{
    const data=await espnFetch(
      CBB_LEAGUE.sport, CBB_LEAGUE.league, "scoreboard",
      {groups:CBB_LEAGUE.groups, limit:CBB_LEAGUE.limit}
    );
    const events=(data&&data.events)||[];
    const games=events.map(ev=>parseGame(ev,CBB_LEAGUE.sport,CBB_LEAGUE.league)).filter(Boolean);
    const updated=games.map(g=>{
      const prev=prevScores.current[g.id];
      const alert=detectAlert(g,prev);
      if(prev&&g.status==="live"&&(prev.home!==g.home.score||prev.away!==g.away.score)){
        setFlashIds(f=>new Set([...f,g.id]));
        setTimeout(()=>setFlashIds(f=>{const n=new Set(f);n.delete(g.id);return n;}),2500);
      }
      prevScores.current[g.id]={home:g.home.score,away:g.away.score};
      return{...g,alert};
    });
    return updated;
  },[]);

  // ── Fetch leaders for one game ────────────────────────────────
  const fetchLeaders=useCallback(async(game,sport,league,storeKey)=>{
    if(game.status==="pre") return;
    try{
      const s=await espnFetch(sport,league,"summary?event="+game.id,{});
      const leaders=parseLeaders(s);
      setAllGames(p=>({...p,[storeKey]:(p[storeKey]||[]).map(g=>g.id===game.id?{...g,leaders}:g)}));
    }catch{}
  },[]);

  // ── Load everything ───────────────────────────────────────────
  const loadAll=useCallback(async()=>{
    setLoading(true);setLoadError(null);
    try{
      const nextGames={};
      const withLeagues=[];

      // Non-CBB in batches
      for(let i=0;i<NON_CBB.length;i+=BATCH_SIZE){
        const batch=NON_CBB.slice(i,i+BATCH_SIZE);
        const res=await Promise.allSettled(batch.map(lg=>fetchLeague(lg)));
        res.forEach((r,bi)=>{
          if(r.status==="fulfilled"){
            const {key,games}=r.value;
            nextGames[key]=games;
            if(games.length>0&&enabledSet.has(key)) withLeagues.push(batch[bi]);
          }
        });
        if(i+BATCH_SIZE<NON_CBB.length) await new Promise(r=>setTimeout(r,BATCH_DELAY_MS));
      }

      // CBB — one fetch
      if(enabledSet.has("NCAAM")){
        try{
          const cbbGames=await fetchCBB();
          // Store all CBB games flat under one key for leader fetching
          nextGames["cbb_all"]=cbbGames;
          // Group by conference
          const grouped=groupByConference(cbbGames);
          grouped.forEach(({confName,games:gs})=>{
            const meta=makeCBBMeta(confName);
            nextGames[leagueKey(meta)]=gs;
            if(gs.length>0) withLeagues.push(meta);
          });
        }catch(err){
          console.warn("CBB fetch failed:",err.message);
        }
      }

      setAllGames(nextGames);
      setActiveLeagues(withLeagues);
      setRow1Idx(v=>Math.min(v,Math.max(withLeagues.length-1,0)));
      setRow2Idx(v=>withLeagues.length>1?Math.min(v,withLeagues.length-1):0);
      setLastUpdated(new Date());
    }catch(err){
      setLoadError(err.message);
    }finally{
      setLoading(false);
    }
  },[fetchLeague,fetchCBB,enabledSet]);

  useEffect(()=>{
    loadAll();
    const iv=setInterval(loadAll,POLL_SCORES_MS);
    return()=>clearInterval(iv);
  },[loadAll]);

  // ── Leaders for both visible rows ────────────────────────────
  useEffect(()=>{
    if(!activeLeagues.length) return;
    const load=async()=>{
      const rows=[activeLeagues[row1Idx],activeLeagues[row2Idx]].filter(Boolean);
      for(const meta of rows){
        const key=leagueKey(meta);
        const games=(allGames[key]||[]).filter(g=>g.status!=="pre");
        for(const g of games){
          await fetchLeaders(g,meta.sport,meta.league,key);
          await new Promise(r=>setTimeout(r,450));
        }
      }
    };
    load();
    const iv=setInterval(load,POLL_LEADERS_MS);
    return()=>clearInterval(iv);
  },[activeLeagues,row1Idx,row2Idx,allGames,fetchLeaders]);

  // ── Row rotation ─────────────────────────────────────────────
  const handleRow1Loop=useCallback(()=>{
    setRow1Idx(prev=>{
      let n=(prev+1)%Math.max(activeLeagues.length,1);
      if(n===row2Idx&&activeLeagues.length>2) n=(n+1)%activeLeagues.length;
      return n;
    });
  },[activeLeagues.length,row2Idx]);

  const handleRow2Loop=useCallback(()=>{
    setRow2Idx(prev=>{
      let n=(prev+1)%Math.max(activeLeagues.length,1);
      if(n===row1Idx&&activeLeagues.length>2) n=(n+1)%activeLeagues.length;
      return n;
    });
  },[activeLeagues.length,row1Idx]);

  const toggleLeague=useCallback((key)=>{
    setEnabledSet(prev=>{
      const n=new Set(prev);
      n.has(key)?n.delete(key):n.add(key);
      return n;
    });
  },[]);

  // ── Render ───────────────────────────────────────────────────
  const meta1  = activeLeagues[row1Idx]||NON_CBB[0];
  const meta2  = activeLeagues.length>1?(activeLeagues[row2Idx]||NON_CBB[1]):null;
  const games1 = allGames[leagueKey(meta1)]||[];
  const games2 = meta2?(allGames[leagueKey(meta2)]||[]):[];

  const HEADER_H = 46;
  const rowHNum  = Math.floor((window.innerHeight-HEADER_H)/2);

  const spinStyle={width:10,height:10,borderRadius:"50%",
    border:"2px solid rgba(255,255,255,0.15)",borderTopColor:"#fff",flexShrink:0};

  const cbbTotal=(allGames["cbb_all"]||[]).length;

  return e(Fragment,null,
    showSettings&&e(SettingsPanel,{
      enabledSet,
      gameCount:key=>{
        if(key==="NCAAM") return cbbTotal;
        return(allGames[key]||[]).length;
      },
      onToggle:toggleLeague,
      onClose:()=>setShowSettings(false),
    }),

    e("div",{style:{width:"100vw",height:"100vh",display:"flex",
      flexDirection:"column",background:"#0a0a0a",overflow:"hidden"}},

      // Error screen
      loadError&&activeLeagues.length===0&&e("div",{style:{
        position:"absolute",inset:0,zIndex:50,background:"#0a0a0a",
        display:"flex",flexDirection:"column",
        alignItems:"center",justifyContent:"center",gap:14}},
        e("span",{style:{fontSize:42}},"📡"),
        e("div",{style:{fontSize:16,fontWeight:800,color:"rgba(255,255,255,0.4)",
          fontFamily:F,letterSpacing:2}},"CONNECTION ERROR"),
        e("div",{style:{fontSize:11,color:"rgba(255,255,255,0.2)",fontFamily:F,
          textAlign:"center",maxWidth:340,lineHeight:1.7}},
          loadError+"\n\nRetrying automatically every 30s…"),
      ),

      // Header
      e("div",{style:{
        height:HEADER_H,flexShrink:0,display:"flex",alignItems:"center",
        justifyContent:"space-between",padding:"0 12px",
        background:"linear-gradient(180deg,#1c1c1c,#111)",
        borderBottom:"1px solid rgba(255,255,255,0.07)"}},
        // Pills
        e("div",{style:{display:"flex",gap:4,alignItems:"center",flex:1,overflow:"hidden"}},
          activeLeagues.map((lg,i)=>{
            const active=i===row1Idx||i===row2Idx;
            return e("div",{key:leagueKey(lg),style:{
              display:"flex",alignItems:"center",gap:3,padding:"2px 7px",
              borderRadius:20,flexShrink:0,
              background:active?lg.accent+"30":"rgba(255,255,255,0.04)",
              border:"1px solid "+(active?lg.accent:"rgba(255,255,255,0.08)"),
            }},
              e("span",{style:{fontSize:11}},lg.icon),
              e("span",{style:{fontSize:10,fontWeight:800,fontFamily:F,letterSpacing:1,
                color:active?"#fff":"rgba(255,255,255,0.35)"}},
                lg.isCBB?lg.shortLabel:lg.label),
              e("span",{style:{fontSize:9,fontWeight:700,
                color:active?"rgba(255,255,255,0.5)":"rgba(255,255,255,0.16)"}},
                (allGames[leagueKey(lg)]||[]).length),
            );
          }),
          loading&&e("div",{className:"spin",style:spinStyle}),
        ),
        // Right: time + gear
        e("div",{style:{display:"flex",alignItems:"center",gap:9,flexShrink:0}},
          lastUpdated&&e("span",{style:{fontSize:10,color:"rgba(255,255,255,0.18)",fontFamily:F}},
            lastUpdated.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})),
          e("span",{style:{fontSize:20,fontWeight:900,color:"rgba(255,255,255,0.78)",fontFamily:F}},
            clock.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})),
          e("button",{onClick:()=>setShowSettings(s=>!s),style:{
            background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.13)",
            color:"#fff",borderRadius:7,width:32,height:32,fontSize:15,cursor:"pointer",
            display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}},"⚙️"),
        ),
      ),

      // Row 1
      e("div",{style:{height:rowHNum,flexShrink:0,display:"flex",alignItems:"stretch",
        borderBottom:"2px solid rgba(255,255,255,0.06)"}},
        e(SportLabel,{meta:meta1,rowH:rowHNum}),
        loading&&!games1.length
          ?e("div",{style:{flex:1,display:"flex",alignItems:"center",
              justifyContent:"center",gap:10}},
              e("div",{className:"spin",style:{...spinStyle,width:13,height:13,
                borderWidth:3,borderTopColor:meta1.accent}}),
              e("span",{style:{fontSize:14,fontWeight:800,color:"rgba(255,255,255,0.28)",
                fontFamily:F,letterSpacing:3}},"LOADING…"))
          :e(ScrollRow,{rowH:rowHNum,speed:SPEED_ROW1,games:games1,
              meta:meta1,flashIds,onLoop:handleRow1Loop}),
      ),

      // Row 2
      meta2
        ?e("div",{style:{height:rowHNum,flexShrink:0,display:"flex",alignItems:"stretch"}},
            e(SportLabel,{meta:meta2,rowH:rowHNum}),
            loading&&!games2.length
              ?e("div",{style:{flex:1,display:"flex",alignItems:"center",
                  justifyContent:"center",gap:10}},
                  e("div",{className:"spin",style:{...spinStyle,width:13,height:13,
                    borderWidth:3,borderTopColor:meta2.accent}}),
                  e("span",{style:{fontSize:14,fontWeight:800,color:"rgba(255,255,255,0.28)",
                    fontFamily:F,letterSpacing:3}},"LOADING…"))
              :e(ScrollRow,{rowH:rowHNum,speed:SPEED_ROW2,games:games2,
                  meta:meta2,flashIds,onLoop:handleRow2Loop}),
          )
        :e("div",{style:{height:rowHNum,flexShrink:0,display:"flex",
            alignItems:"center",justifyContent:"center",
            color:"rgba(255,255,255,0.07)",fontSize:12,fontFamily:F,letterSpacing:3}},
            "NO OTHER SPORTS TODAY"),
    ),
  );
}

const root=ReactDOM.createRoot(document.getElementById("root"));
root.render(e(SportsBoard,null));
