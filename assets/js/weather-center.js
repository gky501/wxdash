/* =========================================================
   MEMS WEATHER CENTER
   File: wxdash/assets/js/weather-center.js

   Load order required:
   1. assets/data/weather-database.js
   2. assets/js/weather-center.js

   The database file may use either:
   - window.MEMS_WEATHER_DB
   - window.MEMS_WEATHER_DATABASE
========================================================= */

const TEMPEST_STATION_ID = "136293";
const TEMPEST_TOKEN = "a394fe76-fe00-4227-836b-f574a15ce385";

const REFRESH_SECONDS = 60;
const USER_ACTIVITY_HOLD_MS = 5 * 60 * 1000;

let secondsUntilRefresh = REFRESH_SECONDS;
let lastUserMapActivity = 0;
let latestPanelAlerts = [];
let latestAllArkansasAlerts = [];
let latestCustomStormTracks = [];
let activeTrackId = null;
let impactedStationNames = new Set();
let TRACK_WINDOW_MINUTES = 60;

let outlookData = {
    tornado: null,
    hail: null,
    wind: null,
    excessiveRain: null
};

/* =========================
   DATABASE
========================= */

const WEATHER_DATABASE = window.MEMS_WEATHER_DB || window.MEMS_WEATHER_DATABASE;

if (!WEATHER_DATABASE) {
    throw new Error("Weather database missing. Load assets/data/weather-database.js before assets/js/weather-center.js");
}

const areaButtons = Array.isArray(WEATHER_DATABASE.areaButtons) ? WEATHER_DATABASE.areaButtons : [];
const stations = Array.isArray(WEATHER_DATABASE.stations) ? WEATHER_DATABASE.stations : [];
const locations = Array.isArray(WEATHER_DATABASE.locations) ? WEATHER_DATABASE.locations : [];
const towns = Array.isArray(WEATHER_DATABASE.towns) ? WEATHER_DATABASE.towns : [];
const zoneProfiles = WEATHER_DATABASE.zoneProfiles || Object.fromEntries(
    areaButtons.map(area => [area.id, {
        title: area.title || area.label || area.id,
        center: area.center,
        stations: area.stations || []
    }])
);

/* =========================
   MAP SETUP
========================= */

const AR_BOUNDS = L.latLngBounds([33.00, -94.75], [36.65, -89.55]);
const AR_CENTER = [34.75, -92.25];
const AR_ZOOM = 7;

const map = L.map("map", {
    worldCopyJump: false
}).setView(AR_CENTER, AR_ZOOM);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    attribution: "© OpenStreetMap © CARTO"
}).addTo(map);

map.on("mousemove dragstart zoomstart movestart", () => {
    lastUserMapActivity = Date.now();
});
const serviceAreaLayer = L.geoJSON(null, {
  style: {
    color: "#000000",
    weight: 2,
    opacity: 0.40,
    fillColor: "#005bea",
    fillOpacity: 0.0
  },
}).addTo(map);

async function loadServiceArea() {
  try {
    const res = await fetch("assets/data/service-map.geojson", {
      cache: "no-store"
    });

    if (!res.ok) {
      throw new Error("Service area GeoJSON failed: " + res.status);
    }

    const data = await res.json();

    console.log("Service area loaded:", data);

    serviceAreaLayer.clearLayers();
    serviceAreaLayer.addData(data);

  } catch (err) {
    console.error("Unable to load service area boundary:", err);
  }
}

loadServiceArea();
const lkzAreaLayer = L.geoJSON(null, {
  style: {
    color: "#005bea",
    weight: 2,
    opacity: 0.40,
    fillColor: "#005bea",
    fillOpacity: 0.0
  },
}).addTo(map);

async function loadlzkArea() {
  try {
    const res = await fetch("assets/data/lzk_wfo.geojson", {
      cache: "no-store"
    });

    if (!res.ok) {
      throw new Error("Service area GeoJSON failed: " + res.status);
    }

    const data = await res.json();

    console.log("Service area loaded:", data);

   lkzAreaLayer.clearLayers();
    lkzAreaLayer.addData(data);

  } catch (err) {
    console.error("Unable to load LZK area boundary:", err);
  }
}

loadlzkArea();
/* =========================
   AREA BUTTONS FROM DATABASE
========================= */

function buildAreaButtons() {
    const bar = document.getElementById("areaButtons");
    if (!bar) return;

    bar.innerHTML = "";

    areaButtons.forEach(area => {
        if (!area || !area.id) return;

        const zone = document.createElement("div");
        zone.className = "zone normal";
        zone.dataset.zone = area.id;

        const button = document.createElement("button");
        button.className = "zone-btn";
        button.type = "button";
        button.textContent = area.label || area.title || area.id;
        button.addEventListener("click", () => openZoneDetail(area.id));

        zone.appendChild(button);
        bar.appendChild(zone);
    });
}

buildAreaButtons();

