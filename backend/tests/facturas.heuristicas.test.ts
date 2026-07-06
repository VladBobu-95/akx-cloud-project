import { describe, it, expect } from "@jest/globals";
import { pareceFacturaConImportes, tieneRegistroMercantil } from "../src/services/extraccion.service";
import {
  reconciliarPartes,
  resolverDireccion,
  type DatosFactura,
} from "../src/services/facturas.service";
import type { Empresa } from "../src/entities/Empresa";

// Tests PUROS de las heurísticas deterministas de facturas (venta/compra, emisor/
// cliente, idioma). No tocan BD ni Ollama. Blindan la lógica frágil (regex, anclas)
// contra regresiones, usando casos reales (TRAZA, Repsol catalán, DonDominio→ATEKA).

// Empresa mínima (resolverDireccion solo lee nombre y nif).
const emp = (nombre: string, nif: string | null = null): Empresa =>
  ({ nombre, nif }) as unknown as Empresa;

describe("tieneRegistroMercantil", () => {
  it("detecta la línea legal en castellano, catalán y gallego", () => {
    expect(tieneRegistroMercantil("… Inscrita en el Registro Mercantil de Madrid")).toBe(true);
    expect(tieneRegistroMercantil("… Inscrita en el Registre Mercantil de Cantàbria")).toBe(true);
    expect(tieneRegistroMercantil("… Rexistro Mercantil de A Coruña")).toBe(true);
  });
  it("no dispara con texto sin esa línea", () => {
    expect(tieneRegistroMercantil("Factura 123 total 50,00 €")).toBe(false);
  });
});

describe("pareceFacturaConImportes", () => {
  it("acepta importes monetarios reales", () => {
    expect(pareceFacturaConImportes("Total a pagar 120,00 €")).toBe(true);
    expect(pareceFacturaConImportes("importe 1.234,56")).toBe(true);
    expect(pareceFacturaConImportes("Subtotal $ 50.00")).toBe(true);
  });
  it("acepta términos de factura en catalán e inglés", () => {
    expect(pareceFacturaConImportes("This is an invoice for services")).toBe(true);
    expect(pareceFacturaConImportes("VAT 21%")).toBe(true);
    expect(pareceFacturaConImportes("Base imposable de la factura")).toBe(true);
    expect(pareceFacturaConImportes("un rebut de la llum")).toBe(true);
  });
  it("rechaza texto que no es factura", () => {
    expect(pareceFacturaConImportes("una foto de un gato en el jardín")).toBe(false);
    expect(pareceFacturaConImportes("cantidad total precio referencia")).toBe(false);
  });
});

describe("reconciliarPartes", () => {
  const REPSOL =
    "Factura de llum\nAKX STUDIO SL\n…\nRepsol Comercializadora de Electricidad y Gas, S.L.U. " +
    "Inscrita en el Registre Mercantil de Cantàbria (T. 1007) NIF B39540760";

  it("invierte emisor↔cliente cuando el cliente coincide con la línea de registro (TRAZA)", () => {
    const d: DatosFactura = {
      emisor: "AKX STUDIO SL",
      emisorNif: "B13861935",
      cliente: "TRAZA NOSITEC S.L.U.",
      clienteNif: "B61462735",
    };
    const contenido =
      "AKX STUDIO SL\nA/A XAVIER\n…\nTRAZA NOSITEC S.L.U. Inscrita en el Registro Mercantil de Barcelona NIF B61462735";
    reconciliarPartes(d, contenido);
    expect(d.emisor).toBe("TRAZA NOSITEC S.L.U.");
    expect(d.cliente).toBe("AKX STUDIO SL");
    expect(d.emisorNif).toBe("B61462735");
    expect(d.clienteNif).toBe("B13861935");
  });

  it("fija el emisor por el pie legal cuando emisor==cliente (Repsol)", () => {
    const d: DatosFactura = { emisor: "AKX STUDIO SL", cliente: "AKX STUDIO SL", emisorNif: "B13861935" };
    reconciliarPartes(d, REPSOL);
    expect(d.emisor).toBe("Repsol Comercializadora de Electricidad y Gas, S.L.U.");
    expect(d.emisorNif).toBe("B39540760");
  });

  it("tolera ruido OCR en el nombre del cliente (AKX vs ARX)", () => {
    const d: DatosFactura = { emisor: "AKX STUDIO SL", cliente: "ARX STUDIO SL" };
    reconciliarPartes(d, REPSOL);
    expect(d.emisor).toBe("Repsol Comercializadora de Electricidad y Gas, S.L.U.");
  });

  it("no toca una extracción ya correcta (emisor = empresa del registro)", () => {
    const d: DatosFactura = { emisor: "Tesys Internet S.L.U.", cliente: "AKX Studio SLU" };
    reconciliarPartes(
      d,
      "Tesys Internet S.L.U. … Sociedad inscrita en el Registro Mercantil de La Rioja",
    );
    expect(d.emisor).toBe("Tesys Internet S.L.U.");
    expect(d.cliente).toBe("AKX Studio SLU");
  });

  it("no hace nada sin línea de registro (factura extranjera)", () => {
    const d: DatosFactura = { emisor: "iFastNet", cliente: "AKX Studio" };
    reconciliarPartes(d, "iFastNet invoice total 18.14 USD");
    expect(d.emisor).toBe("iFastNet");
  });
});

describe("resolverDireccion", () => {
  const AKX = emp("AKX Studio SLU", "B13861935");

  it("clasifica por CIF: cliente = empresa → compra", () => {
    const d: DatosFactura = { emisor: "Tesys", emisorNif: "B26309096", cliente: "AKX", clienteNif: "B13861935" };
    expect(resolverDireccion(d, AKX)).toBe("compra");
  });

  it("clasifica por CIF: emisor = empresa → venta", () => {
    const d: DatosFactura = { emisor: "AKX", emisorNif: "B13861935", cliente: "Cliente X", clienteNif: "B99999999" };
    expect(resolverDireccion(d, AKX)).toBe("venta");
  });

  it("#4: el CIF de la empresa aparece en el texto y el emisor es otro → compra", () => {
    const d: DatosFactura = { emisor: "Repsol", emisorNif: "B39540760", cliente: "ARX STUDIO", clienteNif: "" };
    const contenido = "Factura de llum … client AKX … NIF B13861935 …";
    expect(resolverDireccion(d, AKX, contenido)).toBe("compra");
  });

  it("clasifica por nombre cuando no hay CIF guardado", () => {
    const sinCif = emp("AKX Studio SLU", null);
    const d: DatosFactura = { emisor: "Tesys Internet SLU", cliente: "AKX Studio SLU" };
    expect(resolverDireccion(d, sinCif)).toBe("compra");
  });

  it("emisor == cliente (degenerado) → desconocido", () => {
    const d: DatosFactura = { emisor: "AKX Studio", cliente: "AKX Studio", emisorNif: "B13861935" };
    expect(resolverDireccion(d, AKX)).toBe("desconocido");
  });

  it("ninguna parte es la empresa → desconocido", () => {
    const d: DatosFactura = { emisor: "Foo SL", cliente: "Bar SL" };
    expect(resolverDireccion(d, AKX)).toBe("desconocido");
  });
});
