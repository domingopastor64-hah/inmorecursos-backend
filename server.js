import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "2mb" }));

const CONFIG = {
  BDE_EURIBOR_CSV_URL:
    process.env.BDE_EURIBOR_CSV_URL ||
    "https://www.bde.es/webbe/es/estadisticas/compartido/datos/csv/ti_1_7.csv",

  BDE_TIPO_MEDIO_CSV_URL:
    process.env.BDE_TIPO_MEDIO_CSV_URL || "",

  AEMET_API_KEY:
    process.env.AEMET_API_KEY || "",

  GEOAPIFY_KEY:
    process.env.GEOAPIFY_KEY || "",

  INE_RENTA_TABLE_ID:
    process.env.INE_RENTA_TABLE_ID || "30896"
};

function noCache(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "Surrogate-Control": "no-store"
  });
}

function ok(res, data) {
  noCache(res);
  res.json({
    ok: true,
    consulta_realizada: new Date().toISOString(),
    ...data
  });
}

function fail(res, status, message, detail = null) {
  noCache(res);
  res.status(status).json({
    ok: false,
    consulta_realizada: new Date().toISOString(),
    error: message,
    detalle: detail
  });
}

function parseNumberES(value) {
  if (value === null || value === undefined) return null;
  const clean = String(value)
    .trim()
    .replace(/\./g, "")
    .replace(",", ".")
    .replace("%", "");

  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

function parseCsvLine(line, delimiter) {
  const out = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      out.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  out.push(current.trim());
  return out.map(x => x.replace(/^"|"$/g, ""));
}

function parseCsv(text) {
  const clean = text.replace(/\r/g, "");
  const lines = clean.split("\n").filter(x => x.trim() !== "");
  const sample = lines.slice(0, 10).join("\n");

  const semis = (sample.match(/;/g) || []).length;
  const commas = (sample.match(/,/g) || []).length;
  const delimiter = semis >= commas ? ";" : ",";

  return lines.map(line => parseCsvLine(line, delimiter));
}

function parseAnyDate(value) {
  if (!value) return null;
  const raw = String(value).trim();

  let m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));

  m = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));

  m = raw.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));

  m = raw.match(/^(\d{1,2})[-/](\d{4})$/);
  if (m) return new Date(Date.UTC(Number(m[2]), Number(m[1]) - 1, 1));

  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoDate(d) {
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

async function fetchText(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const finalUrl = url.includes("?")
      ? `${url}&_t=${Date.now()}`
      : `${url}?_t=${Date.now()}`;

    const res = await fetch(finalUrl, {
      signal: controller.signal,
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "User-Agent": "InmoRecursos/1.0"
      }
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 180)}`);
    }

    return text;
  } finally {
    clearTimeout(id);
  }
}

async function fetchJson(url, timeoutMs = 15000, headers = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const finalUrl = url.includes("?")
      ? `${url}&_t=${Date.now()}`
      : `${url}?_t=${Date.now()}`;

    const res = await fetch(finalUrl, {
      signal: controller.signal,
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "User-Agent": "InmoRecursos/1.0",
        ...headers
      }
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 180)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error("La respuesta no es JSON válido.");
    }
  } finally {
    clearTimeout(id);
  }
}

function latestBdeValueFromCsv(csvText, keywords = []) {
  const rows = parseCsv(csvText);
  if (!rows.length) throw new Error("CSV vacío.");

  const normalizedKeywords = keywords.map(k => k.toLowerCase());

  let selectedColumn = -1;

  const scanRows = rows.slice(0, Math.min(12, rows.length));
  for (const row of scanRows) {
    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] || "").toLowerCase();
      if (normalizedKeywords.every(k => cell.includes(k))) {
        selectedColumn = c;
        break;
      }
    }
    if (selectedColumn >= 0) break;
  }

  if (selectedColumn < 0) {
    throw new Error(`No se encontró columna con: ${keywords.join(", ")}`);
  }

  const candidates = [];

  for (const row of rows) {
    const date = parseAnyDate(row[0]);
    const value = parseNumberES(row[selectedColumn]);

    if (date && value !== null) {
      candidates.push({
        fecha: isoDate(date),
        valor: value
      });
    }
  }

  candidates.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

  if (!candidates.length) {
    throw new Error("No se encontraron valores fechados válidos en el CSV.");
  }

  return candidates[0];
}

async function obtenerUltimoEuriborOficial() {
  const csv = await fetchText(CONFIG.BDE_EURIBOR_CSV_URL);

  let dato;
  try {
    dato = latestBdeValueFromCsv(csv, ["euríbor", "1 año"]);
  } catch {
    dato = latestBdeValueFromCsv(csv, ["euribor", "1 año"]);
  }

  return {
    descripcion: "Euríbor a un año",
    valor: dato.valor,
    fecha: dato.fecha,
    fuente: "Banco de España",
    url_fuente: CONFIG.BDE_EURIBOR_CSV_URL,
    tipo_dato: "Último dato oficial disponible en la serie publicada"
  };
}

async function obtenerUltimoTipoMedioOficial() {
  if (!CONFIG.BDE_TIPO_MEDIO_CSV_URL) {
    return {
      descripcion: "Tipo medio hipotecario",
      valor: null,
      fecha: null,
      fuente: "Banco de España",
      url_fuente: null,
      aviso: "Debe configurar BDE_TIPO_MEDIO_CSV_URL con la serie oficial concreta del Banco de España."
    };
  }

  const csv = await fetchText(CONFIG.BDE_TIPO_MEDIO_CSV_URL);

  const dato = latestBdeValueFromCsv(csv, ["hipotec"]);

  return {
    descripcion: "Tipo medio hipotecario",
    valor: dato.valor,
    fecha: dato.fecha,
    fuente: "Banco de España",
    url_fuente: CONFIG.BDE_TIPO_MEDIO_CSV_URL,
    tipo_dato: "Último dato oficial disponible en la serie publicada"
  };
}

app.get("/health", (req, res) => {
  ok(res, {
    servicio: "InmoRecursos backend activo",
    version: "1.0.0"
  });
});

app.get("/financiero", async (req, res) => {
  try {
    const [euribor, tipoMedio] = await Promise.all([
      obtenerUltimoEuriborOficial(),
      obtenerUltimoTipoMedioOficial()
    ]);

    ok(res, {
      financiero: {
        fuente: "Banco de España",
        consulta_realizada: new Date().toISOString(),
        euribor,
        tipo_medio_hipotecario: tipoMedio,
        aviso: "Se muestra siempre el último dato oficial disponible publicado por el organismo emisor."
      }
    });
  } catch (err) {
    fail(res, 500, "No se pudo obtener el dato financiero oficial en tiempo real.", err.message);
  }
});

app.post("/ctr", (req, res) => {
  try {
    const {
      cuota,
      anos,
      ibi,
      comunidad,
      seguro,
      suministros,
      mantenimiento,
      transporte
    } = req.body || {};

    const componentes = {
      cuota_hipotecaria: Number(cuota) || 0,
      ibi: ibi === null || ibi === undefined ? null : Number(ibi),
      comunidad: comunidad === null || comunidad === undefined ? null : Number(comunidad),
      seguro: seguro === null || seguro === undefined ? null : Number(seguro),
      suministros: suministros === null || suministros === undefined ? null : Number(suministros),
      mantenimiento: mantenimiento === null || mantenimiento === undefined ? null : Number(mantenimiento),
      transporte: transporte === null || transporte === undefined || transporte === "" ? null : Number(transporte)
    };

    const advertencias = [];

    for (const [k, v] of Object.entries(componentes)) {
      if (v !== null && (!Number.isFinite(v) || v < 0)) {
        advertencias.push(`El componente ${k} no es válido y no se ha incluido.`);
        componentes[k] = null;
      }
    }

    const ctrMensual = Object.values(componentes)
      .filter(v => Number.isFinite(v))
      .reduce((a, b) => a + b, 0);

    const years = Number(anos) || 0;

    ok(res, {
      ctr: {
        consulta_realizada: new Date().toISOString(),
        fuente: "Cálculo propio a partir de datos introducidos por el usuario",
        ctr_mensual: ctrMensual,
        ctr_anual: ctrMensual * 12,
        ctr_total_periodo: years > 0 ? ctrMensual * 12 * years : null,
        componentes,
        advertencias
      }
    });
  } catch (err) {
    fail(res, 500, "No se pudo calcular el CTR.", err.message);
  }
});

async function geocodificar(direccion) {
  if (!CONFIG.GEOAPIFY_KEY) {
    throw new Error("Falta GEOAPIFY_KEY para geocodificar la dirección.");
  }

  const url =
    `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(direccion)}` +
    `&limit=1&lang=es&apiKey=${CONFIG.GEOAPIFY_KEY}`;

  const data = await fetchJson(url);

  const f = data.features?.[0];
  if (!f) throw new Error("No se pudo geocodificar la dirección.");

  return {
    lat: f.properties.lat,
    lon: f.properties.lon,
    direccion_localizada: f.properties.formatted,
    municipio: f.properties.city || f.properties.town || f.properties.village || null,
    provincia: f.properties.county || null,
    comunidad: f.properties.state || null
  };
}

async function obtenerAireOpenMeteo(lat, lon) {
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
    `&hourly=pm10,pm2_5,nitrogen_dioxide,ozone,carbon_monoxide,sulphur_dioxide,european_aqi` +
    `&timezone=auto&past_days=1&forecast_days=1`;

  const data = await fetchJson(url);

  const h = data.hourly || {};
  const times = h.time || [];

  if (!times.length) {
    throw new Error("Open-Meteo no devolvió datos horarios de calidad del aire.");
  }

  const idx = times.length - 1;

  return {
    fuente: "Open-Meteo Air Quality",
    fecha: times[idx],
    pm2_5: h.pm2_5?.[idx] ?? null,
    pm10: h.pm10?.[idx] ?? null,
    no2: h.nitrogen_dioxide?.[idx] ?? null,
    ozono: h.ozone?.[idx] ?? null,
    co: h.carbon_monoxide?.[idx] ?? null,
    so2: h.sulphur_dioxide?.[idx] ?? null,
    aqi_europeo: h.european_aqi?.[idx] ?? null
  };
}

async function obtenerMeteoOpenMeteo(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m` +
    `&daily=uv_index_max&timezone=auto&forecast_days=1`;

  const data = await fetchJson(url);

  return {
    meteo: {
      fuente: "Open-Meteo",
      fecha: data.current?.time || null,
      temperatura: data.current?.temperature_2m ?? null,
      humedad_relativa: data.current?.relative_humidity_2m ?? null,
      viento: data.current?.wind_speed_10m ?? null
    },
    radiacion: {
      fuente: "Open-Meteo",
      fecha: data.daily?.time?.[0] || null,
      uv_index: data.daily?.uv_index_max?.[0] ?? null
    }
  };
}