const stationLayer=L.layerGroup().addTo(map), poiLayer=L.layerGroup().addTo(map), stormTrackLayer=L.layerGroup().addTo(map);
const radarLayer=L.tileLayer.wms("https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi",{
    layers:"nexrad-n0q-900913",format:"image/png",transparent:true,opacity:.58,attribution:"Radar: Iowa State Mesonet / NEXRAD"
}).addTo(map);
const warningLayer=L.geoJSON(null,{
    style:f=>{
        const s=getSeverity(f.properties);
        return{
            color:s==="tornado-emergency"?"#ff00ff":s==="tornado-warning"?"#7e22ce":"#f97316",weight:s==="tornado-emergency"?5:4,fillColor:s==="tornado-emergency"?"#dc2626":s==="tornado-warning"?"#7e22ce":"#f97316",fillOpacity:s==="tornado-emergency"?.42:.34
        }

    }
    ,onEachFeature:(f,l)=>l.on("click",()=>openDetail(buildAlertDetail(f)))
}).addTo(map);
stations.forEach(station=>{
    L.marker([station.lat,station.lng],{
        icon:L.divIcon({
            className:"",html:`<div class="station-marker" id="marker-${slug(station.name)}"></div>`,iconSize:[18,18],iconAnchor:[9,9]
        })
    }).bindPopup(`<strong>${station.name}</strong><br>${station.area}`).addTo(stationLayer)
});
locations.forEach(location=>{
    L.marker([location.lat,location.lng],{
        icon:L.divIcon({
            className:"",html:`<div class="poi-marker" id="location-marker-${slug(location.name)}"></div>`,iconSize:[15,15],iconAnchor:[7,7]
        })
    }).bindPopup(`<strong>${location.name}</strong><br>Type: ${location.type}<br>Watch radius: ${location.radius||"N/A"}`).addTo(poiLayer)
});
L.control.layers(null,{
    "Radar Reflectivity":radarLayer,"Storm Tracks":stormTrackLayer,"Stations":stationLayer,"Locations":poiLayer,"Warning Polygons":warningLayer
}
,{
    collapsed:false,position:"topleft"
}).addTo(map);
function setLayerVisible(name,on){
    const layers={
        radar:radarLayer,serviceArea:serviceAreaLayer,NWSwfo:  lkzAreaLayer, tracks:stormTrackLayer,stations:stationLayer,poi:poiLayer,warnings:warningLayer
    };

    const l=layers[name];
    if(!l)return;
    if(on&&!map.hasLayer(l))l.addTo(map);
    if(!on&&map.hasLayer(l))map.removeLayer(l)
}

function updateLocationMarkerProminence(){
    document.querySelectorAll(".poi-marker").forEach(el=>el.classList.toggle("zoomed",map.getZoom()>=10))
}

map.on("zoomend",updateLocationMarkerProminence);
updateLocationMarkerProminence();
async function loadTempestConditions(){
    if(!TEMPEST_STATION_ID||TEMPEST_TOKEN==="PASTE_YOUR_TOKEN_HERE"){
        setTempestUnavailable("Token not configured");
        return
    }

    try{
        const res=await fetch(`https://swd.weatherflow.com/swd/rest/observations/station/${TEMPEST_STATION_ID}?token=${TEMPEST_TOKEN}`);
        if(!res.ok)throw new Error("Tempest API failed: "+res.status);
        const data=await res.json(),obs=data.obs&&data.obs[0];
        if(!obs)throw new Error("No Tempest observation returned");
        const airTempF=cToF(obs.air_temperature),humidity=safeRound(obs.relative_humidity),windMph=msToMph(obs.wind_avg),gustMph=msToMph(obs.wind_gust),windDir=degToCompass(obs.wind_direction),rainDay=mmToIn(obs.precip_accum_local_day),rainRate=mmToIn(obs.precip),lightningKm=obs.lightning_strike_last_distance,lightningMiles=lightningKm?Math.round(lightningKm*.621371):null,lightningTime=obs.lightning_strike_last_epoch,obsEpoch=obs.timestamp||obs.epoch,ageSec=obsEpoch?Math.floor(Date.now()/1000-obsEpoch):null;
        tempValue.textContent=`${airTempF}°`;
        humidityValue.textContent=`Humidity ${humidity}%`;
        rainValue.textContent=`${rainDay}"`;
        rainRateValue.textContent=`Rate ${rainRate}"/hr`;
        windValue.textContent=`${windMph}G${gustMph}`;
        windSubValue.textContent=`${windDir} / MPH`;
        lightningValue.textContent=lightningTime&&lightningMiles!==null?`${lightningMiles} MI`:"NONE";
        lightningSubValue.textContent=lightningTime&&lightningMiles!==null?"Last strike distance":"No recent strike";
        tempestUpdatedValue.textContent=obsEpoch?formatTime24(new Date(obsEpoch*1000).toISOString()):"--:--";
        tempestAgeValue.textContent=ageSec!==null?`${ageSec}s ago`:"Age unavailable";
        updateConditionCardClasses(gustMph,lightningMiles,ageSec)
    }

    catch(e){
        console.error(e);
        setTempestUnavailable(e.message)
    }

}
async function loadServiceArea() {
  try {
    const res = await fetch("assets/data/service-map.geojson", {
      cache: "no-store"
    });

    if (!res.ok) {
      throw new Error("Service area GeoJSON failed: " + res.status);
    }

    const data = await res.json();

    serviceAreaLayer.clearLayers();
    serviceAreaLayer.addData(data);

  } catch (err) {
    console.error("Unable to load service area boundary:", err);
  }
}

