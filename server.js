import express from "express";
import cors from "cors";
import axios from "axios";
import * as XLSX from "xlsx";
import { XMLParser } from "fast-xml-parser";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const http = axios.create({
  timeout: 30000,
  headers: {
    "User-Agent": "InmoRecursos-Punto-Control/1.0"
  }
});

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text"
});

/* =========================================================
   UTILIDADES
========================================================= */

function ok(data = {}) {
  return {
    status: "OK",
    timestamp: new Date().toISOString(),
    ...data
  };
}

function fail(message, extra = {}) {
  return {
    status: "ERROR",
    timestamp: new Date().toISOString(),
    mensaje: message,
    ...extra
  };
}

function cleanText(v = "") {
  return String(v)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function toNumber(v) {
  if (v === null || v === undefined || v === "" || v === "nr") return null;

  const raw = String(v).trim();

  if (/^\d{1,3}(\.\d{3})*,\d+$/.test(raw)) {
    return Number(raw.replace(/\./g, "").replace(",", "."));
  }

  if (/^\d+,\d+$/.test(raw)) {
    return Number(raw.replace(",", "."));
  }

  const n = Number(raw.replace(/\s/g, ""));
  return Number.isFinite(n) ? n : null;
}

function normalizarTipoBCE(v) {
  const n = toNumber(v);
  if (n === null) return null;
  return n > 20 ? n / 100 : n;
}

function semaforoMenor(valor, verdeMax, naranjaMax) {
  if (valor === null || valor === undefined || !Number.isFinite(Number(valor))) {
    return { color: "gris", nivel: "No disponible" };
  }

  const n = Number(valor);

  if (n <= verdeMax) return { color: "verde", nivel: "Óptimo" };
  if (n <= naranjaMax) return { color: "naranja", nivel: "Precaución" };
  return { color: "rojo", nivel: "Negativo" };
}

function semaforoMayor(valor, verdeMin, naranjaMin) {
  if (valor === null || valor === undefined || !Number.isFinite(Number(valor))) {
    return { color: "gris", nivel: "No disponible" };
  }

  const n = Number(valor);

  if (n > verdeMin) return { color: "verde", nivel: "Favorable" };
  if (n >= naranjaMin) return { color: "naranja", nivel: "Precaución" };
  return { color: "rojo", nivel: "Negativo" };
}

function municipioExacto(row0, municipio) {
  const limpio = cleanText(row0 || "");
  const buscado = cleanText(municipio);
  const sinCodigo = limpio.replace(/^\d+\s+/, "").trim();

  return (
    sinCodigo === buscado &&
    !sinCodigo.includes("distrito") &&
    !sinCodigo.includes("seccion")
  );
}

async function ineTablaJson(tabla, nult = 1) {
  const url = `https://servicios.ine.es/wstempus/js/es/DATOS_TABLA/${tabla}`;
  const response = await http.get(url, { params: { nult } });
  return response.data;
}

function getLastDato(serie) {
  if (!serie?.Data?.length) return null;
  return serie.Data[0];
}

function elegirSerie(rows, patrones = []) {
  if (!Array.isArray(rows)) return null;

  return rows.find(r => {
    const nombre = cleanText(r.Nombre || "");
    return patrones.every(p => nombre.includes(cleanText(p)));
  }) || null;
}

function scoreColor(color) {
  if (color === "verde") return 100;
  if (color === "naranja") return 60;
  if (color === "rojo") return 20;
  return null;
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/", (req, res) => {
  res.json(ok({
    estado: "Servidor activo",
    endpoints: [
      "/api/catastro?rc=",
      "/api/ine/renta?municipio=Plasencia",
      "/api/bce/tipos",
      "/api/ine/ipc",
      "/api/ine/pib",
      "/api/ine/paro?ambito=ccaa&nombre=Extremadura",
      "/api/ine/paro?ambito=provincia&nombre=Cáceres",
      "/api/ine/salarios",
      "/api/cis/icc",
      "/api/contexto-economico",
      "/api/macro-decision"
    ]
  }));
});

/* =========================================================
   CATASTRO
========================================================= */

