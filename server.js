import express from "express";
import cors from "cors";
import axios from "axios";
import xml2js from "xml2js";
import XLSX from "xlsx";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*" }));
app.use(express.json());

function ok(res, data = {}) {
  res.json({ status: "OK", timestamp: new Date().toISOString(), ...data });
}

function fail(res, fuente, error) {
  res.json({
    status: "ERROR",
    timestamp: new Date().toISOString(),
    fuente,
    mensaje: readableError(error)
  });
}

function readableError(e) {
  if (!e) return "Error desconocido";
  if (e.code) return `${e.code}: ${e.message || "sin detalle"}`;
  if (e.response?.status) return `HTTP ${e.response.status}: ${e.message || "sin detalle"}`;
  return e.message || String(e) || "Error sin mensaje";
}

function limpiarTexto(t = "") {
  return String(t)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function limpiarRC(rc) {
  return String(rc || "").toUpperCase().replace(/\s/g, "").replace(/-/g, "");
}

function toNumber(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (!s || limpiarTexto(s) === "nr" || s === "_") return null;

  s = s.replace(/\s+/g, "");

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastComma > lastDot) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    s = s.replace(",", ".");
  }

  s = s.replace(/[^\d.-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function parseXML(xml) {
  return await xml2js.parseStringPromise(xml, {
    explicitArray: false,
    mergeAttrs: true
  });
}

function splitCSVLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }

  out.push(cur.trim());
  return out;
}