async function loadOutlookData(){
  const base = "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer";

  const endpoints = {
    tornado: `${base}/4/query?where=1%3D1&outFields=*&f=geojson`,
    hail: `${base}/6/query?where=1%3D1&outFields=*&f=geojson`,
    wind: `${base}/5/query?where=1%3D1&outFields=*&f=geojson`,
    excessiveRain: "https://mapservices.weather.noaa.gov/vector/rest/services/hazards/wpc_precip_hazards/MapServer/0/query?where=1%3D1&outFields=*&f=geojson"
  };

  for(const key in endpoints){
    try{
      const res = await fetch(endpoints[key]);
      if(!res.ok) throw new Error(`${key} failed: ${res.status}`);
      outlookData[key] = await res.json();
    }catch(err){
      console.warn("Outlook load failed:", key, err);
      outlookData[key] = null;
    }
  }
}
function setTrackWindow(minutes){
    TRACK_WINDOW_MINUTES=Number(minutes)||60;
    document.querySelectorAll("[data-track-minutes]").forEach(b=>b.classList.toggle("active",Number(b.dataset.trackMinutes)===TRACK_WINDOW_MINUTES));
    redrawStormTracks()
}

function redrawStormTracks(){
    stormTrackLayer.clearLayers();
    latestAllArkansasAlerts.forEach(a=>{
        if(shouldDrawTrackForAlert(a))drawStormTrack(a)
    });
    latestCustomStormTracks.forEach(drawCustomStormTrack)
}

async function loadCustomStormTracks(){
    try{
        const r=await fetch("storm-tracks.json",{
            cache:"no-store"
        });
        if(!r.ok){
            latestCustomStormTracks=[];
            redrawStormTracks();
            return
        }

        const data=await r.json();
        latestCustomStormTracks=Array.isArray(data)?data:(Array.isArray(data.tracks)?data.tracks:[]);
        redrawStormTracks()
    }

    catch(e){
        latestCustomStormTracks=[]
    }

}

async function loadAlerts(){
    const c=document.getElementById("alerts");
    c.innerHTML="";
    warningLayer.clearLayers();
    stormTrackLayer.clearLayers();
    latestPanelAlerts=[];
    resetZones();
    resetStationMarkers();
    updateStationSummary();
    try{
        const res=await fetch("https://api.weather.gov/alerts/active",{
            headers:{
                Accept:"application/geo+json"
            }

        });
        if(!res.ok)throw new Error("NWS API failed: "+res.status);
        const data=await res.json();
        infoTime.textContent=formatTime24(new Date().toISOString());
        const all=data.features.filter(isArkansasRelevantAlert).sort(sortAlerts);
        latestAllArkansasAlerts=all;
        const panel=all.filter(isNwsLittleRockAlert).sort(sortAlerts);
        latestPanelAlerts=panel;
        all.forEach(alert=>{
            if(shouldDrawPolygon(alert))warningLayer.addData(alert);
            if(shouldDrawTrackForAlert(alert))drawStormTrack(alert);
            const d=buildAlertDetail(alert);
            applyZoneStatus(d.affectedStations,getSeverity(alert.properties));
            highlightImpactedStations(d.affectedStations)
        });
        updateStationSummary();
        if(!panel.length)c.innerHTML=`<div class="alert-box normal"><div class="alert-title">No LZK Watches or Warnings</div><div class="alert-meta">No active tracked watches or warnings issued by NWS Little Rock.</div></div>`;
        panel.forEach(alert=>{
            const p=alert.properties,s=getSeverity(p),d=buildAlertDetail(alert);
            c.insertAdjacentHTML("beforeend",`<div class="alert-box ${s}" onclick='openDetailById("${alert.id}")'><div class="alert-title">${formatTitle(p)}</div><div class="alert-meta"><strong>Issued by:</strong> ${p.senderName||"NWS Little Rock"}<br><strong>Expires:</strong> ${formatTime24(p.expires)}<br><strong>Areas:</strong> ${formatAreas(p.areaDesc)}</div><div class="station-hit"><div class="station-hit-title">Affected Stations</div>${formatAffectedStations(d.affectedStations)}</div></div>`)
        });
        maintainMapViewAfterRefresh()
    }

    catch(e){
        console.error(e);
        c.innerHTML=`<div class="alert-box tornado-warning"><div class="alert-title">Unable to load alerts</div><div class="alert-meta">${e.message}</div></div>`
    }

}

