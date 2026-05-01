const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;

const GEOAPIFY_KEY = process.env.GEOAPIFY_KEY || "";
const AEMET_API_KEY = process.env.AEMET_API_KEY || "";
const OPENROUTESERVICE_KEY = process.env.OPENROUTESERVICE_KEY || "";

app.use(cors());
app.use(express.json());

function ahora() {
  return new Date().toISOString();
}

function ok(res, data) {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    consulta_realizada: ahora(),
    ...data
  });
}

function error(res, status, mensaje, detalle = null) {
  res.set("Cache-Control", "no-store");
  res.status(status).json({
    ok: false,
    consulta_realizada: ahora(),
    error: mensaje,
    detalle
  });
}

async function fetchJson(url, timeoutMs = 18000, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const finalUrl = url.includes("?")
      ? `${url}&_t=${Date.now()}`
      : `${url}?_t=${Date.now()}`;

    const response = await fetch(finalUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "InmoRecursos/5.1",
        "Cache-Control": "no-cache",
        ...headers
      }
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 250)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error("La respuesta no es JSON válido.");
    }
  } finally {
    clearTimeout(timer);
  }
}

async function geocodificarDireccion(direccion) {
  if (!GEOAPIFY_KEY) {
    throw new Error("Falta GEOAPIFY_KEY en Render.");
  }

  const url =
    `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(direccion)}` +
    `&limit=1&lang=es&apiKey=${GEOAPIFY_KEY}`;

  const data = await fetchJson(url);
  const f = data.features?.[0];

  if (!f) {
    throw new Error("Geoapify no encontró la dirección.");
  }

  return {
    lat: Number(f.properties.lat),
    lon: Number(f.properties.lon),
    direccion_localizada: f.properties.formatted || direccion,
    municipio: f.properties.city || f.properties.town || f.properties.village || null,
    provincia: f.properties.county || null,
    comunidad: f.properties.state || null,
    cp: f.properties.postcode || null
  };
}