function parseFechaBDE(txt) {
  const meses = {
    ene: 0,
    feb: 1,
    mar: 2,
    abr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    ago: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dic: 11
  };

  const m = String(txt || "")
    .toLowerCase()
    .replace(/"/g, "")
    .match(/(\d{1,2})\s+([a-záéíóúñ]{3})\s+(\d{4})/i);

  if (!m) return null;

  const mesKey = m[2].normalize("NFD").replace(/[\u0300-\u036f]/g, "").slice(0, 3);
  const mes = meses[mesKey];

  if (mes === undefined) return null;

  return new Date(Number(m[3]), mes, Number(m[1]));
}

/* =========================
   GEOCODING + OPEN-METEO
========================= */

async function geocode(direccion) {
  const r = await axios.get("https://geocoding-api.open-meteo.com/v1/search", {
    timeout: 20000,
    params: {
      name: direccion,
      count: 10,
      language: "es",
      format: "json",
      countryCode: "ES"
    }
  });

  const item =
    (r.data?.results || []).find(x => String(x.country_code || "").toUpperCase() === "ES") ||
    r.data?.results?.[0];

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
      timeout: 20000,
      params: {
        latitude: lat,
        longitude: lon,
        current: "pm10,pm2_5,nitrogen_dioxide,ozone,european_aqi",
        timezone: "Europe/Madrid"
      }
    }),
    axios.get("https://api.open-meteo.com/v1/forecast", {
      timeout: 20000,
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

/* =========================
   CATASTRO
========================= */

async function intentoCatastro(nombre, url, params) {
  try {
    const r = await axios.get(url, {
      timeout: 25000,
      params,
      validateStatus: () => true,
      headers: {
        "User-Agent": "InmoRecursos-Punto-Control/1.0",
        Accept: "application/xml,text/xml,*/*"
      }
    });

    let parsed = null;

    try {
      parsed = await parseXML(r.data);
    } catch {}

    return {
      nombre,
      ok: r.status >= 200 && r.status < 300 && Boolean(parsed),
      statusHTTP: r.status,
      parsed: Boolean(parsed),
      params,
      sample: typeof r.data === "string" ? r.data.slice(0, 600) : String(r.data).slice(0, 600),
      raw: parsed
    };
  } catch (e) {
    return {
      nombre,
      ok: false,
      error: readableError(e),
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

  rutas.push(
    await intentoCatastro(
      "REST WCF · RefCat completo",
      "https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCallejero.svc/rest/Consulta_DNPRC",
      { RefCat: rc20 }
    )
  );

  rutas.push(
    await intentoCatastro(
      "REST WCF · RefCat 14",
      "https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCallejero.svc/rest/Consulta_DNPRC",
      { RefCat: rc14 }
    )
  );

  rutas.push(
    await intentoCatastro(
      "ASMX clásico · RefCat completo",
      "https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC",
      { RefCat: rc20 }
    )
  );

  rutas.push(
    await intentoCatastro(
      "ASMX clásico · RC completo",
      "https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC",
      { Provincia: "", Municipio: "", RC: rc20 }
    )
  );

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

/* =========================
   INE · RENTA
========================= */

async function ineRentaTabla30896(municipio) {
  const url = "https://servicios.ine.es/wstempus/js/es/DATOS_TABLA/30896?nult=1";

  const r = await axios.get(url, { timeout: 45000 });
  const data = Array.isArray(r.data) ? r.data : [];

  const objetivo = limpiarTexto(municipio);

  const registrosMunicipio = data.filter(item => {
    const nombre = limpiarTexto(item.Nombre || "");
    return nombre.startsWith(objetivo + ".");
  });

  function ultimoValor(item) {
    const arr = Array.isArray(item?.Data) ? item.Data : [];
    const valido = arr.find(x => x && x.Valor !== undefined && x.Valor !== null);

    return valido
      ? {
          anyo: valido.Anyo,
          valor: toNumber(valido.Valor),
          secreto: Boolean(valido.Secreto)
        }
      : null;
  }

  function buscar(contiene) {
    const encontrado = registrosMunicipio.find(item =>
      limpiarTexto(item.Nombre || "").includes(limpiarTexto(contiene))
    );

    if (!encontrado) return null;

    const valor = ultimoValor(encontrado);

    return {
      cod: encontrado.COD,
      nombre: encontrado.Nombre,
      ...(valor || { anyo: null, valor: null, secreto: null })
    };
  }

  const renta_media_persona = buscar("Renta neta media por persona");
  const renta_media_hogar = buscar("Renta neta media por hogar");
  const renta_unidad_consumo = buscar("Media de la renta por unidad de consumo");
  const mediana_unidad_consumo = buscar("Mediana de la renta por unidad de consumo");
  const renta_mediana_hogar = buscar("Renta mediana por hogar");

  const algunDato =
    renta_media_persona ||
    renta_media_hogar ||
    renta_unidad_consumo ||
    mediana_unidad_consumo ||
    renta_mediana_hogar;

  return {
    fuente: "INE WSTempus · Tabla 30896",
    municipio_buscado: municipio,
    registros_totales: data.length,
    registros_municipio: registrosMunicipio.length,
    estado_dato: algunDato ? "OK" : "NO_DISPONIBLE",
    renta: {
      renta_media_persona,
      renta_media_hogar,
      renta_unidad_consumo,
      mediana_unidad_consumo,
      renta_mediana_hogar
    }
  };
}

async function ineRentaFallback30935(municipio) {
  const url = "https://www.ine.es/jaxiT3/files/t/xlsx/30935.xlsx";
  const r = await axios.get(url, { timeout: 45000, responseType: "arraybuffer" });
  const wb = XLSX.read(r.data, { type: "buffer" });

  const objetivoExacto = limpiarTexto(municipio);
  const coincidencias = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });

    rows.forEach((fila, idx) => {
      const primera = limpiarTexto(fila?.[0] || "");
      const sinCodigo = primera.replace(/^\d+\s+/, "").trim();

      if (sinCodigo === objetivoExacto) {
        coincidencias.push({
          hoja: sheetName,
          fila_numero: idx + 1,
          fila
        });
      }
    });
  }

  return {
    fuente: "INE XLS · Tabla 30935",
    municipio_buscado: municipio,
    estado_dato: coincidencias.length ? "COINCIDENCIA_MUNICIPAL" : "NO_DISPONIBLE",
    total_coincidencias: coincidencias.length,
    coincidencias: coincidencias.slice(0, 5),
    aviso: coincidencias.length
      ? "Coincidencia municipal exacta localizada. Pendiente convertir columnas en indicadores consolidados."
      : "INE 30935 respondió, pero no se localizó coincidencia municipal exacta."
  };
}

async function ineRenta(municipio) {
  try {
    const principal = await ineRentaTabla30896(municipio);

    if (principal.estado_dato === "OK") {
      return {
        ...principal,
        metodo_usado: "WSTempus 30896"
      };
    }

    const fallback = await ineRentaFallback30935(municipio);

    return {
      fuente: "INE · Renta y contexto socioeconómico",
      municipio_buscado: municipio,
      estado_dato: fallback.total_coincidencias > 0 ? "FALLBACK_DEBUG" : "NO_DISPONIBLE",
      tabla_30896: principal,
      tabla_30935: fallback,
      aviso: fallback.total_coincidencias > 0
        ? "No hubo dato municipal en 30896, pero sí coincidencia exacta en 30935. Pendiente consolidar columnas."
        : "No se localizaron datos útiles para este municipio en las fuentes INE probadas."
    };
  } catch (e) {
    return {
      fuente: "INE · Renta y contexto socioeconómico",
      municipio_buscado: municipio,
      estado_dato: "ERROR",
      mensaje: readableError(e),
      aviso: "INE no respondió de forma estable. No se sustituye por estimaciones."
    };
  }
}

/* =========================
   BANCO DE ESPAÑA · EURÍBOR
========================= */

function parseBdeCSV(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  const parsed = lines.map(splitCSVLine);

  const aliasRow = parsed.find(row => limpiarTexto(row[0]).includes("alias de la serie"));
  const descRow = parsed.find(row => limpiarTexto(row[0]).includes("descripcion de la serie"));

  if (!aliasRow) {
    throw new Error("No se encontró la fila de alias de series en el CSV del Banco de España");
  }

  const indexEuribor12 = aliasRow.findIndex(x => limpiarTexto(x) === "ti_1_7.7");

  if (indexEuribor12 === -1) {
    throw new Error("No se localizó la serie TI_1_7.7 correspondiente a Euríbor 12 meses");
  }

  const descripcion = descRow?.[indexEuribor12] || "Euríbor 12 meses";
  const valores = [];

  for (const row of parsed) {
    const fecha = parseFechaBDE(row[0]);
    if (!fecha) continue;

    const valor = toNumber(row[indexEuribor12]);

    if (valor !== null) {
      valores.push({
        fecha: fecha.toISOString().slice(0, 10),
        valor
      });
    }
  }

  if (!valores.length) {
    throw new Error("La serie Euríbor 12 meses no contiene valores numéricos");
  }

  valores.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

  const ultimo = valores[valores.length - 1];
  const maximo = valores.reduce((a, b) => (b.valor > a.valor ? b : a), valores[0]);
  const minimo = valores.reduce((a, b) => (b.valor < a.valor ? b : a), valores[0]);

  const fechaLimite10y = new Date();
  fechaLimite10y.setFullYear(fechaLimite10y.getFullYear() - 10);

  const ultimos10 = valores.filter(x => new Date(x.fecha) >= fechaLimite10y);
  const media10y = ultimos10.length
    ? ultimos10.reduce((sum, x) => sum + x.valor, 0) / ultimos10.length
    : null;

  return {
    fuente: "Banco de España · ti_1_7.csv",
    serie: "TI_1_7.7",
    descripcion,
    total_valores: valores.length,
    euribor_12m_actual: ultimo,
    maximo_historico: maximo,
    minimo_historico: minimo,
    media_10y: media10y !== null ? Number(media10y.toFixed(3)) : null,
    muestra_ultimos_5: valores.slice(-5),
    aviso: "Dato extraído del CSV oficial del Banco de España. La serie TI_1_7.7 corresponde al Euríbor a 12 meses."
  };
}

async function bdeEuribor() {
  const url = "https://www.bde.es/webbe/es/estadisticas/compartido/datos/csv/ti_1_7.csv";
  const r = await axios.get(url, { timeout: 30000, responseType: "text" });
  return parseBdeCSV(r.data);
}

/* =========================
   MIVAU · VALOR TASADO LIMPIO
========================= */

const MIVAU_BASE = "https://apps.fomento.gob.es/boletinonline2/";
const MIVAU_XLS_MUNICIPIOS = "sedal/35103500.XLS";

function parsePeriodoMivau(sheetName) {
  const m = String(sheetName || "").match(/^T([1-4])A(\d{4})$/i);
  if (!m) return null;
  return {
    trimestre: Number(m[1]),
    anyo: Number(m[2]),
    etiqueta: `T${m[1]} ${m[2]}`,
    orden: Number(m[2]) * 10 + Number(m[1])
  };
}

async function leerMivauMunicipios() {
  const url = MIVAU_BASE + MIVAU_XLS_MUNICIPIOS;
  const r = await axios.get(url, { timeout: 45000, responseType: "arraybuffer" });
  const wb = XLSX.read(r.data, { type: "buffer" });

  const registros = [];

  for (const sheetName of wb.SheetNames) {
    const periodo = parsePeriodoMivau(sheetName);
    if (!periodo) continue;

    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });

    for (let i = 0; i < rows.length; i++) {
      const fila = rows[i];

      const municipio = String(fila?.[2] || "").trim();
      if (!municipio) continue;

      const municipioLimpio = limpiarTexto(municipio);
      if (!municipioLimpio || municipioLimpio.includes("municipio")) continue;

      let valorNueva = toNumber(fila[3]);
      let valorUsada = toNumber(fila[4]);
      let valorTotal = toNumber(fila[5]);
      let tasacionesNueva = toNumber(fila[7]);
      let tasacionesUsada = toNumber(fila[8]);
      let tasacionesTotal = toNumber(fila[9]);

      if (periodo.anyo < 2010) {
        valorNueva = null;
        valorUsada = null;
        valorTotal = toNumber(fila[3]);
        tasacionesNueva = null;
        tasacionesUsada = null;
        tasacionesTotal = toNumber(fila[5]);
      }

      if (valorNueva === null && valorUsada === null && valorTotal === null) continue;

      registros.push({
        municipio,
        municipio_limpio: municipioLimpio,
        archivo: MIVAU_XLS_MUNICIPIOS,
        hoja: sheetName,
        fila_numero: i + 1,
        periodo: periodo.etiqueta,
        anyo: periodo.anyo,
        trimestre: periodo.trimestre,
        orden: periodo.orden,
        valor_tasado_nueva: valorNueva,
        valor_tasado_usada: valorUsada,
        valor_tasado_total: valorTotal,
        tasaciones_nueva: tasacionesNueva,
        tasaciones_usada: tasacionesUsada,
        tasaciones_total: tasacionesTotal
      });
    }
  }

  return registros;
}