function openZoneDetail(zoneId){
    const profile=zoneProfiles[zoneId];
    if(!profile)return;
    const zoneStations=stations.filter(s=>profile.stations.includes(s.name));
    const zonePoint=turf.point([profile.center[1],profile.center[0]]);
    const active=latestAllArkansasAlerts.filter(a=>{
        const d=buildAlertDetail(a);
        return d.affectedStations.some(s=>profile.stations.includes(s.name))
    });
    detailTitle.textContent=profile.title;
    detailMeta.innerHTML=`<strong>Station Radar View</strong><br>Local station group view centered on ${profile.title}`;
    detailBody.innerHTML=`<div class="detail-section"><strong>Station Radar View</strong><div id="stationRadarMap" style="height:280px;margin-top:10px;border-radius:10px;overflow:hidden;"></div></div><div class="detail-section"><strong>Outlook Data</strong><ul class="detail-list"><li>Tornado — <strong>${getOutlookLabel(zonePoint,outlookData.tornado)}</strong></li><li>Hail — <strong>${getOutlookLabel(zonePoint,outlookData.hail)}</strong></li><li>Wind — <strong>${getOutlookLabel(zonePoint,outlookData.wind)}</strong></li><li>Excessive Rain — <strong>${getOutlookLabel(zonePoint,outlookData.excessiveRain)}</strong></li></ul></div><div class="detail-section"><strong>Stations</strong><ul class="detail-list">${zoneStations.map(s=>`<li>${
        s.name
    }

    </li>`).join("")}</ul></div><div class="detail-section"><strong>Current Watches and Warnings</strong><ul class="detail-list">${active.length?active.map(a=>`<li><strong>${
        formatTitle(a.properties)
    }

    </strong> — Expires ${
        formatTime24(a.properties.expires)
    }

    </li>`).join(""):"<li>No current watches or warnings for this station group.</li>"}</ul></div>`;
    detailOverlay.style.display="flex";
    setTimeout(()=>buildStationRadarMap(profile,zoneStations),100)
}

function buildStationRadarMap(profile,zoneStations){
    const mini=L.map("stationRadarMap",{
        zoomControl:true,attributionControl:false
    }).setView(profile.center,9);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{
        maxZoom:20
    }).addTo(mini);
    latestAllArkansasAlerts.forEach(a=>{
        if(shouldDrawPolygon(a))L.geoJSON(a,{
            style:{
                color:getSeverity(a.properties)==="tornado-warning"?"#7e22ce":"#f97316",weight:3,fillOpacity:.25
            }

        }).addTo(mini)
    });
    zoneStations.forEach(s=>L.circleMarker([s.lat,s.lng],{
        radius:7,color:"#fff",weight:2,fillColor:"#005bea",fillOpacity:1
    }).bindPopup(`<strong>${s.name}</strong>`).addTo(mini))
}

function getOutlookLabel(point, geojson, type){
    if(!geojson || !geojson.features) return "Not loaded";

    let best = "LOW";

    geojson.features.forEach(f => {
        try{
            if(f.geometry && turf.booleanPointInPolygon(point, f)){
                best = readOutlookProperties(f.properties, type);
            }
        } catch(e){}
    });

    return best;
}

function readOutlookProperties(p){
    return p.LABEL||p.label||p.RISK||p.risk||p.CATEGORY||p.category||p.DN||p.dn||p.THRESHOLD||p.threshold||"Included"
}

function maintainMapViewAfterRefresh(){
    if(Date.now()-lastUserMapActivity<USER_ACTIVITY_HOLD_MS)return;
    map.setView(AR_CENTER,AR_ZOOM,{
        animate:false
    })
}

function isArkansasRelevantAlert(alert){
    const p=alert.properties,event=p.event||"",ugc=p.geocode?.UGC||[],area=p.areaDesc||"";
    const isAR=ugc.some(c=>c.startsWith("AR"))||area.includes(", AR")||area.includes(" AR;")||area.endsWith(" AR");
    return isAR&&["Tornado Watch","Severe Thunderstorm Watch","Severe Thunderstorm Warning","Tornado Warning","Special Weather Statement"].includes(event)
}

function isNwsLittleRockAlert(alert){
    const p=alert.properties,sn=(p.senderName||"").toUpperCase(),sender=(p.sender||"").toUpperCase(),params=p.parameters||{
    };

    const awips=Array.isArray(params.AWIPSidentifier)?params.AWIPSidentifier.join(" ").toUpperCase():"",wmo=Array.isArray(params.WMOidentifier)?params.WMOidentifier.join(" ").toUpperCase():"",headline=Array.isArray(params.NWSheadline)?params.NWSheadline.join(" ").toUpperCase():"";
    return sn.includes("LITTLE ROCK")||sender.includes("LZK")||awips.includes("LZK")||wmo.includes("KLZK")||headline.includes("LITTLE ROCK")
}

function shouldDrawPolygon(alert){
    const event=alert.properties.event||"",s=getSeverity(alert.properties);
    return alert.geometry&&(event==="Tornado Warning"||event==="Severe Thunderstorm Warning"||s==="tornado-emergency")
}

function getSeverity(p){
    const event=p.event||"",text=`${p.headline||""} ${p.description||""} ${p.instruction||""}`.toUpperCase();
    if(event==="Tornado Warning"&&text.includes("TORNADO EMERGENCY"))return"tornado-emergency";
    if(event==="Tornado Warning")return"tornado-warning";
    if(event==="Tornado Watch")return"tornado-watch";
    if(event==="Severe Thunderstorm Warning")return"tstorm-warning";
    if(event==="Severe Thunderstorm Watch")return"tstorm-watch";
    return"normal"
}

function formatTitle(p){
    const n=getAlertNumber(p),s=getSeverity(p);
    if(s==="tornado-emergency")return n?`Tornado Emergency #${n}`:"Tornado Emergency";
    return n?`${p.event} #${n}`:(p.event||"Weather Alert")
}

