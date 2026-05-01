import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 10000;

const AEMET_API_KEY = process.env.AEMET_API_KEY || "";
const GEOAPIFY_KEY = process.env.GEOAPIFY_KEY || "";
const OPENROUTESERVICE_KEY = process.env.OPENROUTESERVICE_KEY || "";

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

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

function fail(res, status, error, detalle = null) {
  noCache(res);
  res.status(status).json({
    ok: false,
    consulta_realizada: new Date().toISOString(),
    error,
    detalle
  });
}

async function fetchJson(url, timeout = 18000, headers = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const finalUrl = url.includes("?")
      ? `${url}&_t=${Date.now()}`
      : `${url}?_t=${Date.now()}`;

    const res = await fetch(finalUrl, {
      signal: controller.signal,
      cache: "no-store",
      headers: {
        "User-Agent": "InmoRecursos/4.0",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        ...headers
      }
    });

    const text = await res.text();

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 250)}`);

    try {
      return JSON.parse(text);
    } catch {
      throw new Error("La respuesta no es JSON válido.");
    }
  } finally {
    clearTimeout(id);
  }
}

async function fetchText(url, timeout = 18000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const finalUrl = url.includes("?")
      ? `${url}&_t=${Date.now()}`
      : `${url}?_t=${Date.now()}`;

    const res = await fetch(finalUrl, {
      signal: controller.signal,
      cache: "no-store",
      headers: {
        "User-Agent": "InmoRecursos/4.0",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      }
    });

    const text = await res.text();

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 250)}`);

    return text;
  } finally {
    clearTimeout(id);
  }
}

function parseNumber(value) {
  if (value === null || value === undefined) return null;

  let s = String(value).trim();
  if (!s || s === "." || s === ".." || s === "-") return null;

  s = s.replace(/\s/g, "").replace("%", "");

  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseDate(value) {
  if (!value) return null;

  const s = String(value).trim();

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));

  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));

  m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, 1));

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function iso(d) {
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

function splitCsvLine(line, delimiter) {
  const out = [];
  let cur = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const nx = line[i + 1];

    if (ch === '"' && quoted && nx === '"') {
      cur += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      out.push(cur.replace(/^"|"$/g, "").trim());
      cur = "";
    } else {
      cur += ch;
    }
  }

  out.push(cur.replace(/^"|"$/g, "").trim());
  return out;
}

function parseCsv(text) {
  const clean = text.replace(/\r/g, "");
  const lines = clean.split("\n").filter(l => l.trim());
  const sample = lines.slice(0, 20).join("\n");
  const delimiter = (sample.match(/;/g) || []).length >= (sample.match(/,/g) || []).length ? ";" : ",";
  return lines.map(line => splitCsvLine(line, delimiter));
}

function findLatestNumberInCsv(csvText, words = []) {
  const rows = parseCsv(csvText);
  if (!rows.length) throw new Error("CSV vacío.");

  const cleanWords = words.map(w =>
    String(w).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  );

  let columnIndex = -1;

  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const cell = String(rows[r][c] || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

      if (cleanWords.every(w => cell.includes(w))) {
        columnIndex = c;
        break;
      }
    }
    if (columnIndex >= 0) break;
  }

  if (columnIndex < 0) {
    throw new Error("No se encontró la columna solicitada en el CSV.");
  }

  const candidates = [];

  for (const row of rows) {
    let date = null;

    for (let c = 0; c < Math.min(6, row.length); c++) {
      date = parseDate(row[c]);
      if (date) break;
    }

    const value = parseNumber(row[columnIndex]);

    if (date && value !== null) {
      candidates.push({
        fecha: iso(date),
        valor: value
      });
    }
  }

  candidates.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

  if (!candidates.length) throw new Error("No se encontraron valores fechados válidos.");

  return candidates[0];
}