async function mivauValorTasado(municipio) {
  const objetivo = limpiarTexto(municipio);
  const registros = await leerMivauMunicipios();

  const serie = registros
    .filter(r => r.municipio_limpio === objetivo)
    .sort((a, b) => a.orden - b.orden);

  if (!serie.length) {
    return {
      fuente: "MIVAU · Valor tasado vivienda · municipios >25.000 habitantes",
      municipio_buscado: municipio,
      estado_dato: "NO_DISPONIBLE",
      mensaje: "No se localizó el municipio en el XLS oficial de municipios.",
      aviso: "No se inventa dato alternativo."
    };
  }

  const ultimo = serie[serie.length - 1];

  return {
    fuente: "MIVAU · Valor tasado vivienda · municipios >25.000 habitantes",
    municipio_buscado: municipio,
    estado_dato: "OK",
    ultimo_periodo: ultimo.periodo,
    ultimo: {
      municipio: ultimo.municipio,
      periodo: ultimo.periodo,
      anyo: ultimo.anyo,
      trimestre: ultimo.trimestre,
      valor_tasado_nueva: ultimo.valor_tasado_nueva,
      valor_tasado_usada: ultimo.valor_tasado_usada,
      valor_tasado_total: ultimo.valor_tasado_total,
      tasaciones_nueva: ultimo.tasaciones_nueva,
      tasaciones_usada: ultimo.tasaciones_usada,
      tasaciones_total: ultimo.tasaciones_total
    },
    serie_historica_ultimos_8: serie.slice(-8).map(r => ({
      periodo: r.periodo,
      valor_tasado_nueva: r.valor_tasado_nueva,
      valor_tasado_usada: r.valor_tasado_usada,
      valor_tasado_total: r.valor_tasado_total,
      tasaciones_total: r.tasaciones_total
    })),
    aviso: "Dato extraído del XLS oficial MIVAU de municipios. Usar como referencia oficial de valor tasado, no como precio exacto de cierre."
  };
}