function getAlertNumber(p){
    const v=Array.isArray(p.parameters?.VTEC)?p.parameters.VTEC:[];
    for(const x of v){
        const raw=String(x).split(".")[6];
        if(raw&&/^\d+$/.test(raw))return String(Number(raw))
    }

    const m=(p.headline||"").match(/(?:watch|warning)\s+(\d+)/i);
    return m?m[1]:""
}

function buildAlertDetail(alert){
    const p=alert.properties,motion=parseStormMotion(p),origin=parseStormOrigin(alert,p),affectedStations=[],affectedTowns=[],affectedPOI=[],bulletin=extractImpactedAreasFromBulletin(p),ugc=getAlertUgcCodes(p);
    if(alert.geometry){
        stations.forEach(s=>{
            if(pointInsideAlert(alert,s))affectedStations.push(s)
        });
        locations.forEach(l=>{
            if(pointInsideAlert(alert,l))affectedPOI.push(l)
        });
        bulletin.forEach(name=>{
            const t=towns.find(x=>normalizeName(x.name)===normalizeName(name));
            affectedTowns.push(t||{
                name,zone:[],impact:"Timing not available"
            })
        })
    }

    else{
        stations.forEach(s=>{
            if(itemMatchesAlertUgc(s,ugc,p.areaDesc))affectedStations.push(s)
        });
        towns.forEach(t=>{
            if(itemMatchesAlertUgc(t,ugc,p.areaDesc))affectedTowns.push(t)
        });
        locations.forEach(l=>{
            if(areaLooksRelevantToPOI(p.areaDesc||"",l))affectedPOI.push(l)
        })
    }

    return{
        id:alert.id,title:formatTitle(p),event:p.event||"",severity:getSeverity(p),expires:p.expires,areaDesc:p.areaDesc||"",motion,stormOrigin:origin,affectedStations:dedupeByName(affectedStations).map(s=>({
            ...s,impact:estimateImpactTime(alert,s,motion,origin)
        })),affectedTowns:dedupeByName(affectedTowns).map(t=>({
            ...t,impact:(t.lat!==undefined&&t.lng!==undefined)?estimateImpactTime(alert,t,motion,origin):(t.impact||"Timing not available")
        })),affectedPOI:dedupeByName(affectedPOI).map(x=>({
            ...x,impact:estimateImpactTime(alert,x,motion,origin)
        })),impactedAreas:bulletin,description:p.description||"",instruction:p.instruction||"",geometry:alert.geometry||null
    }

}

function formatAffectedStations(list){
    return list.length?list.map(s=>`<span class="station-list-line">${s.name} — ${s.impact}</span>`).join(""):`<span class="station-list-line">No MEMS stations currently inside this alert area.</span>`
}

function getAlertUgcCodes(p){
    return (p.geocode&&Array.isArray(p.geocode.UGC)?p.geocode.UGC:[]).map(c=>String(c).toUpperCase())
}

function itemMatchesAlertUgc(item,codes,areaDesc){
    const itemCodes=Array.isArray(item.countyCodes)?item.countyCodes.map(c=>String(c).toUpperCase()):[];
    if(codes.length&&itemCodes.length)return itemCodes.some(c=>codes.includes(c));
    const a=String(areaDesc||"").toLowerCase();
    if(itemCodes.includes("ARC119"))return a.includes("pulaski");
    if(itemCodes.includes("ARC085"))return a.includes("lonoke");
    if(itemCodes.includes("ARC053"))return a.includes("grant");
    return false
}

function pointInsideAlert(alert,point){
    try{
        return !!alert.geometry&&turf.booleanPointInPolygon(turf.point([point.lng,point.lat]),alert)
    }

    catch(e){
        return false
    }

}

