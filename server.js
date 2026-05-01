const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;

const GEOAPIFY_KEY = process.env.GEOAPIFY_KEY || "";

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

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  return JSON.parse(text);
}

async function serviciosGeoapify(lat, lon, radio = 500) {
  if (!GEOAPIFY_KEY) {
    throw new Error("Falta GEOAPIFY_KEY");
  }

  // SOLO CATEGORÍAS SEGURAS (YA DEPURADAS)
  const categorias = [
    "commercial.supermarket",
    "healthcare.pharmacy",
    "education.school",
    "healthcare.hospital",
    "leisure.park",
    "public_transport",
    "catering.restaurant",
    "service.financial.bank",
    "commercial.shopping_mall"
  ];

  const url =
    `https://api.geoapify.com/v2/places?categories=${categorias.join(",")}` +
    `&filter=circle:${lon},${lat},${radio}` +
    `&bias=proximity:${lon},${lat}` +
    `&limit=60&apiKey=${GEOAPIFY_KEY}`;

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
      direccion: p.formatted || "No disponible"
    });
  }

  return {
    resumen,
    lista
  };
}

async function aire(lat, lon) {
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
    `&current=pm10,pm2_5,nitrogen_dioxide,ozone,european_aqi,uv_index`;

  const data = await fetchJson(url);

  return data.current || {};
}

async function meteo(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m`;

  const data = await fetchJson(url);

  return data.current || {};
}

function interpretar(aire, servicios) {
  let score = 100;

  if (aire.pm2_5 > 20) score -= 20;
  if (aire.pm10 > 40) score -= 20;

  const totalServicios = Object.values(servicios).reduce((a, b) => a + b, 0);

  if (totalServicios < 3) score -= 40;
  else if (totalServicios < 6) score -= 20;

  return {
    puntuacion_global: Math.max(0, score),
    estado_global:
      score > 70 ? "Favorable" :
      score > 50 ? "Intermedio" : "Débil"
  };
}

app.get("/", (req, res) => {
  ok(res, {
    servicio: "Backend InmoRecursos",
    rutas: [
      "/api/entorno",
      "/api/euribor"
    ]
  });
});

app.get("/api/euribor", (req, res) => {
  ok(res, {
    euribor: {
      valor: null,
      aviso: "Pendiente integración Banco de España real"
    }
  });
});

app.get("/api/entorno", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);

    if (!lat || !lon) {
      return error(res, 400, "Faltan coordenadas lat/lon");
    }

    const [aireData, meteoData, serviciosData] = await Promise.all([
      aire(lat, lon),
      meteo(lat, lon),
      serviciosGeoapify(lat, lon)
    ]);

    const lectura = interpretar(aireData, serviciosData.resumen);

    ok(res, {
      lat,
      lon,
      aire: aireData,
      meteo: meteoData,
      servicios_resumen: serviciosData.resumen,
      servicios: serviciosData.lista,
      lectura_entorno: lectura
    });

  } catch (e) {
    error(res, 500, "Error en entorno", e.message);
  }
});

app.use((req, res) => {
  error(res, 404, "Ruta no encontrada", req.originalUrl);
});

app.listen(PORT, () => {
  console.log("Servidor funcionando en puerto " + PORT);
});