async function mivauTest() {
  const url = "https://apps.fomento.gob.es/boletinonline2/?nivel=2&orden=35000000";
  const r = await axios.get(url, { timeout: 30000, responseType: "text" });

  const html = String(r.data);
  const enlaces = [...html.matchAll(/href="([^"]+)"/gi)].map(x => x[1]);
  const xls = enlaces.filter(x => x.toLowerCase().endsWith(".xls"));

  return {
    fuente: "MIVAU · Valor tasado de la vivienda",
    url,
    acceso: true,
    longitud_html: html.length,
    contiene_valor_tasado: limpiarTexto(html).includes("valor tasado"),
    contiene_municipios_25000:
      limpiarTexto(html).includes("25.000") || limpiarTexto(html).includes("25000"),
    enlaces_xls_detectados: xls,
    archivo_municipios_usado: MIVAU_XLS_MUNICIPIOS,
    aviso: "MIVAU responde y el backend usa el XLS municipal para obtener valor tasado por municipio."
  };
}

/* =========================
   ENDPOINTS
========================= */

app.get("/", (_, res) => {
  ok(res, {
    servicio: "InmoRecursos · Punto de Control de Compra",
    fase: "Catastro + OpenMeteo + Banco de España + MIVAU limpio + INE controlado",
    endpoints: [
      "/health",
      "/api/geocode?direccion=Plasencia",
      "/api/entorno?direccion=Plasencia",
      "/api/catastro?rc=REFERENCIA",
      "/api/catastro-test?rc=REFERENCIA",
      "/api/ine-renta?municipio=Plasencia",
      "/api/bde/euribor",
      "/api/mivau/test",
      "/api/mivau/valor-tasado?municipio=Plasencia",
      "/api/test/light",
      "/api/test/oficiales?municipio=Plasencia",
      "/api/test/all?rc=REFERENCIA"
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
    if (!req.query.direccion) throw new Error("Falta el parámetro direccion");
    ok(res, {
      fuente: "Open-Meteo Geocoding",
      geocoding: await geocode(req.query.direccion)
    });
  } catch (e) {
    fail(res, "Open-Meteo Geocoding", e);
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
        puntuacion_aire: puntuacion
      }
    });
  } catch (e) {
    fail(res, "Open-Meteo", e);
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
        lectura:
          puntuacion >= 70
            ? "Entorno ambiental favorable"
            : puntuacion >= 45
              ? "Entorno ambiental funcional"
              : "Entorno ambiental condicionante"
      }
    });
  } catch (e) {
    fail(res, "Entorno", e);
  }
});

