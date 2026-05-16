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
  timeout: 25000,
  headers: {
    "User-Agent": "InmoRecursos-Punto-Control/1.0"
  }
});

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text"
});

function ok(data) {
  return {
    status: "OK",
    timestamp: new Date().toISOString(),
    ...data
  };
}

function error(message, extra = {}) {
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
  const s = String(v)
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/", (req, res) => {
  res.json(ok({
    estado: "Servidor activo",
    endpoints: [
      "/api/catastro?rc=",
      "/api/ine/renta?municipio=",
      "/api/bce/tipos",
      "/api/ine/ipc",
      "/api/ine/pib"
    ]
  }));
});

/* =========================================================
   CATASTRO · referencia catastral
========================================================= */

app.get("/api/catastro", async (req, res) => {
  try {
    const rc = String(req.query.rc || "").trim();

    if (!rc || rc.length < 14) {
      return res.json(error("Referencia catastral no válida o incompleta."));
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
    res.json(error("No se pudo consultar Catastro.", {
      detalle: e.message
    }));
  }
});

/* =========================================================
   INE RENTA · 30896 + fallback 30935 XLS
========================================================= */

async function ineTablaJson(tabla, nult = 1) {
  const url = `https://servicios.ine.es/wstempus/js/es/DATOS_TABLA/${tabla}`;
  const response = await http.get(url, {
    params: { nult }
  });
  return response.data;
}

app.get("/api/ine/renta", async (req, res) => {
  try {
    const municipio = String(req.query.municipio || "").trim();

    if (!municipio) {
      return res.json(error("Debe indicar municipio."));
    }

    const target = cleanText(municipio);

    let tabla30896 = null;

    try {
      tabla30896 = await ineTablaJson("30896", 1);
      const registros = Array.isArray(tabla30896) ? tabla30896 : [];

      const encontrados = registros.filter(r =>
        cleanText(r.Nombre || "").includes(target)
      );

      if (encontrados.length) {
        return res.json(ok({
          fuente: "INE WSTempus · Tabla 30896",
          municipio_buscado: municipio,
          estado_dato: "OK",
          registros: encontrados.slice(0, 20),
          aviso:
            "Dato obtenido desde tabla 30896. Se devuelve selección para consolidación de indicadores."
        }));
      }
    } catch {}

    const xlsUrl = "https://www.ine.es/jaxiT3/files/t/es/xlsx/30935.xlsx";

    const xls = await http.get(xlsUrl, {
      responseType: "arraybuffer"
    });

    const workbook = XLSX.read(xls.data, { type: "buffer" });

    const coincidencias = [];

    for (const sheetName of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
        header: 1,
        raw: false,
        defval: ""
      });

      rows.forEach((row, i) => {
        const first = cleanText(row[0] || "");
        if (first.includes(target)) {
          coincidencias.push({
            hoja: sheetName,
            fila_numero: i + 1,
            fila: row
          });
        }
      });
    }

    const municipal = coincidencias.find(c => {
      const first = String(c.fila[0] || "").toLowerCase();
      return first.includes(municipio.toLowerCase()) &&
             !first.includes("distrito") &&
             !first.includes("seccion");
    });

    if (!municipal) {
      return res.json(ok({
        fuente: "INE · Renta",
        municipio_buscado: municipio,
        estado_dato: "NO_DISPONIBLE",
        aviso:
          "INE respondió, pero no se localizó fila municipal clara. No se inventa dato.",
        coincidencias: coincidencias.slice(0, 20)
      }));
    }

    const row = municipal.fila;

    res.json(ok({
      fuente: "INE XLS · Tabla 30935",
      municipio_buscado: municipio,
      estado_dato: "OK",
      fila_municipal: row[0],
      renta: {
        renta_media_persona: toNumber(row[1]),
        renta_media_hogar: toNumber(row[10]),
        renta_media_unidad_consumo: toNumber(row[19]),
        mediana_unidad_consumo: toNumber(row[28]),
        renta_mediana_hogar: toNumber(row[37])
      },
      aviso:
        "Dato extraído de tabla 30935. La estructura por columnas debe mantenerse bajo control al actualizar INE."
    }));
  } catch (e) {
    res.json(error("No se pudo obtener renta INE.", {
      detalle: e.message
    }));
  }
});