async function obtenerEuribor() {
  const url =
    process.env.BDE_EURIBOR_CSV_URL ||
    "https://www.bde.es/webbe/es/estadisticas/compartido/datos/csv/ti_1_7.csv";

  const csv = await fetchText(url);

  let dato;
  try {
    dato = findLatestNumberInCsv(csv, ["euribor", "12"]);
  } catch {
    dato = findLatestNumberInCsv(csv, ["euribor"]);
  }

  return {
    descripcion: "Euríbor",
    valor: dato.valor,
    fecha: dato.fecha,
    fuente: "Banco de España",
    url_fuente: url,
    tipo_dato: "Último dato oficial disponible localizado en la serie publicada"
  };
}

async function geocodificar(direccion) {
  if (!GEOAPIFY_KEY) throw new Error("Falta GEOAPIFY_KEY en Render.");

  const url =
    `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(direccion)}` +
    `&limit=1&lang=es&apiKey=${GEOAPIFY_KEY}`;

  const data = await fetchJson(url);
  const f = data.features?.[0];

  if (!f) throw new Error("Geoapify no encontró la dirección.");

  return {
    lat: Number(f.properties.lat),
    lon: Number(f.properties.lon),
    direccion_localizada: f.properties.formatted,
    municipio: f.properties.city || f.properties.town || f.properties.village || null,
    provincia: f.properties.county || null,
    comunidad: f.properties.state || null,
    cp: f.properties.postcode || null
  };
}

async function obtenerServiciosGeoapify(lat, lon, radio = 500) {
  if (!GEOAPIFY_KEY) throw new Error("Falta GEOAPIFY_KEY en Render.");

  const categorias = [
    "commercial.supermarket",
    "healthcare.pharmacy",
    "education.school",
    "education.university",
    "healthcare.hospital",
    "healthcare.clinic_or_practice",
    "leisure.park",
    "public_transport",
    "catering.restaurant",
    "service.financial.bank",
    "service.vehicle.parking",
    "commercial.shopping_mall"
  ];

  const url =
    `https://api.geoapify.com/v2/places?categories=${categorias.join(",")}` +
    `&filter=circle:${lon},${lat},${radio}` +
    `&bias=proximity:${lon},${lat}` +
    `&limit=80&apiKey=${GEOAPIFY_KEY}`;

  const data = await fetchJson(url);

  const resumen = {};
  const lista = [];

  for (const f of data.features || []) {
    const p = f.properties || {};
    const tipo = p.categories?.[0] || "servicio";

    resumen[tipo] = (resumen[tipo] || 0) + 1;

    lista.push({
      nombre: p.name || "Servicio",
      tipo,
      direccion: p.formatted || "Dirección no disponible",
      distancia_m: p.distance ?? null
    });
  }

  return {
    fuente: "Geoapify Places",
    servicios_resumen: resumen,
    servicios_con_direccion: lista
  };
}

async function obtenerAireOpenMeteo(lat, lon) {
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
    `&current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,european_aqi,uv_index` +
    `&timezone=auto`;

  const data = await fetchJson(url);
  const c = data.current || {};

  return {
    fuente: "Open-Meteo Air Quality",
    fecha: c.time || null,
    pm2_5: c.pm2_5 ?? null,
    pm10: c.pm10 ?? null,
    no2: c.nitrogen_dioxide ?? null,
    ozono: c.ozone ?? null,
    co: c.carbon_monoxide ?? null,
    so2: c.sulphur_dioxide ?? null,
    aqi_europeo: c.european_aqi ?? null,
    uv_index: c.uv_index ?? null
  };
}