function normalizeName(v){
    return String(v||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim()
}

function dedupeByName(items){
    const seen=new Set();
    return items.filter(i=>{
        const k=normalizeName(i.name);
        if(!k||seen.has(k))return false;
        seen.add(k);
        return true
    })
}

function extractImpactedAreasFromBulletin(p){
    const text=String(p.description||"").replace(/\r/g,""),results=[];
    [/Locations impacted include\.\.\.\s*([\s\S]*?)(?:\n\s*\n|PRECAUTIONARY\/PREPAREDNESS ACTIONS|HAZARD|SOURCE|IMPACT|This includes|&&|$)/i,/Other locations impacted by this severe thunderstorm include\.\.\.\s*([\s\S]*?)(?:\n\s*\n|PRECAUTIONARY\/PREPAREDNESS ACTIONS|HAZARD|SOURCE|IMPACT|This includes|&&|$)/i,/The tornado will be near\.\.\.\s*([\s\S]*?)(?:\n\s*\n|PRECAUTIONARY\/PREPAREDNESS ACTIONS|HAZARD|SOURCE|IMPACT|This includes|&&|$)/i].forEach(pattern=>{
        const m=text.match(pattern);
        if(m&&m[1])results.push(...splitBulletinPlaceList(m[1]))
    });
    return [...new Set(results.map(cleanBulletinPlace).filter(Boolean))]
}

function splitBulletinPlaceList(block){
    return String(block||"")
        .replace(/\n/g," ")
        .replace(/\s+/g," ")
        .split(/,|;|\band\b/i)
        .map(cleanBulletinPlace)
        .filter(Boolean)
}

function cleanBulletinPlace(v){
    return String(v||"")
        .replace(/\b(around|near|including|mainly|about|between|after|before)\b/ig,"")
        .replace(/\b\d{1,2}:\d{2}\s*(?:AM|PM)?\b/ig,"")
        .replace(/\b\d{1,2}\s*(?:AM|PM)\b/ig,"")
        .replace(/\b(by|at)\s*\d{1,2}\s*(?:AM|PM)?\b/ig,"")
        .replace(/\.$/,"")
        .replace(/\s+/g," ")
        .trim()
}

function areaLooksRelevantToPOI(area,location){
    const a=area.toLowerCase(),p=`${location.name} ${location.area}`.toLowerCase();
    if(p.includes("cabot")||p.includes("lonoke"))return a.includes("lonoke");
    if(p.includes("sheridan")||p.includes("grant"))return a.includes("grant");
    if(p.includes("benton")||p.includes("saline"))return a.includes("saline");
    return a.includes("pulaski")
}

function parseStormMotion(p){
    const params=p.parameters||{};
    const paramText=Object.keys(params).map(k=>Array.isArray(params[k])?params[k].join(" "):String(params[k]||"")).join(" ");
    const text=`${p.headline||""} ${p.description||""} ${p.instruction||""} ${paramText}`;
    const m=text.match(/moving\s+([A-Z]{1,3}|north|south|east|west|northeast|northwest|southeast|southwest|north-northeast|east-northeast|east-southeast|south-southeast|south-southwest|west-southwest|west-northwest|north-northwest)\s+at\s+(\d+)\s*(mph|kt|kts|knots?)?/i);
    if(!m)return null;
    const dir=normalizeMotionDirection(m[1]);
    let speed=Number(m[2]);
    const unit=String(m[3]||"mph").toLowerCase();
    if(unit.startsWith("kt")||unit.startsWith("knot"))speed=Math.round(speed*1.15078);
    return{direction:dir,speed,originalSpeed:Number(m[2]),unit}
}

function normalizeMotionDirection(v){
    const c=String(v||"").toLowerCase().replace(/-/g," ").trim();
    const w={
        north:"N",south:"S",east:"E",west:"W",northeast:"NE",northwest:"NW",southeast:"SE",southwest:"SW","north northeast":"NNE","east northeast":"ENE","east southeast":"ESE","south southeast":"SSE","south southwest":"SSW","west southwest":"WSW","west northwest":"WNW","north northwest":"NNW"
    };

    return (w[c]||c.toUpperCase()).replace(/\s+/g,"")
}

function parseStormOrigin(alert,p){
    const text=`${p.description||""} ${p.instruction||""}`;
    const m=text.match(/located\s+(?:near|over|around|approximately\s+near|\d+\s+miles?\s+(?:north|south|east|west|northeast|northwest|southeast|southwest)\s+of)\s+([A-Za-z .'-]+?)(?:,|\.| moving| at )/i);if(m){const name=cleanBulletinPlace(m[1]);const known=[...towns,...stations,...locations].find(x=>normalizeName(x.name)===normalizeName(name)||normalizeName(x.area)===normalizeName(name));if(known)return{lat:known.lat,lng:known.lng,label:known.name}}if(alert.geometry){try{const c=turf.centroid(alert).geometry.coordinates;return{lng:c[0],lat:c[1],label:"warning polygon center"}}catch(e){}}return null}
function estimateImpactTime(alert,point,motion,origin){if(!motion||!motion.speed||!origin||point.lat===undefined||point.lng===undefined)return"Timing not available";try{const bearing=directionToBearing(motion.direction);if(bearing===null)return"Timing not available";const originPoint=turf.point([origin.lng,origin.lat]),target=turf.point([point.lng,point.lat]);const dist=turf.distance(originPoint,target,{units:"miles"});const bearingTo=turf.bearing(originPoint,target);let delta=Math.abs((((bearingTo-bearing)+540)%360)-180);if(delta>75)return"Near path, timing uncertain";const min=Math.round(dist/motion.speed*60);if(min<=0)return"Now";if(min>180)return"3+ hr";return`~${min} min / ${formatTime24(new Date(Date.now()+min*60000).toISOString())}`}catch(e){return"Timing not available"}}
function applyZoneStatus(stationsHit,severity){const zones=new Set();stationsHit.forEach(s=>(s.zone||[]).forEach(z=>zones.add(z)));zones.forEach(z=>{const el=document.querySelector(`[data-zone="${z}"]`);if(el)setZoneSeverity(el,severity)})}
function setZoneSeverity(el,severity){const rank={normal:0,"tstorm-watch":1,"tstorm-warning":2,"tornado-watch":3,"tornado-warning":4,"tornado-emergency":5};const cur=Array.from(el.classList).find(c=>rank[c]!==undefined)||"normal";if(rank[severity]>=rank[cur])el.className=`zone ${severity}`}
function highlightImpactedStations(list){list.forEach(s=>{impactedStationNames.add(s.name);const el=document.getElementById(`marker-${slug(s.name)}`);if(el)el.classList.add("impacted")})} function resetStationMarkers(){impactedStationNames=new Set();document.querySelectorAll(".station-marker").forEach(el=>el.classList.remove("impacted"))} function resetZones(){document.querySelectorAll(".zone").forEach(z=>z.className="zone normal")}
function openDetailById(id){const alert=latestPanelAlerts.find(a=>a.id===id);if(alert)openDetail(buildAlertDetail(alert))}
function openDetail(detail){detailTitle.textContent=detail.title;detailMeta.innerHTML=`<strong>Expires:</strong> ${formatTime24(detail.expires)}<br><strong>Motion:</strong> ${detail.motion?`${detail.motion.direction} at ${detail.motion.speed} mph`:"Not available"}<br><strong>Areas:</strong> ${formatAreas(detail.areaDesc)}`;const stationsHtml=formatCondensedAlphabetizedList(detail.affectedStations,s=>`${s.name} <strong>(${s.impact})</strong>`,"No MEMS stations currently inside this alert area."),areasHtml=formatCondensedAlphabetizedList(detail.affectedTowns,t=>`${t.name} <strong>(${t.impact})</strong>`,"No impacted areas listed in the NWS bulletin."),locHtml=formatLocationsByType(detail.affectedPOI);detailBody.innerHTML=`<div class="detail-section"><strong>Affected Stations</strong><ul class="detail-list">${stationsHtml}</ul></div><div class="detail-section"><strong>Areas Impacted</strong><ul class="detail-list">${areasHtml}</ul></div><div class="detail-section"><strong>Locations</strong><ul class="detail-list">${locHtml}</ul></div><div class="detail-section"><strong>Instruction</strong><div>${detail.instruction||"No instruction included."}</div></div>`;detailOverlay.style.display="flex"}
function openStationList(){detailTitle.textContent="MEMS Stations";detailMeta.innerHTML=`<strong>${stations.length}</strong> tracked stations / posts`;detailBody.innerHTML=`<div class="detail-section"><ul class="detail-list">${stations.map(s=>`<li><strong>${s.name}</strong> — ${s.area}${impactedStationNames.has(s.name)?" — <strong>IMPACTED</strong>":""}</li>`).join("")}</ul></div>`;detailOverlay.style.display="flex"} function closeDetail(){detailOverlay.style.display="none"}
function formatCondensedAlphabetizedList(items,render,empty){return items.length?[...items].sort((a,b)=>a.name.localeCompare(b.name)).map(x=>`<li>${render(x)}</li>`).join(""):`<li>${empty}</li>`} function formatLocationsByType(list){if(!list.length)return"<li>No locations currently inside this alert area.</li>";const groups={};list.forEach(l=>{(groups[l.type||"Other"]??=[]).push(l)});return Object.keys(groups).sort().map(t=>`<li><strong>${t}:</strong> ${groups[t].sort((a,b)=>a.name.localeCompare(b.name)).map(l=>`${l.name} <strong>(${l.impact})</strong>`).join(", ")}</li>`).join("")}
function buildTrackMinutes(){return[0,15,30,45,60].filter(m=>m===0||m<=TRACK_WINDOW_MINUTES)} function directionToBearing(d){return{N:0,NNE:22.5,NE:45,ENE:67.5,E:90,ESE:112.5,SE:135,SSE:157.5,S:180,SSW:202.5,SW:225,WSW:247.5,W:270,WNW:292.5,NW:315,NNW:337.5}[String(d||"").toUpperCase()]??null}
function shouldDrawTrackForAlert(alert){const e=alert.properties?.event||"";return Boolean(alert.geometry)&&["Tornado Warning","Severe Thunderstorm Warning","Special Weather Statement","Marine Weather Statement"].includes(e)}
function drawStormTrack(alert) {
    const p = alert.properties || {};
    const motion = parseStormMotion(p);
    const origin = parseStormOrigin(alert, p);
    if (!motion || !motion.speed || !origin) return;

    const bearing = directionToBearing(motion.direction);
    if (bearing === null) return;

    const id = slug(alert.id || `${p.event}-${origin.label}-${p.sent || Date.now()}`);
    const originPoint = turf.point([origin.lng, origin.lat]);
    const minutes = buildTrackMinutes();
    const points = minutes.map(m => projectPointFromOrigin(originPoint, motion.speed, bearing, m));
    const show = activeTrackId === id;
    const group = L.layerGroup().addTo(stormTrackLayer);

    // Shadow line
    L.polyline(points, {color: "#050505", weight: 4, opacity: .85, interactive: false}).addTo(group);

    // Main track line — click toggles labels
    const line = L.polyline(points, {color: "#fff", weight: 1.5, opacity: .98, className: "storm-track-line"})
        .bindPopup(`<strong>${formatTitle(p)}</strong><br><strong>Motion:</strong> ${motion.direction} at ${motion.speed} mph<br><strong>Origin:</strong> ${origin.label}<br><strong>Track timing:</strong> ${buildTrackTimingText(originPoint, motion.speed, bearing)}`)
        .addTo(group);

    line.on("click", () => {
        activeTrackId = activeTrackId === id ? null : id;
        redrawStormTracks();
        if (activeTrackId === id) line.openPopup();
    });

    // Origin dot — click also toggles time labels
    L.marker(points[0], {
        icon: L.divIcon({className: "", html: `<div class="track-origin"></div>`, iconSize: [14, 14], iconAnchor: [7, 7]})
    })
    .bindPopup(`<strong>Storm location</strong><br>${origin.label}<br>${motion.direction} at ${motion.speed} mph`)
    .addTo(group)
    .on("click", () => {
        activeTrackId = activeTrackId === id ? null : id;
        redrawStormTracks();
    });

    // Time step barbs + labels
    minutes.slice(1).forEach((m, i) => {
        const eta = formatTime24(new Date(Date.now() + m * 60000).toISOString());
        const pt = points[i + 1];

        // Barb marker
        L.marker(pt, {
            icon: L.divIcon({
                className: "",
                html: `<div class="track-step" style="transform:rotate(${bearing + 90}deg)"></div>`,
                iconSize: [30, 30],
                iconAnchor: [15, 15]
            }),
            interactive: false
        }).addTo(group);

        // Time label (shown/hidden based on activeTrackId)
        L.marker(pt, {
            icon: L.divIcon({
                className: "",
                html: `<div class="track-label ${show ? "visible" : ""}">${eta}</div>`,
                iconSize: [42, 14],
                iconAnchor: [21, -4]
            }),
            interactive: false
        }).addTo(group);
    });
}

function drawCustomStormTrack(track){if(!track||track.lat===undefined||track.lng===undefined)return;const motion={direction:normalizeMotionDirection(track.direction||"E"),speed:Number(track.speed||track.speedMph||25)},origin={lat:Number(track.lat),lng:Number(track.lng),label:track.name||"Unwarned Storm"};const fake={id:track.id||track.name||Math.random(),properties:{event:track.name||"Unwarned Storm",description:`moving ${motion.direction} at ${motion.speed} mph`},geometry:{type:"Point",coordinates:[origin.lng,origin.lat]}};drawStormTrack({...fake,properties:{...fake.properties,description:`located near ${origin.label}, moving ${motion.direction} at ${motion.speed} mph`}})}
function projectPointFromOrigin(point,speed,bearing,minutes){const miles=speed*(minutes/60);const p=turf.destination(point,miles,bearing,{units:"miles"}).geometry.coordinates;return[p[1],p[0]]} function buildTrackTimingText(originPoint,speed,bearing){return buildTrackMinutes().slice(1).map(m=>`${m} min ${formatTime24(new Date(Date.now()+m*60000).toISOString())}`).join(" • ")}
function updateStationSummary(){stationOnlineCount.textContent=stations.length;stationImpactedCount.textContent=impactedStationNames.size;poiCount.textContent=locations.length}
function formatAreas(areaDesc){if(!areaDesc)return"None listed";const a=areaDesc.split(";").map(x=>x.trim()).filter(Boolean);return a.length<=8?a.join(", "):a.slice(0,8).join(", ")+`, +${a.length-8} more`} function formatTime24(v){if(!v)return"N/A";return new Date(v).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",hour12:false})} function sortAlerts(a,b){const r={"tornado-emergency":5,"tornado-warning":4,"tornado-watch":3,"tstorm-warning":2,"tstorm-watch":1,normal:0};return r[getSeverity(b.properties)]-r[getSeverity(a.properties)]} function slug(v){return String(v).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"")} function cToF(c){return c==null?"--":Math.round(c*9/5+32)} function msToMph(ms){return ms==null?"--":Math.round(ms*2.23694)} function mmToIn(mm){return mm==null?"--":(mm/25.4).toFixed(2)} function safeRound(v){return v==null?"--":Math.round(v)} function degToCompass(deg){if(deg==null)return"--";const dirs=["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];return dirs[Math.round(deg/22.5)%16]}
function updateRefreshCountdown(){secondsUntilRefresh--;if(secondsUntilRefresh<=0){secondsUntilRefresh=REFRESH_SECONDS;loadAlerts();loadCustomStormTracks()}refreshCountdown.textContent=secondsUntilRefresh+"s"} function updateConditionCardClasses(gust,lightning,age){windCard.className="condition-card wind";lightningCard.className="condition-card lightning";updatedCard.className="condition-card updated";if(gust>=50)windCard.classList.add("warn");else if(gust>=35)windCard.classList.add("caution");if(lightning!==null&&lightning<=10)lightningCard.classList.add("lightning-near");else if(lightning!==null&&lightning<=20)lightningCard.classList.add("caution");if(age!==null&&age>180)updatedCard.classList.add("warn");else if(age!==null&&age>90)updatedCard.classList.add("caution")} function setTempestUnavailable(reason){tempValue.textContent="--°";humidityValue.textContent=reason;rainValue.textContent="--";rainRateValue.textContent="Rate --";windValue.textContent="--G--";windSubValue.textContent="Direction --";lightningValue.textContent="--";lightningSubValue.textContent="Unavailable";tempestUpdatedValue.textContent="--:--";tempestAgeValue.textContent="Tempest unavailable"}
updateStationSummary();
loadServiceArea();
loadlzkArea();
loadAlerts();
loadTempestConditions();
loadOutlookData();
loadCustomStormTracks();

setInterval(loadOutlookData, 10 * 60 * 1000);
setInterval(updateRefreshCountdown, 1000);
setInterval(loadTempestConditions, 60000);
setInterval(loadCustomStormTracks, 60000);

// Force Leaflet to recalculate container size after CSS grid has settled
window.addEventListener("load", function(){
    setTimeout(function(){ map.invalidateSize(); }, 150);
});