async function serviciosGeoapify(lat, lon, radio = 500) {
  if (!GEOAPIFY_KEY) {
    throw new Error("Falta GEOAPIFY_KEY en Render.");
  }

  const categorias = [
    "commercial.supermarket",
    "healthcare.pharmacy",
    "education.school",
    "education.university",
    "healthcare.hospital",
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

async function aireOpenMeteo(lat, lon) {
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

async function meteoOpenMeteo(lat, lon) {
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

function interpretarAire(aire) {
  if (!aire) {
    return {
      puntuacion: null,
      estado: "Sin datos",
      alertas: [],
      lectura: "No se han podido obtener datos ambientales."
    };
  }

  let puntos = 100;
  const alertas = [];

  if (Number(aire.pm2_5) > 25) {
    puntos -= 30;
    alertas.push("PM2.5 elevado");
  } else if (Number(aire.pm2_5) > 10) {
    puntos -= 12;
  }

  if (Number(aire.pm10) > 40) {
    puntos -= 25;
    alertas.push("PM10 elevado");
  } else if (Number(aire.pm10) > 20) {
    puntos -= 10;
  }

  if (Number(aire.no2) > 40) {
    puntos -= 25;
    alertas.push("NO₂ elevado");
  }

  if (Number(aire.ozono) > 120) {
    puntos -= 25;
    alertas.push("Ozono elevado");
  } else if (Number(aire.ozono) > 100) {
    puntos -= 10;
  }

  puntos = Math.max(0, Math.min(100, Math.round(puntos)));

  let estado = "Bueno";
  if (puntos < 45) estado = "Delicado";
  else if (puntos < 70) estado = "Aceptable";

  return {
    puntuacion: puntos,
    estado,
    alertas,
    lectura:
      estado === "Bueno"
        ? "El entorno ambiental presenta una lectura favorable con los datos recibidos."
        : estado === "Aceptable"
          ? "El entorno ambiental es aceptable, aunque conviene revisar algunos indicadores."
          : "El entorno ambiental presenta señales que conviene valorar antes de decidir."
  };
}

function interpretarServicios(resumen) {
  const total = Object.values(resumen || {}).reduce((a, b) => a + Number(b || 0), 0);

  let puntuacion = 25;
  if (total >= 15) puntuacion = 90;
  else if (total >= 8) puntuacion = 72;
  else if (total >= 3) puntuacion = 50;

  return {
    total,
    puntuacion,
    estado: puntuacion >= 70 ? "Buena cobertura" : puntuacion >= 50 ? "Cobertura media" : "Cobertura baja",
    lectura:
      puntuacion >= 70
        ? "La vivienda cuenta con una dotación cercana de servicios suficiente para la vida diaria."
        : puntuacion >= 50
          ? "La zona tiene algunos servicios próximos, pero no una cobertura especialmente completa."
          : "La zona presenta baja dotación de servicios dentro del radio analizado."
  };
}

function construirLecturaEntorno(aire, serviciosResumen) {
  const lecturaAire = interpretarAire(aire);
  const lecturaServicios = interpretarServicios(serviciosResumen);

  const scores = [lecturaAire.puntuacion, lecturaServicios.puntuacion].filter(Number.isFinite);

  const global = scores.length
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : null;

  let estado = "Sin datos suficientes";
  if (global !== null) {
    estado = global >= 70 ? "Favorable" : global >= 50 ? "Intermedio" : "Débil";
  }

  return {
    puntuacion_global: global,
    estado_global: estado,
    aire: lecturaAire,
    servicios: lecturaServicios,
    lectura:
      estado === "Favorable"
        ? "El entorno acompaña razonablemente la decisión: buena lectura ambiental y cobertura suficiente de servicios."
        : estado === "Intermedio"
          ? "El entorno no invalida la operación, pero exige una lectura más cuidadosa por servicios o indicadores ambientales."
          : estado === "Débil"
            ? "El entorno puede condicionar la operación: conviene revisar la dependencia de transporte, servicios y calidad ambiental."
            : "No hay datos suficientes para interpretar el entorno."
  };
}

async function construirEntorno({ direccion, lat, lon, radio }) {
  let geo = null;

  if (direccion) {
    geo = await geocodificarDireccion(direccion);
    lat = geo.lat;
    lon = geo.lon;
  }

  if (!lat || !lon) {
    throw new Error("Debe facilitar dirección o coordenadas lat/lon.");
  }

  lat = Number(lat);
  lon = Number(lon);

  const [aireR, meteoR, serviciosR] = await Promise.allSettled([
    aireOpenMeteo(lat, lon),
    meteoOpenMeteo(lat, lon),
    serviciosGeoapify(lat, lon, radio)
  ]);

  const advertencias = [];

  const aire = aireR.status === "fulfilled" ? aireR.value : null;
  const meteo = meteoR.status === "fulfilled" ? meteoR.value : null;

  const servicios = serviciosR.status === "fulfilled"
    ? serviciosR.value
    : {
        servicios_resumen: {},
        servicios_con_direccion: [],
        fuente: "Geoapify Places"
      };

  if (aireR.status === "rejected") {
    advertencias.push(`Calidad del aire no disponible: ${aireR.reason.message}`);
  }

  if (meteoR.status === "rejected") {
    advertencias.push(`Meteorología no disponible: ${meteoR.reason.message}`);
  }

  if (serviciosR.status === "rejected") {
    advertencias.push(`Servicios cercanos no disponibles: ${serviciosR.reason.message}`);
  }

  const lectura = construirLecturaEntorno(aire, servicios.servicios_resumen);

  return {
    direccion_solicitada: direccion || null,
    direccion_localizada: geo?.direccion_localizada || null,
    lat,
    lon,
    municipio: geo?.municipio || null,
    provincia: geo?.provincia || null,
    comunidad: geo?.comunidad || null,
    cp: geo?.cp || null,
    radio_m: radio,
    fuente_geocodificacion: direccion ? "Geoapify" : "Coordenadas facilitadas",
    aire,
    meteo,
    radiacion: {
      fuente: "Open-Meteo Air Quality",
      fecha: aire?.fecha || null,
      uv_index: aire?.uv_index ?? null
    },
    servicios_resumen: servicios.servicios_resumen,
    servicios_con_direccion: servicios.servicios_con_direccion,
    fuente_servicios: servicios.fuente,
    lectura_entorno: lectura,
    advertencias
  };
}

function euriborOperativo() {
  return {
    descripcion: "Euríbor",
    valor: null,
    fecha: null,
    fuente: "Banco de España",
    aviso: "Ruta operativa. Falta fijar la serie exacta del Banco de España para lectura automática estable. No se devuelve dato simulado."
  };
}

app.get("/", (req, res) => {
  ok(res, {
    servicio: "InmoRecursos backend profesional",
    version: "5.1.0",
    rutas: [
      "/health",
      "/test-ruta",
      "/api/euribor",
      "/api/entorno?lat=40.03&lon=-6.08",
      "/api/entorno?direccion=...",
      "/api/renta",
      "/financiero",
      "/entorno",
      "/demografia",
      "/ctr"
    ]
  });
});

app.get("/health", (req, res) => {
  ok(res, {
    estado: "activo",
    version: "5.1.0",
    claves: {
      GEOAPIFY_KEY: Boolean(GEOAPIFY_KEY),
      AEMET_API_KEY: Boolean(AEMET_API_KEY),
      OPENROUTESERVICE_KEY: Boolean(OPENROUTESERVICE_KEY)
    }
  });
});

app.get("/test-ruta", (req, res) => {
  ok(res, { mensaje: "RUTA OK" });
});

app.get("/api/euribor", (req, res) => {
  ok(res, { euribor: euriborOperativo() });
});

app.get("/financiero", (req, res) => {
  ok(res, {
    financiero: {
      fuente: "Banco de España",
      euribor: euriborOperativo(),
      tipo_medio_hipotecario: {
        descripcion: "Tipo medio hipotecario",
        valor: null,
        fecha: null,
        fuente: "Banco de España",
        aviso: "Pendiente de configurar la serie oficial concreta del tipo medio hipotecario. No se devuelve dato simulado."
      }
    }
  });
});

app.get("/api/entorno", async (req, res) => {
  try {
    const data = await construirEntorno({
      direccion: String(req.query.direccion || "").trim() || null,
      lat: req.query.lat,
      lon: req.query.lon,
      radio: Number(req.query.radio || 500)
    });

    ok(res, data);
  } catch (e) {
    error(res, 500, "No se pudo consultar el entorno.", e.message);
  }
});

app.get("/entorno", async (req, res) => {
  try {
    const data = await construirEntorno({
      direccion: String(req.query.direccion || "").trim() || null,
      lat: req.query.lat,
      lon: req.query.lon,
      radio: Number(req.query.radio || 500)
    });

    ok(res, data);
  } catch (e) {
    error(res, 500, "No se pudo consultar el entorno.", e.message);
  }
});

app.get("/api/renta", (req, res) => {
  ok(res, {
    renta: {
      renta_media_persona: null,
      renta_media_hogar: null,
      renta_mediana: null,
      renta_unidad_consumo: null,
      fecha: null,
      fuente: "INE",
      aviso: "Ruta activa. Para devolver renta real se necesita mapear coordenadas/dirección con el código territorial exacto de la tabla INE correspondiente. No se devuelve renta simulada."
    }
  });
});

app.get("/demografia", async (req, res) => {
  try {
    let geo = null;
    const direccion = String(req.query.direccion || "").trim();

    if (direccion) {
      geo = await geocodificarDireccion(direccion);
    }

    ok(res, {
      direccion_solicitada: direccion || null,
      direccion_localizada: geo?.direccion_localizada || null,
      municipio: geo?.municipio || null,
      provincia: geo?.provincia || null,
      comunidad: geo?.comunidad || null,
      cp: geo?.cp || null,
      renta: {
        renta_media_persona: null,
        renta_media_hogar: null,
        renta_mediana: null,
        renta_unidad_consumo: null,
        fecha: null,
        fuente: "INE",
        aviso: "Ruta activa. Pendiente mapear el territorio a identificador INE exacto. No se devuelven datos inventados."
      }
    });
  } catch (e) {
    error(res, 500, "No se pudo consultar demografía.", e.message);
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
        ctr_mensual: ctrMensual,
        ctr_anual: ctrMensual * 12,
        ctr_total_periodo: anos > 0 ? ctrMensual * 12 * anos : null,
        componentes,
        advertencias
      }
    });
  } catch (e) {
    error(res, 500, "No se pudo calcular CTR.", e.message);
  }
});

app.use((req, res) => {
  error(res, 404, "Ruta no encontrada.", req.originalUrl);
});

app.listen(PORT, () => {
  console.log(`Servidor InmoRecursos profesional funcionando en puerto ${PORT}`);
});