app.get("/api/catastro", async (req, res) => {
  try {
    const rc = String(req.query.rc || "").trim();

    if (!rc || rc.length < 14) {
      return res.json(fail("Referencia catastral no válida o incompleta."));
    }

    const rc14 = rc.slice(0, 14);

    const url =
      "https://ovc.catastro.meh.es/OVCServWeb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC";

    const response = await http.get(url, {
      params: {
        Provincia: "",
        Municipio: "",
        RC: rc14
      },
      responseType: "text"
    });

    const parsed = xmlParser.parse(response.data);
    const jsonText = JSON.stringify(parsed);

    const superficieMatch = jsonText.match(/"sfc":\s*"?([^",}]+)"?/);
    const antiguedadMatch = jsonText.match(/"ant":\s*"?([^",}]+)"?/);
    const usoMatch = jsonText.match(/"luso":\s*"?([^",}]+)"?/);

    res.json(ok({
      fuente: "Catastro · Consulta_DNPRC",
      estado_dato: "OK",
      referencia_introducida: rc,
      referencia_14: rc14,
      disponible: true,
      lectura_catastro: {
        referencia: rc14,
        superficie: superficieMatch ? superficieMatch[1] : null,
        antiguedad: antiguedadMatch ? antiguedadMatch[1] : null,
        uso: usoMatch ? usoMatch[1] : null
      },
      catastro: parsed,
      aviso:
        "Catastro identifica y describe. No sustituye Registro, nota simple, urbanismo ni revisión jurídica."
    }));
  } catch (e) {
    res.json(fail("No se pudo consultar Catastro.", {
      detalle: e.message
    }));
  }
});

/* =========================================================
   INE RENTA
========================================================= */

app.get("/api/ine/renta", async (req, res) => {
  try {
    const municipio = String(req.query.municipio || "").trim();

    if (!municipio) {
      return res.json(fail("Debe indicar municipio."));
    }

    const target = cleanText(municipio);

    try {
      const tabla30896 = await ineTablaJson("30896", 1);
      const registros = Array.isArray(tabla30896) ? tabla30896 : [];

      const exactos = registros.filter(r => {
        const nombre = cleanText(r.Nombre || "");
        const primeraParte = nombre.split(".")[0].trim();
        return primeraParte === target;
      });

      if (exactos.length) {
        return res.json(ok({
          fuente: "INE WSTempus · Tabla 30896",
          estado_dato: "OK",
          municipio_buscado: municipio,
          registros: exactos.slice(0, 20),
          aviso:
            "Dato obtenido desde tabla 30896 mediante coincidencia municipal exacta."
        }));
      }
    } catch {}

    const xlsUrl = "https://www.ine.es/jaxiT3/files/t/es/xlsx/30935.xlsx";
    const xls = await http.get(xlsUrl, { responseType: "arraybuffer" });
    const workbook = XLSX.read(xls.data, { type: "buffer" });

    const coincidencias = [];

    for (const sheetName of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
        header: 1,
        raw: false,
        defval: ""
      });

      rows.forEach((row, i) => {
        const first = String(row[0] || "");
        const limpio = cleanText(first);

        if (limpio.includes(target)) {
          coincidencias.push({
            hoja: sheetName,
            fila_numero: i + 1,
            fila: row
          });
        }
      });
    }

    const municipal = coincidencias.find(c =>
      municipioExacto(c.fila[0], municipio)
    );

    if (!municipal) {
      return res.json(ok({
        fuente: "INE · Renta",
        estado_dato: "NO_DISPONIBLE",
        municipio_buscado: municipio,
        aviso:
          "INE respondió, pero no se localizó fila municipal exacta. No se inventa dato.",
        coincidencias: coincidencias.slice(0, 20)
      }));
    }

    const row = municipal.fila;

    res.json(ok({
      fuente: "INE XLS · Tabla 30935",
      estado_dato: "OK",
      municipio_buscado: municipio,
      fila_municipal: row[0],
      renta: {
        renta_media_persona: toNumber(row[1]),
        renta_media_hogar: toNumber(row[10]),
        renta_media_unidad_consumo: toNumber(row[19]),
        mediana_unidad_consumo: toNumber(row[28]),
        renta_mediana_hogar: toNumber(row[37])
      },
      aviso:
        "Dato extraído de tabla 30935 mediante coincidencia exacta municipal."
    }));
  } catch (e) {
    res.json(fail("No se pudo obtener renta INE.", {
      detalle: e.message
    }));
  }
});

/* =========================================================
   BCE · TIPOS OFICIALES
========================================================= */