async function obtenerServiciosGeoapify(lat, lon, radio) {
  if (!CONFIG.GEOAPIFY_KEY) {
    return {
      fuente: "Geoapify",
      aviso: "Falta GEOAPIFY_KEY. No se han consultado servicios cercanos.",
      servicios_resumen: {},
      servicios_con_direccion: []
    };
  }

  const categorias = [
    "commercial.supermarket",
    "healthcare.pharmacy",
    "education.school",
    "healthcare.hospital",
    "healthcare.clinic_or_praxis",
    "leisure.park",
    "public_transport",
    "catering.restaurant"
  ];

  const url =
    `https://api.geoapify.com/v2/places?categories=${categorias.join(",")}` +
    `&filter=circle:${lon},${lat},${radio}` +
    `&bias=proximity:${lon},${lat}` +
    `&limit=80&apiKey=${CONFIG.GEOAPIFY_KEY}`;

  const data = await fetchJson(url);

  const resumen = {};
  const lista = [];

  for (const f of data.features || []) {
    const p = f.properties || {};
    const tipo = (p.categories || [])[0] || "servicio";
    resumen[tipo] = (resumen[tipo] || 0) + 1;

    lista.push({
      nombre: p.name || "Servicio",
      tipo,
      direccion: p.formatted || null,
      distancia_m: p.distance ?? null
    });
  }

  return {
    fuente: "Geoapify Places",
    servicios_resumen: resumen,
    servicios_con_direccion: lista
  };
}

