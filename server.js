const express = require("express");
const cors = require("cors");
const XLSX = require("xlsx");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const GEOAPIFY_KEY = process.env.GEOAPIFY_KEY;
const AEMET_KEY = process.env.AEMET_KEY;
const OPENROUTESERVICE_KEY = process.env.OPENROUTESERVICE_KEY;

const CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const cache = new Map();

const INE = {
  base: "https://servicios.ine.es/wstempus/js/ES",
  tablas: {
    renta: 30896,
    poblacion: 68532,
    educacion: 66620,
    actividad: 67079,
    compraventas: 6150
  }
};

const GEOAPIFY_GEOCODE = "https://api.geoapify.com/v1/geocode/search";
const GEOAPIFY_PLACES = "https://api.geoapify.com/v2/places";
const OPEN_METEO_AIR = "https://air-quality-api.open-meteo.com/v1/air-quality";
const OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast";

function normalizeText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’'`´]/g, "")
    .replace(/[,.;:()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function cacheSet(key, value) {
  cache.set(key, { time: Date.now(), value });
}

async function fetchBuffer(url) {
  const cached = cacheGet("buffer:" + url);
  if (cached) return cached;

  const res = await fetch(url, {
    headers: { "User-Agent": "InmoRecursos/1.0" }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} al descargar ${url}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  cacheSet("buffer:" + url, buffer);
  return buffer;
}

async function fetchText(url, options = {}) {
  const cacheKey = "text:" + url + JSON.stringify(options.body || "");
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const res = await fetch(url, {
    ...options,
    headers: {
      "User-Agent": "InmoRecursos/1.0",
      ...(options.headers || {})
    }
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`);
  }

  if (text.trim().startsWith("<")) {
    throw new Error(`La fuente ha devuelto HTML y no JSON: ${text.slice(0, 180)}`);
  }

  cacheSet(cacheKey, text);
  return text;
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON no válido desde ${url}`);
  }
}

function latestValue(series) {
  const data = Array.isArray(series?.Data) ? series.Data : [];
  if (!data.length) return { valor: null, fecha: null };

  const sorted = [...data].sort((a, b) => Number(b.Fecha || 0) - Number(a.Fecha || 0));
  const first = sorted[0];

  return {
    valor: first?.Valor ?? null,
    fecha: first?.Fecha ?? null
  };
}

function findSeriesByText(seriesList, requiredTerms = [], excludedTerms = []) {
  const req = requiredTerms.map(normalizeText).filter(Boolean);
  const exc = excludedTerms.map(normalizeText).filter(Boolean);

  return (seriesList || []).filter((s) => {
    const name = normalizeText(s.Nombre || "");
    return req.every((t) => name.includes(t)) && !exc.some((t) => name.includes(t));
  });
}

function pickValue(seriesList, requiredTerms, excludedTerms = []) {
  const series = findSeriesByText(seriesList, requiredTerms, excludedTerms);
  if (!series.length) return { valor: null, fecha: null };
  return latestValue(series[0]);
}

async function geocodeAddress(direccion) {
  if (!GEOAPIFY_KEY) throw new Error("Falta GEOAPIFY_KEY en Render.");

  const url =
    `${GEOAPIFY_GEOCODE}?text=${encodeURIComponent(direccion)}` +
    `&filter=countrycode:es&limit=1&apiKey=${GEOAPIFY_KEY}`;

  const data = await fetchJson(url);
  const f = data.features?.[0];

  if (!f) throw new Error("No se ha podido geolocalizar la dirección.");

  const p = f.properties || {};

  return {
    direccion_localizada: p.formatted || direccion,
    municipio: p.city || p.town || p.village || p.municipality || null,
    provincia: p.county || p.state_district || null,
    comunidad: p.state || null,
    lat: p.lat,
    lon: p.lon
  };
}

/**
 * Descarga oficial de códigos INE.
 * El INE cambia cada año la ruta codmunXX/XXcodmun.xls(x).
 * Se prueban años recientes y extensiones habituales. Si no se consigue,
 * el endpoint devuelve codigo_ine=null y una advertencia, no inventa nada.
 */
async function loadMunicipiosINE() {
  const cached = cacheGet("municipios_ine");
  if (cached) return cached;

  const currentYear = new Date().getFullYear();
  const yyList = [];
  for (let y = currentYear; y >= currentYear - 8; y--) yyList.push(String(y).slice(-2));

  const candidates = [];
  yyList.forEach((yy) => {
    candidates.push(`https://www.ine.es/daco/daco42/codmun/codmun${yy}/${yy}codmun.xlsx`);
    candidates.push(`https://www.ine.es/daco/daco42/codmun/codmun${yy}/${yy}codmun.xls`);
  });

  let lastError = null;

  for (const url of candidates) {
    try {
      const buffer = await fetchBuffer(url);
      const wb = XLSX.read(buffer, { type: "buffer" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      const parsed = rows
        .map((r) => {
          const keys = Object.keys(r);
          const cproKey = keys.find((k) => normalizeText(k).includes("cpro") || normalizeText(k).includes("provincia"));
          const cmunKey = keys.find((k) => normalizeText(k).includes("cmun") || normalizeText(k).includes("municipio"));
          const nombreKey = keys.find((k) => normalizeText(k).includes("nombre") || normalizeText(k).includes("denominacion"));

          const cpro = cproKey ? String(r[cproKey]).padStart(2, "0") : null;
          const cmun = cmunKey ? String(r[cmunKey]).padStart(3, "0").slice(0, 3) : null;
          const nombre = nombreKey ? String(r[nombreKey]) : null;

          if (!cpro || !cmun || !nombre) return null;

          return {
            cpro,
            cmun,
            codigo_ine: cpro + cmun,
            nombre,
            nombre_norm: normalizeText(nombre)
          };
        })
        .filter(Boolean);

      if (parsed.length > 7000) {
        cacheSet("municipios_ine", parsed);
        return parsed;
      }
    } catch (e) {
      lastError = e;
    }
  }

  throw new Error("No se pudo descargar la relación oficial de municipios INE. " + (lastError?.message || ""));
}

async function resolveCodigoINE(municipio, provincia, advertencias) {
  if (!municipio) {
    advertencias.push("No se puede resolver código INE municipal porque no se ha identificado municipio.");
    return null;
  }

  try {
    const list = await loadMunicipiosINE();
    const municipioNorm = normalizeText(municipio);
    const provinciaNorm = normalizeText(provincia || "");

    let matches = list.filter((m) => m.nombre_norm === municipioNorm);

    if (!matches.length) {
      matches = list.filter((m) => m.nombre_norm.includes(municipioNorm) || municipioNorm.includes(m.nombre_norm));
    }

    if (matches.length > 1 && provinciaNorm) {
      const provMap = await loadProvinciasINE().catch(() => null);
      if (provMap) {
        matches = matches.filter((m) => normalizeText(provMap[m.cpro] || "") === provinciaNorm);
      }
    }

    if (!matches.length) {
      advertencias.push(`No se ha encontrado código INE para el municipio "${municipio}".`);
      return null;
    }

    if (matches.length > 1) {
      advertencias.push(`Hay varios municipios compatibles con "${municipio}". Se devuelve el primero encontrado.`);
    }

    return matches[0].codigo_ine;
  } catch (e) {
    advertencias.push("No se pudo resolver código INE municipal: " + e.message);
    return null;
  }
}

async function loadProvinciasINE() {
  const cached = cacheGet("provincias_ine");
  if (cached) return cached;

  const html = await fetchText("https://www.ine.es/daco/daco42/codmun/cod_provincia.htm");
  const map = {};
  const regex = /<td[^>]*>\s*(\d{2})\s*<\/td>\s*<td[^>]*>\s*([^<]+)\s*<\/td>/gi;
  let m;
  while ((m = regex.exec(html))) {
    map[m[1]] = m[2].trim();
  }

  cacheSet("provincias_ine", map);
  return map;
}

async function ineTable(tableId, nult = 1) {
  const url = `${INE.base}/DATOS_TABLA/${tableId}?nult=${nult}&tip=A`;
  return await fetchJson(url);
}

function filterSeriesByGeo(seriesList, codigoIne, municipio, provincia) {
  const mun = normalizeText(municipio || "");
  const prov = normalizeText(provincia || "");
  const code = String(codigoIne || "");

  return (seriesList || []).filter((s) => {
    const name = normalizeText(s.Nombre || "");
    return (
      (code && name.includes(code)) ||
      (mun && name.includes(mun)) ||
      (prov && name.includes(prov))
    );
  });
}

async function getRentaINE({ codigo_ine, municipio, provincia }, advertencias) {
  try {
    const tabla = await ineTable(INE.tablas.renta, 1);
    const geoSeries = filterSeriesByGeo(tabla, codigo_ine, municipio, provincia);

    const mediaPersona = pickValue(geoSeries, ["renta", "media", "persona"]);
    const mediaHogar = pickValue(geoSeries, ["renta", "media", "hogar"]);
    const mediana = pickValue(geoSeries, ["renta", "mediana"]);
    const unidadConsumo = pickValue(geoSeries, ["unidad", "consumo"]);

    if (
      mediaPersona.valor === null &&
      mediaHogar.valor === null &&
      mediana.valor === null &&
      unidadConsumo.valor === null
    ) {
      advertencias.push("El INE no devolvió indicadores de renta coincidentes para el municipio localizado.");
    }

    return {
      renta_media_persona: mediaPersona.valor,
      renta_media_hogar: mediaHogar.valor,
      renta_mediana: mediana.valor,
      renta_unidad_consumo: unidadConsumo.valor,
      fecha: mediaPersona.fecha || mediaHogar.fecha || mediana.fecha || unidadConsumo.fecha,
      nivel_dato: "municipio si la tabla lo permite; si no, coincidencia territorial disponible"
    };
  } catch (e) {
    advertencias.push("No se pudo consultar renta INE: " + e.message);
    return {
      renta_media_persona: null,
      renta_media_hogar: null,
      renta_mediana: null,
      renta_unidad_consumo: null,
      fecha: null,
      nivel_dato: null
    };
  }
}

async function getPoblacionINE({ codigo_ine, municipio, provincia }, advertencias) {
  try {
    const tabla = await ineTable(INE.tablas.poblacion, 1);
    const geoSeries = filterSeriesByGeo(tabla, codigo_ine, municipio, provincia);

    const total = pickValue(geoSeries, ["total"], ["hombres", "mujeres"]);
    const hombres = pickValue(geoSeries, ["hombres"]);
    const mujeres = pickValue(geoSeries, ["mujeres"]);
    const extranjera = pickValue(geoSeries, ["extranjera"]);

    if (total.valor === null && hombres.valor === null && mujeres.valor === null) {
      advertencias.push("El INE no devolvió población municipal coincidente.");
    }

    return {
      poblacion_total: total.valor,
      hombres: hombres.valor,
      mujeres: mujeres.valor,
      poblacion_extranjera: extranjera.valor,
      edad_media: null,
      menores_18: null,
      mayores_65: null,
      fecha: total.fecha || hombres.fecha || mujeres.fecha || extranjera.fecha,
      nivel_dato: "municipio si la tabla lo permite; si no, coincidencia territorial disponible"
    };
  } catch (e) {
    advertencias.push("No se pudo consultar población INE: " + e.message);
    return {
      poblacion_total: null,
      hombres: null,
      mujeres: null,
      poblacion_extranjera: null,
      edad_media: null,
      menores_18: null,
      mayores_65: null,
      fecha: null,
      nivel_dato: null
    };
  }
}

async function getEducacionINE({ codigo_ine, municipio, provincia }, advertencias) {
  try {
    const tabla = await ineTable(INE.tablas.educacion, 1);
    const geoSeries = filterSeriesByGeo(tabla, codigo_ine, municipio, provincia);

    const superior = pickValue(geoSeries, ["superiores"]);
    const secundaria = pickValue(geoSeries, ["secundaria"]);
    const primaria = pickValue(geoSeries, ["primaria"]);

    if (superior.valor === null && secundaria.valor === null && primaria.valor === null) {
      advertencias.push("El INE no devolvió indicadores educativos coincidentes.");
    }

    return {
      estudios_superiores: superior.valor,
      estudios_secundarios: secundaria.valor,
      estudios_primarios: primaria.valor,
      fecha: superior.fecha || secundaria.fecha || primaria.fecha,
      nivel_dato: "municipio si la tabla lo permite; si no, coincidencia territorial disponible"
    };
  } catch (e) {
    advertencias.push("No se pudo consultar educación INE: " + e.message);
    return {
      estudios_superiores: null,
      estudios_secundarios: null,
      estudios_primarios: null,
      fecha: null,
      nivel_dato: null
    };
  }
}

async function getActividadINE({ codigo_ine, municipio, provincia }, advertencias) {
  try {
    const tabla = await ineTable(INE.tablas.actividad, 1);
    const geoSeries = filterSeriesByGeo(tabla, codigo_ine, municipio, provincia);

    const ocupados = pickValue(geoSeries, ["ocupad"]);
    const parados = pickValue(geoSeries, ["parad"]);
    const activos = pickValue(geoSeries, ["activ"]);

    if (ocupados.valor === null && parados.valor === null && activos.valor === null) {
      advertencias.push("El INE no devolvió indicadores de actividad coincidentes.");
    }

    return {
      poblacion_activa: activos.valor,
      ocupados: ocupados.valor,
      parados: parados.valor,
      fecha: activos.fecha || ocupados.fecha || parados.fecha,
      nivel_dato: "municipio si la tabla lo permite; si no, coincidencia territorial disponible"
    };
  } catch (e) {
    advertencias.push("No se pudo consultar actividad INE: " + e.message);
    return {
      poblacion_activa: null,
      ocupados: null,
      parados: null,
      fecha: null,
      nivel_dato: null
    };
  }
}

async function getCompraventasINE({ provincia }, advertencias) {
  try {
    const tabla = await ineTable(INE.tablas.compraventas, 1);
    const geoSeries = filterSeriesByGeo(tabla, null, null, provincia);

    const total = pickValue(geoSeries, ["total"]);
    const nueva = pickValue(geoSeries, ["nueva"]);
    const usada = pickValue(geoSeries, ["usada"]);

    if (total.valor === null && nueva.valor === null && usada.valor === null) {
      advertencias.push("El INE no devolvió compraventas provinciales coincidentes.");
    }

    return {
      compraventas_total: total.valor,
      compraventas_vivienda_nueva: nueva.valor,
      compraventas_vivienda_usada: usada.valor,
      fecha: total.fecha || nueva.fecha || usada.fecha,
      nivel_dato: "provincia"
    };
  } catch (e) {
    advertencias.push("No se pudo consultar compraventas INE: " + e.message);
    return {
      compraventas_total: null,
      compraventas_vivienda_nueva: null,
      compraventas_vivienda_usada: null,
      fecha: null,
      nivel_dato: null
    };
  }
}

async function getAirAndUV(lat, lon, advertencias) {
  try {
    const airUrl =
      `${OPEN_METEO_AIR}?latitude=${lat}&longitude=${lon}` +
      `&hourly=pm2_5,pm10,nitrogen_dioxide,ozone,carbon_monoxide,sulphur_dioxide,european_aqi` +
      `&forecast_days=1&timezone=auto`;

    const uvUrl =
      `${OPEN_METEO_FORECAST}?latitude=${lat}&longitude=${lon}` +
      `&daily=uv_index_max,uv_index_clear_sky_max&current=temperature_2m,relative_humidity_2m,wind_speed_10m&timezone=auto`;

    const [air, uv] = await Promise.all([fetchJson(airUrl), fetchJson(uvUrl)]);

    const firstValid = (arr) => Array.isArray(arr) ? arr.find((v) => v !== null && v !== undefined) ?? null : null;

    return {
      aire: {
        pm2_5: firstValid(air.hourly?.pm2_5),
        pm10: firstValid(air.hourly?.pm10),
        no2: firstValid(air.hourly?.nitrogen_dioxide),
        ozono: firstValid(air.hourly?.ozone),
        co: firstValid(air.hourly?.carbon_monoxide),
        so2: firstValid(air.hourly?.sulphur_dioxide),
        aqi_europeo: firstValid(air.hourly?.european_aqi)
      },
      radiacion: {
        uv_index: uv.daily?.uv_index_max?.[0] ?? null,
        uv_index_cielo_despejado: uv.daily?.uv_index_clear_sky_max?.[0] ?? null
      },
      meteo: {
        temperatura: uv.current?.temperature_2m ?? null,
        humedad_relativa: uv.current?.relative_humidity_2m ?? null,
        viento: uv.current?.wind_speed_10m ?? null
      }
    };
  } catch (e) {
    advertencias.push("No se pudo consultar Open-Meteo: " + e.message);
    return {
      aire: {},
      radiacion: {},
      meteo: {}
    };
  }
}

async function getAemetUvi(advertencias) {
  if (!AEMET_KEY) {
    advertencias.push("AEMET_KEY no configurada. No se consulta AEMET.");
    return null;
  }

  try {
    const url = `https://opendata.aemet.es/opendata/api/prediccion/especifica/uvi/0/?api_key=${AEMET_KEY}`;
    const meta = await fetchJson(url);
    if (!meta.datos) throw new Error("AEMET no devolvió URL de datos.");
    return await fetchJson(meta.datos);
  } catch (e) {
    advertencias.push("No se pudo consultar AEMET UVI: " + e.message);
    return null;
  }
}

async function getPlaces(lat, lon, radio, advertencias) {
  if (!GEOAPIFY_KEY) throw new Error("Falta GEOAPIFY_KEY.");

  try {
    const categories = [
      "commercial.supermarket",
      "healthcare.pharmacy",
      "education.school",
      "healthcare.hospital",
      "healthcare.clinic_or_praxis",
      "leisure.park",
      "public_transport",
      "catering.restaurant"
    ].join(",");

    const url =
      `${GEOAPIFY_PLACES}?categories=${encodeURIComponent(categories)}` +
      `&filter=circle:${lon},${lat},${radio}` +
      `&bias=proximity:${lon},${lat}` +
      `&limit=80&apiKey=${GEOAPIFY_KEY}`;

    const data = await fetchJson(url);

    const servicios = (data.features || []).map((f) => {
      const p = f.properties || {};
      return {
        nombre: p.name || p.address_line1 || null,
        tipo: Array.isArray(p.categories) ? p.categories[0] : null,
        direccion: p.formatted || null,
        distancia_m: p.distance ?? null,
        tiene_direccion: Boolean(p.formatted)
      };
    });

    const resumen = {};
    servicios.forEach((s) => {
      const key = s.tipo ? s.tipo.split(".")[0] : "servicio";
      resumen[key] = (resumen[key] || 0) + 1;
    });

    return {
      servicios_resumen: resumen,
      servicios_con_direccion: servicios.filter((s) => s.tiene_direccion),
      servicios_sin_direccion: servicios.filter((s) => !s.tiene_direccion).length,
      servicios
    };
  } catch (e) {
    advertencias.push("No se pudieron consultar servicios Geoapify: " + e.message);
    return {
      servicios_resumen: {},
      servicios_con_direccion: [],
      servicios_sin_direccion: null,
      servicios: []
    };
  }
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function calcularCTR(body) {
  const advertencias = [];
  const componentes = {
    cuota: parseOptionalNumber(body.cuota),
    ibi: parseOptionalNumber(body.ibi),
    comunidad: parseOptionalNumber(body.comunidad),
    seguro: parseOptionalNumber(body.seguro),
    suministros: parseOptionalNumber(body.suministros),
    mantenimiento: parseOptionalNumber(body.mantenimiento),
    transporte: parseOptionalNumber(body.transporte)
  };

  let mensual = 0;
  Object.entries(componentes).forEach(([k, v]) => {
    if (v === null) {
      advertencias.push(`${k} no incluido: no se ha introducido dato real.`);
    } else {
      mensual += v;
    }
  });

  const anos = parseOptionalNumber(body.anos);
  const anual = mensual * 12;
  const total_periodo = anos !== null ? anual * anos : null;

  if (anos === null) advertencias.push("Total de periodo no calculado: falta plazo real en años.");

  return {
    ctr_mensual: mensual,
    ctr_anual: anual,
    ctr_total_periodo: total_periodo,
    componentes,
    advertencias,
    criterio: "Sólo se suman datos introducidos por el usuario o calculados de forma trazable. No se usan estimaciones automáticas."
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    servicio: "InmoRecursos backend real",
    endpoints: [
      "/demografia?direccion=",
      "/entorno?direccion=&radio=500",
      "POST /ctr"
    ]
  });
});

app.get("/demografia", async (req, res) => {
  const direccion = req.query.direccion;
  if (!direccion) return res.status(400).json({ ok: false, error: "Falta direccion." });

  const advertencias = [];

  try {
    const geo = await geocodeAddress(direccion);
    const codigo_ine = await resolveCodigoINE(geo.municipio, geo.provincia, advertencias);

    const ctx = {
      codigo_ine,
      municipio: geo.municipio,
      provincia: geo.provincia
    };

    const [renta, poblacion, educacion, actividad, mercado] = await Promise.all([
      getRentaINE(ctx, advertencias),
      getPoblacionINE(ctx, advertencias),
      getEducacionINE(ctx, advertencias),
      getActividadINE(ctx, advertencias),
      getCompraventasINE(ctx, advertencias)
    ]);

    res.json({
      ok: true,
      direccion_solicitada: direccion,
      direccion_localizada: geo.direccion_localizada,
      nivel_dato: "municipio/provincia según disponibilidad de tabla",
      municipio: geo.municipio,
      provincia: geo.provincia,
      comunidad: geo.comunidad,
      lat: geo.lat,
      lon: geo.lon,
      codigo_ine,
      renta,
      poblacion,
      vivienda: {
        hogares: null,
        tamano_medio_hogar: null,
        viviendas_principales: null,
        viviendas_secundarias: null,
        viviendas_vacias: null,
        regimen_tenencia: null,
        nivel_dato: null,
        advertencia: "No se devuelve dato de vivienda si no se integra una tabla INE específica y verificable."
      },
      mercado,
      educacion,
      actividad,
      fuentes: [
        { nombre: "INE - Relación de municipios y códigos", nivel: "municipio" },
        { nombre: "INE - DATOS_TABLA 30896", contenido: "renta", nivel: "según disponibilidad" },
        { nombre: "INE - DATOS_TABLA 68532", contenido: "población", nivel: "según disponibilidad" },
        { nombre: "INE - DATOS_TABLA 66620", contenido: "educación", nivel: "según disponibilidad" },
        { nombre: "INE - DATOS_TABLA 67079", contenido: "actividad", nivel: "según disponibilidad" },
        { nombre: "INE - DATOS_TABLA 6150", contenido: "compraventas", nivel: "provincia" }
      ],
      advertencias
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Error en /demografia.", detalle: e.message });
  }
});

app.get("/entorno", async (req, res) => {
  const direccion = req.query.direccion;
  const radio = Number(req.query.radio || 500);
  const advertencias = [];

  if (!direccion) return res.status(400).json({ ok: false, error: "Falta direccion." });

  try {
    const geo = await geocodeAddress(direccion);

    const [ambiente, places, aemetUvi] = await Promise.all([
      getAirAndUV(geo.lat, geo.lon, advertencias),
      getPlaces(geo.lat, geo.lon, radio, advertencias),
      getAemetUvi(advertencias)
    ]);

    res.json({
      ok: true,
      direccion_solicitada: direccion,
      direccion_localizada: geo.direccion_localizada,
      radio_m: radio,
      municipio: geo.municipio,
      provincia: geo.provincia,
      comunidad: geo.comunidad,
      lat: geo.lat,
      lon: geo.lon,
      ...ambiente,
      ...places,
      aemet_uvi_raw: aemetUvi,
      fuente: {
        geocoding: "Geoapify",
        aire_uv_meteo: "Open-Meteo y AEMET si está disponible",
        servicios: "Geoapify Places"
      },
      advertencias
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Error en /entorno.", detalle: e.message });
  }
});

app.post("/ctr", (req, res) => {
  try {
    const ctr = calcularCTR(req.body || {});
    res.json({ ok: true, ctr });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Error en /ctr.", detalle: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor funcionando en puerto ${PORT}`);
});
