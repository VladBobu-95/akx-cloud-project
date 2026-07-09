import { describe, it, expect } from "@jest/globals";
import {
  quitarTildes,
  distanciaDamerau,
  contieneFactura,
  detectarRestaurarTodo,
  detectarVaciarPapelera,
  clasificarBorradoMasivo,
  detectarTrimestreSemestre,
} from "../src/services/chat.deteccion";

// Tests PUROS de la capa de detección de intenciones del chat (#7): no tocan BD
// ni Ollama. Blindan los regex frágiles de los pre-flights más peligrosos
// (borrados masivos y papelera) contra regresiones al ajustar una frase.

// Igual que en chat.service.ts: las funciones reciben el texto en minúsculas y
// sin tildes.
const norm = (s: string): string => quitarTildes(s.toLowerCase());

describe("quitarTildes", () => {
  it("quita diacríticos y deja el resto igual", () => {
    expect(quitarTildes("Bórralo")).toBe("Borralo");
    expect(quitarTildes("vacíalas")).toBe("vacialas");
    expect(quitarTildes("papelera")).toBe("papelera");
  });
});

describe("distanciaDamerau", () => {
  it("cuenta una transposición de adyacentes como 1", () => {
    expect(distanciaDamerau("factura", "factura")).toBe(0);
    expect(distanciaDamerau("fcatura", "factura")).toBe(1);
    expect(distanciaDamerau("gato", "pato")).toBe(1);
  });
});

describe("contieneFactura", () => {
  it("detecta 'factura(s)' y erratas de 1 cambio", () => {
    expect(contieneFactura("dame las facturas")).toBe(true);
    expect(contieneFactura("la factura de marzo")).toBe(true);
    expect(contieneFactura("fcaturas de marzo")).toBe(true); // errata
  });
  it("no dispara con palabras no relacionadas", () => {
    expect(contieneFactura("dame las fotos")).toBe(false);
    expect(contieneFactura("borra el informe")).toBe(false);
  });
});

describe("detectarRestaurarTodo", () => {
  it.each([
    "restaura todo",
    "restauralo todo",
    "recupera todos los archivos",
    "saca todos los ficheros de la papelera",
  ])("true: %s", (frase) => {
    expect(detectarRestaurarTodo(norm(frase))).toBe(true);
  });

  it.each([
    "restaura factura_3",
    "borra todo",
    "que hay en la papelera",
    "restaurame todas las carpetas", // el preflight original no cubre carpetas
  ])("false: %s", (frase) => {
    expect(detectarRestaurarTodo(norm(frase))).toBe(false);
  });
});

describe("detectarVaciarPapelera", () => {
  it.each([
    "vacía la papelera",
    "vaciame la papelera",
    "borra toda la papelera",
    "borra todo de la papelera",
    "borra la papelera",
    "elimina la papelera",
  ])("true: %s", (frase) => {
    expect(detectarVaciarPapelera(norm(frase))).toBe(true);
  });

  it.each([
    "borra factura_3 de la papelera", // archivo concreto (factura) -> NO masivo
    "que hay en la papelera", // consulta
    "vacía la carpeta informes", // no es la papelera
    "borra el informe.pdf", // ni papelera ni masivo
  ])("false: %s", (frase) => {
    expect(detectarVaciarPapelera(norm(frase))).toBe(false);
  });
});

describe("clasificarBorradoMasivo", () => {
  it.each([
    ["borra todo", "todo"],
    ["vacíalo todo", "todo"],
    ["elimina todo", "todo"],
    ["empezar de cero", "todo"],
    ["borra todas las carpetas", "carpetas"],
    ["elimina todos los archivos", "archivos"],
    ["borra todos los ficheros", "archivos"],
  ] as const)("%s -> %s", (frase, esperado) => {
    expect(clasificarBorradoMasivo(norm(frase))).toBe(esperado);
  });

  it.each([
    "borra el informe.pdf",
    "no quiero borrar nada",
    "mueve todos los archivos a la carpeta x",
  ])("null: %s", (frase) => {
    expect(clasificarBorradoMasivo(norm(frase))).toBeNull();
  });
});

describe("detectarTrimestreSemestre", () => {
  // Fecha fija para los relativos: 9 jul 2026 → T3 (jul-sep), S2 (jul-dic).
  const AHORA = new Date(2026, 6, 9);
  const det = (frase: string) => detectarTrimestreSemestre(norm(frase), AHORA);

  it.each([
    ["primer trimestre", "2026-01-01", "2026-03-31"],
    ["segundo trimestre de 2025", "2025-04-01", "2025-06-30"],
    ["tercer trimestre", "2026-07-01", "2026-09-30"],
    ["cuarto trimestre", "2026-10-01", "2026-12-31"],
    ["T3 de 2026", "2026-07-01", "2026-09-30"],
    ["Q1 2026", "2026-01-01", "2026-03-31"],
    ["trimestre 2", "2026-04-01", "2026-06-30"],
    ["primer semestre", "2026-01-01", "2026-06-30"],
    ["segundo semestre de 2024", "2024-07-01", "2024-12-31"],
    ["S1", "2026-01-01", "2026-06-30"],
  ] as const)("%s → %s..%s", (frase, desde, hasta) => {
    const r = det(frase);
    expect(r).not.toBeNull();
    expect(r!.desde).toBe(desde);
    expect(r!.hasta).toBe(hasta);
  });

  it("relativos: este trimestre y trimestre pasado dependen de la fecha", () => {
    expect(det("este trimestre")).toMatchObject({ desde: "2026-07-01", hasta: "2026-09-30" });
    expect(det("trimestre pasado")).toMatchObject({ desde: "2026-04-01", hasta: "2026-06-30" });
    expect(det("el trimestre anterior")).toMatchObject({ desde: "2026-04-01", hasta: "2026-06-30" });
  });

  it("trimestre pasado desde Q1 retrocede a Q4 del año anterior", () => {
    const enero = new Date(2026, 0, 15); // Q1
    expect(detectarTrimestreSemestre("trimestre pasado", enero)).toMatchObject({
      desde: "2025-10-01",
      hasta: "2025-12-31",
    });
  });

  it.each([
    "facturas de junio",
    "cuanto he facturado en 2026",
    "resumen de ventas",
  ])("null cuando no hay trimestre/semestre: %s", (frase) => {
    expect(det(frase)).toBeNull();
  });
});