app.get("/entorno", async (req, res) => {
  try {
    const direccion = String(req.query.direccion || "").trim();
    const radio = Number(req.query.radio || 500);

    if (!direccion) {
      return fail(res, 400, "Debe facilitar una dirección.");
    }

    const geo = await geocodificar(direccion);

    const [aireResult, meteoResult, serviciosResult] = await Promise.allSettled([
      obtenerAireOpenMeteo(geo.lat, geo.lon),
      obtenerMeteoOpenMeteo(geo.lat, geo.lon),
      obtenerServiciosGeoapify(geo.lat, geo.lon, radio)
    ]);

    const advertencias = [];

    let aire = null;
    let meteo = null;
    let radiacion = null;
    let servicios_resumen = {};
    let servicios_con_direccion = [];

    if (aireResult.status === "fulfilled") {
      aire = aireResult.value;
    } else {
      advertencias.push(`No se pudo consultar calidad del aire: ${aireResult.reason.message}`);
    }

    if (meteoResult.status === "fulfilled") {
      meteo = meteoResult.value.meteo;
      radiacion = meteoResult.value.radiacion;
    } else {
      advertencias.push(`No se pudo consultar meteorología/UV: ${meteoResult.reason.message}`);
    }

    if (serviciosResult.status === "fulfilled") {
      servicios_resumen = serviciosResult.value.servicios_resumen;
      servicios_con_direccion = serviciosResult.value.servicios_con_direccion;
      if (serviciosResult.value.aviso) advertencias.push(serviciosResult.value.aviso);
    } else {
      advertencias.push(`No se pudo consultar servicios cercanos: ${serviciosResult.reason.message}`);
    }

    ok(res, {
      direccion_solicitada: direccion,
      direccion_localizada: geo.direccion_localizada,
      lat: geo.lat,
      lon: geo.lon,
      municipio: geo.municipio,
      provincia: geo.provincia,
      comunidad: geo.comunidad,
      radio_m: radio,
      fuente_geocodificacion: "Geoapify",
      aire,
      meteo,
      radiacion,
      servicios_resumen,
      servicios_con_direccion,
      advertencias,
      aviso: "Los datos ambientales se consultan en tiempo real. Si una fuente no responde, se informa expresamente."
    });
  } catch (err) {
    fail(res, 500, "No se pudo consultar el entorno en tiempo real.", err.message);
  }
});

