import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { parse } from "csv-parse/sync";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || "*";

app.use(cors({
  origin: ALLOWED_ORIGINS === "*"
    ? true
    : ALLOWED_ORIGINS.split(",").map(x => x.trim()),
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

const GEOAPIFY_KEY = process.env.GEOAPIFY_KEY || "";
const ORS_KEY = process.env.ORS_KEY || "";
const AEMET_KEY = process.env.AEMET_KEY || "";

const BDE_API_BASE = process.env.BDE_API_BASE || "https://app.bde.es/asb_www/es";
const BDE_EURIBOR_SERIES = process.env.BDE_EURIBOR_SERIES || "";

const INE_RENTA_TABLE = process.env.INE_RENTA_TABLE || "30896";
const MARKET_PRICE_API_URL = process.env.MARKET_PRICE_API_URL || "";
const CATASTRO_PROXY_URL = process.env.CATASTRO_PROXY_URL || "";

const cache = new Map();

function ok(data = {}) {
  return {
    ok: true,
    consulta_realizada: new Date().toISOString(),
    ...data
  };
}

function fail(message, extra = {}) {
  return {
    ok: false,
    consulta_realizada: new Date().toISOString(),
    error: message,
    ...extra
  };
}

function cleanText(v = "") {
  return String(v)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function toNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(",", ".").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function cached(key, ttlMs, fn) {
  const now = Date.now();
  const item = cache.get(key);
  if (item && now - item.t < ttlMs) return item.v;
  const v = await fn();
  cache.set(key, { t: now, v });
  return v;
}

async function getJson(url, options = {}, timeout = 18000) {
  const res = await axios.get(url, {
    timeout,
    responseType: "json",
    validateStatus: () => true,
    ...options
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}`);
  }

  return res.data;
}

async function getText(url, options = {}, timeout = 18000) {
  const res = await axios.get(url, {
    timeout,
    responseType: "text",
    validateStatus: () => true,
    ...options
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}`);
  }

  return res.data;
}

function requireQuery(res, value, name) {
  if (!value) {
    res.status(400).json(fail(`Falta el parámetro obligatorio: ${name}`));
    return false;
  }
  return true;
}

async function geocodeAddress(address) {
  if (!address) throw new Error("Dirección no indicada");

  if (GEOAPIFY_KEY) {
    const url = "https://api.geoapify.com/v1/geocode/search";
    const data = await getJson(url, {
      params: {
        text: address,
        lang: "es",
        limit: 1,
        apiKey: GEOAPIFY_KEY
      }
    });

    const f = data?.features?.[0];
    if (!f) throw new Error("No se pudo geocodificar la dirección");

    return {
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      label: f.properties.formatted || address,
      municipio: f.properties.city || f.properties.town || f.properties.village || f.properties.county || "",
      provincia: f.properties.county || f.properties.state || "",
      comunidad: f.properties.state || "",
      source: "Geoapify"
    };
  }

  const url = "https://nominatim.openstreetmap.org/search";
  const data = await getJson(url, {
    params: {
      q: address,
      format: "json",
      limit: 1,
      addressdetails: 1
    },
    headers: {
      "User-Agent": "InmoRecursos/1.0 contacto@inmorecursos.com"
    }
  });

  const f = data?.[0];
  if (!f) throw new Error("No se pudo geocodificar la dirección");

  return {
    lat: Number(f.lat),
    lon: Number(f.lon),
    label: f.display_name || address,
    municipio: f.address?.city || f.address?.town || f.address?.village || "",
    provincia: f.address?.county || f.address?.state || "",
    comunidad: f.address?.state || "",
    source: "OpenStreetMap Nominatim"
  };
}

async function getGeoapifyPlaces(lat, lon, radius = 500) {
  if (!GEOAPIFY_KEY) {
    return {
      ok: false,
      resumen: {},
      items: [],
      advertencia: "Geoapify no configurado"
    };
  }

  const categories = [
    "commercial.supermarket",
    "healthcare.pharmacy",
    "healthcare.hospital",
    "healthcare.clinic_or_praxis",
    "education.school",
    "education.university",
    "public_transport",
    "leisure.park",
    "catering.restaurant",
    "service.financial.bank",
    "entertainment.culture.library",
    "parking"
  ].join(",");

  const data = await getJson("https://api.geoapify.com/v2/places", {
    params: {
      categories,
      filter: `circle:${lon},${lat},${radius}`,
      bias: `proximity:${lon},${lat}`,
      limit: 60,
      lang: "es",
      apiKey: GEOAPIFY_KEY
    }
  });

  const items = (data.features || []).map(f => ({
    nombre: f.properties.name || "Servicio sin nombre",
    tipo: f.properties.categories?.[0] || "",
    direccion: f.properties.formatted || "",
    distancia_m: f.properties.distance ?? null,
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0]
  }));

  const resumen = {};
  for (const item of items) {
    const k = item.tipo.split(".")[0] || "otros";
    resumen[k] = (resumen[k] || 0) + 1;
  }

  return {
    ok: true,
    resumen,
    items
  };
}

async function getOpenMeteoAir(lat, lon) {
  const vars = [
    "pm10",
    "pm2_5",
    "carbon_monoxide",
    "nitrogen_dioxide",
    "sulphur_dioxide",
    "ozone",
    "european_aqi"
  ].join(",");

  const data = await getJson("https://air-quality-api.open-meteo.com/v1/air-quality", {
    params: {
      latitude: lat,
      longitude: lon,
      hourly: vars,
      timezone: "Europe/Madrid"
    }
  });

  const h = data.hourly || {};
  const idx = 0;

  return {
    pm10: h.pm10?.[idx] ?? null,
    pm2_5: h.pm2_5?.[idx] ?? null,
    co: h.carbon_monoxide?.[idx] ?? null,
    no2: h.nitrogen_dioxide?.[idx] ?? null,
    so2: h.sulphur_dioxide?.[idx] ?? null,
    ozono: h.ozone?.[idx] ?? null,
    aqi_europeo: h.european_aqi?.[idx] ?? null,
    fuente: "Open-Meteo Air Quality"
  };
}

async function getOpenMeteoWeather(lat, lon) {
  const data = await getJson("https://api.open-meteo.com/v1/forecast", {
    params: {
      latitude: lat,
      longitude: lon,
      current: "temperature_2m,relative_humidity_2m,wind_speed_10m,uv_index",
      timezone: "Europe/Madrid"
    }
  });

  const c = data.current || {};

  return {
    temperatura: c.temperature_2m ?? null,
    humedad_relativa: c.relative_humidity_2m ?? null,
    viento: c.wind_speed_10m ?? null,
    uv_index: c.uv_index ?? null,
    fuente: "Open-Meteo Forecast"
  };
}

async function getAemetUvFallback() {
  if (!AEMET_KEY) return null;

  try {
    const first = await getJson(
      "https://opendata.aemet.es/opendata/api/prediccion/especifica/uvi/0/",
      { headers: { api_key: AEMET_KEY } },
      12000
    );

    if (!first?.datos) return null;

    const data = await getJson(first.datos, {}, 12000);

    return {
      datos: data,
      fuente: "AEMET OpenData UVI"
    };
  } catch {
    return null;
  }
}

function scoreAir(air = {}) {
  let score = 100;

  const pm25 = toNumber(air.pm2_5);
  const pm10 = toNumber(air.pm10);
  const no2 = toNumber(air.no2);
  const ozone = toNumber(air.ozono);
  const aqi = toNumber(air.aqi_europeo);

  if (pm25 !== null) score -= pm25 > 25 ? 28 : pm25 > 10 ? 12 : 0;
  if (pm10 !== null) score -= pm10 > 40 ? 20 : pm10 > 20 ? 8 : 0;
  if (no2 !== null) score -= no2 > 40 ? 20 : no2 > 20 ? 8 : 0;
  if (ozone !== null) score -= ozone > 120 ? 14 : ozone > 100 ? 6 : 0;
  if (aqi !== null) score -= aqi > 50 ? 20 : aqi > 20 ? 8 : 0;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreServices(resumen = {}) {
  const total = Object.values(resumen).reduce((a, b) => a + Number(b || 0), 0);
  if (total >= 15) return 90;
  if (total >= 10) return 75;
  if (total >= 5) return 55;
  if (total >= 2) return 35;
  return 20;
}

app.get("/", (_, res) => {
  res.json(ok({
    service: "InmoRecursos · Backend puntos de control",
    endpoints: [
      "/health",
      "/api/geocode",
      "/api/entorno",
      "/api/euribor",
      "/api/renta",
      "/api/compra/mercado",
      "/api/catastro",
      "/api/ruta"
    ]
  }));
});

app.get("/health", (_, res) => {
  res.json(ok({
    status: "running",
    configured: {
      geoapify: Boolean(GEOAPIFY_KEY),
      openRouteService: Boolean(ORS_KEY),
      aemet: Boolean(AEMET_KEY),
      bancoEspanaSerieEuribor: Boolean(BDE_EURIBOR_SERIES),
      marketPriceApi: Boolean(MARKET_PRICE_API_URL),
      catastroProxy: Boolean(CATASTRO_PROXY_URL)
    }
  }));
});

app.get("/api/geocode", async (req, res) => {
  const direccion = req.query.direccion || req.query.address;
  if (!requireQuery(res, direccion, "direccion")) return;

  try {
    const geo = await cached(
      `geo:${direccion}`,
      1000 * 60 * 60 * 24,
      () => geocodeAddress(direccion)
    );

    res.json(ok({ geocoding: geo }));
  } catch (err) {
    res.status(502).json(fail("No se pudo geocodificar la dirección", {
      detalle: err.message
    }));
  }
});

app.get("/api/entorno", async (req, res) => {
  const direccion = req.query.direccion || req.query.address;
  const radio = Number(req.query.radio || 500);

  if (!requireQuery(res, direccion, "direccion")) return;

  try {
    const result = await cached(
      `entorno:${direccion}:${radio}`,
      1000 * 60 * 60,
      async () => {
        const geo = await geocodeAddress(direccion);

        const [airResult, weatherResult, placesResult, aemetUv] = await Promise.allSettled([
          getOpenMeteoAir(geo.lat, geo.lon),
          getOpenMeteoWeather(geo.lat, geo.lon),
          getGeoapifyPlaces(geo.lat, geo.lon, radio),
          getAemetUvFallback()
        ]);

        const aire = airResult.status === "fulfilled" ? airResult.value : {};
        const meteo = weatherResult.status === "fulfilled" ? weatherResult.value : {};
        const places = placesResult.status === "fulfilled"
          ? placesResult.value
          : { ok: false, resumen: {}, items: [], advertencia: "Servicios no disponibles" };

        const airScore = scoreAir(aire);
        const serviceScore = scoreServices(places.resumen);
        const puntuacion = Math.round((airScore * 0.55) + (serviceScore * 0.45));

        const advertencias = [];
        if (airResult.status !== "fulfilled") advertencias.push("Calidad del aire no disponible.");
        if (weatherResult.status !== "fulfilled") advertencias.push("Meteorología no disponible.");
        if (placesResult.status !== "fulfilled") advertencias.push("Servicios cercanos no disponibles.");
        if (!GEOAPIFY_KEY) advertencias.push("Geoapify no configurado; no se pueden consultar servicios cercanos.");
        if (!AEMET_KEY) advertencias.push("AEMET no configurado; se usa Open-Meteo para datos ambientales disponibles.");

        return {
          direccion_solicitada: direccion,
          direccion_localizada: geo.label,
          lat: geo.lat,
          lon: geo.lon,
          municipio: geo.municipio,
          provincia: geo.provincia,
          comunidad: geo.comunidad,
          radio_m: radio,
          geocodificacion_fuente: geo.source,
          aire,
          meteo: {
            ...meteo,
            uv_aemet: aemetUv.status === "fulfilled" ? aemetUv.value : null
          },
          servicios_resumen: places.resumen,
          servicios_con_direccion: places.items,
          lectura_entorno: {
            puntuacion_aire: airScore,
            puntuacion_servicios: serviceScore,
            puntuacion_global: puntuacion,
            lectura: puntuacion >= 70 ? "Entorno favorable" : puntuacion >= 45 ? "Entorno funcional" : "Entorno condicionante"
          },
          advertencias
        };
      }
    );

    res.json(ok(result));
  } catch (err) {
    res.status(502).json(fail("No se pudo obtener el entorno", {
      detalle: err.message
    }));
  }
});

app.get("/api/euribor", async (_, res) => {
  try {
    if (!BDE_EURIBOR_SERIES) {
      return res.json(ok({
        financiero: {
          euribor: null,
          fuente: "Banco de España no configurado"
        },
        advertencias: [
          "Falta BDE_EURIBOR_SERIES. Configure el código de serie oficial del Banco de España para devolver el último dato real."
        ]
      }));
    }

    const data = await cached(
      `bde:euribor:${BDE_EURIBOR_SERIES}`,
      1000 * 60 * 60 * 12,
      async () => {
        const url = `${BDE_API_BASE}/api/series/${encodeURIComponent(BDE_EURIBOR_SERIES)}/ultimo`;
        return getJson(url, {}, 20000);
      }
    );

    const raw = Array.isArray(data) ? data[0] : data;
    const valor =
      toNumber(raw?.valor) ??
      toNumber(raw?.value) ??
      toNumber(raw?.ultimoDato?.valor) ??
      toNumber(raw?.observaciones?.[0]?.valor);

    const fecha =
      raw?.fecha ??
      raw?.date ??
      raw?.ultimoDato?.fecha ??
      raw?.observaciones?.[0]?.fecha ??
      null;

    res.json(ok({
      financiero: {
        euribor: {
          valor,
          fecha,
          serie: BDE_EURIBOR_SERIES
        },
        fuente: "Banco de España"
      },
      bruto: data
    }));
  } catch (err) {
    res.status(502).json(fail("No se pudo consultar Banco de España", {
      detalle: err.message
    }));
  }
});

app.get("/api/renta", async (req, res) => {
  const direccion = req.query.direccion || req.query.address;
  if (!requireQuery(res, direccion, "direccion")) return;

  try {
    const data = await cached(
      `renta:${direccion}:${INE_RENTA_TABLE}`,
      1000 * 60 * 60 * 24,
      async () => {
        const geo = await geocodeAddress(direccion);

        const url = `https://servicios.ine.es/wstempus/js/ES/DATOS_TABLA/${INE_RENTA_TABLE}`;
        const tabla = await getJson(url, {
          params: { nult: 1 }
        }, 25000);

        const muni = cleanText(geo.municipio);
        const encontrados = [];

        for (const serie of Array.isArray(tabla) ? tabla : []) {
          const nombre = cleanText([
            serie.Nombre,
            serie.Metadata?.map(m => m.Nombre).join(" "),
            serie.MetaData?.map(m => m.Nombre).join(" ")
          ].filter(Boolean).join(" "));

          if (!muni || nombre.includes(muni)) {
            const dato = serie.Data?.[0] || serie.Datos?.[0] || null;
            encontrados.push({
              nombre: serie.Nombre || "",
              valor: toNumber(dato?.Valor),
              fecha: dato?.Fecha || dato?.Anyo || null
            });
          }
        }

        return {
          direccion_solicitada: direccion,
          direccion_localizada: geo.label,
          municipio: geo.municipio,
          provincia: geo.provincia,
          comunidad: geo.comunidad,
          fuente: `INE WSTempus DATOS_TABLA ${INE_RENTA_TABLE}`,
          resultados: encontrados.slice(0, 20),
          advertencias: encontrados.length
            ? []
            : ["No se han encontrado series filtradas por municipio. El backend devuelve dato no disponible."]
        };
      }
    );

    res.json(ok({ renta: data }));
  } catch (err) {
    res.status(502).json(fail("No se pudo consultar INE", {
      detalle: err.message
    }));
  }
});

app.get("/api/compra/mercado", async (req, res) => {
  const direccion = req.query.direccion || "";
  const superficie = toNumber(req.query.superficie);
  const precio = toNumber(req.query.precio);

  if (!requireQuery(res, direccion, "direccion")) return;

  try {
    const geo = await geocodeAddress(direccion);

    if (!MARKET_PRICE_API_URL) {
      return res.json(ok({
        mercado: {
          direccion_solicitada: direccion,
          direccion_localizada: geo.label,
          municipio: geo.municipio,
          provincia: geo.provincia,
          precio_compra: precio,
          superficie,
          precio_m2_compra: precio && superficie ? precio / superficie : null,
          precio_m2_referencia: null,
          ventas_realizadas: null,
          liquidez: null,
          fuente: "Mercado no configurado"
        },
        advertencias: [
          "No hay MARKET_PRICE_API_URL configurado. No se inventa precio de mercado, ventas ni precio/m² de referencia."
        ]
      }));
    }

    const external = await getJson(MARKET_PRICE_API_URL, {
      params: {
        direccion,
        municipio: geo.municipio,
        provincia: geo.provincia,
        superficie,
        precio
      }
    }, 25000);

    const ref = toNumber(
      external.precio_m2_referencia ??
      external.precio_m2 ??
      external.media_m2
    );

    const desviacion = precio && superficie && ref
      ? ((precio / superficie) - ref) / ref * 100
      : null;

    res.json(ok({
      mercado: {
        direccion_solicitada: direccion,
        direccion_localizada: geo.label,
        municipio: geo.municipio,
        provincia: geo.provincia,
        precio_compra: precio,
        superficie,
        precio_m2_compra: precio && superficie ? precio / superficie : null,
        precio_m2_referencia: ref,
        desviacion_pct: desviacion,
        ventas_realizadas: external.ventas_realizadas ?? external.operaciones ?? null,
        liquidez: external.liquidez ?? null,
        fuente: external.fuente || "Fuente externa configurada",
        bruto: external
      }
    }));
  } catch (err) {
    res.status(502).json(fail("No se pudo consultar mercado", {
      detalle: err.message
    }));
  }
});

app.get("/api/catastro", async (req, res) => {
  const rc = req.query.rc || req.query.referenciaCatastral;

  if (!requireQuery(res, rc, "rc")) return;

  try {
    if (!CATASTRO_PROXY_URL) {
      return res.json(ok({
        catastro: {
          referencia_catastral: rc,
          datos: null,
          fuente: "Catastro no configurado"
        },
        advertencias: [
          "No hay CATASTRO_PROXY_URL configurado. No se inventan superficie, uso ni antigüedad."
        ]
      }));
    }

    const data = await getJson(CATASTRO_PROXY_URL, {
      params: { rc }
    }, 25000);

    res.json(ok({
      catastro: {
        referencia_catastral: rc,
        fuente: data.fuente || "Proxy Catastro configurado",
        datos: data
      }
    }));
  } catch (err) {
    res.status(502).json(fail("No se pudo consultar Catastro", {
      detalle: err.message
    }));
  }
});

app.get("/api/ruta", async (req, res) => {
  const origen = req.query.origen;
  const destino = req.query.destino;
  const profile = req.query.profile || "driving-car";

  if (!requireQuery(res, origen, "origen")) return;
  if (!requireQuery(res, destino, "destino")) return;

  try {
    if (!ORS_KEY) {
      return res.json(ok({
        ruta: null,
        advertencias: [
          "OpenRouteService no configurado. No se inventan tiempos ni distancias."
        ]
      }));
    }

    const [o, d] = await Promise.all([
      geocodeAddress(origen),
      geocodeAddress(destino)
    ]);

    const data = await getJson(
      `https://api.openrouteservice.org/v2/directions/${profile}`,
      {
        params: {
          api_key: ORS_KEY,
          start: `${o.lon},${o.lat}`,
          end: `${d.lon},${d.lat}`
        }
      },
      25000
    );

    const summary = data.features?.[0]?.properties?.summary || {};

    res.json(ok({
      ruta: {
        origen: o,
        destino: d,
        perfil: profile,
        distancia_m: summary.distance ?? null,
        duracion_s: summary.duration ?? null,
        fuente: "OpenRouteService"
      }
    }));
  } catch (err) {
    res.status(502).json(fail("No se pudo calcular ruta", {
      detalle: err.message
    }));
  }
});

app.post("/api/ctr", (req, res) => {
  const b = req.body || {};

  const componentes = {
    cuota_hipoteca: toNumber(b.cuota) || 0,
    ibi: toNumber(b.ibi) || 0,
    comunidad: toNumber(b.comunidad) || 0,
    seguro: toNumber(b.seguro) || 0,
    suministros: toNumber(b.suministros) || 0,
    mantenimiento: toNumber(b.mantenimiento) || 0,
    transporte: toNumber(b.transporte) || 0
  };

  const mensual = Object.values(componentes).reduce((a, v) => a + v, 0);
  const anos = toNumber(b.anos) || 30;

  const advertencias = [];
  if (!componentes.transporte) advertencias.push("Transporte no incluido.");
  if (!componentes.mantenimiento) advertencias.push("Mantenimiento no incluido.");

  res.json(ok({
    ctr: {
      componentes,
      ctr_mensual: mensual,
      ctr_anual: mensual * 12,
      ctr_total_periodo: mensual * 12 * anos,
      advertencias
    }
  }));
});

app.use((req, res) => {
  res.status(404).json(fail("Endpoint no encontrado"));
});

app.listen(PORT, () => {
  console.log(`InmoRecursos backend escuchando en puerto ${PORT}`);
});