app.get("/api/catastro-test", async (req, res) => {
  try {
    if (!req.query.rc) throw new Error("Falta la referencia catastral");
    ok(res, {
      fuente: "Diagnóstico Catastro",
      catastro_test: await diagnosticarCatastro(req.query.rc)
    });
  } catch (e) {
    fail(res, "Diagnóstico Catastro", e);
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
    fail(res, "Dirección General del Catastro", e);
  }
});

app.get("/api/ine-renta", async (req, res) => {
  try {
    if (!req.query.municipio) throw new Error("Falta el parámetro municipio");
    ok(res, await ineRenta(req.query.municipio));
  } catch (e) {
    fail(res, "INE renta", e);
  }
});

app.get("/api/bde/euribor", async (_, res) => {
  try {
    ok(res, await bdeEuribor());
  } catch (e) {
    fail(res, "Banco de España · Euríbor", e);
  }
});

app.get("/api/mivau/test", async (_, res) => {
  try {
    ok(res, await mivauTest());
  } catch (e) {
    fail(res, "MIVAU · Test", e);
  }
});

app.get("/api/mivau/valor-tasado", async (req, res) => {
  try {
    if (!req.query.municipio) throw new Error("Falta el parámetro municipio");
    ok(res, await mivauValorTasado(req.query.municipio));
  } catch (e) {
    fail(res, "MIVAU · Valor tasado", e);
  }
});

