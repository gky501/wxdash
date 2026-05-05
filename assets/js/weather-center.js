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
const TEMPEST_TOKEN = "PASTE_YOUR_TEMPEST_TOKEN_HERE";

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
  tornadoCig: null,
  tornadoProb: null,
  hailCig: null,
  hailProb: null,
  windCig: null,
  windProb: null,
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
  areaButtons.map(area => [
    area.id,
    {
      title: area.title || area.label || area.id,
      center: area.center,
      stations: area.stations || []
    }
  ])
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

/* =========================
   BACKGROUND BOUNDARIES
========================= */

const serviceAreaLayer = L.geoJSON(null, {
  style: {
    color: "#000000",
    weight: 2,
    opacity: 0.40,
    fillColor: "#005bea",
    fillOpacity: 0.0
  }
}).addTo(map);

const lzkAreaLayer = L.geoJSON(null, {
  style: {
    color: "#005bea",
    weight: 2,
    opacity: 0.40,
    fillColor: "#005bea",
    fillOpacity: 0.0
  }
}).addTo(map);

async function loadServiceArea(){
  try{
    const res = await fetch("assets/data/service-map.geojson", {
      cache: "no-store"
    });

    if(!res.ok){
      throw new Error("Service area GeoJSON failed: " + res.status);
    }

    const data = await res.json();
    serviceAreaLayer.clearLayers();
    serviceAreaLayer.addData(data);

  }catch(err){
    console.error("Unable to load service area boundary:", err);
  }
}

async function loadLzkArea(){
  try{
    const res = await fetch("assets/data/lzk_wfo.geojson", {
      cache: "no-store"
    });

    if(!res.ok){
      throw new Error("LZK area GeoJSON failed: " + res.status);
    }

    const data = await res.json();
    lzkAreaLayer.clearLayers();
    lzkAreaLayer.addData(data);

  }catch(err){
    console.error("Unable to load LZK area boundary:", err);
  }
}

/* =========================
   AREA BUTTONS
========================= */

