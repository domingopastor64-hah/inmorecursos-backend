import express from "express";
import cors from "cors";
import axios from "axios";
import xml2js from "xml2js";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*" }));
app.use(express.json());

function ok(res, data = {}) {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    ...data
  });
}

function error(res, fuente, mensaje) {
  res.json({
    status: "ERROR",
    timestamp: new Date().toISOString(),
    fuente,
    mensaje
  });
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function limpiarRC(rc) {
  return String(rc || "")
    .toUpperCase()
    .replace(/\s/g, "")
    .replace(/-/g, "");
}

function validarRC(rc) {
  const limpia = limpiarRC(rc);
  if (![14, 18, 20].includes(limpia.length)) {
    throw new Error("La referencia catastral debe tener 14, 18 o 20 caracteres");
  }
  if (!/^[A-Z0-9]+$/.test(limpia)) {
    throw new Error("La referencia catastral sólo debe contener letras y números");
  }
  return limpia;
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

  const results = r.data?.results || [];

  const item =
    results.find(x => String(x.country_code || "").toUpperCase() === "ES") ||
    results[0];

  if (!item) {
    throw new Error("No se pudo localizar la dirección o municipio en España");
  }

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

async function consultarCatastro(rcOriginal) {
  const refCat = validarRC(rcOriginal);

  const url =
    "https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCallejero.svc/rest/Consulta_DNPRC";

  const r = await axios.get(url, {
    timeout: 20000,
    params: {
      RefCat: refCat
    },
    validateStatus: () => true
  });

  if (r.status < 200 || r.status >= 300) {
    throw new Error(`Catastro respondió HTTP ${r.status}. Referencia enviada: ${refCat}`);
  }

  const parsed = await xml2js.parseStringPromise(r.data, {
    explicitArray: false,
    mergeAttrs: true
  });

  const texto = JSON.stringify(parsed).toLowerCase();

  return {
    referencia_usada: refCat,
    contiene_error_catastro:
      texto.includes("error") ||
      texto.includes("err") ||
      texto.includes("no existe"),
    raw: parsed
  };
}

app.get("/", (_, res) => {
  ok(res, {
    servicio: "InmoRecursos · Punto de Control de Compra",
    endpoints: [
      "/health",
      "/api/test/all?rc=REFERENCIA_CATASTRAL_REAL",
      "/api/geocode?direccion=Plasencia",
      "/api/openmeteo?lat=40.0312&lon=-6.0885",
      "/api/entorno?direccion=Plasencia",
      "/api/catastro?rc=REFERENCIA_CATASTRAL_REAL"
    ]
  });
});

app.get("/health", (_, res) => {
  ok(res, {
    estado: "Servidor activo"
  });
});

app.get("/api/geocode", async (req, res) => {
  try {
    const direccion = req.query.direccion;

    if (!direccion) {
      throw new Error("Falta el parámetro direccion");
    }

    const data = await geocode(direccion);

    ok(res, {
      fuente: "Open-Meteo Geocoding",
      geocoding: data
    });

  } catch (e) {
    error(res, "Open-Meteo Geocoding", e.message);
  }
});

app.get("/api/openmeteo", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error("Faltan coordenadas válidas");
    }

    const data = await openMeteo(lat, lon);
    const puntuacion = scoreAire(data.aire);

    ok(res, {
      ...data,
      lectura_entorno: {
        puntuacion_aire: puntuacion,
        lectura:
          puntuacion >= 70
            ? "Entorno ambiental favorable"
            : puntuacion >= 45
              ? "Entorno ambiental funcional"
              : "Entorno ambiental condicionante"
      }
    });

  } catch (e) {
    error(res, "Open-Meteo", e.message);
  }
});

app.get("/api/entorno", async (req, res) => {
  try {
    const direccion = req.query.direccion;

    if (!direccion) {
      throw new Error("Falta el parámetro direccion");
    }

    const geo = await geocode(direccion);
    const meteo = await openMeteo(geo.lat, geo.lon);
    const puntuacion = scoreAire(meteo.aire);

    ok(res, {
      fuente: "Open-Meteo Geocoding España + Open-Meteo",
      direccion_solicitada: direccion,
      geocoding: geo,
      aire: meteo.aire,
      meteo: meteo.meteo,
      lectura_entorno: {
        puntuacion_aire: puntuacion,
        lectura:
          puntuacion >= 70
            ? "Entorno ambiental favorable"
            : puntuacion >= 45
              ? "Entorno ambiental funcional"
              : "Entorno ambiental condicionante"
      }
    });

  } catch (e) {
    error(res, "Entorno", e.message);
  }
});

app.get("/api/catastro", async (req, res) => {
  try {
    const rc = req.query.rc;

    if (!rc) {
      throw new Error("Falta la referencia catastral");
    }

    const data = await consultarCatastro(rc);

    ok(res, {
      fuente: "Dirección General del Catastro",
      catastro: data
    });

  } catch (e) {
    error(res, "Dirección General del Catastro", e.message);
  }
});

app.get("/api/test/all", async (req, res) => {
  const tests = {};

  try {
    const geo = await geocode("Plasencia");
    tests.geocode = {
      status: "OK",
      data: geo
    };
  } catch (e) {
    tests.geocode = {
      status: "ERROR",
      mensaje: e.message
    };
  }

  try {
    const meteo = await openMeteo(40.0312, -6.0885);
    tests.openmeteo = {
      status: "OK",
      data: meteo
    };
  } catch (e) {
    tests.openmeteo = {
      status: "ERROR",
      mensaje: e.message
    };
  }

  try {
    const refcat = req.query.rc;

    if (!refcat) {
      tests.catastro = {
        status: "ERROR",
        mensaje: "Para probar Catastro use /api/test/all?rc=SU_REFERENCIA_CATASTRAL_REAL"
      };
    } else {
      const data = await consultarCatastro(refcat);

      tests.catastro = {
        status: "OK",
        referencia_usada: data.referencia_usada,
        contiene_error_catastro: data.contiene_error_catastro,
        parsed: Boolean(data.raw)
      };
    }

  } catch (e) {
    tests.catastro = {
      status: "ERROR",
      mensaje: e.message
    };
  }

  ok(res, {
    tests
  });
});

app.listen(PORT, () => {
  console.log(`Servidor Punto de Control activo en puerto ${PORT}`);
});
