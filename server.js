const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const GEOAPIFY_KEY = process.env.GEOAPIFY_KEY;
const AEMET_KEY = process.env.AEMET_KEY;

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

function normalizarTexto(v = "") {
  return String(v)
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
  cache.set(key, {
    time: Date.now(),
    value
  });
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

  cacheSet(cacheKey, text);
  return text;
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);

  if (text.trim().startsWith("<")) {
    throw new Error(`La fuente ha devuelto HTML y no JSON: ${text.slice(0, 180)}`);
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON no válido recibido desde: ${url}`);
  }
}

function cargarMunicipiosLocales() {
  const filePath = path.join(__dirname, "municipios.json");

  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function resolveCodigoINELocal(municipio, provincia, advertencias = []) {
  const municipios = cargarMunicipiosLocales();

  if (!municipios.length) {
    advertencias.push("No existe municipios.json o está vacío. No se puede resolver código INE municipal.");
    return null;
  }

  const munNorm = normalizarTexto(municipio || "");
  const provNorm = normalizarTexto(provincia || "");

  let encontrados = municipios.filter((m) =>
    normalizarTexto(m.municipio) === munNorm
  );

  if (!encontrados.length) {
    encontrados = municipios.filter((m) =>
      normalizarTexto(m.municipio).includes(munNorm) ||
      munNorm.includes(normalizarTexto(m.municipio))
    );
  }

  if (provNorm && encontrados.length > 1) {
    encontrados = encontrados.filter((m) =>
      normalizarTexto(m.provincia) === provNorm ||
      normalizarTexto(m.provincia).includes(provNorm) ||
      provNorm.includes(normalizarTexto(m.provincia))
    );
  }

  if (!encontrados.length) {
    advertencias.push(
      `No se ha encontrado código INE local para "${municipio || "municipio no identificado"}". Añada ese municipio a municipios.json.`
    );
    return null;
  }

  if (encontrados.length > 1) {
    advertencias.push(`Se han encontrado varios códigos INE para "${municipio}". Se usa el primero.`);
  }

  return encontrados[0].codigo_ine || null;
}

async function geocodeAddress(direccion) {
  if (!GEOAPIFY_KEY) {
    throw new Error("Falta GEOAPIFY_KEY en Render.");
  }

  const url =
    `${GEOAPIFY_GEOCODE}?text=${encodeURIComponent(direccion)}` +
    `&filter=countrycode:es&limit=1&apiKey=${GEOAPIFY_KEY}`;

  const data = await fetchJson(url);
  const f = data.features?.[0];

  if (!f) {
    throw new Error("No se ha podido geolocalizar la dirección.");
  }

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

async function ineTable(tableId, nult = 1) {
  const url = `${INE.base}/DATOS_TABLA/${tableId}?nult=${nult}&tip=A`;
  return await fetchJson(url);
}

function latestValue(series) {
  const data = Array.isArray(series?.Data) ? series.Data : [];

  if (!data.length) {
    return {
      valor: null,
      fecha: null
    };
  }

  const sorted = [...data].sort((a, b) => Number(b.Fecha || 0) - Number(a.Fecha || 0));
  const first = sorted[0];

  return {
    valor: first?.Valor ?? null,
    fecha: first?.Fecha ?? null
  };
}

function findSeriesByText(seriesList, requiredTerms = [], excludedTerms = []) {
  const req = requiredTerms.map(normalizarTexto).filter(Boolean);
  const exc = excludedTerms.map(normalizarTexto).filter(Boolean);

  return (seriesList || []).filter((s) => {
    const name = normalizarTexto(s.Nombre || "");
    return req.every((t) => name.includes(t)) && !exc.some((t) => name.includes(t));
  });
}

function pickValue(seriesList, requiredTerms = [], excludedTerms = []) {
  const series = findSeriesByText(seriesList, requiredTerms, excludedTerms);

  if (!series.length) {
    return {
      valor: null,
      fecha: null
    };
  }

  return latestValue(series[0]);
}

function filterSeriesByGeo(seriesList, codigoIne, municipio, provincia) {
  const mun = normalizarTexto(municipio || "");
  const prov = normalizarTexto(provincia || "");
  const code = String(codigoIne || "");

  return (seriesList || []).filter((s) => {
    const name = normalizarTexto(s.Nombre || "");

    return (
      (code && name.includes(code)) ||
      (mun && name.includes(mun)) ||
      (prov && name.includes(prov))
    );
  });
}

async function getRentaINE(ctx, advertencias) {
  try {
    const tabla = await ineTable(INE.tablas.renta, 1);
    const geoSeries = filterSeriesByGeo(tabla, ctx.codigo_ine, ctx.municipio, ctx.provincia);

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
      nivel_dato: "municipio si la tabla devuelve coincidencia territorial"
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

async function getPoblacionINE(ctx, advertencias) {
  try {
    const tabla = await ineTable(INE.tablas.poblacion, 1);
    const geoSeries = filterSeriesByGeo(tabla, ctx.codigo_ine, ctx.municipio, ctx.provincia);

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
      nivel_dato: "municipio si la tabla devuelve coincidencia territorial"
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

async function getEducacionINE(ctx, advertencias) {
  try {
    const tabla = await ineTable(INE.tablas.educacion, 1);
    const geoSeries = filterSeriesByGeo(tabla, ctx.codigo_ine, ctx.municipio, ctx.provincia);

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
      nivel_dato: "municipio si la tabla devuelve coincidencia territorial"
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

async function getActividadINE(ctx, advertencias) {
  try {
    const tabla = await ineTable(INE.tablas.actividad, 1);
    const geoSeries = filterSeriesByGeo(tabla, ctx.codigo_ine, ctx.municipio, ctx.provincia);

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
      nivel_dato: "municipio si la tabla devuelve coincidencia territorial"
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

async function getCompraventasINE(ctx, advertencias) {
  try {
    const tabla = await ineTable(INE.tablas.compraventas, 1);
    const geoSeries = filterSeriesByGeo(tabla, null, null, ctx.provincia);

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

    const [air, uv] = await Promise.all([
      fetchJson(airUrl),
      fetchJson(uvUrl)
    ]);

    const firstValid = (arr) =>
      Array.isArray(arr)
        ? arr.find((v) => v !== null && v !== undefined) ?? null
        : null;

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

    if (!meta.datos) {
      throw new Error("AEMET no devolvió URL de datos.");
    }

    return await fetchJson(meta.datos);
  } catch (e) {
    advertencias.push("No se pudo consultar AEMET UVI: " + e.message);
    return null;
  }
}

async function getPlaces(lat, lon, radio, advertencias) {
  if (!GEOAPIFY_KEY) {
    throw new Error("Falta GEOAPIFY_KEY.");
  }

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

  if (anos === null) {
    advertencias.push("Total de periodo no calculado: falta plazo real en años.");
  }

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

  if (!direccion) {
    return res.status(400).json({
      ok: false,
      error: "Falta direccion."
    });
  }

  const advertencias = [];

  try {
    const geo = await geocodeAddress(direccion);
    const codigo_ine = resolveCodigoINELocal(geo.municipio, geo.provincia, advertencias);

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
        {
          nombre: "INE - Relación local municipios.json",
          nivel: "municipio"
        },
        {
          nombre: "INE - DATOS_TABLA 30896",
          contenido: "renta",
          nivel: "según disponibilidad"
        },
        {
          nombre: "INE - DATOS_TABLA 68532",
          contenido: "población",
          nivel: "según disponibilidad"
        },
        {
          nombre: "INE - DATOS_TABLA 66620",
          contenido: "educación",
          nivel: "según disponibilidad"
        },
        {
          nombre: "INE - DATOS_TABLA 67079",
          contenido: "actividad",
          nivel: "según disponibilidad"
        },
        {
          nombre: "INE - DATOS_TABLA 6150",
          contenido: "compraventas",
          nivel: "provincia"
        }
      ],
      advertencias
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "Error en /demografia.",
      detalle: e.message
    });
  }
});

app.get("/entorno", async (req, res) => {
  const direccion = req.query.direccion;
  const radio = Number(req.query.radio || 500);
  const advertencias = [];

  if (!direccion) {
    return res.status(400).json({
      ok: false,
      error: "Falta direccion."
    });
  }

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
    res.status(500).json({
      ok: false,
      error: "Error en /entorno.",
      detalle: e.message
    });
  }
});

app.post("/ctr", (req, res) => {
  try {
    const ctr = calcularCTR(req.body || {});

    res.json({
      ok: true,
      ctr
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "Error en /ctr.",
      detalle: e.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor funcionando en puerto ${PORT}`);
});