function buildAreaButtons(){
  const bar = document.getElementById("areaButtons");
  if(!bar) return;

  bar.innerHTML = "";

  areaButtons.forEach(area => {
    if(!area || !area.id) return;

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

/* =========================
   LAYERS
========================= */

const stationLayer = L.layerGroup().addTo(map);
const poiLayer = L.layerGroup().addTo(map);
const stormTrackLayer = L.layerGroup().addTo(map);

const radarLayer = L.tileLayer.wms("https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi", {
  layers: "nexrad-n0q-900913",
  format: "image/png",
  transparent: true,
  opacity: 0.58,
  attribution: "Radar: Iowa State Mesonet / NEXRAD"
}).addTo(map);

const warningLayer = L.geoJSON(null, {
  style: feature => {
    const severity = getSeverity(feature.properties || {});

    return {
      color:
        severity === "tornado-emergency" ? "#ff00ff" :
        severity === "tornado-warning" ? "#7e22ce" :
        "#f97316",
      weight: severity === "tornado-emergency" ? 5 : 4,
      fillColor:
        severity === "tornado-emergency" ? "#dc2626" :
        severity === "tornado-warning" ? "#7e22ce" :
        "#f97316",
      fillOpacity: severity === "tornado-emergency" ? 0.42 : 0.34
    };
  },
  onEachFeature: (feature, layer) => {
    layer.on("click", () => openDetail(buildAlertDetail(feature)));
  }
}).addTo(map);

stations.forEach(station => {
  if(station.lat === undefined || station.lng === undefined) return;

  L.marker([station.lat, station.lng], {
    icon: L.divIcon({
      className: "",
      html: `<div class="station-marker" id="marker-${slug(station.name)}"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    })
  })
  .bindPopup(`<strong>${station.name}</strong><br>${station.area || ""}`)
  .addTo(stationLayer);
});

locations.forEach(location => {
  if(location.lat === undefined || location.lng === undefined) return;

  L.marker([location.lat, location.lng], {
    icon: L.divIcon({
      className: "",
      html: `<div class="poi-marker" id="location-marker-${slug(location.name)}"></div>`,
      iconSize: [15, 15],
      iconAnchor: [7, 7]
    })
  })
  .bindPopup(`<strong>${location.name}</strong><br>Type: ${location.type || "Location"}<br>Watch radius: ${location.radius || "N/A"}`)
  .addTo(poiLayer);
});

L.control.layers(null, {
  "Radar Reflectivity": radarLayer,
  "Storm Tracks": stormTrackLayer,
  "Stations": stationLayer,
  "Locations": poiLayer,
  "Warning Polygons": warningLayer
}, {
  collapsed: false,
  position: "topleft"
}).addTo(map);

function setLayerVisible(name, on){
  const layers = {
    radar: radarLayer,
    serviceArea: serviceAreaLayer,
    NWSwfo: lzkAreaLayer,
    tracks: stormTrackLayer,
    stations: stationLayer,
    poi: poiLayer,
    warnings: warningLayer
  };

  const layer = layers[name];
  if(!layer) return;

  if(on && !map.hasLayer(layer)){
    layer.addTo(map);
  }

  if(!on && map.hasLayer(layer)){
    map.removeLayer(layer);
  }
}

window.setLayerVisible = setLayerVisible;

function updateLocationMarkerProminence(){
  document.querySelectorAll(".poi-marker").forEach(el => {
    el.classList.toggle("zoomed", map.getZoom() >= 10);
  });
}

map.on("zoomend", updateLocationMarkerProminence);
updateLocationMarkerProminence();

/* =========================
   TEMPEST
========================= */

async function loadTempestConditions(){
  if(!TEMPEST_STATION_ID || TEMPEST_TOKEN === "PASTE_YOUR_TEMPEST_TOKEN_HERE"){
    setTempestUnavailable("Token not configured");
    return;
  }

  try{
    const res = await fetch(`https://swd.weatherflow.com/swd/rest/observations/station/${TEMPEST_STATION_ID}?token=${TEMPEST_TOKEN}`);

    if(!res.ok){
      throw new Error("Tempest API failed: " + res.status);
    }

    const data = await res.json();
    const obs = data.obs && data.obs[0];

    if(!obs){
      throw new Error("No Tempest observation returned");
    }

    const airTempF = cToF(obs.air_temperature);
    const humidity = safeRound(obs.relative_humidity);
    const windMph = msToMph(obs.wind_avg);
    const gustMph = msToMph(obs.wind_gust);
    const windDir = degToCompass(obs.wind_direction);
    const rainDay = mmToIn(obs.precip_accum_local_day);
    const rainRate = mmToIn(obs.precip);
    const lightningKm = obs.lightning_strike_last_distance;
    const lightningMiles = lightningKm ? Math.round(lightningKm * 0.621371) : null;
    const lightningTime = obs.lightning_strike_last_epoch;
    const obsEpoch = obs.timestamp || obs.epoch;
    const ageSec = obsEpoch ? Math.floor(Date.now() / 1000 - obsEpoch) : null;

    setText("tempValue", `${airTempF}°`);
    setText("humidityValue", `Humidity ${humidity}%`);
    setText("rainValue", `${rainDay}"`);
    setText("rainRateValue", `Rate ${rainRate}"/hr`);
    setText("windValue", `${windMph}G${gustMph}`);
    setText("windSubValue", `${windDir} / MPH`);

    if(lightningTime && lightningMiles !== null){
      setText("lightningValue", `${lightningMiles} MI`);
      setText("lightningSubValue", "Last strike distance");
    }else{
      setText("lightningValue", "NONE");
      setText("lightningSubValue", "No recent strike");
    }

    setText("tempestUpdatedValue", obsEpoch ? formatTime24(new Date(obsEpoch * 1000).toISOString()) : "--:--");
    setText("tempestAgeValue", ageSec !== null ? `${ageSec}s ago` : "Age unavailable");

    updateConditionCardClasses(gustMph, lightningMiles, ageSec);

  }catch(err){
    console.error("Tempest error:", err);
    setTempestUnavailable(err.message);
  }
}

function setTempestUnavailable(reason){
  setText("tempValue", "--°");
  setText("humidityValue", reason);
  setText("rainValue", "--");
  setText("rainRateValue", "Rate --");
  setText("windValue", "--G--");
  setText("windSubValue", "Direction --");
  setText("lightningValue", "--");
  setText("lightningSubValue", "Unavailable");
  setText("tempestUpdatedValue", "--:--");
  setText("tempestAgeValue", "Tempest unavailable");
}

function updateConditionCardClasses(gust, lightning, age){
  const windCard = document.getElementById("windCard");
  const lightningCard = document.getElementById("lightningCard");
  const updatedCard = document.getElementById("updatedCard");

  if(windCard) windCard.className = "condition-card wind";
  if(lightningCard) lightningCard.className = "condition-card lightning";
  if(updatedCard) updatedCard.className = "condition-card updated";

  if(windCard){
    if(gust >= 50) windCard.classList.add("warn");
    else if(gust >= 35) windCard.classList.add("caution");
  }

  if(lightningCard){
    if(lightning !== null && lightning <= 10) lightningCard.classList.add("lightning-near");
    else if(lightning !== null && lightning <= 20) lightningCard.classList.add("caution");
  }

  if(updatedCard){
    if(age !== null && age > 180) updatedCard.classList.add("warn");
    else if(age !== null && age > 90) updatedCard.classList.add("caution");
  }
}

/* =========================
   OUTLOOK DATA
========================= */

async function loadOutlookData(){
  const base = "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer";

  const endpoints = {
    tornadoCig: `${base}/2/query?where=1%3D1&outFields=*&f=geojson`,
    tornadoProb: `${base}/3/query?where=1%3D1&outFields=*&f=geojson`,
    hailCig: `${base}/4/query?where=1%3D1&outFields=*&f=geojson`,
    hailProb: `${base}/5/query?where=1%3D1&outFields=*&f=geojson`,
    windCig: `${base}/6/query?where=1%3D1&outFields=*&f=geojson`,
    windProb: `${base}/7/query?where=1%3D1&outFields=*&f=geojson`,
    excessiveRain: "https://mapservices.weather.noaa.gov/vector/rest/services/hazards/wpc_precip_hazards/MapServer/0/query?where=1%3D1&outFields=*&f=geojson"
  };

  for(const key in endpoints){
    try{
      const res = await fetch(endpoints[key]);

      if(!res.ok){
        throw new Error(`${key} failed: ${res.status}`);
      }

      outlookData[key] = await res.json();

    }catch(err){
      console.warn("Outlook load failed:", key, err);
      outlookData[key] = null;
    }
  }
}

function getStormOutlook(point){
  return {
    tornado: {
      prob: getProbLabel(point, outlookData.tornadoProb, "tornado"),
      note: getCigLabel(point, outlookData.tornadoCig, "tornado")
    },
    hail: {
      prob: getProbLabel(point, outlookData.hailProb, "hail"),
      note: getCigLabel(point, outlookData.hailCig, "hail")
    },
    wind: {
      prob: getProbLabel(point, outlookData.windProb, "wind"),
      note: getCigLabel(point, outlookData.windCig, "wind")
    },
    excessiveRain: getRainLabel(point, outlookData.excessiveRain)
  };
}

function getProbLabel(point, geojson, type){
  if(!geojson || !geojson.features){
    return "Not loaded";
  }

  let best = {
    rank: 0,
    label: "Not highlighted"
  };

  geojson.features.forEach(feature => {
    if(!feature.geometry) return;

    try{
      if(turf.booleanPointInPolygon(point, feature)){
        const parsed = readProbabilityProperties(feature.properties || {}, type);

        if(parsed.rank >= best.rank){
          best = parsed;
        }
      }
    }catch(err){}
  });

  return best.label;
}

function getCigLabel(point, geojson, type){
  if(!geojson || !geojson.features){
    return "Not loaded";
  }

  let best = {
    rank: 0,
    label: "No added note"
  };

  geojson.features.forEach(feature => {
    if(!feature.geometry) return;

    try{
      if(turf.booleanPointInPolygon(point, feature)){
        const parsed = readCigProperties(feature.properties || {}, type);

        if(parsed.rank >= best.rank){
          best = parsed;
        }
      }
    }catch(err){}
  });

  return best.label;
}

function getRainLabel(point, geojson){
  if(!geojson || !geojson.features){
    return "Not loaded";
  }

  let best = {
    rank: 0,
    label: "Not highlighted"
  };

  geojson.features.forEach(feature => {
    if(!feature.geometry) return;

    try{
      if(turf.booleanPointInPolygon(point, feature)){
        const raw = readRawOutlookValue(feature.properties || {});
        const upper = raw.toUpperCase();

        const parsed =
          upper.includes("HIGH") ? { rank: 4, label: "High flooding concern" } :
          upper.includes("MODERATE") ? { rank: 3, label: "Moderate flooding concern" } :
          upper.includes("SLIGHT") ? { rank: 2, label: "Elevated flooding concern" } :
          upper.includes("MARGINAL") ? { rank: 1, label: "Limited flooding concern" } :
          { rank: 1, label: raw || "Included in rain outlook" };

        if(parsed.rank >= best.rank){
          best = parsed;
        }
      }
    }catch(err){}
  });

  return best.label;
}

function readProbabilityProperties(props, type){
  const raw = readRawOutlookValue(props);
  const upper = raw.toUpperCase();

  const numberMatch = upper.match(/(\d+)\s*%?/);
  const number = numberMatch ? Number(numberMatch[1]) : null;

  if(number !== null){
    return {
      rank: number,
      label: `${number}% area`
    };
  }

  if(upper.includes("HIGH")) return { rank: 60, label: "High risk area" };
  if(upper.includes("MODERATE") || upper.includes("MDT")) return { rank: 45, label: "Moderate risk area" };
  if(upper.includes("ENHANCED") || upper.includes("ENH")) return { rank: 30, label: "Enhanced risk area" };
  if(upper.includes("SLIGHT") || upper.includes("SLGT")) return { rank: 15, label: "Slight risk area" };
  if(upper.includes("MARGINAL") || upper.includes("MRGL")) return { rank: 5, label: "Marginal risk area" };

  return {
    rank: 0,
    label: raw || "Not highlighted"
  };
}

function readCigProperties(props, type){
  const raw = readRawOutlookValue(props);
  const upper = raw.toUpperCase();
  const cig = extractCigLevel(upper);

  if(type === "tornado"){
    if(cig === 3) return { rank: 3, label: "Highest tornado strength note" };
    if(cig === 2) return { rank: 2, label: "Stronger tornadoes possible" };
    if(cig === 1) return { rank: 1, label: "A stronger tornado is possible" };
    return { rank: 0, label: "No added tornado note" };
  }

  if(type === "hail"){
    if(cig === 2) return { rank: 2, label: "Very large hail possible" };
    if(cig === 1) return { rank: 1, label: "Large hail possible" };
    return { rank: 0, label: "No added hail note" };
  }

  if(type === "wind"){
    if(cig === 3) return { rank: 3, label: "Highest damaging wind note" };
    if(cig === 2) return { rank: 2, label: "Organized damaging wind possible" };
    if(cig === 1) return { rank: 1, label: "Damaging wind possible" };
    return { rank: 0, label: "No added wind note" };
  }

  return {
    rank: 0,
    label: "No added note"
  };
}

function readRawOutlookValue(props){
  const possibleKeys = [
    "LABEL", "label",
    "RISK", "risk",
    "CATEGORY", "category",
    "DN", "dn",
    "THRESHOLD", "threshold",
    "OUTLOOK", "outlook",
    "name", "Name",
    "CIG", "cig",
    "LEVEL", "level",
    "VALUE", "value"
  ];

  for(const key of possibleKeys){
    if(props[key] !== undefined && props[key] !== null && String(props[key]).trim() !== ""){
      return String(props[key]).trim();
    }
  }

  return "";
}

function extractCigLevel(text){
  const value = String(text || "").trim().toUpperCase();

  const cigMatch = value.match(/CIG\s*([123])/i);
  if(cigMatch){
    return Number(cigMatch[1]);
  }

  const levelMatch = value.match(/LEVEL\s*([123])/i);
  if(levelMatch){
    return Number(levelMatch[1]);
  }

  if(value === "1" || value === "2" || value === "3"){
    return Number(value);
  }

  return 0;
}

/* =========================
   ALERTS
========================= */

async function loadAlerts(){
  const container = document.getElementById("alerts");

  if(container){
    container.innerHTML = "";
  }

  warningLayer.clearLayers();
  stormTrackLayer.clearLayers();
  latestPanelAlerts = [];

  resetZones();
  resetStationMarkers();
  updateStationSummary();

  try{
    const res = await fetch("https://api.weather.gov/alerts/active", {
      headers: {
        Accept: "application/geo+json"
      }
    });

    if(!res.ok){
      throw new Error("NWS API failed: " + res.status);
    }

    const data = await res.json();

    setText("infoTime", formatTime24(new Date().toISOString()));

    const allAlerts = data.features
      .filter(isArkansasRelevantAlert)
      .sort(sortAlerts);

    latestAllArkansasAlerts = allAlerts;

    const panelAlerts = allAlerts
      .filter(isNwsLittleRockAlert)
      .sort(sortAlerts);

    latestPanelAlerts = panelAlerts;

    allAlerts.forEach(alert => {
      if(shouldDrawPolygon(alert)){
        warningLayer.addData(alert);
      }

      if(shouldDrawTrackForAlert(alert)){
        drawStormTrack(alert);
      }

      const detail = buildAlertDetail(alert);
      applyZoneStatus(detail.affectedStations, getSeverity(alert.properties || {}));
      highlightImpactedStations(detail.affectedStations);
    });

    updateStationSummary();

    if(container && !panelAlerts.length){
      container.innerHTML = `
        <div class="alert-box normal">
          <div class="alert-title">No LZK Watches or Warnings</div>
          <div class="alert-meta">No active tracked watches or warnings issued by NWS Little Rock.</div>
        </div>
      `;
    }

    if(container){
      panelAlerts.forEach(alert => {
        const p = alert.properties || {};
        const severity = getSeverity(p);
        const detail = buildAlertDetail(alert);

        container.insertAdjacentHTML("beforeend", `
          <div class="alert-box ${severity}" onclick='openDetailById("${alert.id}")'>
            <div class="alert-title">${formatTitle(p)}</div>
            <div class="alert-meta">
              <strong>Issued by:</strong> ${p.senderName || "NWS Little Rock"}<br>
              <strong>Expires:</strong> ${formatTime24(p.expires)}<br>
              <strong>Areas:</strong> ${formatAreas(p.areaDesc)}
            </div>
            <div class="station-hit">
              <div class="station-hit-title">Affected Stations</div>
              ${formatAffectedStations(detail.affectedStations)}
            </div>
          </div>
        `);
      });
    }

    maintainMapViewAfterRefresh();

  }catch(err){
    console.error(err);

    if(container){
      container.innerHTML = `
        <div class="alert-box tornado-warning">
          <div class="alert-title">Unable to load alerts</div>
          <div class="alert-meta">${err.message}</div>
        </div>
      `;
    }
  }
}

function isArkansasRelevantAlert(alert){
  const p = alert.properties || {};
  const event = p.event || "";
  const ugc = p.geocode?.UGC || [];
  const area = p.areaDesc || "";

  const isAR =
    ugc.some(code => String(code).startsWith("AR")) ||
    area.includes(", AR") ||
    area.includes(" AR;") ||
    area.endsWith(" AR");

  const tracked = [
    "Tornado Watch",
    "Severe Thunderstorm Watch",
    "Severe Thunderstorm Warning",
    "Tornado Warning",
    "Special Weather Statement"
  ].includes(event);

  return isAR && tracked;
}

function isNwsLittleRockAlert(alert){
  const p = alert.properties || {};
  const senderName = (p.senderName || "").toUpperCase();
  const sender = (p.sender || "").toUpperCase();
  const params = p.parameters || {};

  const awips = Array.isArray(params.AWIPSidentifier)
    ? params.AWIPSidentifier.join(" ").toUpperCase()
    : "";

  const wmo = Array.isArray(params.WMOidentifier)
    ? params.WMOidentifier.join(" ").toUpperCase()
    : "";

  const headline = Array.isArray(params.NWSheadline)
    ? params.NWSheadline.join(" ").toUpperCase()
    : "";

  return (
    senderName.includes("LITTLE ROCK") ||
    sender.includes("LZK") ||
    awips.includes("LZK") ||
    wmo.includes("KLZK") ||
    headline.includes("LITTLE ROCK")
  );
}

function shouldDrawPolygon(alert){
  const event = alert.properties?.event || "";
  const severity = getSeverity(alert.properties || {});

  return Boolean(alert.geometry) && (
    event === "Tornado Warning" ||
    event === "Severe Thunderstorm Warning" ||
    severity === "tornado-emergency"
  );
}

function getSeverity(p){
  const event = p.event || "";
  const text = `${p.headline || ""} ${p.description || ""} ${p.instruction || ""}`.toUpperCase();

  if(event === "Tornado Warning" && text.includes("TORNADO EMERGENCY")){
    return "tornado-emergency";
  }

  if(event === "Tornado Warning") return "tornado-warning";
  if(event === "Tornado Watch") return "tornado-watch";
  if(event === "Severe Thunderstorm Warning") return "tstorm-warning";
  if(event === "Severe Thunderstorm Watch") return "tstorm-watch";

  return "normal";
}

function formatTitle(p){
  const number = getAlertNumber(p);
  const severity = getSeverity(p);

  if(severity === "tornado-emergency"){
    return number ? `Tornado Emergency #${number}` : "Tornado Emergency";
  }

  return number ? `${p.event} #${number}` : (p.event || "Weather Alert");
}

function getAlertNumber(p){
  const vtec = Array.isArray(p.parameters?.VTEC) ? p.parameters.VTEC : [];

  for(const item of vtec){
    const raw = String(item).split(".")[6];

    if(raw && /^\d+$/.test(raw)){
      return String(Number(raw));
    }
  }

  const match = (p.headline || "").match(/(?:watch|warning)\s+(\d+)/i);
  return match ? match[1] : "";
}

/* =========================
   DETAIL BUILDING
========================= */

function buildAlertDetail(alert){
  const p = alert.properties || {};
  const motion = parseStormMotion(p);
  const origin = parseStormOrigin(alert, p);
  const affectedStations = [];
  const affectedTowns = [];
  const affectedPOI = [];
  const bulletin = extractImpactedAreasFromBulletin(p);
  const ugc = getAlertUgcCodes(p);

  if(alert.geometry){
    stations.forEach(station => {
      if(pointInsideAlert(alert, station)){
        affectedStations.push(station);
      }
    });

    locations.forEach(location => {
      if(pointInsideAlert(alert, location)){
        affectedPOI.push(location);
      }
    });

    bulletin.forEach(name => {
      const town = towns.find(t => normalizeName(t.name) === normalizeName(name));

      affectedTowns.push(town || {
        name,
        zone: [],
        impact: "Timing not available"
      });
    });

  }else{
    stations.forEach(station => {
      if(itemMatchesAlertUgc(station, ugc, p.areaDesc)){
        affectedStations.push(station);
      }
    });

    towns.forEach(town => {
      if(itemMatchesAlertUgc(town, ugc, p.areaDesc)){
        affectedTowns.push(town);
      }
    });

    locations.forEach(location => {
      if(areaLooksRelevantToPOI(p.areaDesc || "", location)){
        affectedPOI.push(location);
      }
    });
  }

  return {
    id: alert.id,
    title: formatTitle(p),
    event: p.event || "",
    severity: getSeverity(p),
    expires: p.expires,
    areaDesc: p.areaDesc || "",
    motion,
    stormOrigin: origin,
    affectedStations: dedupeByName(affectedStations).map(station => ({
      ...station,
      impact: estimateImpactTime(alert, station, motion, origin)
    })),
    affectedTowns: dedupeByName(affectedTowns).map(town => ({
      ...town,
      impact: town.lat !== undefined && town.lng !== undefined
        ? estimateImpactTime(alert, town, motion, origin)
        : (town.impact || "Timing not available")
    })),
    affectedPOI: dedupeByName(affectedPOI).map(location => ({
      ...location,
      impact: estimateImpactTime(alert, location, motion, origin)
    })),
    impactedAreas: bulletin,
    description: p.description || "",
    instruction: p.instruction || "",
    geometry: alert.geometry || null
  };
}

function openDetailById(id){
  const alert = latestPanelAlerts.find(item => item.id === id);
  if(alert){
    openDetail(buildAlertDetail(alert));
  }
}

function openDetail(detail){
  setText("detailTitle", detail.title);

  setHTML("detailMeta", `
    <strong>Expires:</strong> ${formatTime24(detail.expires)}<br>
    <strong>Motion:</strong> ${detail.motion ? `${detail.motion.direction} at ${detail.motion.speed} mph` : "Not available"}<br>
    <strong>Areas:</strong> ${formatAreas(detail.areaDesc)}
  `);

  const stationsHtml = formatCondensedAlphabetizedList(
    detail.affectedStations,
    station => `${station.name} <strong>(${station.impact})</strong>`,
    "No MEMS stations currently inside this alert area."
  );

  const areasHtml = formatCondensedAlphabetizedList(
    detail.affectedTowns,
    town => `${town.name} <strong>(${town.impact})</strong>`,
    "No impacted areas listed in the NWS bulletin."
  );

  const locationHtml = formatLocationsByType(detail.affectedPOI);

  setHTML("detailBody", `
    <div class="detail-section">
      <strong>Affected Stations</strong>
      <ul class="detail-list">${stationsHtml}</ul>
    </div>

    <div class="detail-section">
      <strong>Areas Impacted</strong>
      <ul class="detail-list">${areasHtml}</ul>
    </div>

    <div class="detail-section">
      <strong>Locations</strong>
      <ul class="detail-list">${locationHtml}</ul>
    </div>

    <div class="detail-section">
      <strong>Instruction</strong>
      <div>${detail.instruction || "No instruction included."}</div>
    </div>
  `);

  const overlay = document.getElementById("detailOverlay");
  if(overlay){
    overlay.style.display = "flex";
  }
}

function closeDetail(){
  const overlay = document.getElementById("detailOverlay");
  if(overlay){
    overlay.style.display = "none";
  }
}

window.closeDetail = closeDetail;

/* =========================
   ZONE DETAIL MODAL
========================= */

function openZoneDetail(zoneId){
  const profile = zoneProfiles[zoneId];

  if(!profile || !profile.center){
    return;
  }

  const zoneStations = stations.filter(station => {
    return Array.isArray(profile.stations) && profile.stations.includes(station.name);
  });

  const zonePoint = turf.point([profile.center[1], profile.center[0]]);

  const activeAlerts = latestAllArkansasAlerts.filter(alert => {
    const detail = buildAlertDetail(alert);
    return detail.affectedStations.some(station => profile.stations.includes(station.name));
  });

  const stationListHtml = zoneStations.length
    ? zoneStations.map(station => `<li>${station.name}</li>`).join("")
    : `<li>No stations assigned to this area.</li>`;

  const activeAlertsHtml = activeAlerts.length
    ? activeAlerts.map(alert => `
      <li>
        <strong>${formatTitle(alert.properties || {})}</strong>
        — Expires ${formatTime24(alert.properties?.expires)}
      </li>
    `).join("")
    : `<li>No current watches or warnings for this station group.</li>`;

  const outlook = getStormOutlook(zonePoint);

  setText("detailTitle", profile.title || zoneId);

  setHTML("detailMeta", `
    <strong>Station Radar View</strong><br>
    Local station group view centered on ${profile.title || zoneId}
  `);

  setHTML("detailBody", `
    <div class="detail-section">
      <strong>Station Radar View</strong>
      <div id="stationRadarMap" style="height:280px;margin-top:10px;border-radius:10px;overflow:hidden;"></div>
    </div>

    <div class="detail-section">
      <strong>Storm Outlook</strong>
      <div style="font-size:12px;opacity:.75;margin-top:4px;margin-bottom:8px;">
        Outlook shows the SPC forecast area. Notes explain how strong storms could be if they develop.
      </div>

      <ul class="detail-list">
        <li>
          <strong>Tornado</strong><br>
          Outlook: ${outlook.tornado.prob}<br>
          Note: ${outlook.tornado.note}
        </li>

        <li>
          <strong>Hail</strong><br>
          Outlook: ${outlook.hail.prob}<br>
          Note: ${outlook.hail.note}
        </li>

        <li>
          <strong>Wind</strong><br>
          Outlook: ${outlook.wind.prob}<br>
          Note: ${outlook.wind.note}
        </li>

        <li>
          <strong>Excessive Rain</strong><br>
          Outlook: ${outlook.excessiveRain}
        </li>
      </ul>
    </div>

    <div class="detail-section">
      <strong>Stations</strong>
      <ul class="detail-list">${stationListHtml}</ul>
    </div>

    <div class="detail-section">
      <strong>Current Watches and Warnings</strong>
      <ul class="detail-list">${activeAlertsHtml}</ul>
    </div>
  `);

  const overlay = document.getElementById("detailOverlay");
  if(overlay){
    overlay.style.display = "flex";
  }

  setTimeout(() => {
    buildStationRadarMap(profile, zoneStations);
  }, 100);
}

window.openZoneDetail = openZoneDetail;

function buildStationRadarMap(profile, zoneStations){
  const container = document.getElementById("stationRadarMap");
  if(!container) return;

  const mini = L.map("stationRadarMap", {
    zoomControl: true,
    attributionControl: false
  }).setView(profile.center, 9);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 20
  }).addTo(mini);

  latestAllArkansasAlerts.forEach(alert => {
    if(shouldDrawPolygon(alert)){
      L.geoJSON(alert, {
        style: {
          color: getSeverity(alert.properties || {}) === "tornado-warning" ? "#7e22ce" : "#f97316",
          weight: 3,
          fillOpacity: 0.25
        }
      }).addTo(mini);
    }
  });

  zoneStations.forEach(station => {
    L.circleMarker([station.lat, station.lng], {
      radius: 7,
      color: "#fff",
      weight: 2,
      fillColor: "#005bea",
      fillOpacity: 1
    })
    .bindPopup(`<strong>${station.name}</strong>`)
    .addTo(mini);
  });

  setTimeout(() => {
    mini.invalidateSize();
  }, 150);
}

/* =========================
   ALERT MATCHING
========================= */

function getAlertUgcCodes(p){
  return (p.geocode && Array.isArray(p.geocode.UGC) ? p.geocode.UGC : [])
    .map(code => String(code).toUpperCase());
}

function itemMatchesAlertUgc(item, codes, areaDesc){
  const itemCodes = Array.isArray(item.countyCodes)
    ? item.countyCodes.map(code => String(code).toUpperCase())
    : [];

  if(codes.length && itemCodes.length){
    return itemCodes.some(code => codes.includes(code));
  }

  const area = String(areaDesc || "").toLowerCase();

  if(itemCodes.includes("ARC119")) return area.includes("pulaski");
  if(itemCodes.includes("ARC085")) return area.includes("lonoke");
  if(itemCodes.includes("ARC053")) return area.includes("grant");

  return false;
}

function pointInsideAlert(alert, point){
  try{
    return Boolean(alert.geometry) && turf.booleanPointInPolygon(
      turf.point([point.lng, point.lat]),
      alert
    );
  }catch(err){
    return false;
  }
}

function areaLooksRelevantToPOI(area, location){
  const areaText = String(area || "").toLowerCase();
  const locationText = `${location.name || ""} ${location.area || ""}`.toLowerCase();

  if(locationText.includes("cabot") || locationText.includes("lonoke")) return areaText.includes("lonoke");
  if(locationText.includes("sheridan") || locationText.includes("grant")) return areaText.includes("grant");
  if(locationText.includes("benton") || locationText.includes("saline")) return areaText.includes("saline");

  return areaText.includes("pulaski");
}

/* =========================
   BULLETIN PARSING
========================= */

function extractImpactedAreasFromBulletin(p){
  const text = String(p.description || "").replace(/\r/g, "");
  const results = [];

  const patterns = [
    /Locations impacted include\.\.\.\s*([\s\S]*?)(?:\n\s*\n|PRECAUTIONARY\/PREPAREDNESS ACTIONS|HAZARD|SOURCE|IMPACT|This includes|&&|$)/i,
    /Other locations impacted by this severe thunderstorm include\.\.\.\s*([\s\S]*?)(?:\n\s*\n|PRECAUTIONARY\/PREPAREDNESS ACTIONS|HAZARD|SOURCE|IMPACT|This includes|&&|$)/i,
    /The tornado will be near\.\.\.\s*([\s\S]*?)(?:\n\s*\n|PRECAUTIONARY\/PREPAREDNESS ACTIONS|HAZARD|SOURCE|IMPACT|This includes|&&|$)/i
  ];

  patterns.forEach(pattern => {
    const match = text.match(pattern);

    if(match && match[1]){
      results.push(...splitBulletinPlaceList(match[1]));
    }
  });

  return [...new Set(results.map(cleanBulletinPlace).filter(Boolean))];
}

function splitBulletinPlaceList(block){
  return String(block || "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .split(/,|;|\band\b/i)
    .map(cleanBulletinPlace)
    .filter(Boolean);
}

function cleanBulletinPlace(value){
  return String(value || "")
    .replace(/\b(around|near|including|mainly|about|between|after|before)\b/ig, "")
    .replace(/\b\d{1,2}:\d{2}\s*(?:AM|PM)?\b/ig, "")
    .replace(/\b\d{1,2}\s*(?:AM|PM)\b/ig, "")
    .replace(/\b(by|at)\s*\d{1,2}\s*(?:AM|PM)?\b/ig, "")
    .replace(/\.$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* =========================
   STORM MOTION / IMPACT TIME
========================= */

function parseStormMotion(p){
  const params = p.parameters || {};
  const paramText = Object.keys(params)
    .map(key => Array.isArray(params[key]) ? params[key].join(" ") : String(params[key] || ""))
    .join(" ");

  const text = `${p.headline || ""} ${p.description || ""} ${p.instruction || ""} ${paramText}`;

  const match = text.match(/moving\s+([A-Z]{1,3}|north|south|east|west|northeast|northwest|southeast|southwest|north-northeast|east-northeast|east-southeast|south-southeast|south-southwest|west-southwest|west-northwest|north-northwest)\s+at\s+(\d+)\s*(mph|kt|kts|knots?)?/i);

  if(!match) return null;

  const direction = normalizeMotionDirection(match[1]);
  let speed = Number(match[2]);
  const unit = String(match[3] || "mph").toLowerCase();

  if(unit.startsWith("kt") || unit.startsWith("knot")){
    speed = Math.round(speed * 1.15078);
  }

  return {
    direction,
    speed,
    originalSpeed: Number(match[2]),
    unit
  };
}

function normalizeMotionDirection(value){
  const cleaned = String(value || "").toLowerCase().replace(/-/g, " ").trim();

  const words = {
    north: "N",
    south: "S",
    east: "E",
    west: "W",
    northeast: "NE",
    northwest: "NW",
    southeast: "SE",
    southwest: "SW",
    "north northeast": "NNE",
    "east northeast": "ENE",
    "east southeast": "ESE",
    "south southeast": "SSE",
    "south southwest": "SSW",
    "west southwest": "WSW",
    "west northwest": "WNW",
    "north northwest": "NNW"
  };

  return (words[cleaned] || cleaned.toUpperCase()).replace(/\s+/g, "");
}

function parseStormOrigin(alert, p){
  const text = `${p.description || ""} ${p.instruction || ""}`;

  const match = text.match(/located\s+(?:near|over|around|approximately\s+near|\d+\s+miles?\s+(?:north|south|east|west|northeast|northwest|southeast|southwest)\s+of)\s+([A-Za-z .'-]+?)(?:,|\.| moving| at )/i);

  if(match){
    const name = cleanBulletinPlace(match[1]);

    const known = [...towns, ...stations, ...locations].find(item => {
      return normalizeName(item.name) === normalizeName(name) ||
             normalizeName(item.area) === normalizeName(name);
    });

    if(known){
      return {
        lat: known.lat,
        lng: known.lng,
        label: known.name
      };
    }
  }

  if(alert.geometry){
    try{
      const center = turf.centroid(alert).geometry.coordinates;

      return {
        lng: center[0],
        lat: center[1],
        label: "warning polygon center"
      };
    }catch(err){}
  }

  return null;
}

function estimateImpactTime(alert, point, motion, origin){
  if(!motion || !motion.speed || !origin || point.lat === undefined || point.lng === undefined){
    return "Timing not available";
  }

  try{
    const bearing = directionToBearing(motion.direction);
    if(bearing === null) return "Timing not available";

    const originPoint = turf.point([origin.lng, origin.lat]);
    const target = turf.point([point.lng, point.lat]);
    const distance = turf.distance(originPoint, target, { units: "miles" });
    const bearingToTarget = turf.bearing(originPoint, target);

    const delta = Math.abs((((bearingToTarget - bearing) + 540) % 360) - 180);

    if(delta > 75){
      return "Near path, timing uncertain";
    }

    const minutes = Math.round(distance / motion.speed * 60);

    if(minutes <= 0) return "Now";
    if(minutes > 180) return "3+ hr";

    return `~${minutes} min / ${formatTime24(new Date(Date.now() + minutes * 60000).toISOString())}`;

  }catch(err){
    return "Timing not available";
  }
}

/* =========================
   ZONES / STATIONS
========================= */

function applyZoneStatus(stationsHit, severity){
  const zones = new Set();

  stationsHit.forEach(station => {
    (station.zone || []).forEach(zone => zones.add(zone));
  });

  zones.forEach(zoneName => {
    const element = document.querySelector(`[data-zone="${zoneName}"]`);

    if(element){
      setZoneSeverity(element, severity);
    }
  });
}

function setZoneSeverity(element, severity){
  const rank = {
    normal: 0,
    "tstorm-watch": 1,
    "tstorm-warning": 2,
    "tornado-watch": 3,
    "tornado-warning": 4,
    "tornado-emergency": 5
  };

  const current = Array.from(element.classList).find(className => rank[className] !== undefined) || "normal";

  if(rank[severity] >= rank[current]){
    element.className = `zone ${severity}`;
  }
}

function highlightImpactedStations(list){
  list.forEach(station => {
    impactedStationNames.add(station.name);

    const marker = document.getElementById(`marker-${slug(station.name)}`);
    if(marker){
      marker.classList.add("impacted");
    }
  });
}

function resetStationMarkers(){
  impactedStationNames = new Set();
  document.querySelectorAll(".station-marker").forEach(marker => {
    marker.classList.remove("impacted");
  });
}

function resetZones(){
  document.querySelectorAll(".zone").forEach(zone => {
    zone.className = "zone normal";
  });
}

function openStationList(){
  setText("detailTitle", "MEMS Stations");
  setHTML("detailMeta", `<strong>${stations.length}</strong> tracked stations / posts`);

  setHTML("detailBody", `
    <div class="detail-section">
      <ul class="detail-list">
        ${stations.map(station => `
          <li>
            <strong>${station.name}</strong> — ${station.area || ""}
            ${impactedStationNames.has(station.name) ? " — <strong>IMPACTED</strong>" : ""}
          </li>
        `).join("")}
      </ul>
    </div>
  `);

  const overlay = document.getElementById("detailOverlay");
  if(overlay){
    overlay.style.display = "flex";
  }
}

window.openStationList = openStationList;

/* =========================
   STORM TRACKS
========================= */

function setTrackWindow(minutes){
  TRACK_WINDOW_MINUTES = Number(minutes) || 60;

  document.querySelectorAll("[data-track-minutes]").forEach(button => {
    button.classList.toggle("active", Number(button.dataset.trackMinutes) === TRACK_WINDOW_MINUTES);
  });

  redrawStormTracks();
}

window.setTrackWindow = setTrackWindow;

function redrawStormTracks(){
  stormTrackLayer.clearLayers();

  latestAllArkansasAlerts.forEach(alert => {
    if(shouldDrawTrackForAlert(alert)){
      drawStormTrack(alert);
    }
  });

  latestCustomStormTracks.forEach(drawCustomStormTrack);
}

async function loadCustomStormTracks(){
  try{
    const res = await fetch("storm-tracks.json", {
      cache: "no-store"
    });

    if(!res.ok){
      latestCustomStormTracks = [];
      redrawStormTracks();
      return;
    }

    const data = await res.json();

    latestCustomStormTracks = Array.isArray(data)
      ? data
      : (Array.isArray(data.tracks) ? data.tracks : []);

    redrawStormTracks();

  }catch(err){
    latestCustomStormTracks = [];
  }
}

function shouldDrawTrackForAlert(alert){
  const event = alert.properties?.event || "";

  return Boolean(alert.geometry) && [
    "Tornado Warning",
    "Severe Thunderstorm Warning",
    "Special Weather Statement",
    "Marine Weather Statement"
  ].includes(event);
}

function drawStormTrack(alert){
  const p = alert.properties || {};
  const motion = parseStormMotion(p);
  const origin = parseStormOrigin(alert, p);

  if(!motion || !motion.speed || !origin) return;

  const bearing = directionToBearing(motion.direction);
  if(bearing === null) return;

  const id = slug(alert.id || `${p.event}-${origin.label}-${p.sent || Date.now()}`);
  const originPoint = turf.point([origin.lng, origin.lat]);
  const minutes = buildTrackMinutes();
  const points = minutes.map(minute => projectPointFromOrigin(originPoint, motion.speed, bearing, minute));
  const showLabels = activeTrackId === id;
  const group = L.layerGroup().addTo(stormTrackLayer);

  L.polyline(points, {
    color: "#050505",
    weight: 4,
    opacity: 0.85,
    interactive: false
  }).addTo(group);

  const line = L.polyline(points, {
    color: "#fff",
    weight: 1.5,
    opacity: 0.98,
    className: "storm-track-line"
  })
  .bindPopup(`
    <strong>${formatTitle(p)}</strong><br>
    <strong>Motion:</strong> ${motion.direction} at ${motion.speed} mph<br>
    <strong>Origin:</strong> ${origin.label}<br>
    <strong>Track timing:</strong> ${buildTrackTimingText(originPoint, motion.speed, bearing)}
  `)
  .addTo(group);

  line.on("click", () => {
    activeTrackId = activeTrackId === id ? null : id;
    redrawStormTracks();

    if(activeTrackId === id){
      line.openPopup();
    }
  });

  L.marker(points[0], {
    icon: L.divIcon({
      className: "",
      html: `<div class="track-origin"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    })
  })
  .bindPopup(`<strong>Storm location</strong><br>${origin.label}<br>${motion.direction} at ${motion.speed} mph`)
  .addTo(group)
  .on("click", () => {
    activeTrackId = activeTrackId === id ? null : id;
    redrawStormTracks();
  });

  minutes.slice(1).forEach((minute, index) => {
    const eta = formatTime24(new Date(Date.now() + minute * 60000).toISOString());
    const point = points[index + 1];

    L.marker(point, {
      icon: L.divIcon({
        className: "",
        html: `<div class="track-step" style="transform:rotate(${bearing + 90}deg)"></div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      }),
      interactive: false
    }).addTo(group);

    L.marker(point, {
      icon: L.divIcon({
        className: "",
        html: `<div class="track-label ${showLabels ? "visible" : ""}">${eta}</div>`,
        iconSize: [42, 14],
        iconAnchor: [21, -4]
      }),
      interactive: false
    }).addTo(group);
  });
}

function drawCustomStormTrack(track){
  if(!track || track.lat === undefined || track.lng === undefined) return;

  const motion = {
    direction: normalizeMotionDirection(track.direction || "E"),
    speed: Number(track.speed || track.speedMph || 25)
  };

  const origin = {
    lat: Number(track.lat),
    lng: Number(track.lng),
    label: track.name || "Unwarned Storm"
  };

  const fakeAlert = {
    id: track.id || track.name || Math.random(),
    properties: {
      event: track.name || "Unwarned Storm",
      description: `located near ${origin.label}, moving ${motion.direction} at ${motion.speed} mph`
    },
    geometry: {
      type: "Point",
      coordinates: [origin.lng, origin.lat]
    }
  };

  drawStormTrack(fakeAlert);
}

function buildTrackMinutes(){
  return [0, 15, 30, 45, 60].filter(minute => minute === 0 || minute <= TRACK_WINDOW_MINUTES);
}

function directionToBearing(direction){
  const bearings = {
    N: 0,
    NNE: 22.5,
    NE: 45,
    ENE: 67.5,
    E: 90,
    ESE: 112.5,
    SE: 135,
    SSE: 157.5,
    S: 180,
    SSW: 202.5,
    SW: 225,
    WSW: 247.5,
    W: 270,
    WNW: 292.5,
    NW: 315,
    NNW: 337.5
  };

  return bearings[String(direction || "").toUpperCase()] ?? null;
}

function projectPointFromOrigin(point, speed, bearing, minutes){
  const miles = speed * (minutes / 60);
  const projected = turf.destination(point, miles, bearing, { units: "miles" }).geometry.coordinates;

  return [projected[1], projected[0]];
}

function buildTrackTimingText(originPoint, speed, bearing){
  return buildTrackMinutes()
    .slice(1)
    .map(minute => `${minute} min ${formatTime24(new Date(Date.now() + minute * 60000).toISOString())}`)
    .join(" • ");
}

/* =========================
   FORMAT HELPERS
========================= */

function formatAffectedStations(list){
  return list.length
    ? list.map(station => `<span class="station-list-line">${station.name} — ${station.impact}</span>`).join("")
    : `<span class="station-list-line">No MEMS stations currently inside this alert area.</span>`;
}

function formatCondensedAlphabetizedList(items, render, empty){
  return items.length
    ? [...items]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(item => `<li>${render(item)}</li>`)
      .join("")
    : `<li>${empty}</li>`;
}

function formatLocationsByType(list){
  if(!list.length){
    return "<li>No locations currently inside this alert area.</li>";
  }

  const groups = {};

  list.forEach(location => {
    const type = location.type || "Other";

    if(!groups[type]){
      groups[type] = [];
    }

    groups[type].push(location);
  });

  return Object.keys(groups)
    .sort()
    .map(type => {
      const names = groups[type]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(location => `${location.name} <strong>(${location.impact})</strong>`)
        .join(", ");

      return `<li><strong>${type}:</strong> ${names}</li>`;
    })
    .join("");
}

function formatAreas(areaDesc){
  if(!areaDesc) return "None listed";

  const areas = areaDesc
    .split(";")
    .map(area => area.trim())
    .filter(Boolean);

  return areas.length <= 8
    ? areas.join(", ")
    : areas.slice(0, 8).join(", ") + `, +${areas.length - 8} more`;
}

function formatTime24(value){
  if(!value) return "N/A";

  return new Date(value).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function sortAlerts(a, b){
  const rank = {
    "tornado-emergency": 5,
    "tornado-warning": 4,
    "tornado-watch": 3,
    "tstorm-warning": 2,
    "tstorm-watch": 1,
    normal: 0
  };

  return rank[getSeverity(b.properties || {})] - rank[getSeverity(a.properties || {})];
}

function slug(value){
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function normalizeName(value){
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function dedupeByName(items){
  const seen = new Set();

  return items.filter(item => {
    const key = normalizeName(item.name);

    if(!key || seen.has(key)){
      return false;
    }

    seen.add(key);
    return true;
  });
}

function cToF(c){
  return c == null ? "--" : Math.round(c * 9 / 5 + 32);
}

function msToMph(ms){
  return ms == null ? "--" : Math.round(ms * 2.23694);
}

function mmToIn(mm){
  return mm == null ? "--" : (mm / 25.4).toFixed(2);
}

function safeRound(value){
  return value == null ? "--" : Math.round(value);
}

function degToCompass(deg){
  if(deg == null) return "--";

  const directions = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];

  return directions[Math.round(deg / 22.5) % 16];
}

function setText(id, value){
  const el = document.getElementById(id);
  if(el){
    el.textContent = value;
  }
}

function setHTML(id, value){
  const el = document.getElementById(id);
  if(el){
    el.innerHTML = value;
  }
}

/* =========================
   REFRESH / SUMMARY
========================= */

function updateStationSummary(){
  setText("stationOnlineCount", stations.length);
  setText("stationImpactedCount", impactedStationNames.size);
  setText("poiCount", locations.length);
}

function maintainMapViewAfterRefresh(){
  if(Date.now() - lastUserMapActivity < USER_ACTIVITY_HOLD_MS){
    return;
  }

  map.setView(AR_CENTER, AR_ZOOM, {
    animate: false
  });
}

function updateRefreshCountdown(){
  secondsUntilRefresh--;

  if(secondsUntilRefresh <= 0){
    secondsUntilRefresh = REFRESH_SECONDS;
    loadAlerts();
    loadCustomStormTracks();
  }

  setText("refreshCountdown", secondsUntilRefresh + "s");
}

/* =========================
   STARTUP
========================= */

updateStationSummary();
loadServiceArea();
loadLzkArea();
loadAlerts();
loadTempestConditions();
loadOutlookData();
loadCustomStormTracks();

setInterval(loadOutlookData, 10 * 60 * 1000);
setInterval(updateRefreshCountdown, 1000);
setInterval(loadTempestConditions, 60000);
setInterval(loadCustomStormTracks, 60000);

window.addEventListener("load", () => {
  setTimeout(() => {
    map.invalidateSize();
  }, 150);
});