/* =========================================================
   BCE · tipos oficiales
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
  header.forEach((h, i) => obj[h] = last[i]);

  return obj;
}

app.get("/api/bce/tipos", async (req, res) => {
  try {
    const main = await ecbCsv("B.U2.EUR.4F.KR.MRR_FR.LEV");
    const deposit = await ecbCsv("B.U2.EUR.4F.KR.DFR.LEV");
    const marginal = await ecbCsv("B.U2.EUR.4F.KR.MLFR.LEV");

    res.json(ok({
      fuente: "ECB Data Portal · Official interest rates",
      estado_dato: "OK",
      tipos: {
        operaciones_principales: {
          valor: toNumber(main.OBS_VALUE),
          fecha: main.TIME_PERIOD
        },
        facilidad_deposito: {
          valor: toNumber(deposit.OBS_VALUE),
          fecha: deposit.TIME_PERIOD
        },
        facilidad_marginal_credito: {
          valor: toNumber(marginal.OBS_VALUE),
          fecha: marginal.TIME_PERIOD
        }
      },
      aviso:
        "Tipos oficiales del BCE. No equivalen directamente al tipo hipotecario ofrecido al cliente."
    }));
  } catch (e) {
    res.json(error("No se pudo obtener tipos BCE.", {
      detalle: e.message
    }));
  }
});

/* =========================================================
   INE · IPC
   Tabla configurable. Por defecto se usa 50902 como tabla IPC nacional.
========================================================= */

app.get("/api/ine/ipc", async (req, res) => {
  try {
    const tabla = process.env.INE_IPC_TABLA || "50902";
    const data = await ineTablaJson(tabla, 1);
    const rows = Array.isArray(data) ? data : [];

    const candidato =
      rows.find(r =>
        cleanText(r.Nombre || "").includes("indice general") &&
        cleanText(r.Nombre || "").includes("nacional") &&
        cleanText(r.Nombre || "").includes("variacion anual")
      ) ||
      rows.find(r =>
        cleanText(r.Nombre || "").includes("indice general") &&
        cleanText(r.Nombre || "").includes("nacional")
      );

    if (!candidato || !candidato.Data?.length) {
      return res.json(ok({
        fuente: `INE WSTempus · Tabla ${tabla}`,
        estado_dato: "NO_DISPONIBLE",
        aviso:
          "INE respondió, pero no se localizó serie IPC nacional consolidable. Revisar tabla configurada."
      }));
    }

    const dato = candidato.Data[0];

    res.json(ok({
      fuente: `INE WSTempus · Tabla ${tabla}`,
      estado_dato: "OK",
      indicador: candidato.Nombre,
      fecha: dato.Anyo,
      periodo: dato.FK_Periodo,
      valor: dato.Valor,
      aviso:
        "Dato IPC obtenido desde INE. Verificar si la serie localizada es índice o variación anual según tabla."
    }));
  } catch (e) {
    res.json(error("No se pudo obtener IPC INE.", {
      detalle: e.message
    }));
  }
});

/* =========================================================
   INE · PIB
   Recomendado configurar tabla exacta en variable INE_PIB_TABLA.
========================================================= */

app.get("/api/ine/pib", async (req, res) => {
  try {
    const tabla = process.env.INE_PIB_TABLA;

    if (!tabla) {
      return res.json(ok({
        fuente: "INE WSTempus · PIB",
        estado_dato: "NO_CONFIGURADO",
        aviso:
          "Debe definirse INE_PIB_TABLA en Render con la tabla exacta de PIB que se quiera explotar."
      }));
    }

    const data = await ineTablaJson(tabla, 1);
    const rows = Array.isArray(data) ? data : [];

    const candidato =
      rows.find(r =>
        cleanText(r.Nombre || "").includes("producto interior bruto") ||
        cleanText(r.Nombre || "").includes("pib")
      ) || rows[0];

    if (!candidato || !candidato.Data?.length) {
      return res.json(ok({
        fuente: `INE WSTempus · Tabla ${tabla}`,
        estado_dato: "NO_DISPONIBLE",
        aviso:
          "INE respondió, pero no se localizó una serie PIB consolidable."
      }));
    }

    const dato = candidato.Data[0];

    res.json(ok({
      fuente: `INE WSTempus · Tabla ${tabla}`,
      estado_dato: "OK",
      indicador: candidato.Nombre,
      fecha: dato.Anyo,
      periodo: dato.FK_Periodo,
      valor: dato.Valor,
      aviso:
        "Dato PIB obtenido desde INE según tabla configurada."
    }));
  } catch (e) {
    res.json(error("No se pudo obtener PIB INE.", {
      detalle: e.message
    }));
  }
});

/* =========================================================
   CONTEXTO ECONÓMICO AGRUPADO
========================================================= */

app.get("/api/contexto-economico", async (req, res) => {
  try {
    const [bce, ipc, pib] = await Promise.allSettled([
      axios.get(`http://localhost:${PORT}/api/bce/tipos`),
      axios.get(`http://localhost:${PORT}/api/ine/ipc`),
      axios.get(`http://localhost:${PORT}/api/ine/pib`)
    ]);

    res.json(ok({
      fuente: "Contexto económico agrupado",
      bce: bce.status === "fulfilled" ? bce.value.data : null,
      ipc: ipc.status === "fulfilled" ? ipc.value.data : null,
      pib: pib.status === "fulfilled" ? pib.value.data : null,
      aviso:
        "Sólo se deben usar en decisión los indicadores con estado_dato OK."
    }));
  } catch (e) {
    res.json(error("No se pudo generar contexto económico.", {
      detalle: e.message
    }));
  }
});

app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