async function ecbCsv(seriesKey) {
  const url = `https://data-api.ecb.europa.eu/service/data/FM/${seriesKey}`;

  const response = await http.get(url, {
    params: {
      lastNObservations: 1,
      format: "csvdata"
    },
    responseType: "text"
  });

  const lines = String(response.data)
    .split(/\r?\n/)
    .filter(Boolean);

  const header = lines[0].split(",");
  const last = lines[lines.length - 1].split(",");

  const obj = {};
  header.forEach((h, i) => {
    obj[h] = last[i];
  });

  return obj;
}

app.get("/api/bce/tipos", async (req, res) => {
  try {
    const main = await ecbCsv("B.U2.EUR.4F.KR.MRR_FR.LEV");
    const deposit = await ecbCsv("B.U2.EUR.4F.KR.DFR.LEV");
    const marginal = await ecbCsv("B.U2.EUR.4F.KR.MLFR.LEV");

    const operaciones = normalizarTipoBCE(main.OBS_VALUE);
    const deposito = normalizarTipoBCE(deposit.OBS_VALUE);
    const marginalCredito = normalizarTipoBCE(marginal.OBS_VALUE);

    res.json(ok({
      fuente: "ECB Data Portal · Official interest rates",
      estado_dato: "OK",
      tipos: {
        operaciones_principales: {
          valor: operaciones,
          fecha: main.TIME_PERIOD,
          semaforo: semaforoMenor(operaciones, 2, 4)
        },
        facilidad_deposito: {
          valor: deposito,
          fecha: deposit.TIME_PERIOD,
          semaforo: semaforoMenor(deposito, 2, 4)
        },
        facilidad_marginal_credito: {
          valor: marginalCredito,
          fecha: marginal.TIME_PERIOD,
          semaforo: semaforoMenor(marginalCredito, 2.5, 4.5)
        }
      },
      aviso:
        "Tipos oficiales del BCE. No equivalen directamente al tipo hipotecario ofrecido al cliente."
    }));
  } catch (e) {
    res.json(fail("No se pudo obtener tipos BCE.", {
      detalle: e.message
    }));
  }
});

/* =========================================================
   INE · IPC
========================================================= */

app.get("/api/ine/ipc", async (req, res) => {
  try {
    const tabla = process.env.INE_IPC_TABLA || "50902";
    const data = await ineTablaJson(tabla, 1);
    const rows = Array.isArray(data) ? data : [];

    const candidato =
      elegirSerie(rows, ["nacional", "indice general", "variacion anual"]) ||
      elegirSerie(rows, ["indice general", "variacion anual"]) ||
      rows[0];

    if (!candidato || !candidato.Data?.length) {
      return res.json(ok({
        fuente: `INE WSTempus · Tabla ${tabla}`,
        estado_dato: "NO_DISPONIBLE",
        aviso:
          "INE respondió, pero no se localizó serie IPC nacional en variación anual."
      }));
    }

    const dato = getLastDato(candidato);
    const valor = toNumber(dato.Valor);

    res.json(ok({
      fuente: `INE WSTempus · Tabla ${tabla}`,
      estado_dato: "OK",
      indicador: candidato.Nombre,
      fecha: dato.Anyo,
      periodo: dato.FK_Periodo,
      valor,
      semaforo: semaforoMenor(valor, 2, 4),
      aviso:
        "Dato IPC obtenido desde INE. Serie nacional del Índice general en variación anual."
    }));
  } catch (e) {
    res.json(fail("No se pudo obtener IPC INE.", {
      detalle: e.message
    }));
  }
});

/* =========================================================
   INE · PIB
   Render: INE_PIB_TABLA=67295
   Calcula variación anual desde valores absolutos.
========================================================= */