/* =========================
   TESTS
========================= */

app.get("/api/test/light", async (_, res) => {
  ok(res, {
    mensaje: "Servidor activo. Este test no llama APIs externas pesadas.",
    endpoints_recomendados: [
      "/api/bde/euribor",
      "/api/mivau/valor-tasado?municipio=Plasencia",
      "/api/entorno?direccion=Plasencia",
      "/api/catastro?rc=REFERENCIA"
    ]
  });
});

app.get("/api/test/oficiales", async (req, res) => {
  const municipio = req.query.municipio || "Plasencia";
  const tests = {};

  try {
    tests.banco_espana = {
      status: "OK",
      data: await bdeEuribor()
    };
  } catch (e) {
    tests.banco_espana = {
      status: "ERROR",
      mensaje: readableError(e)
    };
  }

  try {
    tests.mivau_valor_tasado = {
      status: "OK",
      data: await mivauValorTasado(municipio)
    };
  } catch (e) {
    tests.mivau_valor_tasado = {
      status: "ERROR",
      mensaje: readableError(e)
    };
  }

  try {
    tests.ine_renta = {
      status: "OK",
      data: await ineRenta(municipio)
    };
  } catch (e) {
    tests.ine_renta = {
      status: "ERROR",
      mensaje: readableError(e)
    };
  }

  ok(res, {
    municipio,
    tests
  });
});

app.get("/api/test/all", async (req, res) => {
  const tests = {};

  try {
    tests.banco_espana = {
      status: "OK",
      data: await bdeEuribor()
    };
  } catch (e) {
    tests.banco_espana = {
      status: "ERROR",
      mensaje: readableError(e)
    };
  }

  try {
    tests.mivau_valor_tasado = {
      status: "OK",
      data: await mivauValorTasado("Plasencia")
    };
  } catch (e) {
    tests.mivau_valor_tasado = {
      status: "ERROR",
      mensaje: readableError(e)
    };
  }

  if (req.query.rc) {
    try {
      const cat = await diagnosticarCatastro(req.query.rc);
      tests.catastro = {
        status: cat.exito ? "OK" : "ERROR",
        endpoint_valido: cat.endpoint_valido,
        referencia_introducida: cat.referencia_introducida,
        referencia_14: cat.referencia_14
      };
    } catch (e) {
      tests.catastro = {
        status: "ERROR",
        mensaje: readableError(e)
      };
    }
  } else {
    tests.catastro = {
      status: "NO_PROBADO",
      mensaje: "Añada ?rc=REFERENCIA_CATASTRAL_REAL para probar Catastro"
    };
  }

  ok(res, {
    tests,
    aviso: "Test reducido para evitar saturar fuentes externas. Entorno e INE deben probarse en sus endpoints propios."
  });
});

app.listen(PORT, () => {
  console.log(`Servidor Punto de Control activo en puerto ${PORT}`);
});
