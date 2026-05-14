// ======================================================
// server.js · TEST REAL FUENTES OFICIALES
// Punto de Control · InmoRecursos
// ======================================================

import express from "express";
import cors from "cors";
import axios from "axios";
import xml2js from "xml2js";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ======================================================
// HELPERS
// ======================================================

async function parseXML(xml) {
  return await xml2js.parseStringPromise(xml, {
    explicitArray: false,
    mergeAttrs: true
  });
}

function safeNumber(v) {
  if (v === null || v === undefined) return null;

  const n = Number(
    String(v)
      .replace(",", ".")
      .replace(/[^\d.-]/g, "")
  );

  return isNaN(n) ? null : n;
}

// ======================================================
// TEST GENERAL
// ======================================================

app.get("/api/test/all", async (req, res) => {

  const result = {
    server: "OK",
    timestamp: new Date().toISOString(),
    tests: {}
  };

  // ====================================================
  // 1. TEST CATASTRO
  // ====================================================

  try {

    const refcat = "1481301QE2318S0001WK";

    const url =
      `https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC?RefCat=${refcat}`;

    const response = await axios.get(url, {
      timeout: 15000
    });

    const parsed = await parseXML(response.data);

    result.tests.catastro = {
      status: "OK",
      refcat,
      fuente: "Dirección General del Catastro",
      parsed: !!parsed
    };

  } catch (error) {

    result.tests.catastro = {
      status: "ERROR",
      error: error.message
    };
  }

  // ====================================================
  // 2. TEST OPEN-METEO GEOCODING
  // ====================================================

  try {

    const geoURL =
      "https://geocoding-api.open-meteo.com/v1/search?name=Plasencia&count=1&language=es&format=json";

    const geo = await axios.get(geoURL, {
      timeout: 15000
    });

    const item = geo.data.results?.[0];

    result.tests.openMeteoGeocoding = {
      status: "OK",
      municipio: item?.name,
      lat: item?.latitude,
      lon: item?.longitude
    };

  } catch (error) {

    result.tests.openMeteoGeocoding = {
      status: "ERROR",
      error: error.message
    };
  }

  // ====================================================
  // 3. TEST OPEN-METEO ENTORNO
  // ====================================================

  try {

    const lat = 40.0312;
    const lon = -6.0885;

    const meteoURL =
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm10,pm2_5,nitrogen_dioxide,ozone,uv_index`;

    const meteo = await axios.get(meteoURL, {
      timeout: 15000
    });

    result.tests.openMeteoAir = {
      status: "OK",
      data: meteo.data.current || null
    };

  } catch (error) {

    result.tests.openMeteoAir = {
      status: "ERROR",
      error: error.message
    };
  }

  // ====================================================
  // 4. TEST BANCO DE ESPAÑA
  // ====================================================

  try {

    const csvURL =
      "https://www.bde.es/webbe/es/estadisticas/compartido/datos/csv/ti_1_7.csv";

    const csv = await axios.get(csvURL, {
      timeout: 15000
    });

    const text = csv.data;

    const containsEuribor =
      text.toLowerCase().includes("eur");

    result.tests.bancoEspana = {
      status: "OK",
      fuente: "Banco de España CSV oficial",
      contieneEuribor: containsEuribor,
      longitudCSV: text.length
    };

  } catch (error) {

    result.tests.bancoEspana = {
      status: "ERROR",
      error: error.message
    };
  }

  // ====================================================
  // 5. TEST INE
  // ====================================================

  try {

    const ineURL =
      "https://servicios.ine.es/wstempus/js/es/DATOS_TABLA/30896?tip=AM";

    const ine = await axios.get(ineURL, {
      timeout: 20000
    });

    const data = ine.data;

    result.tests.ine = {
      status: "OK",
      registros: Array.isArray(data) ? data.length : 0,
      fuente: "INE WSTempus Tabla 30896"
    };

  } catch (error) {

    result.tests.ine = {
      status: "ERROR",
      error: error.message
    };
  }

  // ====================================================

  res.json(result);

});

// ======================================================
// TEST SIMPLE
// ======================================================

app.get("/", (req, res) => {

  res.send(`
    <h1>Servidor operativo</h1>
    <p>Punto de Control · InmoRecursos</p>
    <a href="/api/test/all">PROBAR FUENTES</a>
  `);

});

// ======================================================

app.listen(PORT, () => {
  console.log("====================================");
  console.log("SERVIDOR INICIADO");
  console.log("Puerto:", PORT);
  console.log("====================================");
});