app.get("/api/ine/pib", async (req, res) => {
  try {
    const tabla = process.env.INE_PIB_TABLA;

    if (!tabla) {
      return res.json(ok({
        fuente: "INE WSTempus · PIB",
        estado_dato: "NO_CONFIGURADO",
        aviso:
          "Debe definirse INE_PIB_TABLA en Render."
      }));
    }

    const data = await ineTablaJson(tabla, 2);
    const rows = Array.isArray(data) ? data : [];

    const candidato =
      elegirSerie(rows, ["producto interior bruto", "precios de mercado", "valor"]) ||
      elegirSerie(rows, ["producto interior bruto", "valor"]) ||
      elegirSerie(rows, ["pib", "valor"]);

    if (!candidato || !candidato.Data?.length || candidato.Data.length < 2) {
      return res.json(ok({
        fuente: `INE WSTempus · Tabla ${tabla}`,
        estado_dato: "NO_DISPONIBLE",
        aviso:
          "INE respondió, pero no se localizaron dos valores absolutos consecutivos de PIB para calcular variación anual."
      }));
    }

    const actual = candidato.Data[0];
    const anterior = candidato.Data[1];

    const valorActual = toNumber(actual.Valor);
    const valorAnterior = toNumber(anterior.Valor);

    const variacionAnual =
      valorActual !== null && valorAnterior
        ? ((valorActual - valorAnterior) / valorAnterior) * 100
        : null;

    res.json(ok({
      fuente: `INE WSTempus · Tabla ${tabla}`,
      estado_dato: variacionAnual === null ? "NO_DISPONIBLE" : "OK",
      indicador: candidato.Nombre,
      fecha_actual: actual.Anyo,
      periodo_actual: actual.FK_Periodo,
      fecha_anterior: anterior.Anyo,
      periodo_anterior: anterior.FK_Periodo,
      valor_absoluto_actual: valorActual,
      valor_absoluto_anterior: valorAnterior,
      variacion_anual: variacionAnual,
      valor: variacionAnual,
      semaforo:
        variacionAnual === null
          ? { color: "gris", nivel: "No disponible" }
          : semaforoMayor(variacionAnual, 2, 0),
      interpretacion:
        variacionAnual === null
          ? "No se puede calcular la variación anual del PIB."
          : variacionAnual > 2
          ? "Economía expansiva."
          : variacionAnual >= 0
          ? "Crecimiento moderado."
          : "Entorno de desaceleración o contracción.",
      aviso:
        "PIB calculado como variación anual a partir de valores absolutos consecutivos de la tabla configurada. El semáforo se aplica a la variación anual, no al valor absoluto."
    }));
  } catch (e) {
    res.json(fail("No se pudo obtener PIB INE.", {
      detalle: e.message
    }));
  }
});

/* =========================================================
   INE · PARO
   Render:
   INE_PARO_CCAA_TABLA=4247
   INE_PARO_PROVINCIA_TABLA=3996
========================================================= */

app.get("/api/ine/paro", async (req, res) => {
  try {
    const ambito = String(req.query.ambito || "ccaa").toLowerCase();
    const nombre = String(req.query.nombre || "").trim();

    const tabla =
      ambito === "provincia"
        ? process.env.INE_PARO_PROVINCIA_TABLA
        : process.env.INE_PARO_CCAA_TABLA;

    if (!tabla) {
      return res.json(ok({
        fuente: "INE WSTempus · EPA / tasa de paro",
        estado_dato: "NO_CONFIGURADO",
        aviso:
          "Debe definirse INE_PARO_CCAA_TABLA o INE_PARO_PROVINCIA_TABLA en Render."
      }));
    }

    const data = await ineTablaJson(tabla, 1);
    const rows = Array.isArray(data) ? data : [];
    const target = cleanText(nombre);

    const candidato =
      rows.find(r => {
        const serie = cleanText(r.Nombre || "");
        return (
          (!target || serie.includes(target)) &&
          serie.includes("tasa de paro")
        );
      }) ||
      rows.find(r => cleanText(r.Nombre || "").includes("tasa de paro"));

    if (!candidato || !candidato.Data?.length) {
      return res.json(ok({
        fuente: `INE WSTempus · Tabla ${tabla}`,
        estado_dato: "NO_DISPONIBLE",
        ambito,
        territorio: nombre || null,
        aviso:
          "INE respondió, pero no se localizó una serie de tasa de paro válida."
      }));
    }

    const dato = getLastDato(candidato);
    const valor = toNumber(dato.Valor);

    res.json(ok({
      fuente: `INE WSTempus · Tabla ${tabla}`,
      estado_dato: "OK",
      ambito,
      territorio: nombre || null,
      indicador: candidato.Nombre,
      fecha: dato.Anyo,
      periodo: dato.FK_Periodo,
      valor,
      semaforo: semaforoMenor(valor, 8, 14),
      interpretacion:
        valor < 8
          ? "Entorno laboral sólido."
          : valor <= 14
          ? "Mercado laboral sensible."
          : "Entorno laboral tensionado.",
      aviso:
        "Dato de tasa de paro obtenido desde INE."
    }));
  } catch (e) {
    res.json(fail("No se pudo obtener tasa de paro INE.", {
      detalle: e.message
    }));
  }
});

