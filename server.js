import express from "express";
import cors from "cors";
import axios from "axios";
import xml2js from "xml2js";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*" }));
app.use(express.json());

function ok(res, data = {}) {
  res.json({ status: "OK", timestamp: new Date().toISOString(), ...data });
}

function error(res, fuente, mensaje) {
  res.json({ status: "ERROR", timestamp: new Date().toISOString(), fuente, mensaje });
}

function limpiarRC(rc) {
  return String(rc || "").toUpperCase().replace(/\s/g, "").replace(/-/g, "");
}

async function parseXML(xml) {
  return await xml2js.parseStringPromise(xml, {
    explicitArray: false,
    mergeAttrs: true
  });
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function geocode(direccion) {
  const r = await axios.get("https://geocoding-api.open-meteo.com/v1/search", {
    timeout: 15000,
    params: {
      name: direccion,
      count: 10,
      language: "es",
      format: "json",
      countryCode: "ES"
    }
  });

  const item = (r.data?.results || []).find(x => String(x.country_code || "").toUpperCase() === "ES") || r.data?.results?.[0];
  if (!item) throw new Error("No se pudo localizar la dirección o municipio en España");

  return {
    lat: item.latitude,
    lon: item.longitude,
    municipio: item.name || "",
    provincia: item.admin2 || "",
    comunidad: item.admin1 || "",
    pais: item.country || "",
    country_code: item.country_code || ""
  };
}

async function openMeteo(lat, lon) {
  const [air, weather] = await Promise.all([
    axios.get("https://air-quality-api.open-meteo.com/v1/air-quality", {
      timeout: 15000,
      params: {
        latitude: lat,
        longitude: lon,
        current: "pm10,pm2_5,nitrogen_dioxide,ozone,european_aqi",
        timezone: "Europe/Madrid"
      }
    }),
    axios.get("https://api.open-meteo.com/v1/forecast", {
      timeout: 15000,
      params: {
        latitude: lat,
        longitude: lon,
        current: "temperature_2m,relative_humidity_2m,wind_speed_10m,uv_index",
        timezone: "Europe/Madrid"
      }
    })
  ]);

  const a = air.data.current || {};
  const m = weather.data.current || {};

  return {
    fuente: "Open-Meteo",
    aire: {
      pm10: toNumber(a.pm10),
      pm25: toNumber(a.pm2_5),
      no2: toNumber(a.nitrogen_dioxide),
      ozono: toNumber(a.ozone),
      aqi_europeo: toNumber(a.european_aqi)
    },
    meteo: {
      temperatura: toNumber(m.temperature_2m),
      humedad: toNumber(m.relative_humidity_2m),
      viento: toNumber(m.wind_speed_10m),
      uvi: toNumber(m.uv_index)
    }
  };
}

function scoreAire(aire) {
  let score = 100;
  if (aire.pm25 !== null) score -= aire.pm25 > 25 ? 28 : aire.pm25 > 10 ? 12 : 0;
  if (aire.pm10 !== null) score -= aire.pm10 > 40 ? 20 : aire.pm10 > 20 ? 8 : 0;
  if (aire.no2 !== null) score -= aire.no2 > 40 ? 20 : aire.no2 > 20 ? 8 : 0;
  if (aire.ozono !== null) score -= aire.ozono > 120 ? 14 : aire.ozono > 100 ? 6 : 0;
  if (aire.aqi_europeo !== null) score -= aire.aqi_europeo > 50 ? 20 : aire.aqi_europeo > 20 ? 8 : 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

async function intento(nombre, url, params) {
  try {
    const r = await axios.get(url, {
      timeout: 20000,
      params,
      validateStatus: () => true,
      headers: {
        "User-Agent": "InmoRecursos-Punto-Control/1.0",
        "Accept": "application/xml,text/xml,*/*"
      }
    });

    let parsed = null;
    try {
      parsed = await parseXML(r.data);
    } catch {}

    return {
      nombre,
      statusHTTP: r.status,
      ok: r.status >= 200 && r.status < 300,
      params,
      parsed: Boolean(parsed),
      sample: typeof r.data === "string" ? r.data.slice(0, 600) : String(r.data).slice(0, 600),
      raw: parsed
    };
  } catch (e) {
    return {
      nombre,
      ok: false,
      error: e.message,
      params
    };
  }
}

async function diagnosticarCatastro(rcOriginal) {
  const rc20 = limpiarRC(rcOriginal);
  const rc14 = rc20.slice(0, 14);

  if (![14, 18, 20].includes(rc20.length)) {
    throw new Error("La referencia catastral debe tener 14, 18 o 20 caracteres");
  }

  const rutas = [];

  rutas.push(await intento(
    "REST WCF moderno · RefCat completo",
    "https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCallejero.svc/rest/Consulta_DNPRC",
    { RefCat: rc20 }
  ));

  rutas.push(await intento(
    "REST WCF moderno · RefCat 14",
    "https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCallejero.svc/rest/Consulta_DNPRC",
    { RefCat: rc14 }
  ));

  rutas.push(await intento(
    "ASMX clásico · RefCat completo",
    "https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC",
    { RefCat: rc20 }
  ));

  rutas.push(await intento(
    "ASMX clásico · RC completo",
    "https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC",
    { RC: rc20 }
  ));

  rutas.push(await intento(
    "ASMX clásico · Provincia/Municipio vacío + RC completo",
    "https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC",
    { Provincia: "", Municipio: "", RC: rc20 }
  ));

  const valido = rutas.find(x => x.ok && x.parsed);

  return {
    referencia_introducida: rc20,
    referencia_14: rc14,
    endpoint_valido: valido ? valido.nombre : null,
    exito: Boolean(valido),
    resultado_valido: valido || null,
    intentos: rutas.map(x => ({
      nombre: x.nombre,
      ok: x.ok,
      statusHTTP: x.statusHTTP || null,
      parsed: x.parsed || false,
      error: x.error || null,
      params: x.params,
      sample: x.sample || null
    }))
  };
}

app.get("/", (_, res) => {
  ok(res, {
    servicio: "InmoRecursos · Punto de Control de Compra",
    endpoints: [
      "/health",
      "/api/test/all?rc=REFERENCIA_CATASTRAL_REAL",
      "/api/catastro-test?rc=REFERENCIA_CATASTRAL_REAL",
      "/api/geocode?direccion=Plasencia",
      "/api/entorno?direccion=Plasencia"
    ]
  });
});

app.get("/health", (_, res) => {
  ok(res, { estado: "Servidor activo" });
});

app.get("/api/geocode", async (req, res) => {
  try {
    if (!req.query.direccion) throw new Error("Falta el parámetro direccion");
    const data = await geocode(req.query.direccion);
    ok(res, { fuente: "Open-Meteo Geocoding", geocoding: data });
  } catch (e) {
    error(res, "Open-Meteo Geocoding", e.message);
  }
});

app.get("/api/openmeteo", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Faltan coordenadas válidas");

    const data = await openMeteo(lat, lon);
    const puntuacion = scoreAire(data.aire);

    ok(res, {
      ...data,
      lectura_entorno: {
        puntuacion_aire: puntuacion,
        lectura: puntuacion >= 70 ? "Entorno ambiental favorable" : puntuacion >= 45 ? "Entorno ambiental funcional" : "Entorno ambiental condicionante"
      }
    });
  } catch (e) {
    error(res, "Open-Meteo", e.message);
  }
});

