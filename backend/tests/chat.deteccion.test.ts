import { describe, it, expect } from "@jest/globals";
import {
  quitarTildes,
  distanciaDamerau,
  contieneFactura,
  detectarRestaurarTodo,
  detectarVaciarPapelera,
  clasificarBorradoMasivo,
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