/* =========================================================
   INE · SALARIOS
   Render: INE_SALARIOS_TABLA=10882
   Prioriza: salario medio bruto · ambos sexos · España.
========================================================= */

app.get("/api/ine/salarios", async (req, res) => {
  try {
    const tabla = process.env.INE_SALARIOS_TABLA;

    if (!tabla) {
      return res.json(ok({
        fuente: "INE WSTempus · Salarios",
        estado_dato: "NO_CONFIGURADO",
        aviso:
          "Debe definirse INE_SALARIOS_TABLA en Render."
      }));
    }

    const data = await ineTablaJson(tabla, 1);
    const rows = Array.isArray(data) ? data : [];

    const candidato =
      elegirSerie(rows, ["salario medio bruto", "ambos sexos", "espana"]) ||
      elegirSerie(rows, ["salario medio bruto", "ambos sexos"]) ||
      elegirSerie(rows, ["ganancia media", "ambos sexos"]) ||
      elegirSerie(rows, ["salario medio", "ambos sexos"]) ||
      elegirSerie(rows, ["salario medio bruto"]) ||
      elegirSerie(rows, ["salario medio"]) ||
      rows[0];

    if (!candidato || !candidato.Data?.length) {
      return res.json(ok({
        fuente: `INE WSTempus · Tabla ${tabla}`,
        estado_dato: "NO_DISPONIBLE",
        aviso:
          "INE respondió, pero no se localizó una serie salarial consolidable."
      }));
    }

    const dato = getLastDato(candidato);
    const valor = toNumber(dato.Valor);

    res.json(ok({
      fuente: `INE WSTempus · Tabla ${tabla}`,
      estado_dato: "OK",
      indicador: candidato.Nombre,
      fecha: dato.Anyo,
      periodo: dato.FK_Periodo,
      valor,
      interpretacion:
        "El salario medio bruto sirve como referencia comparativa del esfuerzo económico y nivel adquisitivo.",
      aviso:
        "Dato salarial obtenido desde INE priorizando salario medio bruto, ambos sexos y España."
    }));
  } catch (e) {
    res.json(fail("No se pudo obtener salarios INE.", {
      detalle: e.message
    }));
  }
});

/* =========================================================
   CIS · ICC
   Render: CIS_ICC_ESTUDIO=3549
   Si devuelve 410 u otro error, no rompe el sistema.
========================================================= */

app.get("/api/cis/icc", async (req, res) => {
  try {
    const estudio = process.env.CIS_ICC_ESTUDIO;

    if (!estudio) {
      return res.json(ok({
        fuente: "CIS · Índice de Confianza del Consumidor",
        estado_dato: "NO_CONFIGURADO",
        aviso:
          "Debe definirse CIS_ICC_ESTUDIO en Render."
      }));
    }

    const url = `https://www.cis.es/documents/d/cis/es${estudio}marmt_a`;

    const response = await http.get(url, {
      responseType: "text"
    });

    const text = String(response.data);
    const matches = text.match(/\d+,\d+/g);

    const valor = matches?.length
      ? toNumber(matches[matches.length - 1])
      : null;

    res.json(ok({
      fuente: "CIS · Índice de Confianza del Consumidor",
      estado_dato: valor !== null ? "OK" : "NO_DISPONIBLE",
      estudio,
      valor,
      semaforo:
        valor !== null
          ? semaforoMayor(valor, 100, 80)
          : null,
      interpretacion:
        valor === null
          ? "No se ha podido consolidar el dato ICC."
          : valor > 100
          ? "Consumidor optimista."
          : valor >= 80
          ? "Consumidor prudente."
          : "Consumidor con desconfianza económica.",
      aviso:
        "Dato ICC interpretado desde estudio CIS configurado. Debe comprobarse que el documento mantiene la estructura esperada."
    }));
  } catch (e) {
    res.json(ok({
      fuente: "CIS · Índice de Confianza del Consumidor",
      estado_dato: "NO_DISPONIBLE",
      estudio: process.env.CIS_ICC_ESTUDIO || null,
      valor: null,
      semaforo: null,
      interpretacion:
        "No se ha podido obtener un dato ICC consolidado desde el CIS.",
      aviso:
        "El CIS no devuelve actualmente un recurso estable para este estudio o la URL configurada no está disponible. El dato no entra en la macrodecisión.",
      detalle: e.message
    }));
  }
});

/* =========================================================
   CONTEXTO ECONÓMICO AGRUPADO
========================================================= */