app.get("/api/entorno", async (req, res) => {
  try {
    if (!req.query.direccion) throw new Error("Falta el parámetro direccion");

    const geo = await geocode(req.query.direccion);
    const meteo = await openMeteo(geo.lat, geo.lon);
    const puntuacion = scoreAire(meteo.aire);

    ok(res, {
      fuente: "Open-Meteo Geocoding España + Open-Meteo",
      direccion_solicitada: req.query.direccion,
      geocoding: geo,
      aire: meteo.aire,
      meteo: meteo.meteo,
      lectura_entorno: {
        puntuacion_aire: puntuacion,
        lectura: puntuacion >= 70 ? "Entorno ambiental favorable" : puntuacion >= 45 ? "Entorno ambiental funcional" : "Entorno ambiental condicionante"
      }
    });
  } catch (e) {
    error(res, "Entorno", e.message);
  }
});

app.get("/api/catastro-test", async (req, res) => {
  try {
    if (!req.query.rc) throw new Error("Falta la referencia catastral");
    const data = await diagnosticarCatastro(req.query.rc);
    ok(res, { fuente: "Diagnóstico Catastro", catastro_test: data });
  } catch (e) {
    error(res, "Diagnóstico Catastro", e.message);
  }
});

app.get("/api/catastro", async (req, res) => {
  try {
    if (!req.query.rc) throw new Error("Falta la referencia catastral");

    const data = await diagnosticarCatastro(req.query.rc);

    if (!data.exito) {
      ok(res, {
        fuente: "Dirección General del Catastro",
        disponible: false,
        mensaje: "Catastro no devolvió datos válidos con ninguno de los métodos probados.",
        catastro_test: data
      });
      return;
    }

    ok(res, {
      fuente: "Dirección General del Catastro",
      disponible: true,
      endpoint_usado: data.endpoint_valido,
      catastro: data.resultado_valido.raw,
      catastro_test: data
    });
  } catch (e) {
    error(res, "Dirección General del Catastro", e.message);
  }
});

app.get("/api/test/all", async (req, res) => {
  const tests = {};

  try {
    tests.geocode = { status: "OK", data: await geocode("Plasencia") };
  } catch (e) {
    tests.geocode = { status: "ERROR", mensaje: e.message };
  }

  try {
    tests.openmeteo = { status: "OK", data: await openMeteo(40.0312, -6.0885) };
  } catch (e) {
    tests.openmeteo = { status: "ERROR", mensaje: e.message };
  }

  try {
    if (!req.query.rc) {
      tests.catastro = {
        status: "ERROR",
        mensaje: "Para probar Catastro use /api/test/all?rc=SU_REFERENCIA_CATASTRAL_REAL"
      };
    } else {
      const data = await diagnosticarCatastro(req.query.rc);
      tests.catastro = {
        status: data.exito ? "OK" : "ERROR",
        endpoint_valido: data.endpoint_valido,
        referencia_introducida: data.referencia_introducida,
        referencia_14: data.referencia_14,
        intentos: data.intentos
      };
    }
  } catch (e) {
    tests.catastro = { status: "ERROR", mensaje: e.message };
  }

  ok(res, { tests });
});

app.listen(PORT, () => {
  console.log(`Servidor Punto de Control activo en puerto ${PORT}`);
});