async function obtenerMeteoOpenMeteo(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m` +
    `&timezone=auto`;

  const data = await fetchJson(url);
  const c = data.current || {};

  return {
    fuente: "Open-Meteo",
    fecha: c.time || null,
    temperatura: c.temperature_2m ?? null,
    humedad_relativa: c.relative_humidity_2m ?? null,
    viento: c.wind_speed_10m ?? null
  };
}

app.get("/", (req, res) => {
  noCache(res);
  res.send("InmoRecursos backend activo. Pruebe /health");
});

app.get("/health", (req, res) => {
  ok(res, {
    servicio: "InmoRecursos backend activo",
    version: "4.0.0",
    claves: {
      AEMET_API_KEY: Boolean(AEMET_API_KEY),
      GEOAPIFY_KEY: Boolean(GEOAPIFY_KEY),
      OPENROUTESERVICE_KEY: Boolean(OPENROUTESERVICE_KEY)
    },
    rutas: [
      "/financiero",
      "/ctr",
      "/entorno?direccion=...",
      "/demografia?direccion=...",
      "/api/euribor",
      "/api/entorno?direccion=..."
    ]
  });
});

app.get("/financiero", async (req, res) => {
  try {
    const euribor = await obtenerEuribor();

    ok(res, {
      financiero: {
        fuente: "Banco de España",
        consulta_realizada: new Date().toISOString(),
        euribor,
        tipo_medio_hipotecario: {
          descripcion: "Tipo medio hipotecario",
          valor: null,
          fecha: null,
          fuente: "Banco de España",
          aviso: "Pendiente de configurar la URL oficial concreta de la serie si desea mostrar este dato."
        },
        aviso: "Se devuelve el último dato oficial disponible localizado en la serie publicada."
      }
    });
  } catch (err) {
    fail(res, 500, "No se pudo obtener el dato financiero oficial.", err.message);
  }
});

app.get("/api/euribor", async (req, res) => {
  try {
    const euribor = await obtenerEuribor();
    ok(res, { euribor });
  } catch (err) {
    fail(res, 500, "No se pudo obtener el Euríbor.", err.message);
  }
});

app.post("/ctr", (req, res) => {
  try {
    const b = req.body || {};

    const componentes = {
      cuota_hipotecaria: Number(b.cuota) || 0,
      ibi: b.ibi === null || b.ibi === undefined || b.ibi === "" ? null : Number(b.ibi),
      comunidad: b.comunidad === null || b.comunidad === undefined || b.comunidad === "" ? null : Number(b.comunidad),
      seguro: b.seguro === null || b.seguro === undefined || b.seguro === "" ? null : Number(b.seguro),
      suministros: b.suministros === null || b.suministros === undefined || b.suministros === "" ? null : Number(b.suministros),
      mantenimiento: b.mantenimiento === null || b.mantenimiento === undefined || b.mantenimiento === "" ? null : Number(b.mantenimiento),
      transporte: b.transporte === null || b.transporte === undefined || b.transporte === "" ? null : Number(b.transporte)
    };

    const advertencias = [];

    for (const [k, v] of Object.entries(componentes)) {
      if (v !== null && (!Number.isFinite(v) || v < 0)) {
        componentes[k] = null;
        advertencias.push(`El componente ${k} no es válido y no se ha incluido.`);
      }
    }

    const ctrMensual = Object.values(componentes)
      .filter(v => Number.isFinite(v))
      .reduce((a, b) => a + b, 0);

    const anos = Number(b.anos) || 0;

    ok(res, {
      ctr: {
        fuente: "Cálculo propio a partir de datos introducidos por el usuario",
        consulta_realizada: new Date().toISOString(),
        ctr_mensual: ctrMensual,
        ctr_anual: ctrMensual * 12,
        ctr_total_periodo: anos > 0 ? ctrMensual * 12 * anos : null,
        componentes,
        advertencias
      }
    });
  } catch (err) {
    fail(res, 500, "No se pudo calcular CTR.", err.message);
  }
});

async function construirEntorno(direccion, radio) {
  const geo = await geocodificar(direccion);

  const [aireR, meteoR, serviciosR] = await Promise.allSettled([
    obtenerAireOpenMeteo(geo.lat, geo.lon),
    obtenerMeteoOpenMeteo(geo.lat, geo.lon),
    obtenerServiciosGeoapify(geo.lat, geo.lon, radio)
  ]);

  const advertencias = [];

  const aire = aireR.status === "fulfilled" ? aireR.value : null;
  const meteo = meteoR.status === "fulfilled" ? meteoR.value : null;
  const servicios = serviciosR.status === "fulfilled"
    ? serviciosR.value
    : { servicios_resumen: {}, servicios_con_direccion: [], fuente: "Geoapify Places" };

  if (aireR.status === "rejected") advertencias.push(`Calidad del aire no disponible: ${aireR.reason.message}`);
  if (meteoR.status === "rejected") advertencias.push(`Meteorología no disponible: ${meteoR.reason.message}`);
  if (serviciosR.status === "rejected") advertencias.push(`Servicios cercanos no disponibles: ${serviciosR.reason.message}`);

  return {
    direccion_solicitada: direccion,
    direccion_localizada: geo.direccion_localizada,
    lat: geo.lat,
    lon: geo.lon,
    municipio: geo.municipio,
    provincia: geo.provincia,
    comunidad: geo.comunidad,
    cp: geo.cp,
    radio_m: radio,
    fuente_geocodificacion: "Geoapify",
    aire,
    meteo,
    radiacion: {
      fuente: "Open-Meteo Air Quality",
      fecha: aire?.fecha || null,
      uv_index: aire?.uv_index ?? null
    },
    servicios_resumen: servicios.servicios_resumen,
    servicios_con_direccion: servicios.servicios_con_direccion,
    fuente_servicios: servicios.fuente || "Geoapify Places",
    advertencias,
    aviso: "Datos consultados en tiempo real. Si una fuente falla, se informa en advertencias."
  };
}

app.get("/entorno", async (req, res) => {
  try {
    const direccion = String(req.query.direccion || "").trim();
    const radio = Number(req.query.radio || 500);

    if (!direccion) return fail(res, 400, "Debe facilitar una dirección.");

    const data = await construirEntorno(direccion, radio);
    ok(res, data);
  } catch (err) {
    fail(res, 500, "No se pudo consultar el entorno.", err.message);
  }
});

app.get("/api/entorno", async (req, res) => {
  try {
    const direccion = String(req.query.direccion || "").trim();
    const radio = Number(req.query.radio || 500);

    if (!direccion) return fail(res, 400, "Debe facilitar una dirección.");

    const data = await construirEntorno(direccion, radio);
    ok(res, data);
  } catch (err) {
    fail(res, 500, "No se pudo consultar el entorno.", err.message);
  }
});

app.get("/demografia", async (req, res) => {
  try {
    const direccion = String(req.query.direccion || "").trim();

    if (!direccion) return fail(res, 400, "Debe facilitar una dirección.");

    const geo = await geocodificar(direccion);

    ok(res, {
      direccion_solicitada: direccion,
      direccion_localizada: geo.direccion_localizada,
      municipio: geo.municipio,
      provincia: geo.provincia,
      comunidad: geo.comunidad,
      cp: geo.cp,
      fuente_geocodificacion: "Geoapify",
      renta: {
        renta_media_persona: null,
        renta_media_hogar: null,
        renta_mediana: null,
        renta_unidad_consumo: null,
        fecha: null,
        fuente: "INE",
        aviso: "La renta INE requiere conectar la consulta oficial exacta. No se devuelven datos simulados."
      },
      aviso: "Bloque operativo. Pendiente conectar renta real INE por identificador territorial."
    });
  } catch (err) {
    fail(res, 500, "No se pudo consultar demografía.", err.message);
  }
});

app.use((req, res) => {
  fail(res, 404, "Ruta no encontrada. Revise /health para ver rutas disponibles.");
});

app.listen(PORT, () => {
  console.log(`InmoRecursos backend activo en puerto ${PORT}`);
});