app.get("/api/contexto-economico", async (req, res) => {
  try {
    const base = `http://localhost:${PORT}`;

    const [
      bce,
      ipc,
      pib,
      paroCcaa,
      paroProvincia,
      salarios,
      cis
    ] = await Promise.allSettled([
      http.get(`${base}/api/bce/tipos`),
      http.get(`${base}/api/ine/ipc`),
      http.get(`${base}/api/ine/pib`),
      http.get(`${base}/api/ine/paro?ambito=ccaa&nombre=Extremadura`),
      http.get(`${base}/api/ine/paro?ambito=provincia&nombre=Cáceres`),
      http.get(`${base}/api/ine/salarios`),
      http.get(`${base}/api/cis/icc`)
    ]);

    res.json(ok({
      fuente: "Contexto económico agrupado",
      estado_dato: "OK",
      bce: bce.status === "fulfilled" ? bce.value.data : null,
      ipc: ipc.status === "fulfilled" ? ipc.value.data : null,
      pib: pib.status === "fulfilled" ? pib.value.data : null,
      paro_ccaa: paroCcaa.status === "fulfilled" ? paroCcaa.value.data : null,
      paro_provincia: paroProvincia.status === "fulfilled" ? paroProvincia.value.data : null,
      salarios: salarios.status === "fulfilled" ? salarios.value.data : null,
      cis: cis.status === "fulfilled" ? cis.value.data : null,
      aviso:
        "Sólo deben interpretarse datos con estado_dato OK."
    }));
  } catch (e) {
    res.json(fail("No se pudo generar contexto económico.", {
      detalle: e.message
    }));
  }
});

/* =========================================================
   MACRODECISIÓN
========================================================= */

app.get("/api/macro-decision", async (req, res) => {
  try {
    const base = `http://localhost:${PORT}`;
    const response = await http.get(`${base}/api/contexto-economico`);
    const c = response.data;

    const indicadores = [];

    function sumar(nombre, endpoint, color) {
      if (!endpoint || endpoint.estado_dato !== "OK") return;
      if (!color || color === "gris") return;

      const score = scoreColor(color);
      if (score === null) return;

      indicadores.push({ nombre, color, score });
    }

    sumar(
      "BCE",
      c.bce,
      c.bce?.tipos?.operaciones_principales?.semaforo?.color
    );

    sumar(
      "IPC",
      c.ipc,
      c.ipc?.semaforo?.color
    );

    sumar(
      "PIB variación anual",
      c.pib,
      c.pib?.semaforo?.color
    );

    sumar(
      "Paro CCAA",
      c.paro_ccaa,
      c.paro_ccaa?.semaforo?.color
    );

    sumar(
      "Paro provincia",
      c.paro_provincia,
      c.paro_provincia?.semaforo?.color
    );

    sumar(
      "CIS",
      c.cis,
      c.cis?.semaforo?.color
    );

    const final =
      indicadores.length > 0
        ? Math.round(
            indicadores.reduce((acc, item) => acc + item.score, 0) /
            indicadores.length
          )
        : null;

    let color = "gris";
    let nivel = "Sin datos";
    let interpretacion =
      "No existen suficientes datos macroeconómicos para emitir una lectura fiable.";

    if (final !== null) {
      if (final >= 75) {
        color = "verde";
        nivel = "Contexto favorable";
        interpretacion =
          "El contexto económico general es razonablemente favorable para operaciones equilibradas.";
      } else if (final >= 50) {
        color = "naranja";
        nivel = "Contexto prudente";
        interpretacion =
          "El contexto económico permite operaciones viables, aunque exige prudencia en compras ajustadas.";
      } else {
        color = "rojo";
        nivel = "Contexto tensionado";
        interpretacion =
          "El contexto macroeconómico aconseja reforzar margen financiero, ahorro y prudencia antes de comprar.";
      }
    }

    res.json(ok({
      fuente: "Motor macroeconómico InmoRecursos",
      estado_dato: final !== null ? "OK" : "NO_DISPONIBLE",
      score: final,
      semaforo: { color, nivel },
      indicadores_usados: indicadores,
      interpretacion,
      contexto: c,
      aviso:
        "La macrodecisión interpreta únicamente indicadores oficiales con estado_dato OK. El PIB se usa sólo como variación anual calculada, no como valor absoluto."
    }));
  } catch (e) {
    res.json(fail("No se pudo generar macrodecisión.", {
      detalle: e.message
    }));
  }
});

app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