async function obtenerRentaINEPorMunicipio(nombreMunicipio) {
  return {
    renta_media_persona: null,
    renta_media_hogar: null,
    renta_mediana: null,
    renta_unidad_consumo: null,
    fecha: null,
    fuente: "INE",
    aviso:
      "El endpoint queda preparado para INE, pero necesita mapear municipio/sección censal con el identificador oficial de la tabla INE utilizada. No se devuelve ningún dato simulado."
  };
}

app.get("/demografia", async (req, res) => {
  try {
    const direccion = String(req.query.direccion || "").trim();

    if (!direccion) {
      return fail(res, 400, "Debe facilitar una dirección.");
    }

    const geo = await geocodificar(direccion);
    const renta = await obtenerRentaINEPorMunicipio(geo.municipio);

    ok(res, {
      direccion_solicitada: direccion,
      direccion_localizada: geo.direccion_localizada,
      municipio: geo.municipio,
      provincia: geo.provincia,
      comunidad: geo.comunidad,
      fuente_geocodificacion: "Geoapify",
      renta,
      aviso:
        "La renta del INE no es diaria. Debe mostrarse como último dato oficial disponible, no como dato actualizado diariamente."
    });
  } catch (err) {
    fail(res, 500, "No se pudo consultar la demografía/renta oficial.", err.message);
  }
});

app.use((req, res) => {
  fail(res, 404, "Endpoint no encontrado.");
});

app.listen(PORT, () => {
  console.log(`InmoRecursos backend activo en puerto ${PORT}`);
});
